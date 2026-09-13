// BOOKING / A7 — the booking WRITE path: `createBooking`, `cancelBooking`,
// `rescheduleBooking` (Phase A) + Phase-B side-effect STUBS.
//
// PHASE A vs PHASE B (lifecycle spec §7):
//   - Phase A = this file's mutations. Each is ONE serializable ACID transaction:
//     idempotency dedupe → write-time conflict re-check → insert bookings +
//     bookingAttendees → consume hold → schedule Phase B. It is the complete,
//     committed source of truth. It NEVER does calendar I/O / email / webhooks.
//   - Phase B = calendar sync + confirmation email + webhooks. Implemented as
//     internalActions, scheduled via `ctx.scheduler.runAfter(0, …)` INSIDE the
//     mutation body so the scheduler call commits atomically with the row (if it
//     were after an `await` on the mutation result it could be lost on a crash).
//     A7 ships these as clearly-named NO-OP stubs; the real impls land in Phase
//     B/D. The wiring compiles + the booking row is never blocked on them.
//
// PUBLIC/CANDIDATE PATH: `createBooking` is the unauthenticated candidate surface
// — NO `requireAuthUserId`. Identity for the new booking is the attendee email +
// the `holderToken`. `cancelBooking` / `rescheduleBooking` accept an optional
// signed token for candidate self-service (token VERIFICATION lands in the
// deploy-auth PRD; here we only thread the arg + the organizer-auth branch is
// deferred to that PRD). Every write gates on the DEFAULT-OFF `booking_enabled`
// flag.
//
// RACE GUARD: Convex mutations are serializable. Two concurrent createBooking
// calls for the same slot are sequenced; the second's conflict re-check
// (assertSlotFreeForAllHosts) reads the first's just-inserted accepted booking
// and throws `slot_unavailable`. This is the Postgres GiST-exclusion substitute.
//
// SCHEMA NOTE: the booking tables are NEW (schema pushed, codegen operator-gated).
// String table names + `internal.scheduling.booking.*` refs typecheck at runtime;
// tsc under the stale `_generated` types may flag them until codegen runs —
// EXPECTED (same as the A4/A5/A6 modules + the crons.ts `(internal as any)` hops).

import { ConvexError, v } from "convex/values";
import { internalMutation, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { requireFlagEnabled } from "../_helpers/featureFlag";
import { assertSlotFreeForAllHosts } from "./holds";
import { getUserAvailabilityRangesHandler } from "./availability";
import { checkForConflicts, dayjs } from "@dibslist/scheduling-engine";
import { syncToCalendarsHandler } from "./sync";
import { sendNotificationHandler } from "./notify";
import {
  assertEmailVerified,
  resolveSingleUseToken,
  burnSingleUseToken,
} from "./antiAbuse";

const BOOKING_LOOKBACK_MS = 24 * 60 * 60 * 1000;

// WAVE-2 PAIR — how long a pair booking holds `pending` for the partner
// (clamped to the slot start at create time).
export const PAIR_HOLD_TTL_MS = 24 * 60 * 60 * 1000;

// Opaque URL-safe partner-join capability. Math.random is deterministic-replay
// safe in Convex mutations; two segments + time keep it unguessable enough for
// a short-lived, single-purpose capability (same class as holderToken).
function mintPairToken(): string {
  return `pair-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random()
    .toString(36)
    .slice(2)}`;
}

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

const attendeeArg = v.object({
  name: v.string(),
  email: v.string(),
  timeZone: v.string(),
  notes: v.optional(v.string()),
});

interface AttendeeInput {
  name: string;
  email: string;
  timeZone: string;
  notes?: string;
}

// BOOKING-PAYMENTS §6 — answers to the event type's custom booking questions
// (the intake form). Threaded through create so BOTH the free public path
// (M5 fork adapter) and the paid webhook finalize (M3) persist them onto the
// booking row. Absent = no custom questions asked.
export interface IntakeResponse {
  name: string;
  label: string;
  value: string;
}

// Check whether a single host is free for [startTime,endTime) (+buffers): the
// slot must sit fully inside one of the host's engine free ranges AND have no
// overlapping accepted/pending booking. Mirrors the per-host body of
// `assertSlotFreeForAllHosts` (holds.ts) but as a boolean (no throw) so the RR
// picker can probe candidates and fall back.
async function hostIsFreeForSlot(
  ctx: Ctx,
  args: {
    host: Record<string, any>;
    eventType: Record<string, any>;
    startTime: number;
    endTime: number;
    viewerTimeZone: string;
    nowMs: number;
    excludeBookingId?: Id<"bookings">;
  },
): Promise<boolean> {
  const { host, eventType, startTime, endTime, viewerTimeZone, nowMs } = args;
  const bufferBefore = (eventType.bufferBeforeMinutes ?? 0) * 60_000;
  const bufferAfter = (eventType.bufferAfterMinutes ?? 0) * 60_000;

  const freeRanges = await getUserAvailabilityRangesHandler(ctx, {
    hostAuthUserId: host.hostAuthUserId,
    scheduleId: host.scheduleId ?? undefined,
    windowStart: startTime,
    windowEnd: endTime,
    viewerTimeZone,
    nowMs,
  });
  const slotIsFree = freeRanges.some(
    (r) => r.start <= startTime && r.end >= endTime,
  );
  if (!slotIsFree) return false;

  const rawBookings: Array<Record<string, any>> = await ctx.db
    .query("bookings")
    .withIndex("by_assignedHost_startTime", (q: Ctx) =>
      q
        .eq("assignedHostAuthUserId", host.hostAuthUserId)
        .gte("startTime", startTime - BOOKING_LOOKBACK_MS)
        .lte("startTime", endTime),
    )
    .collect();
  const busy = rawBookings
    .filter(
      (b) =>
        b._id !== args.excludeBookingId &&
        (b.status === "accepted" || b.status === "pending"),
    )
    .map((b) => ({
      start: new Date((b.startTime as number) - bufferBefore),
      end: new Date((b.endTime as number) + bufferAfter),
    }));
  const eventLengthWithBuffers =
    (endTime - startTime + bufferBefore + bufferAfter) / 60_000;
  const hasConflict = checkForConflicts({
    busy,
    time: dayjs(startTime - bufferBefore),
    eventLength: eventLengthWithBuffers,
  });
  return !hasConflict;
}

// getLuckyUser (E1) — given the round-robin pool's eligible (free-for-this-slot)
// host rows, pick the one that should absorb this booking. Lifted selection math
// (cal.diy getLuckyUser): least-recently-booked wins, modulated by `weight`
// (a higher-weight host is "due" sooner, so its effective recency is pulled
// older), tie-broken by `priority` (RR star, higher wins) then host id for
// determinism. Equal-distribution is the default and falls out of the same
// least-recently-booked scoring.
//
// "Least recently booked" = the host whose most-recent assigned booking is the
// OLDEST (or who has none) is the most overdue. We query each candidate's latest
// booking via `by_assignedHost_startTime` (descending, take 1).
async function getLuckyHost(
  ctx: Ctx,
  candidates: Array<Record<string, any>>,
  nowMs: number,
): Promise<Record<string, any> | null> {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Most-recent assigned booking startTime per candidate (or -Infinity if none).
  const lastBooked = new Map<string, number>();
  for (const c of candidates) {
    const hostId = c.hostAuthUserId as string;
    const rows: Array<Record<string, any>> = await ctx.db
      .query("bookings")
      .withIndex("by_assignedHost_startTime", (q: Ctx) =>
        q.eq("assignedHostAuthUserId", hostId),
      )
      .collect();
    const considered = rows.filter(
      (b) => b.status === "accepted" || b.status === "pending",
    );
    let latest = -Infinity;
    for (const b of considered) {
      const st = b.startTime as number;
      if (st > latest) latest = st;
    }
    lastBooked.set(hostId, latest);
  }

  // Score: how OVERDUE each candidate is. recencyAge = now - lastBooked (bigger =
  // longer since last booked = more overdue). Weight scales the age up so a
  // higher-weight host appears more overdue and is picked sooner. A host that has
  // never been booked uses a large finite age so it always wins the first round.
  const NEVER_AGE = 365 * 24 * 60 * 60 * 1000; // 1y — beats any realistic age
  let best: Record<string, any> | null = null;
  let bestScore = -Infinity;
  let bestPriority = -Infinity;
  let bestId = "";
  for (const c of candidates) {
    const hostId = c.hostAuthUserId as string;
    const last = lastBooked.get(hostId)!;
    const age = last === -Infinity ? NEVER_AGE : Math.max(0, nowMs - last);
    const weight = typeof c.weight === "number" && c.weight > 0 ? c.weight : 1;
    const score = age * weight; // higher = more due
    const priority = typeof c.priority === "number" ? c.priority : 0;
    if (
      score > bestScore ||
      (score === bestScore && priority > bestPriority) ||
      (score === bestScore && priority === bestPriority && hostId < bestId)
    ) {
      best = c;
      bestScore = score;
      bestPriority = priority;
      bestId = hostId;
    }
  }
  return best;
}

// Resolve the event type's hosts + the assigned host for a confirm.
//   - collective: every fixed host is required; assertSlotFreeForAllHosts has
//     already (or will) enforce all-free. assignedHost = the single host when
//     there's exactly one, else undefined (panel — no single assignee).
//   - round_robin: offer the slot if ANY one host is free; pick the lucky host
//     among the free candidates via getLuckyHost; on a race (none free) throw
//     slot_unavailable. Returns ONLY the picked host as the booking's host row,
//     and that host id as assignedHostAuthUserId.
async function resolveBookingHosts(
  ctx: Ctx,
  args: {
    eventType: Record<string, any>;
    startTime: number;
    endTime: number;
    viewerTimeZone: string;
    nowMs: number;
    excludeBookingId?: Id<"bookings">;
  },
): Promise<{ hostRows: Array<Record<string, any>>; assignedHostId?: string }> {
  const { eventType } = args;
  const allHosts: Array<Record<string, any>> = await ctx.db
    .query("eventTypeHosts")
    .withIndex("by_eventType", (q: Ctx) => q.eq("eventTypeId", eventType._id))
    .collect();

  if (eventType.schedulingType !== "round_robin") {
    // Collective (and managed, treated as collective for MVP): all fixed hosts.
    const fixed = allHosts.filter((h) => h.isFixed !== false);
    return {
      hostRows: fixed,
      assignedHostId: fixed.length === 1 ? (fixed[0].hostAuthUserId as string) : undefined,
    };
  }

  // ── ROUND_ROBIN ──────────────────────────────────────────────────────────
  // The RR pool is every non-fixed host (fixed hosts on an RR type still attend
  // every booking — collective-within-RR — but the MVP RR pool is the non-fixed
  // set; if all hosts are fixed we treat them as the pool).
  const pool = allHosts.filter((h) => h.isFixed !== true);
  const rrPool = pool.length > 0 ? pool : allHosts;

  // Find the hosts actually free for this slot (the candidate set the picker
  // carried as eligibleHostIdxs; we re-derive authoritatively at confirm time).
  const freeCandidates: Array<Record<string, any>> = [];
  for (const host of rrPool) {
    const free = await hostIsFreeForSlot(ctx, {
      host,
      eventType,
      startTime: args.startTime,
      endTime: args.endTime,
      viewerTimeZone: args.viewerTimeZone,
      nowMs: args.nowMs,
      excludeBookingId: args.excludeBookingId,
    });
    if (free) freeCandidates.push(host);
  }
  if (freeCandidates.length === 0) {
    throw new ConvexError({
      kind: "slot_unavailable",
      message: "This slot is no longer available.",
    });
  }

  // Pick the lucky (least-recently-booked, weighted) host. Alternate-host
  // fallback is inherent: the candidate set already excludes hosts booked out
  // between picker-load and confirm, so getLuckyHost selects from the still-free
  // set rather than failing the booking.
  const picked = (await getLuckyHost(ctx, freeCandidates, args.nowMs)) ?? freeCandidates[0];
  return {
    hostRows: [picked],
    assignedHostId: picked.hostAuthUserId as string,
  };
}

// Seed externalEvents[] entries (one per host) as syncStatus:"pending". Phase B
// fills externalEventId + flips to "synced"/"failed". credentialId /
// externalCalendarId resolution from calendarCredentials/selectedCalendars is a
// Phase B/D concern; until then the array carries the host roster so Phase B
// knows which calendars to write. We OMIT the externalEvents array entirely when
// no host has a resolvable credential yet (keeps the row schema-valid:
// externalEvents is optional, and each entry requires a credentialId which we
// can't synthesize). Phase B re-derives entries from the host roster.
function seedExternalEventsHostRoster(
  hostRows: Array<Record<string, any>>,
): string[] {
  return hostRows.map((h) => h.hostAuthUserId as string);
}

// Insert the bookings row + booker/host attendee rows. Shared by create + the
// new-booking half of reschedule. Returns the new bookingId.
async function insertBookingWithAttendees(
  ctx: Ctx,
  args: {
    eventType: Record<string, any>;
    hostRows: Array<Record<string, any>>;
    startTime: number;
    endTime: number;
    bookerTimeZone: string;
    idempotencyKey: string;
    attendee: AttendeeInput;
    rescheduledFromBookingId?: Id<"bookings">;
    assignedHostId?: string;
    emailVerifiedAt?: number;
    intakeResponses?: IntakeResponse[];
    // WAVE-2 PAIR — land as `pending` with the partner-join hold fields.
    status?: "accepted" | "pending";
    partnerToken?: string;
    partnerDeadline?: number;
    nowMs: number;
  },
): Promise<Id<"bookings">> {
  const { eventType, hostRows, attendee, nowMs } = args;
  const hostIds = seedExternalEventsHostRoster(hostRows);
  // The assigned host: an explicit RR/collective-single pick when provided; else the single-host
  // degenerate case (collective with one host); else — SOLO event with NO eventTypeHosts rows — the
  // OWNER is the implicit host. Recording the owner here is REQUIRED for correctness: the
  // double-book + availability checks (holds.ts / availability.ts) query bookings by the
  // `by_assignedHost_startTime` index, so a solo booking with an undefined assignedHost is INVISIBLE
  // to conflict detection (two people could book the same slot). Mirrors the owner-fallback in
  // availableSlots.ts / holds.ts.
  const assignedHostAuthUserId =
    args.assignedHostId ??
    (hostIds.length === 1
      ? hostIds[0]
      : hostIds.length === 0
        ? (eventType.ownerAuthUserId as string)
        : undefined);

  const bookingId: Id<"bookings"> = await ctx.db.insert("bookings", {
    eventTypeId: eventType._id,
    ownerAuthUserId: eventType.ownerAuthUserId,
    assignedHostAuthUserId,
    startTime: args.startTime,
    endTime: args.endTime,
    timeZone: args.bookerTimeZone,
    // accepted unless a WAVE-2 pair hold lands it pending.
    status: args.status ?? "accepted",
    partnerToken: args.partnerToken,
    partnerDeadline: args.partnerDeadline,
    rescheduledFromBookingId: args.rescheduledFromBookingId,
    idempotencyKey: args.idempotencyKey,
    locationText: eventType.locationText,
    bookerNotes: attendee.notes,
    // BOOKING-PAYMENTS §6 — custom intake answers (omitted when none asked).
    intakeResponses:
      args.intakeResponses && args.intakeResponses.length > 0
        ? args.intakeResponses
        : undefined,
    // externalEvents seeded as pending host roster — see note above. We can't
    // populate credentialId (required field) until Phase B resolves calendar
    // creds, so we leave the optional array unset and let Phase B build it.
    createdAt: nowMs,
    updatedAt: nowMs,
  });

  // Booker attendee row. `emailVerifiedAt` is stamped when the E4 verification
  // gate passed for this booking (left unset otherwise).
  await ctx.db.insert("bookingAttendees", {
    bookingId,
    ownerAuthUserId: eventType.ownerAuthUserId,
    name: attendee.name,
    email: attendee.email,
    timeZone: attendee.timeZone,
    role: "booker",
    emailVerifiedAt: args.emailVerifiedAt,
    createdAt: nowMs,
  });

  // One host attendee row per fixed host.
  for (const host of hostRows) {
    await ctx.db.insert("bookingAttendees", {
      bookingId,
      ownerAuthUserId: eventType.ownerAuthUserId,
      name: (host.hostAuthUserId as string) ?? "Host",
      email: "", // host email resolved from their profile in Phase B/D
      timeZone: eventType.timeZone ?? args.bookerTimeZone,
      role: "host",
      createdAt: nowMs,
    });
  }

  return bookingId;
}

// Consume (delete) the caller's hold for this event type + slot, if present.
// Expired/missing hold is tolerated — the conflict re-check is authoritative.
async function consumeHold(
  ctx: Ctx,
  args: { eventTypeId: Id<"eventTypes">; holderToken: string; startTime: number },
): Promise<void> {
  const holds: Array<Record<string, any>> = await ctx.db
    .query("bookingHolds")
    .withIndex("by_holderToken", (q: Ctx) =>
      q.eq("holderToken", args.holderToken),
    )
    .collect();
  const match = holds.find(
    (h) =>
      h.eventTypeId === args.eventTypeId && h.startTime === args.startTime,
  );
  if (match) await ctx.db.delete(match._id);
}

// E3 GROUP capacity. Count the accepted/pending bookings for this exact
// (eventType, startTime) slot. For a group event type (seatsPerSlot > 1) the
// slot is full only when this count reaches capacity. With the existing
// `by_eventType` index this is a collect-then-filter (acceptable at pilot
// scale); a composite `by_eventType_startTime` index is the O(slot) follow-up.
async function countSlotBookings(
  ctx: Ctx,
  eventTypeId: Id<"eventTypes">,
  startTime: number,
  excludeBookingId?: Id<"bookings">,
): Promise<number> {
  const rows: Array<Record<string, any>> = await ctx.db
    .query("bookings")
    .withIndex("by_eventType", (q: Ctx) => q.eq("eventTypeId", eventTypeId))
    .collect();
  return rows.filter(
    (b) =>
      b._id !== excludeBookingId &&
      (b.status === "accepted" || b.status === "pending") &&
      b.startTime === startTime,
  ).length;
}

// E3 GROUP capacity write-time conflict re-check for a NON-round-robin event
// type. seatsPerSlot undefined/<=1 = solo: defer to the existing zero-overlap
// `assertSlotFreeForAllHosts`. seatsPerSlot > 1 = group: the slot may absorb up
// to N bookings — count the accepted/pending bookings for this exact slot and
// reject (slot_unavailable / "full") only when the count has reached capacity.
// The group branch intentionally bypasses the all-hosts zero-overlap assert
// (the host roster attends EVERY booking in a group slot — overlap is expected).
async function assertSlotBookableForGroup(
  ctx: Ctx,
  args: {
    eventType: Record<string, any>;
    startTime: number;
    endTime: number;
    viewerTimeZone: string;
    nowMs: number;
    excludeBookingId?: Id<"bookings">;
  },
): Promise<void> {
  const capacity = args.eventType.seatsPerSlot ?? 1;
  if (capacity <= 1) {
    // SOLO — existing zero-overlap behavior, unchanged.
    await assertSlotFreeForAllHosts(ctx, {
      eventType: args.eventType,
      startTime: args.startTime,
      endTime: args.endTime,
      viewerTimeZone: args.viewerTimeZone,
      nowMs: args.nowMs,
      excludeBookingId: args.excludeBookingId,
    });
    return;
  }
  // GROUP — count-based capacity check for this exact slot.
  const taken = await countSlotBookings(
    ctx,
    args.eventType._id,
    args.startTime,
    args.excludeBookingId,
  );
  if (taken >= capacity) {
    throw new ConvexError({
      kind: "slot_unavailable",
      message: "This slot is full.",
    });
  }
}

// Shared slot-parameter validation (duration / min-notice / booking window).
// Exported for reuse by the lottery enter path (scheduling/lottery.ts) — the
// same duration/notice/window validation applies to a lottery entry's slot.
export function validateSlotParams(
  eventType: Record<string, any>,
  startTime: number,
  endTime: number,
  nowMs: number,
): void {
  if (endTime - startTime !== eventType.durationMinutes * 60_000) {
    throw new ConvexError({
      kind: "invalid_duration",
      message: "Slot duration does not match the event type.",
    });
  }
  if (startTime < nowMs + eventType.minimumBookingNoticeMinutes * 60_000) {
    throw new ConvexError({
      kind: "booking_too_soon",
      message: "This slot is within the minimum booking notice window.",
    });
  }
  if (
    eventType.bookingWindowDays !== undefined &&
    eventType.bookingWindowDays !== null
  ) {
    if (startTime > nowMs + eventType.bookingWindowDays * 86_400_000) {
      throw new ConvexError({
        kind: "outside_booking_window",
        message: "This slot is outside the booking window.",
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────
// createBooking — mutation (public/candidate; flag-gated)
// ─────────────────────────────────────────────────────────────

export interface CreateBookingArgs {
  slug: string;
  startTime: number;
  endTime: number;
  bookerTimeZone: string;
  holderToken: string;
  idempotencyKey: string;
  attendee: AttendeeInput;
  // E4 anti-abuse (optional; enforced only when the event type opts in):
  //   - verificationCode: the 6-digit OTP the booker received by email.
  //     REQUIRED when eventType.requireEmailVerification === true.
  //   - singleUseToken: the host-minted single-use link token. REQUIRED when
  //     eventType.isSingleUse === true; burned on success.
  verificationCode?: string;
  singleUseToken?: string;
  // BOOKING-PAYMENTS §6 — custom intake-form answers (optional; persisted onto
  // the booking row). Carried through the free public path and the paid
  // webhook finalize alike.
  intakeResponses?: IntakeResponse[];
  // BOOKING-LOTTERY §2 — INTERNAL-ONLY bypass for the lottery draw. The public
  // create paths (publicApi/MCP) build args explicitly and never set this, so
  // a client cannot smuggle it in via the request body. When the event type is
  // interactionMode === "lottery", creates WITHOUT this flag are rejected
  // (kind: "lottery_only") — winning the draw is the only path to the slot.
  fromLotteryDraw?: boolean;
  nowMs?: number;
}

export async function createBookingHandler(
  ctx: Ctx,
  args: CreateBookingArgs,
): Promise<{ bookingId: Id<"bookings">; status: string; deduplicated?: boolean }> {
  await gateBooking(ctx);
  const now = args.nowMs ?? Date.now();

  // Step 1 — event type load + active assert.
  const eventType = await ctx.db
    .query("eventTypes")
    .withIndex("by_slug", (q: Ctx) => q.eq("slug", args.slug))
    .unique();
  if (!eventType) {
    throw new ConvexError({
      kind: "event_type_not_found",
      message: "Not found.",
    });
  }
  if (eventType.active === false) {
    throw new ConvexError({
      kind: "event_type_inactive",
      message: "This event type is not accepting bookings.",
    });
  }

  // Step 1a' — BOOKING-LOTTERY §2 / WAVE-2: lottery AND application events
  // cannot be booked directly; the round resolution (random draw or owner
  // pick — scheduling/lottery.ts, internal-only fromLotteryDraw bypass) is
  // the only path to a booking.
  if (
    (eventType.interactionMode === "lottery" ||
      eventType.interactionMode === "application") &&
    args.fromLotteryDraw !== true
  ) {
    throw new ConvexError({
      kind: "lottery_only",
      message:
        "This event uses a drawing — enter it for a time instead of booking directly.",
    });
  }

  // Step 1a'' — WAVE-2 threshold/pair creates gate on the interactions flag
  // (DEFAULT-OFF; 404-dark like every other booking gate).
  const isThreshold = eventType.interactionMode === "threshold";
  const isPair = eventType.interactionMode === "pair";
  if (isThreshold || isPair) {
    const gate = await requireFlagEnabled(ctx, "booking_interactions_enabled", {
      kind: "interactions_disabled",
      message: "This booking mode is not available.",
      defaultValue: false,
    });
    if (!gate.ok) throw new ConvexError({ kind: gate.kind, message: gate.message });
  }

  // Step 1b — E4 email-verification gate. When the event type requires it, the
  // booker must supply a matching, unexpired, unconsumed 6-digit code (minted
  // via POST /book/api/request-code). assertEmailVerified consumes the code on
  // success (single-use) and throws `email_verification_required` on any
  // failure (no oracle: wrong/expired/locked-out/none are indistinguishable).
  let emailVerifiedAt: number | undefined;
  if (eventType.requireEmailVerification === true) {
    await assertEmailVerified(ctx, {
      eventTypeId: String(eventType._id),
      email: args.attendee.email,
      code: args.verificationCode ?? "",
      nowMs: now,
    });
    emailVerifiedAt = now;
  }

  // Step 1c — E4 single-use link gate. When the event type is single-use the
  // booker must present a live (unburned, unexpired) host-minted token. We
  // resolve it here (throws single_use_required / single_use_consumed) and
  // burn it AFTER the booking row is inserted (Step 6b) so a mid-flight throw
  // can't burn a token without producing a booking.
  const singleUseRow = await resolveSingleUseToken(ctx, {
    eventType,
    token: args.singleUseToken,
    nowMs: now,
  });

  // Step 2 — idempotency dedupe (BEFORE any conflict work).
  const existing = await ctx.db
    .query("bookings")
    .withIndex("by_idempotencyKey", (q: Ctx) =>
      q.eq("idempotencyKey", args.idempotencyKey),
    )
    .unique();
  if (existing) {
    return {
      bookingId: existing._id as Id<"bookings">,
      status: existing.status as string,
      deduplicated: true,
    };
  }

  // Step 3 — slot parameter validation.
  validateSlotParams(eventType, args.startTime, args.endTime, now);

  // Step 4 — write-time conflict re-check (the authoritative race guard).
  //   - COLLECTIVE: every fixed host must be free for [start,end). Serializability
  //     makes a concurrent create's just-inserted booking visible → second throws.
  //   - ROUND_ROBIN: at least ONE host must be free; the all-free assert would be
  //     wrong (it requires every host free), so we DON'T call it here — the
  //     RR-aware host resolution below both enforces "≥1 free" and picks the
  //     lucky host (throwing slot_unavailable when none are free).
  //   - GROUP (seatsPerSlot > 1, non-RR): the slot absorbs up to N bookings; we
  //     count the slot's accepted/pending bookings and reject only when full.
  if (eventType.schedulingType !== "round_robin") {
    await assertSlotBookableForGroup(ctx, {
      eventType,
      startTime: args.startTime,
      endTime: args.endTime,
      viewerTimeZone: args.bookerTimeZone,
      nowMs: now,
    });
  }

  // Step 5 — resolve the booking's hosts + the assigned host. For round-robin
  // this runs getLuckyUser over the still-free candidate set (least-recently-
  // booked, weighted, priority tiebreak) and returns the single picked host;
  // for collective it returns the full fixed roster.
  const { hostRows, assignedHostId } = await resolveBookingHosts(ctx, {
    eventType,
    startTime: args.startTime,
    endTime: args.endTime,
    viewerTimeZone: args.bookerTimeZone,
    nowMs: now,
  });

  // Step 6 — insert bookings + bookingAttendees. A WAVE-2 pair booking lands
  // `pending` with a partner-join token + hold deadline (pending already
  // occupies the slot in every conflict check, so the hold is race-safe).
  const pairToken = isPair ? mintPairToken() : undefined;
  const pairDeadline = isPair
    ? Math.min(args.startTime, now + PAIR_HOLD_TTL_MS)
    : undefined;
  const bookingId = await insertBookingWithAttendees(ctx, {
    eventType,
    hostRows,
    startTime: args.startTime,
    endTime: args.endTime,
    bookerTimeZone: args.bookerTimeZone,
    idempotencyKey: args.idempotencyKey,
    attendee: args.attendee,
    assignedHostId,
    emailVerifiedAt,
    intakeResponses: args.intakeResponses,
    status: isPair ? "pending" : "accepted",
    partnerToken: pairToken,
    partnerDeadline: pairDeadline,
    nowMs: now,
  });

  // WAVE-2 THRESHOLD — ensure the slot's round row exists + its resolve is
  // scheduled (lazily, on the first booking of the slot).
  if (isThreshold) {
    await ensureThresholdRound(ctx, eventType, args.startTime, args.endTime, now);
  }

  // Step 6b — E4 burn the single-use token (after the booking row exists). A
  // re-load / re-book via the same link now reads as 410 gone.
  if (singleUseRow) {
    await burnSingleUseToken(ctx, singleUseRow._id, String(bookingId), now);
  }

  // Step 7 — consume the hold (tolerate missing/expired).
  await consumeHold(ctx, {
    eventTypeId: eventType._id,
    holderToken: args.holderToken,
    startTime: args.startTime,
  });

  // Step 7b/8 — reminders + Phase B side effects. A pair hold DEFERS both to
  // the partner join (no confirmation/calendar-sync for a booking that may
  // evaporate); instead it schedules the expiry check + the "forward this
  // link" email.
  if (isPair) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lotteryRef = (internal as any).scheduling?.lottery;
    if (lotteryRef?.expirePairBooking && ctx.scheduler?.runAt && pairDeadline) {
      try {
        await ctx.scheduler.runAt(pairDeadline, lotteryRef.expirePairBooking, {
          bookingId,
        });
      } catch {
        /* hourly sweep is the backstop */
      }
    }
    if (lotteryRef?.sendLotteryEmails && ctx.scheduler?.runAfter) {
      await ctx.scheduler.runAfter(0, lotteryRef.sendLotteryEmails, {
        kind: "pair_held",
        recipients: [
          {
            email: args.attendee.email,
            name: args.attendee.name,
            timeZone: args.attendee.timeZone,
          },
        ],
        eventTitle: eventType.title,
        slotStartMs: args.startTime,
        slotEndMs: args.endTime,
        token: pairToken,
        deadlineMs: pairDeadline,
      });
    }
    return { bookingId, status: "pending" };
  }

  await insertConfirmationReminders(ctx, bookingId, args.startTime, now);

  // Step 8 — schedule Phase B side effects INSIDE the mutation (atomic commit).
  await scheduleBookingSideEffects(ctx, bookingId, "BOOKING_CREATED");

  return { bookingId, status: "accepted" };
}

// INTERNAL only: the public entry point is the F1 httpAction (publicApi.ts), which
// enforces IP rate-limit + Turnstile BEFORE calling this via ctx.runMutation. Exposing
// it as a public `mutation` would let the Convex client bypass those gates (the
// flag/email-verify/single-use/conflict checks below are mutation-level and still hold,
// but rate-limit + captcha live only in the httpAction). E4 security-review fix.
export const createBooking = internalMutation({
  args: {
    slug: v.string(),
    startTime: v.number(),
    endTime: v.number(),
    bookerTimeZone: v.string(),
    holderToken: v.string(),
    idempotencyKey: v.string(),
    attendee: attendeeArg,
    // E4 anti-abuse: enforced only when the event type opts in (see handler).
    verificationCode: v.optional(v.string()),
    singleUseToken: v.optional(v.string()),
    nowMs: v.optional(v.number()),
  },
  handler: createBookingHandler,
});

// ─────────────────────────────────────────────────────────────
// cancelBooking — mutation (token-guarded candidate path; flag-gated)
// ─────────────────────────────────────────────────────────────

export async function cancelBookingHandler(
  ctx: Ctx,
  args: {
    bookingId: Id<"bookings">;
    cancelToken?: string;
    reason?: string;
    nowMs?: number;
  },
): Promise<{ bookingId: Id<"bookings">; status: string }> {
  await gateBooking(ctx);
  const now = args.nowMs ?? Date.now();

  const booking = await ctx.db.get(args.bookingId);
  if (!booking) {
    throw new ConvexError({
      kind: "booking_not_found",
      message: "Not found.",
    });
  }

  // AUTH (deferred): the organizer-auth branch + signed cancelToken verification
  // land with the deploy-auth PRD's verifyCancelToken. A7 threads the token arg
  // and enforces only the status-transition guard; wiring the real verifier in
  // is additive (no schema/signature change).

  if (booking.status !== "accepted" && booking.status !== "pending") {
    throw new ConvexError({
      kind: "cannot_cancel_status",
      message: `Cannot cancel a ${booking.status} booking.`,
      status: booking.status,
    });
  }

  await ctx.db.patch(args.bookingId, {
    status: "cancelled",
    updatedAt: now,
  });

  // D3 — drop the booking's pending (unsent) reminders so a cancelled booking
  // can't fire a stale 24h-before nudge. Already-sent rows are left for the
  // table-hygiene evict.
  await cancelPendingReminders(ctx, args.bookingId);

  // Phase B: release calendar holds, email the candidate, fire webhook.
  await scheduleBookingSideEffects(ctx, args.bookingId, "BOOKING_CANCELLED");

  return { bookingId: args.bookingId, status: "cancelled" };
}

// INTERNAL only (token-guarded public entry = F1 httpAction). See createBooking note.
export const cancelBooking = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    cancelToken: v.optional(v.string()),
    reason: v.optional(v.string()),
    nowMs: v.optional(v.number()),
  },
  handler: cancelBookingHandler,
});

// ─────────────────────────────────────────────────────────────
// rescheduleBooking — mutation (token-guarded candidate path; flag-gated)
// ─────────────────────────────────────────────────────────────

export async function rescheduleBookingHandler(
  ctx: Ctx,
  args: {
    oldBookingId: Id<"bookings">;
    newStartTime: number;
    newEndTime: number;
    newBookerTimeZone: string;
    holderToken: string;
    idempotencyKey: string;
    rescheduleToken?: string;
    attendee: AttendeeInput;
    nowMs?: number;
  },
): Promise<{
  oldBookingId: Id<"bookings">;
  newBookingId: Id<"bookings">;
  status: string;
  deduplicated?: boolean;
}> {
  await gateBooking(ctx);
  const now = args.nowMs ?? Date.now();

  // Step 1 — load old booking.
  const oldBooking = await ctx.db.get(args.oldBookingId);
  if (!oldBooking) {
    throw new ConvexError({
      kind: "booking_not_found",
      message: "Not found.",
    });
  }

  // AUTH (deferred): same as cancel — organizer auth / signed rescheduleToken
  // verification lands with deploy-auth's verifyRescheduleToken.

  // Step 2 — status guard on the old booking.
  if (oldBooking.status !== "accepted" && oldBooking.status !== "pending") {
    throw new ConvexError({
      kind: "cannot_reschedule_status",
      message: `Cannot reschedule a ${oldBooking.status} booking.`,
      status: oldBooking.status,
    });
  }

  // Step 3 — idempotency dedupe on the NEW booking's key.
  const existing = await ctx.db
    .query("bookings")
    .withIndex("by_idempotencyKey", (q: Ctx) =>
      q.eq("idempotencyKey", args.idempotencyKey),
    )
    .unique();
  if (existing) {
    return {
      oldBookingId: args.oldBookingId,
      newBookingId: existing._id as Id<"bookings">,
      status: existing.status as string,
      deduplicated: true,
    };
  }

  // Step 4 — load + validate the event type.
  const eventType = await ctx.db.get(oldBooking.eventTypeId);
  if (!eventType || eventType.active === false) {
    throw new ConvexError({
      kind: "event_type_inactive",
      message: "This event type is not accepting bookings.",
    });
  }

  // Step 4b — BOOKING-LOTTERY §2: reschedule inserts its new booking via
  // insertBookingWithAttendees directly (NOT createBookingHandler), so the
  // lottery_only gate there does not cover this path. Without this guard a
  // drawing winner could self-reschedule onto any other slot of the lottery
  // event, bypassing that slot's drawing entirely (and torpedoing an open
  // lottery on it — the draw would find the slot taken and cancel). On a
  // lottery event every slot is claimed by winning its drawing, never by
  // rescheduling onto it.
  if (
    eventType.interactionMode === "lottery" ||
    eventType.interactionMode === "application"
  ) {
    throw new ConvexError({
      kind: "lottery_only",
      message:
        "This event uses a drawing — enter it for the new time instead of rescheduling onto it.",
    });
  }

  // Step 5 — validate the new slot params.
  validateSlotParams(eventType, args.newStartTime, args.newEndTime, now);

  // Step 7 — mark the old booking rescheduled (terminal) BEFORE the conflict
  // re-check. This is the same ACID transaction, so flipping it first is safe,
  // and it makes the re-check naturally ignore the old booking: the engine
  // availability pipeline (assertSlotFreeForAllHosts step 1) only subtracts
  // `accepted`/`pending` bookings, so a `rescheduled` old booking no longer
  // occupies its old slot — which is exactly what we want when the new slot
  // overlaps the old one (reschedule-in-place). `excludeBookingId` below is a
  // belt-and-suspenders guard for the lower-level checkForConflicts scan.
  await ctx.db.patch(args.oldBookingId, {
    status: "rescheduled",
    updatedAt: now,
  });

  // Step 8 — conflict re-check on the NEW slot, EXCLUDING the (now-rescheduled)
  // old booking so it can never self-conflict for the same host. COLLECTIVE
  // requires every fixed host free; ROUND_ROBIN requires ≥1 free and is enforced
  // by the RR-aware host resolution below (same exclusion).
  if (eventType.schedulingType !== "round_robin") {
    await assertSlotBookableForGroup(ctx, {
      eventType,
      startTime: args.newStartTime,
      endTime: args.newEndTime,
      viewerTimeZone: args.newBookerTimeZone,
      nowMs: now,
      excludeBookingId: args.oldBookingId,
    });
  }

  // Step 8b — resolve the new booking's hosts + assigned host (RR getLuckyUser
  // pick over the still-free candidate set, excluding the old booking).
  const { hostRows, assignedHostId } = await resolveBookingHosts(ctx, {
    eventType,
    startTime: args.newStartTime,
    endTime: args.newEndTime,
    viewerTimeZone: args.newBookerTimeZone,
    nowMs: now,
    excludeBookingId: args.oldBookingId,
  });

  // Step 9 — insert the new booking via the shared create path.
  const newBookingId = await insertBookingWithAttendees(ctx, {
    eventType,
    hostRows,
    startTime: args.newStartTime,
    endTime: args.newEndTime,
    bookerTimeZone: args.newBookerTimeZone,
    idempotencyKey: args.idempotencyKey,
    attendee: args.attendee,
    rescheduledFromBookingId: args.oldBookingId,
    assignedHostId,
    nowMs: now,
  });

  // Step 10 — back-patch the old → new link.
  await ctx.db.patch(args.oldBookingId, {
    rescheduledToBookingId: newBookingId,
  });

  // Step 11 — consume the new slot's hold.
  await consumeHold(ctx, {
    eventTypeId: eventType._id,
    holderToken: args.holderToken,
    startTime: args.newStartTime,
  });

  // Step 11b — D3 reminders: drop the OLD booking's pending reminders and
  // insert fresh ones for the NEW slot (a reschedule replaces the schedule).
  await cancelPendingReminders(ctx, args.oldBookingId);
  await insertConfirmationReminders(ctx, newBookingId, args.newStartTime, now);

  // Step 12 — schedule Phase B for the new booking.
  await scheduleBookingSideEffects(ctx, newBookingId, "BOOKING_RESCHEDULED");

  return {
    oldBookingId: args.oldBookingId,
    newBookingId,
    status: "accepted",
  };
}

// INTERNAL only (token-guarded public entry = F1 httpAction). See createBooking note.
export const rescheduleBooking = internalMutation({
  args: {
    oldBookingId: v.id("bookings"),
    newStartTime: v.number(),
    newEndTime: v.number(),
    newBookerTimeZone: v.string(),
    holderToken: v.string(),
    idempotencyKey: v.string(),
    rescheduleToken: v.optional(v.string()),
    attendee: attendeeArg,
    nowMs: v.optional(v.number()),
  },
  handler: rescheduleBookingHandler,
});

// ─────────────────────────────────────────────────────────────
// WAVE-2 THRESHOLD — round-over-bookings plumbing
// ─────────────────────────────────────────────────────────────

// Lazily create the slot's threshold round on the FIRST booking + schedule its
// resolve at closesAt (same formula as the lottery; the hourly sweep is the
// backstop). Lives here (not lottery.ts) to avoid an import cycle — the
// resolve itself runs in lottery.ts's drawSlotLotteryImpl via its `threshold`
// resolution branch.
async function ensureThresholdRound(
  ctx: Ctx,
  eventType: Record<string, any>,
  slotStart: number,
  slotEnd: number,
  nowMs: number,
): Promise<void> {
  const existing = await ctx.db
    .query("slotLotteries")
    .withIndex("by_eventType_slotStart", (q: Ctx) =>
      q.eq("eventTypeId", eventType._id).eq("slotStart", slotStart),
    )
    .unique();
  if (existing) return;
  const leadMinutes = Math.max(
    (eventType.lotteryCloseLeadMinutes as number | undefined) ?? 24 * 60,
    (eventType.minimumBookingNoticeMinutes as number | undefined) ?? 0,
  );
  const closesAt = slotStart - leadMinutes * 60_000;
  const roundId = await ctx.db.insert("slotLotteries", {
    eventTypeId: eventType._id,
    ownerAuthUserId: eventType.ownerAuthUserId,
    slotStart,
    slotEnd,
    closesAt,
    resolution: "threshold",
    status: "open",
    createdAt: nowMs,
    updatedAt: nowMs,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lotteryRef = (internal as any).scheduling?.lottery;
  if (lotteryRef?.drawSlotLottery && ctx.scheduler?.runAt && closesAt > nowMs) {
    try {
      const scheduledDrawId = await ctx.scheduler.runAt(
        closesAt,
        lotteryRef.drawSlotLottery,
        { lotteryId: roundId },
      );
      await ctx.db.patch(roundId, { scheduledDrawId: String(scheduledDrawId) });
    } catch {
      /* hourly sweep is the backstop */
    }
  }
}

// ─────────────────────────────────────────────────────────────
// WAVE-2 PAIR — join / expire / public DTO
// ─────────────────────────────────────────────────────────────

export interface PairPublicDto {
  status: "pending" | "accepted" | "gone";
  eventTitle: string;
  slotStart: number;
  slotEnd: number;
  bookerName: string;
  deadline: number | null;
}

// PUBLIC-SAFE partner view: the booker's display name is intentionally shown
// (the partner got the link FROM the booker); email is never exposed. Garbage
// or non-pair tokens → null (404).
export async function getPairPublicImpl(
  ctx: Ctx,
  token: string,
): Promise<PairPublicDto | null> {
  if (!token) return null;
  const booking = await ctx.db
    .query("bookings")
    .withIndex("by_partnerToken", (q: Ctx) => q.eq("partnerToken", token))
    .unique();
  if (!booking) return null;
  const eventType = await ctx.db.get(booking.eventTypeId);
  const attendees = await ctx.db
    .query("bookingAttendees")
    .withIndex("by_booking", (q: Ctx) => q.eq("bookingId", booking._id))
    .collect();
  const booker = attendees.find((a: Ctx) => a.role === "booker");
  const status: PairPublicDto["status"] =
    booking.status === "pending"
      ? "pending"
      : booking.status === "accepted"
        ? "accepted"
        : "gone";
  return {
    status,
    eventTitle: (eventType?.title as string) ?? "Session",
    slotStart: booking.startTime,
    slotEnd: booking.endTime,
    bookerName: (booker?.name as string) ?? "Your partner",
    deadline: booking.partnerDeadline ?? null,
  };
}

export interface JoinPairArgs {
  token: string;
  name: string;
  email: string;
  timeZone?: string;
  nowMs?: number;
}

// Partner joins: flip the pending hold to accepted, add the guest attendee,
// and fire the deferred confirmation machinery (reminders + calendar sync +
// notification) for the now-real booking. Idempotent-ish: an already-accepted
// pair booking returns pair_already_joined.
export async function joinPairBookingImpl(
  ctx: Ctx,
  args: JoinPairArgs,
): Promise<{ bookingId: Id<"bookings">; status: string }> {
  await gateBooking(ctx);
  const gate = await requireFlagEnabled(ctx, "booking_interactions_enabled", {
    kind: "interactions_disabled",
    message: "This booking mode is not available.",
    defaultValue: false,
  });
  if (!gate.ok) throw new ConvexError({ kind: gate.kind, message: gate.message });
  const now = args.nowMs ?? Date.now();

  if (!args.name?.trim() || !args.email?.trim()) {
    throw new ConvexError({ kind: "invalid_request", message: "name and email are required." });
  }
  const booking = await ctx.db
    .query("bookings")
    .withIndex("by_partnerToken", (q: Ctx) => q.eq("partnerToken", args.token))
    .unique();
  if (!booking) {
    throw new ConvexError({ kind: "pair_not_found", message: "Not found." });
  }
  if (booking.status === "accepted") {
    throw new ConvexError({
      kind: "pair_already_joined",
      message: "This booking already has its partner.",
    });
  }
  if (booking.status !== "pending") {
    throw new ConvexError({ kind: "pair_gone", message: "This hold has expired." });
  }
  if (booking.partnerDeadline && booking.partnerDeadline <= now) {
    throw new ConvexError({ kind: "pair_gone", message: "This hold has expired." });
  }

  const eventType = await ctx.db.get(booking.eventTypeId);
  await ctx.db.insert("bookingAttendees", {
    bookingId: booking._id,
    ownerAuthUserId: booking.ownerAuthUserId,
    name: args.name.trim(),
    email: args.email.trim().toLowerCase(),
    timeZone: args.timeZone ?? booking.timeZone,
    role: "guest",
    createdAt: now,
  });
  await ctx.db.patch(booking._id, { status: "accepted", updatedAt: now });

  // The deferred create machinery (skipped at pair-create time).
  await insertConfirmationReminders(ctx, booking._id, booking.startTime, now);
  await scheduleBookingSideEffects(ctx, booking._id, "BOOKING_CREATED");

  // Confirmation emails to BOTH (the booker's normal confirmation rides the
  // reminders sweep; this immediate pair_joined note tells them it's locked).
  const attendees = await ctx.db
    .query("bookingAttendees")
    .withIndex("by_booking", (q: Ctx) => q.eq("bookingId", booking._id))
    .collect();
  const booker = attendees.find((a: Ctx) => a.role === "booker");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lotteryRef = (internal as any).scheduling?.lottery;
  if (lotteryRef?.sendLotteryEmails && ctx.scheduler?.runAfter) {
    const recipients = [
      booker
        ? { email: booker.email, name: booker.name, timeZone: booker.timeZone ?? "UTC" }
        : null,
      { email: args.email.trim().toLowerCase(), name: args.name.trim(), timeZone: args.timeZone ?? "UTC" },
    ].filter(Boolean);
    await ctx.scheduler.runAfter(0, lotteryRef.sendLotteryEmails, {
      kind: "pair_joined",
      recipients,
      eventTitle: (eventType?.title as string) ?? "Session",
      slotStartMs: booking.startTime,
      slotEndMs: booking.endTime,
    });
  }

  return { bookingId: booking._id as Id<"bookings">, status: "accepted" };
}

// Expire a still-pending pair hold (scheduled at the deadline; sweep backstop).
// Cancels through cancelBookingHandler so reminders/side effects cascade, then
// emails the booker. No-op for anything not pending-past-deadline.
export async function expirePairBookingImpl(
  ctx: Ctx,
  args: { bookingId: Id<"bookings">; nowMs?: number },
): Promise<{ expired: boolean }> {
  const now = args.nowMs ?? Date.now();
  const booking = await ctx.db.get(args.bookingId);
  if (
    !booking ||
    booking.status !== "pending" ||
    !booking.partnerToken ||
    (booking.partnerDeadline && booking.partnerDeadline > now)
  ) {
    return { expired: false };
  }
  await ctx.db.patch(booking._id, { status: "cancelled", updatedAt: now });
  await cancelPendingReminders(ctx, booking._id);
  const attendees = await ctx.db
    .query("bookingAttendees")
    .withIndex("by_booking", (q: Ctx) => q.eq("bookingId", booking._id))
    .collect();
  const booker = attendees.find((a: Ctx) => a.role === "booker");
  const eventType = await ctx.db.get(booking.eventTypeId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lotteryRef = (internal as any).scheduling?.lottery;
  if (booker && lotteryRef?.sendLotteryEmails && ctx.scheduler?.runAfter) {
    await ctx.scheduler.runAfter(0, lotteryRef.sendLotteryEmails, {
      kind: "pair_expired",
      recipients: [
        { email: booker.email, name: booker.name, timeZone: booker.timeZone ?? "UTC" },
      ],
      eventTitle: (eventType?.title as string) ?? "Session",
      slotStartMs: booking.startTime,
      slotEndMs: booking.endTime,
    });
  }
  return { expired: true };
}

// Hourly sweep backstop for pair holds whose exact-time expiry was missed.
export async function sweepExpiredPairHoldsImpl(
  ctx: Ctx,
  nowMs?: number,
): Promise<{ expired: number }> {
  const now = nowMs ?? Date.now();
  const pending: Array<Record<string, any>> = await ctx.db
    .query("bookings")
    .withIndex("by_status_startTime", (q: Ctx) => q.eq("status", "pending"))
    .take(100);
  let expired = 0;
  for (const b of pending) {
    if (b.partnerToken && b.partnerDeadline && b.partnerDeadline <= now) {
      const r = await expirePairBookingImpl(ctx, {
        bookingId: b._id as Id<"bookings">,
        nowMs: now,
      });
      if (r.expired) expired += 1;
    }
  }
  return { expired };
}

// ─────────────────────────────────────────────────────────────
// Phase B scheduling + STUB internalActions
// ─────────────────────────────────────────────────────────────
//
// The scheduler calls MUST live inside the mutation body (lifecycle spec §2.2)
// so they commit atomically with the booking row. The committed _generated/api
// is stale (codegen operator-gated; this brand-new scheduling.booking module
// isn't materialized on the typed `internal` yet), so the refs go through an
// `as any` hop — the SAME precedent as the crons.ts (internal as any).gmailPush
// / pushWatchdog references. The runtime paths
// internal.scheduling.booking.syncToCalendars / sendNotification are correct and
// a deploy regenerates the types.

// ─────────────────────────────────────────────────────────────
// D3 — reminder rows (inserted atomically in the booking mutation)
// ─────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

// Insert the two confirmation-time reminder rows for a freshly-committed
// booking: an immediate `confirmation` (sendAt = now → dispatched on the next
// hourly sweep tick) and a `reminder_24h` at start − 24h. Both target the
// booker on the email channel; `sentAt` is left unset (the A8 sweep stamps it).
async function insertConfirmationReminders(
  ctx: Ctx,
  bookingId: Id<"bookings">,
  startTime: number,
  now: number,
): Promise<void> {
  await ctx.db.insert("reminders", {
    bookingId,
    kind: "confirmation",
    channel: "email",
    recipient: "booker",
    sendAt: now,
  });
  await ctx.db.insert("reminders", {
    bookingId,
    kind: "reminder_24h",
    channel: "email",
    recipient: "booker",
    sendAt: startTime - DAY_MS,
  });
}

// Delete a booking's PENDING (unsent) reminders. Used on cancel + reschedule so
// a terminal booking can't fire a stale reminder. Already-dispatched rows
// (`sentAt` set) are left for the table-hygiene evict.
async function cancelPendingReminders(
  ctx: Ctx,
  bookingId: Id<"bookings">,
): Promise<void> {
  const rows: Array<Record<string, any>> = await ctx.db
    .query("reminders")
    .withIndex("by_bookingId", (q: Ctx) => q.eq("bookingId", bookingId))
    .collect();
  for (const r of rows) {
    if (r.sentAt === undefined) await ctx.db.delete(r._id);
  }
}

// Map the internal lifecycle enum → the canonical lowercase `booking.*` webhook
// event name (developer-API §; the `{type, created, data}` envelope is built by
// internal.webhooks._emitEvent).
const WEBHOOK_EVENT_BY_LIFECYCLE: Record<string, string> = {
  BOOKING_CREATED: "booking.created",
  BOOKING_CANCELLED: "booking.cancelled",
  BOOKING_RESCHEDULED: "booking.rescheduled",
};

async function scheduleBookingSideEffects(
  ctx: Ctx,
  bookingId: Id<"bookings">,
  event: "BOOKING_CREATED" | "BOOKING_CANCELLED" | "BOOKING_RESCHEDULED",
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = (internal as any).scheduling?.booking;
  if (ref) {
    await ctx.scheduler.runAfter(0, ref.syncToCalendars, { bookingId, event });
    await ctx.scheduler.runAfter(0, ref.sendNotification, { bookingId, event });
  }

  // D4 — webhook fan-out via the developer-API HMAC infra. Scheduled (not
  // called inline) per the webhook research: `_emitEvent` is an
  // internalMutation that must be reached via ctx.scheduler.runAfter so it
  // commits with the booking row. We build a PII-minimal `data` payload
  // (deploy-auth PRD §7) from the booking + booker attendee.
  await emitBookingWebhook(ctx, bookingId, event);
}

// Build the PII-minimal webhook `data` payload and schedule the emit. Reads the
// booking + event type slug + booker attendee. Best-effort: a missing row (e.g.
// a race) simply skips the emit — never throws into the mutation body.
async function emitBookingWebhook(
  ctx: Ctx,
  bookingId: Id<"bookings">,
  event: "BOOKING_CREATED" | "BOOKING_CANCELLED" | "BOOKING_RESCHEDULED",
): Promise<void> {
  const webhookEvent = WEBHOOK_EVENT_BY_LIFECYCLE[event];
  if (!webhookEvent) return;
  const booking = await ctx.db.get(bookingId);
  if (!booking) return;

  const eventType = await ctx.db.get(booking.eventTypeId);
  // Resolve the cal int event-type id so PER-EVENT-TYPE webhook endpoints (the cal
  // Webhooks tab, scoped via eventTypeCalId) fire only for THIS event type;
  // unscoped endpoints (the developer-API dashboard) fire for every booking.
  const calMap = await ctx.db
    .query("eventTypeIdMap")
    .withIndex("by_convexId", (q: Ctx) => q.eq("convexId", booking.eventTypeId))
    .unique();
  const eventTypeCalId = calMap?.calId as number | undefined;
  const attendeeRows: Array<Record<string, any>> = await ctx.db
    .query("bookingAttendees")
    .withIndex("by_booking", (q: Ctx) => q.eq("bookingId", bookingId))
    .collect();
  const attendees = attendeeRows
    .filter((a) => a.role === "booker")
    .map((a) => ({ email: a.email as string, name: a.name as string }));

  const data = {
    bookingId,
    eventTypeSlug: (eventType?.slug as string) ?? null,
    start: booking.startTime,
    end: booking.endTime,
    attendees,
  };

  await ctx.scheduler.runAfter(0, internal.webhooks._emitEvent, {
    authUserId: booking.ownerAuthUserId,
    event: webhookEvent,
    data,
    eventTypeCalId,
  });
}

// B4 — REAL calendar sync. The per-host CalendarService create/delete loop (with
// syncStatus tracking + backoff retry + organizer notice) lives in
// `scheduling/sync.ts`; this registration keeps the
// `internal.scheduling.booking.syncToCalendars` ref that `scheduleBookingSideEffects`
// resolves stable (the scheduler call inside the mutation body is unchanged) while
// delegating the body to the real handler. The booking row is the source of truth
// and is NEVER rolled back by this action under any host's calendar failure.
export const syncToCalendars = internalAction({
  args: {
    bookingId: v.id("bookings"),
    event: v.string(),
  },
  handler: syncToCalendarsHandler,
});

// SCHEDULING D1 — REAL notification dispatch (Brevo email + .ics / Twilio SMS /
// in-app, channel-pluggable, each external channel gated on its env key). The
// body lives in `scheduling/notify.ts`; this registration keeps the
// `internal.scheduling.booking.sendNotification` ref that
// `scheduleBookingSideEffects` resolves stable (the scheduler call inside the
// mutation body is unchanged) while delegating to the real handler. Webhook
// `booking.*` emission is scheduled separately in `scheduleBookingSideEffects`
// (via internal.webhooks._emitEvent) so a webhook failure can't block the
// candidate-facing email/in-app dispatch and vice-versa.
export const sendNotification = internalAction({
  args: {
    bookingId: v.id("bookings"),
    event: v.string(),
    channel: v.optional(
      v.union(v.literal("email"), v.literal("sms"), v.literal("in_app")),
    ),
  },
  handler: sendNotificationHandler,
});
