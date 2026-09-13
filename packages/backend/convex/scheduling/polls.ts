// BOOKING / E3 — MEETING POLLS (`bookingPolls` + `bookingPollVotes`).
//
// A Doodle-style coordination layer that sits IN FRONT OF the booking write
// path (PRD §4.2 / §14): an organizer proposes a set of time options, invitees
// vote on the ones they're available for (public, no login — like the booking
// candidate surface), and the organizer (or an auto-close) picks the winning
// option, which DELEGATES to the existing `createBooking` internal mutation to
// materialize a real booking. The poll layer never re-implements booking
// creation — the winning option's {startMs,endMs} is handed to createBooking so
// poll-originated bookings are indistinguishable downstream (calendar sync /
// reminders / webhooks all fire via the normal pipeline).
//
// AUTH + FLAG CONTRACT:
//   - createPoll / closePoll / cancelPoll / pickWinner: ORGANIZER mutations —
//     `requireAuthUserId(ctx)` FIRST, then gate on the DEFAULT-OFF
//     `booking_enabled` flag (identical to schedules.ts / eventTypes.ts).
//   - votePoll: PUBLIC handler (NO requireAuthUserId) — invoked via the
//     flag-gated, IP-rate-limited httpAction in publicApi.ts (same posture as
//     createBooking). The bare handler still gates on the flag.
//   - getPollWithVotes / getPublicPoll: public reads (poll = share-by-link).
//
// TESTABILITY: each handler is exported as a bare async fn (the *Handler
// functions) so the *.test.ts exercises them against the repo in-memory FakeDb
// (see booking.test.ts). closePoll calls createBookingHandler directly in-isolate
// (no RPC) so the booking-creation delegation is exercised end-to-end in tests.
//
// SCHEMA NOTE: `bookingPolls` / `bookingPollVotes` are NEW tables (codegen
// operator-gated). String table names typecheck at runtime; tsc under the stale
// `_generated` types may flag them until codegen runs — EXPECTED, same as the
// other scheduling modules.

import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { requireAuthUserId } from "../_helpers/auth";
import { requireFlagEnabled } from "../_helpers/featureFlag";
import { createBookingHandler } from "./booking";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

const BOOKING_FLAG_GATE = {
  kind: "booking_disabled",
  message: "Booking is not available.",
  defaultValue: false as const,
};

async function gateBooking(ctx: Ctx): Promise<void> {
  const gate = await requireFlagEnabled(ctx, "booking_enabled", BOOKING_FLAG_GATE);
  if (!gate.ok) throw new ConvexError({ kind: gate.kind, message: gate.message });
}

// Default poll TTL when the organizer doesn't pass an explicit `expiresAt`.
const DEFAULT_POLL_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Load a poll and assert the caller owns it. Throws "Not found." on any
// miss-or-not-owned (leak-prevention, like requireOwnedSchedule).
async function requireOwnedPoll(
  ctx: Ctx,
  pollId: Id<"bookingPolls">,
  organizerId: string,
): Promise<Record<string, any>> {
  const poll = await ctx.db.get(pollId);
  if (!poll || poll.organizerAuthUserId !== organizerId) {
    throw new ConvexError("Not found.");
  }
  return poll;
}

// ─────────────────────────────────────────────────────────────
// createPoll — organizer mutation (auth + flag-gated)
// ─────────────────────────────────────────────────────────────

export interface CreatePollArgs {
  eventTypeId?: Id<"eventTypes">;
  title: string;
  description?: string;
  location?: string;
  // Caller supplies [{startMs,endMs}]; server assigns the stable 0-based idx.
  options: Array<{ startMs: number; endMs: number }>;
  expiresAt?: number;
  nowMs?: number;
}

export async function createPollHandler(
  ctx: Ctx,
  args: CreatePollArgs,
): Promise<Id<"bookingPolls">> {
  const organizerId = await requireAuthUserId(ctx);
  await gateBooking(ctx);

  if (!args.title.trim()) throw new ConvexError("Title is required.");
  if (!Array.isArray(args.options) || args.options.length === 0) {
    throw new ConvexError("At least one time option is required.");
  }
  for (const opt of args.options) {
    if (
      !Number.isFinite(opt.startMs) ||
      !Number.isFinite(opt.endMs) ||
      opt.endMs <= opt.startMs
    ) {
      throw new ConvexError("Each option needs endMs > startMs.");
    }
  }

  const now = args.nowMs ?? Date.now();
  const options = args.options.map((opt, idx) => ({
    idx,
    startMs: opt.startMs,
    endMs: opt.endMs,
  }));

  return await ctx.db.insert("bookingPolls", {
    organizerAuthUserId: organizerId,
    eventTypeId: args.eventTypeId,
    title: args.title,
    description: args.description,
    location: args.location,
    options,
    status: "open",
    expiresAt: args.expiresAt ?? now + DEFAULT_POLL_TTL_MS,
    createdAt: now,
    updatedAt: now,
  });
}

export const createPoll = mutation({
  args: {
    eventTypeId: v.optional(v.id("eventTypes")),
    title: v.string(),
    description: v.optional(v.string()),
    location: v.optional(v.string()),
    options: v.array(v.object({ startMs: v.number(), endMs: v.number() })),
    expiresAt: v.optional(v.number()),
    nowMs: v.optional(v.number()),
  },
  handler: createPollHandler,
});

// ─────────────────────────────────────────────────────────────
// votePoll — PUBLIC handler (no auth; flag-gated). Upsert per voter.
// ─────────────────────────────────────────────────────────────

export interface VotePollArgs {
  pollId: Id<"bookingPolls">;
  voterEmail: string;
  voterName?: string;
  selectedOptionIdxs: number[];
  ifNeededOptionIdxs?: number[];
  nowMs?: number;
}

export async function votePollHandler(
  ctx: Ctx,
  args: VotePollArgs,
): Promise<Id<"bookingPollVotes">> {
  await gateBooking(ctx);
  const now = args.nowMs ?? Date.now();

  const poll = await ctx.db.get(args.pollId);
  if (!poll) {
    throw new ConvexError({ kind: "poll_not_found", message: "Not found." });
  }
  // Only an OPEN poll accepts votes; closed/expired reject.
  if (poll.status !== "open") {
    throw new ConvexError({
      kind: "poll_closed",
      message: "This poll is no longer accepting votes.",
    });
  }
  if (!args.voterEmail.trim()) {
    throw new ConvexError({ kind: "invalid_request", message: "voterEmail is required." });
  }

  // Validate every selected/if-needed idx exists in the poll's options.
  const validIdxs = new Set<number>(poll.options.map((o: any) => o.idx as number));
  const allIdxs = [
    ...(args.selectedOptionIdxs ?? []),
    ...(args.ifNeededOptionIdxs ?? []),
  ];
  for (const idx of allIdxs) {
    if (!validIdxs.has(idx)) {
      throw new ConvexError({
        kind: "invalid_request",
        message: `Unknown option idx ${idx}.`,
      });
    }
  }

  // Upsert on (pollId, voterEmail) — a voter returning to update their choices
  // before close patches their existing row rather than inserting a duplicate.
  const existing: Array<Record<string, any>> = await ctx.db
    .query("bookingPollVotes")
    .withIndex("by_pollId_voterEmail", (q: Ctx) =>
      q.eq("pollId", args.pollId).eq("voterEmail", args.voterEmail),
    )
    .collect();

  if (existing.length > 0) {
    const row = existing[0];
    await ctx.db.patch(row._id, {
      voterName: args.voterName,
      selectedOptionIdxs: args.selectedOptionIdxs ?? [],
      ifNeededOptionIdxs: args.ifNeededOptionIdxs,
      updatedAt: now,
    });
    return row._id as Id<"bookingPollVotes">;
  }

  return await ctx.db.insert("bookingPollVotes", {
    pollId: args.pollId,
    voterEmail: args.voterEmail,
    voterName: args.voterName,
    selectedOptionIdxs: args.selectedOptionIdxs ?? [],
    ifNeededOptionIdxs: args.ifNeededOptionIdxs,
    createdAt: now,
    updatedAt: now,
  });
}

// INTERNAL only — the public entry point is the flag-gated, IP-rate-limited
// httpAction (publicApi.ts bookPollVoteHandler). Exposing this as a public
// `mutation` would let the Convex client bypass the rate-limit gate (the flag
// check below still holds, but the IP rate-limit lives only in the httpAction).
// Same precedent as createBooking. Registered so it materializes on `internal`.
export const _votePoll = mutation({
  args: {
    pollId: v.id("bookingPolls"),
    voterEmail: v.string(),
    voterName: v.optional(v.string()),
    selectedOptionIdxs: v.array(v.number()),
    ifNeededOptionIdxs: v.optional(v.array(v.number())),
    nowMs: v.optional(v.number()),
  },
  handler: votePollHandler,
});

// ─────────────────────────────────────────────────────────────
// Tally — pure aggregation over a poll's votes (shared by reads + auto-pick).
// ─────────────────────────────────────────────────────────────

export interface PollTallyEntry {
  idx: number;
  yesCount: number;
  ifNeededCount: number;
}

export function tallyVotes(
  options: Array<{ idx: number }>,
  votes: Array<Record<string, any>>,
): PollTallyEntry[] {
  const yes = new Map<number, number>();
  const ifNeeded = new Map<number, number>();
  for (const v of votes) {
    for (const idx of (v.selectedOptionIdxs ?? []) as number[]) {
      yes.set(idx, (yes.get(idx) ?? 0) + 1);
    }
    for (const idx of (v.ifNeededOptionIdxs ?? []) as number[]) {
      ifNeeded.set(idx, (ifNeeded.get(idx) ?? 0) + 1);
    }
  }
  return options.map((o) => ({
    idx: o.idx,
    yesCount: yes.get(o.idx) ?? 0,
    ifNeededCount: ifNeeded.get(o.idx) ?? 0,
  }));
}

// ─────────────────────────────────────────────────────────────
// getPollWithVotes — public read (vote-grid UI). Returns poll + votes + tally.
// ─────────────────────────────────────────────────────────────

export async function getPollWithVotesHandler(
  ctx: Ctx,
  args: { pollId: Id<"bookingPolls"> },
): Promise<{
  poll: Record<string, any>;
  votes: Array<Record<string, any>>;
  tally: PollTallyEntry[];
} | null> {
  const poll = await ctx.db.get(args.pollId);
  if (!poll) return null;
  const votes: Array<Record<string, any>> = await ctx.db
    .query("bookingPollVotes")
    .withIndex("by_pollId", (q: Ctx) => q.eq("pollId", args.pollId))
    .collect();
  return { poll, votes, tally: tallyVotes(poll.options, votes) };
}

export const getPollWithVotes = query({
  args: { pollId: v.id("bookingPolls") },
  handler: getPollWithVotesHandler,
});

// ─────────────────────────────────────────────────────────────
// PUBLIC-SAFE poll DTO (the /book/api/poll/{id} surface). Strips the
// organizerAuthUserId + every voter's raw email (only aggregate counts +
// names-less option metadata leave the server). Voter identities are NOT
// exposed on the public read — only the per-option tally.
// ─────────────────────────────────────────────────────────────

export interface PublicPollOption {
  idx: number;
  startMs: number;
  endMs: number;
  yesCount: number;
  ifNeededCount: number;
}

export interface PublicPollDto {
  pollId: Id<"bookingPolls">;
  title: string;
  description: string | null;
  location: string | null;
  status: string;
  options: PublicPollOption[];
  expiresAt: number | null;
  pickedOptionIdx: number | null;
  // Total distinct voters (count only — never the voter list / emails).
  voteCount: number;
}

export async function getPublicPollImpl(
  ctx: Ctx,
  pollId: string,
): Promise<PublicPollDto | null> {
  const poll = await ctx.db.get(pollId as Id<"bookingPolls">);
  if (!poll) return null;
  const votes: Array<Record<string, any>> = await ctx.db
    .query("bookingPollVotes")
    .withIndex("by_pollId", (q: Ctx) => q.eq("pollId", poll._id))
    .collect();
  const tally = tallyVotes(poll.options, votes);
  const tallyByIdx = new Map(tally.map((t) => [t.idx, t]));
  const options: PublicPollOption[] = poll.options.map((o: any) => {
    const t = tallyByIdx.get(o.idx);
    return {
      idx: o.idx,
      startMs: o.startMs,
      endMs: o.endMs,
      yesCount: t?.yesCount ?? 0,
      ifNeededCount: t?.ifNeededCount ?? 0,
    };
  });
  return {
    pollId: poll._id as Id<"bookingPolls">,
    title: poll.title,
    description: poll.description ?? null,
    location: poll.location ?? null,
    status: poll.status,
    options,
    expiresAt: poll.expiresAt ?? null,
    pickedOptionIdx: poll.pickedOptionIdx ?? null,
    voteCount: votes.length,
  };
}

// ─────────────────────────────────────────────────────────────
// closePoll / pickWinner — organizer picks a winning option, which creates a
// booking at that option via the EXISTING createBooking path.
// ─────────────────────────────────────────────────────────────

export interface ClosePollArgs {
  pollId: Id<"bookingPolls">;
  pickedOptionIdx: number;
  bookerName?: string;
  bookerEmail?: string;
  location?: string;
  idempotencyKey: string;
  nowMs?: number;
}

export async function closePollHandler(
  ctx: Ctx,
  args: ClosePollArgs,
): Promise<{ bookingId: Id<"bookings">; pollId: Id<"bookingPolls"> }> {
  const organizerId = await requireAuthUserId(ctx);
  await gateBooking(ctx);

  const poll = await requireOwnedPoll(ctx, args.pollId, organizerId);
  if (poll.status !== "open") {
    throw new ConvexError({
      kind: "poll_closed",
      message: "This poll is already closed.",
    });
  }

  const option = (poll.options as any[]).find(
    (o) => o.idx === args.pickedOptionIdx,
  );
  if (!option) {
    throw new ConvexError({
      kind: "invalid_request",
      message: `Unknown option idx ${args.pickedOptionIdx}.`,
    });
  }

  // A poll-originated booking REQUIRES a backing event type — the booking write
  // path resolves hosts / availability / capacity from it. Ad-hoc polls (no
  // eventTypeId) can't materialize a booking; the organizer must use cancelPoll
  // (close with no winner) to coordinate purely out-of-band.
  if (!poll.eventTypeId) {
    throw new ConvexError({
      kind: "poll_no_event_type",
      message: "This poll has no booking page; cancel it instead of picking a winner.",
    });
  }

  // Resolve the event type's slug for the createBooking call (it takes a slug,
  // not an id). The poll layer does NOT re-implement booking creation — it
  // delegates so conflict re-check / idempotency / hold-consume all apply.
  const eventType = await ctx.db.get(poll.eventTypeId);
  if (!eventType || eventType.active === false) {
    throw new ConvexError({
      kind: "event_type_inactive",
      message: "This event type is not accepting bookings.",
    });
  }

  const now = args.nowMs ?? Date.now();
  const bookerEmail = args.bookerEmail ?? "poll-organizer@dibslist.app";
  const res = await createBookingHandler(ctx, {
    slug: eventType.slug,
    startTime: option.startMs,
    endTime: option.endMs,
    bookerTimeZone: "UTC",
    holderToken: "",
    idempotencyKey: args.idempotencyKey,
    attendee: {
      name: args.bookerName ?? "Poll attendee",
      email: bookerEmail,
      timeZone: "UTC",
    },
    nowMs: now,
  });

  await ctx.db.patch(args.pollId, {
    status: "closed",
    pickedOptionIdx: args.pickedOptionIdx,
    resultBookingId: res.bookingId,
    location: args.location ?? poll.location,
    updatedAt: now,
  });

  return { bookingId: res.bookingId, pollId: args.pollId };
}

export const closePoll = mutation({
  args: {
    pollId: v.id("bookingPolls"),
    pickedOptionIdx: v.number(),
    bookerName: v.optional(v.string()),
    bookerEmail: v.optional(v.string()),
    location: v.optional(v.string()),
    idempotencyKey: v.string(),
    nowMs: v.optional(v.number()),
  },
  handler: closePollHandler,
});

// `pickWinner` is an alias of closePoll (the task brief names it `closePoll` /
// `pickWinner`). Registered under both names so either ref resolves; the body
// is identical (organizer picks an option → createBooking delegation).
export const pickWinner = mutation({
  args: {
    pollId: v.id("bookingPolls"),
    pickedOptionIdx: v.number(),
    bookerName: v.optional(v.string()),
    bookerEmail: v.optional(v.string()),
    location: v.optional(v.string()),
    idempotencyKey: v.string(),
    nowMs: v.optional(v.number()),
  },
  handler: closePollHandler,
});

// ─────────────────────────────────────────────────────────────
// cancelPoll — organizer closes WITHOUT picking (no booking created).
// ─────────────────────────────────────────────────────────────

export async function cancelPollHandler(
  ctx: Ctx,
  args: { pollId: Id<"bookingPolls">; nowMs?: number },
): Promise<null> {
  const organizerId = await requireAuthUserId(ctx);
  await gateBooking(ctx);
  await requireOwnedPoll(ctx, args.pollId, organizerId);
  await ctx.db.patch(args.pollId, {
    status: "closed",
    pickedOptionIdx: undefined,
    updatedAt: args.nowMs ?? Date.now(),
  });
  return null;
}

export const cancelPoll = mutation({
  args: { pollId: v.id("bookingPolls"), nowMs: v.optional(v.number()) },
  handler: cancelPollHandler,
});
