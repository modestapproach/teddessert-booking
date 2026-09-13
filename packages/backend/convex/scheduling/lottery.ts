// BOOKING-LOTTERY (L2–L3) — per-slot drawings for "???" lottery event types.
//
// docs/booking-lottery-prd.md. An owner flips an event type to
// `interactionMode: "lottery"`; bookers then ENTER a drawing for the specific
// slot they want instead of booking it. The first entry for a slot lazily
// creates the `slotLotteries` row (closesAt = slotStart − max(lead, notice))
// and schedules an exact-time draw via ctx.scheduler.runAt; the hourly
// `booking-lottery-sweep` cron is the backstop. The draw picks a uniform
// random winner and creates the REAL booking through the same
// `createBookingHandler` as the normal path (conflict re-check, idempotency
// `lottery:{id}`, reminders, calendar sync, confirmation email all included).
// Direct booking on lottery event types is rejected (kind: "lottery_only") —
// winning is the only path to the slot.
//
// Flag-dark: `booking_lottery_enabled` DEFAULT-OFF (plus the suite-wide
// `booking_enabled`). While off, enter/status routes 404 and due draws DEFER
// (stay open, no booking is created) rather than cancel — flipping the flag
// back on lets the sweep finish them.
//
// TESTABILITY: repo convention — `*Impl` plain async cores tested against
// convex-test's real ctx; thin internalMutation/internalQuery wrappers; the
// httpAction glue lives in publicApi.ts (one-directional imports:
// publicApi → lottery → booking, no cycle).

import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { isFlagEnabled, requireFlagEnabled } from "../_helpers/featureFlag";
import { log } from "../_helpers/log";
import {
  createBookingHandler,
  validateSlotParams,
  cancelBookingHandler,
  joinPairBookingImpl,
  expirePairBookingImpl,
  sweepExpiredPairHoldsImpl,
  getPairPublicImpl,
} from "./booking";
import { getCalcomUserByAuthUserIdImpl } from "./calcomUsers";
import { sendBrevoEmail } from "./notify";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

export const DEFAULT_CLOSE_LEAD_MINUTES = 24 * 60; // entries close 24h before the slot

// ─── Flag plumbing ────────────────────────────────────────────────────────────

export const _bookingLotteryEnabled = internalQuery({
  args: {},
  handler: async (ctx) => isFlagEnabled(ctx, "booking_lottery_enabled", false),
});

// Operator toggle (DEFAULT-OFF). CLI:
// `npx convex run scheduling/lottery:_setBookingLotteryEnabled '{"value":true}'`
export const _setBookingLotteryEnabled = internalMutation({
  args: { value: v.boolean() },
  handler: async (ctx, { value }) => {
    const existing = await ctx.db
      .query("featureFlags")
      .withIndex("by_key", (q: Ctx) => q.eq("key", "booking_lottery_enabled"))
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        value,
        updatedAt: now,
        updatedBy: "cli",
        reason: "booking lottery toggle",
      });
    } else {
      await ctx.db.insert("featureFlags", {
        key: "booking_lottery_enabled",
        value,
        updatedAt: now,
        updatedBy: "cli",
        reason: "booking lottery toggle",
      });
    }
    return { key: "booking_lottery_enabled", value };
  },
});

export const _bookingInteractionsEnabled = internalQuery({
  args: {},
  handler: async (ctx) => isFlagEnabled(ctx, "booking_interactions_enabled", false),
});

// Operator toggle (DEFAULT-OFF). CLI:
// `npx convex run scheduling/lottery:_setBookingInteractionsEnabled '{"value":true}'`
export const _setBookingInteractionsEnabled = internalMutation({
  args: { value: v.boolean() },
  handler: async (ctx, { value }) => {
    const existing = await ctx.db
      .query("featureFlags")
      .withIndex("by_key", (q: Ctx) => q.eq("key", "booking_interactions_enabled"))
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        value,
        updatedAt: now,
        updatedBy: "cli",
        reason: "booking interactions toggle",
      });
    } else {
      await ctx.db.insert("featureFlags", {
        key: "booking_interactions_enabled",
        value,
        updatedAt: now,
        updatedBy: "cli",
        reason: "booking interactions toggle",
      });
    }
    return { key: "booking_interactions_enabled", value };
  },
});

async function gateInteractions(ctx: Ctx): Promise<void> {
  const booking = await requireFlagEnabled(ctx, "booking_enabled", {
    kind: "booking_disabled",
    message: "Booking is not available.",
    defaultValue: false,
  });
  if (!booking.ok)
    throw new ConvexError({ kind: booking.kind, message: booking.message });
  const inter = await requireFlagEnabled(ctx, "booking_interactions_enabled", {
    kind: "interactions_disabled",
    message: "This booking mode is not available.",
    defaultValue: false,
  });
  if (!inter.ok)
    throw new ConvexError({ kind: inter.kind, message: inter.message });
}

async function gateLottery(ctx: Ctx): Promise<void> {
  const booking = await requireFlagEnabled(ctx, "booking_enabled", {
    kind: "booking_disabled",
    message: "Booking is not available.",
    defaultValue: false,
  });
  if (!booking.ok)
    throw new ConvexError({ kind: booking.kind, message: booking.message });
  const lottery = await requireFlagEnabled(ctx, "booking_lottery_enabled", {
    kind: "lottery_disabled",
    message: "Lotteries are not available.",
    defaultValue: false,
  });
  if (!lottery.ok)
    throw new ConvexError({ kind: lottery.kind, message: lottery.message });
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

export interface IntakeResponse {
  name: string;
  label: string;
  value: string;
}

const intakeValidator = v.array(
  v.object({ name: v.string(), label: v.string(), value: v.string() }),
);

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// closesAt = slotStart − max(lead, minimumBookingNoticeMinutes). Taking the max
// guarantees the draw-time booking can never fail validateSlotParams'
// booking_too_soon check (slotStart − closesAt ≥ notice by construction).
export function computeClosesAt(
  eventType: { lotteryCloseLeadMinutes?: number; minimumBookingNoticeMinutes: number },
  slotStart: number,
): number {
  const leadMinutes = Math.max(
    eventType.lotteryCloseLeadMinutes ?? DEFAULT_CLOSE_LEAD_MINUTES,
    eventType.minimumBookingNoticeMinutes ?? 0,
  );
  return slotStart - leadMinutes * 60_000;
}

// Codegen-pending self-ref (same `(internal as any).scheduling?.X` precedent as
// booking.ts / publicApi.ts). Guarded at every use: in convex-test the
// scheduling namespace isn't materialized, so scheduling/email side effects are
// skipped and tests drive the Impl functions directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function selfRef(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (internal as any).scheduling?.lottery;
}

// ─── L2: enter a slot's lottery ───────────────────────────────────────────────

export interface EnterLotteryArgs {
  slug: string;
  start: number;
  end: number;
  name: string;
  email: string;
  timeZone?: string;
  notes?: string;
  intakeResponses?: IntakeResponse[];
  nowMs?: number;
}

export interface EnterLotteryResult {
  lotteryId: Id<"slotLotteries">;
  closesAt: number;
  entrantCount: number;
  alreadyEntered: boolean;
}

export async function enterSlotLotteryImpl(
  ctx: Ctx,
  args: EnterLotteryArgs,
): Promise<EnterLotteryResult> {
  const now = args.nowMs ?? Date.now();

  if (!args.slug || !args.name || !args.email) {
    throw new ConvexError({
      kind: "invalid_request",
      message: "slug, name and email are required.",
    });
  }
  if (typeof args.start !== "number" || typeof args.end !== "number") {
    throw new ConvexError({
      kind: "invalid_request",
      message: "start and end (epoch-ms) are required.",
    });
  }

  const eventType = await ctx.db
    .query("eventTypes")
    .withIndex("by_slug", (q: Ctx) => q.eq("slug", args.slug))
    .unique();
  if (!eventType || eventType.active === false) {
    throw new ConvexError({ kind: "event_type_not_found", message: "Not found." });
  }
  // WAVE-2: APPLICATION shares the entry machinery (resolution owner_pick);
  // every other mode rejects. Gate per mode AFTER resolving it.
  const mode = eventType.interactionMode;
  if (mode !== "lottery" && mode !== "application") {
    throw new ConvexError({
      kind: "not_a_lottery_event",
      message: "This event type does not use a drawing.",
    });
  }
  if (mode === "lottery") {
    await gateLottery(ctx);
  } else {
    await gateInteractions(ctx);
  }

  // Same duration / notice / window validation as a direct booking.
  validateSlotParams(eventType, args.start, args.end, now);

  // Find-or-create the slot's lottery.
  let lottery = await ctx.db
    .query("slotLotteries")
    .withIndex("by_eventType_slotStart", (q: Ctx) =>
      q.eq("eventTypeId", eventType._id).eq("slotStart", args.start),
    )
    .unique();

  if (lottery) {
    if (lottery.status !== "open" || lottery.closesAt <= now) {
      throw new ConvexError({
        kind: "lottery_closed",
        message: "Entries for this time have closed.",
      });
    }
  } else {
    const closesAt = computeClosesAt(eventType, args.start);
    if (closesAt <= now) {
      throw new ConvexError({
        kind: "lottery_closed",
        message: "It is too late to start a drawing for this time.",
      });
    }
    const lotteryId = await ctx.db.insert("slotLotteries", {
      eventTypeId: eventType._id,
      ownerAuthUserId: eventType.ownerAuthUserId,
      slotStart: args.start,
      slotEnd: args.end,
      closesAt,
      resolution: mode === "application" ? "owner_pick" : "random",
      status: "open",
      createdAt: now,
      updatedAt: now,
    });
    // Exact-time draw. Guarded: ref/scheduler may be absent pre-codegen / in
    // tests — the hourly sweep is the durable backstop either way.
    const ref = selfRef();
    if (ref?.drawSlotLottery && ctx.scheduler?.runAt) {
      try {
        const scheduledDrawId = await ctx.scheduler.runAt(
          closesAt,
          ref.drawSlotLottery,
          { lotteryId },
        );
        await ctx.db.patch(lotteryId, {
          scheduledDrawId: String(scheduledDrawId),
        });
      } catch (err) {
        log.warn("booking.lottery.schedule_draw_failed", {
          lotteryId: String(lotteryId),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    lottery = await ctx.db.get(lotteryId);
  }

  const email = normalizeEmail(args.email);
  const existing = await ctx.db
    .query("slotLotteryEntries")
    .withIndex("by_lottery_email", (q: Ctx) =>
      q.eq("lotteryId", lottery._id).eq("email", email),
    )
    .unique();
  const entries = await ctx.db
    .query("slotLotteryEntries")
    .withIndex("by_lottery", (q: Ctx) => q.eq("lotteryId", lottery._id))
    .collect();
  if (existing) {
    return {
      lotteryId: lottery._id as Id<"slotLotteries">,
      closesAt: lottery.closesAt as number,
      entrantCount: entries.length,
      alreadyEntered: true,
    };
  }

  await ctx.db.insert("slotLotteryEntries", {
    lotteryId: lottery._id,
    ownerAuthUserId: eventType.ownerAuthUserId,
    name: args.name,
    email,
    timeZone: args.timeZone ?? "UTC",
    notes: args.notes,
    intakeResponses:
      args.intakeResponses && args.intakeResponses.length > 0
        ? args.intakeResponses
        : undefined,
    createdAt: now,
  });

  // "You're in" email (commit-atomic schedule; skipped when refs absent).
  const ref = selfRef();
  if (ref?.sendLotteryEmails && ctx.scheduler?.runAfter) {
    await ctx.scheduler.runAfter(0, ref.sendLotteryEmails, {
      kind: mode === "application" ? "application_received" : "entered",
      recipients: [{ email, name: args.name, timeZone: args.timeZone ?? "UTC" }],
      eventTitle: eventType.title,
      slotStartMs: args.start,
      slotEndMs: args.end,
      closesAtMs: lottery.closesAt,
      lotteryId: String(lottery._id),
    });
  }

  return {
    lotteryId: lottery._id as Id<"slotLotteries">,
    closesAt: lottery.closesAt as number,
    entrantCount: entries.length + 1,
    alreadyEntered: false,
  };
}

const enterArgsValidator = {
  slug: v.string(),
  start: v.number(),
  end: v.number(),
  name: v.string(),
  email: v.string(),
  timeZone: v.optional(v.string()),
  notes: v.optional(v.string()),
  intakeResponses: v.optional(intakeValidator),
};

export const _enterSlotLottery = internalMutation({
  args: enterArgsValidator,
  handler: async (ctx, args) => enterSlotLotteryImpl(ctx, args),
});

// PUBLIC, no-auth enter — the CV-3 trusted-fork pattern (mirrors
// scheduling/publicApi:createBookingPublic): the cal fork's server route calls
// this server-to-server via getConvex().mutation(...). The double flag gate +
// per-email dedupe live inside enterSlotLotteryImpl, so this is safe even if
// hit by a raw client; IP rate-limiting lives in the parallel httpAction
// (/book/api/lottery/enter), and the fork route does its own upstream limits.
export const enterSlotLotteryPublic = mutation({
  args: enterArgsValidator,
  handler: async (ctx, args) => enterSlotLotteryImpl(ctx, args),
});

// ─── L2: public countdown DTO ─────────────────────────────────────────────────

export interface PublicSlotLotteryDto {
  lotteryId: string;
  eventSlug: string;
  eventTitle: string;
  durationMinutes: number;
  slotStart: number;
  slotEnd: number;
  closesAt: number;
  status: string;
  entrantCount: number;
  drawnAt: number | null;
  /** WAVE-2 — how this round resolves; drives the countdown page copy. */
  resolution: "random" | "owner_pick" | "threshold";
  /** Threshold rounds only: the minimum needed to confirm. */
  minAttendees: number | null;
}

// PUBLIC-SAFE: never exposes entrant names/emails or the winner's identity —
// only the drawing's shape + count. Null for a missing/garbage id (→ 404).
export async function getSlotLotteryPublicImpl(
  ctx: Ctx,
  lotteryId: string,
): Promise<PublicSlotLotteryDto | null> {
  let lottery: Record<string, any> | null = null;
  try {
    lottery = await ctx.db.get(lotteryId as Id<"slotLotteries">);
  } catch {
    return null; // malformed id
  }
  if (!lottery) return null;
  const eventType = await ctx.db.get(lottery.eventTypeId);
  if (!eventType) return null;
  const resolution: "random" | "owner_pick" | "threshold" =
    lottery.resolution ?? "random";
  let entrantCount: number;
  if (resolution === "threshold") {
    // Threshold rounds track REAL bookings on the slot, not entries.
    const all: Array<Record<string, any>> = await ctx.db
      .query("bookings")
      .withIndex("by_eventType", (q: Ctx) => q.eq("eventTypeId", lottery.eventTypeId))
      .collect();
    entrantCount = all.filter(
      (b) => b.startTime === lottery.slotStart && b.status === "accepted",
    ).length;
  } else {
    const entries = await ctx.db
      .query("slotLotteryEntries")
      .withIndex("by_lottery", (q: Ctx) => q.eq("lotteryId", lottery._id))
      .collect();
    entrantCount = entries.length;
  }
  return {
    lotteryId: String(lottery._id),
    eventSlug: eventType.slug,
    eventTitle: eventType.title,
    durationMinutes: eventType.durationMinutes,
    slotStart: lottery.slotStart,
    slotEnd: lottery.slotEnd,
    closesAt: lottery.closesAt,
    status: lottery.status,
    entrantCount,
    drawnAt: lottery.drawnAt ?? null,
    resolution,
    minAttendees:
      resolution === "threshold"
        ? ((eventType.thresholdMinAttendees as number | undefined) ?? null)
        : null,
  };
}

export const _publicSlotLottery = internalQuery({
  args: { lotteryId: v.string() },
  handler: async (ctx, { lotteryId }) => getSlotLotteryPublicImpl(ctx, lotteryId),
});

// PUBLIC, no-auth countdown read for the fork's /lottery/[id] page (browser
// ConvexHttpClient → reactive countdown without proxying through the fork
// server). DTO is public-safe by construction (no entrant identities); while
// either flag is dark this returns null (the page 404s) — same
// don't-reveal-the-surface behavior as the httpAction.
export const publicSlotLottery = query({
  args: { lotteryId: v.string() },
  handler: async (ctx, { lotteryId }) => {
    const bookingOn = await isFlagEnabled(ctx, "booking_enabled", false);
    const lotteryOn = await isFlagEnabled(ctx, "booking_lottery_enabled", false);
    const interactionsOn = await isFlagEnabled(
      ctx,
      "booking_interactions_enabled",
      false,
    );
    if (!bookingOn || (!lotteryOn && !interactionsOn)) return null;
    return getSlotLotteryPublicImpl(ctx, lotteryId);
  },
});

// ─── L3: the draw ─────────────────────────────────────────────────────────────

export type DrawOutcome =
  | "not_found"
  | "noop" // already drawn/cancelled/expired (idempotent redelivery)
  | "too_early" // closesAt is still in the future (manual misfire guard)
  | "deferred" // flags are off — leave open; sweep retries when re-enabled
  | "expired" // no entries
  | "cancelled" // winner's booking could not be created (slot unfulfillable)
  | "awaiting_pick" // WAVE-2 application: owner pick links emailed
  | "drawn";

export interface DrawResult {
  outcome: DrawOutcome;
  bookingId?: Id<"bookings">;
  winnerEntryId?: Id<"slotLotteryEntries">;
  reason?: string;
}

// WAVE-2 THRESHOLD resolve — count the slot's REAL accepted bookings; at or
// above the minimum the session is confirmed (everyone emailed), otherwise
// every booking is cancelled (cancelBookingHandler cascades reminders/sync)
// and everyone gets the didn't-happen email.
async function resolveThresholdRound(
  ctx: Ctx,
  lottery: Record<string, any>,
  eventType: Record<string, any> | null,
  now: number,
): Promise<DrawResult> {
  const all: Array<Record<string, any>> = await ctx.db
    .query("bookings")
    .withIndex("by_eventType", (q: Ctx) => q.eq("eventTypeId", lottery.eventTypeId))
    .collect();
  const slotBookings = all.filter(
    (b) => b.startTime === lottery.slotStart && b.status === "accepted",
  );
  const recipients: Array<{ email: string; name: string; timeZone: string }> = [];
  for (const b of slotBookings) {
    const attendees = await ctx.db
      .query("bookingAttendees")
      .withIndex("by_booking", (q: Ctx) => q.eq("bookingId", b._id))
      .collect();
    const booker = attendees.find((a: Ctx) => a.role === "booker");
    if (booker) {
      recipients.push({
        email: booker.email,
        name: booker.name,
        timeZone: booker.timeZone ?? "UTC",
      });
    }
  }
  const minNeeded = (eventType?.thresholdMinAttendees as number | undefined) ?? 2;
  const ref = selfRef();
  const emailMeta = {
    eventTitle: (eventType?.title as string) ?? "Session",
    slotStartMs: lottery.slotStart as number,
    slotEndMs: lottery.slotEnd as number,
    lotteryId: String(lottery._id),
  };

  if (slotBookings.length === 0) {
    await ctx.db.patch(lottery._id, { status: "expired", updatedAt: now });
    return { outcome: "expired" };
  }

  if (slotBookings.length >= minNeeded) {
    await ctx.db.patch(lottery._id, {
      status: "drawn",
      entrantCountAtDraw: slotBookings.length,
      drawnAt: now,
      updatedAt: now,
    });
    if (ref?.sendLotteryEmails && ctx.scheduler?.runAfter && recipients.length) {
      await ctx.scheduler.runAfter(0, ref.sendLotteryEmails, {
        kind: "threshold_confirmed",
        recipients,
        ...emailMeta,
      });
    }
    return { outcome: "drawn" };
  }

  // Below minimum — cancel every booking, then the round.
  for (const b of slotBookings) {
    try {
      await cancelBookingHandler(ctx, {
        bookingId: b._id as Id<"bookings">,
        reason: "Minimum group size not reached",
        nowMs: now,
      });
    } catch (err) {
      log.warn("booking.threshold.cancel_failed", {
        bookingId: String(b._id),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await ctx.db.patch(lottery._id, {
    status: "cancelled",
    entrantCountAtDraw: slotBookings.length,
    updatedAt: now,
  });
  if (ref?.sendLotteryEmails && ctx.scheduler?.runAfter && recipients.length) {
    await ctx.scheduler.runAfter(0, ref.sendLotteryEmails, {
      kind: "threshold_cancelled",
      recipients,
      ...emailMeta,
    });
  }
  return { outcome: "cancelled", reason: "below_threshold" };
}

export async function drawSlotLotteryImpl(
  ctx: Ctx,
  args: { lotteryId: Id<"slotLotteries">; nowMs?: number },
): Promise<DrawResult> {
  const now = args.nowMs ?? Date.now();
  const lottery = await ctx.db.get(args.lotteryId);
  if (!lottery) return { outcome: "not_found" };
  if (lottery.status !== "open") return { outcome: "noop" };
  if (lottery.closesAt > now) return { outcome: "too_early" };

  // Flags off → DEFER (leave open, no booking, no cancellation). Flipping the
  // flags back on lets the sweep finish the drawing; while dark nothing fires.
  // Resolution decides WHICH mode flag applies (wave-2 rounds use the
  // interactions flag; classic lotteries the lottery flag).
  const resolution: "random" | "owner_pick" | "threshold" =
    lottery.resolution ?? "random";
  const bookingOn = await isFlagEnabled(ctx, "booking_enabled", false);
  const modeOn =
    resolution === "random"
      ? await isFlagEnabled(ctx, "booking_lottery_enabled", false)
      : await isFlagEnabled(ctx, "booking_interactions_enabled", false);
  if (!bookingOn || !modeOn) return { outcome: "deferred" };

  const eventType = await ctx.db.get(lottery.eventTypeId);

  // ── WAVE-2 THRESHOLD: the round tracks REAL bookings, not entries ─────────
  if (resolution === "threshold") {
    return resolveThresholdRound(ctx, lottery, eventType, now);
  }

  const entries = await ctx.db
    .query("slotLotteryEntries")
    .withIndex("by_lottery", (q: Ctx) => q.eq("lotteryId", lottery._id))
    .collect();

  if (entries.length === 0) {
    await ctx.db.patch(lottery._id, { status: "expired", updatedAt: now });
    return { outcome: "expired" };
  }

  const recipients = entries.map((e: Ctx) => ({
    email: e.email as string,
    name: e.name as string,
    timeZone: (e.timeZone as string) ?? "UTC",
  }));
  const ref = selfRef();
  const emailMeta = {
    eventTitle: (eventType?.title as string) ?? "Session",
    slotStartMs: lottery.slotStart as number,
    slotEndMs: lottery.slotEnd as number,
    lotteryId: String(lottery._id),
  };

  // Cancel path helper — slot unfulfillable: mark + apologize to everyone.
  const cancel = async (reason: string): Promise<DrawResult> => {
    await ctx.db.patch(lottery._id, { status: "cancelled", updatedAt: now });
    if (ref?.sendLotteryEmails && ctx.scheduler?.runAfter) {
      await ctx.scheduler.runAfter(0, ref.sendLotteryEmails, {
        kind: "cancelled",
        recipients,
        ...emailMeta,
      });
    }
    return { outcome: "cancelled", reason };
  };

  if (!eventType || eventType.active === false) {
    return cancel("event_type_gone");
  }

  // ── WAVE-2 APPLICATION: freeze entries + email the owner pick links ───────
  if (resolution === "owner_pick") {
    const pickToken = `pick-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2)}${Math.random().toString(36).slice(2)}`;
    await ctx.db.patch(lottery._id, {
      status: "awaiting_pick",
      pickToken,
      entrantCountAtDraw: entries.length,
      updatedAt: now,
    });
    const owner = await getCalcomUserByAuthUserIdImpl(
      ctx,
      lottery.ownerAuthUserId as string,
    );
    const ownerEmail = (owner as { email?: string } | null)?.email;
    if (ownerEmail && ref?.sendLotteryEmails && ctx.scheduler?.runAfter) {
      await ctx.scheduler.runAfter(0, ref.sendLotteryEmails, {
        kind: "application_owner_pick",
        recipients: [
          { email: ownerEmail, name: (owner as { name?: string })?.name ?? "Host", timeZone: "UTC" },
        ],
        ...emailMeta,
        applicants: entries.map((e: Ctx) => ({
          entryId: String(e._id),
          name: e.name as string,
          summary: ((e.intakeResponses ?? []) as Array<{ label: string; value: string }>)
            .map((r) => `${r.label}: ${r.value}`)
            .join(" · ")
            .slice(0, 500),
        })),
        pickToken,
      });
    } else if (!ownerEmail) {
      log.warn("booking.application.owner_email_missing", {
        lotteryId: String(lottery._id),
        owner: String(lottery.ownerAuthUserId),
      });
    }
    return { outcome: "awaiting_pick" };
  }

  // Uniform random winner. Convex mutations provide deterministic-replay-safe
  // Math.random; the picked index + entrant count are persisted for audit.
  const winnerIndex = Math.floor(Math.random() * entries.length);
  const winner = entries[winnerIndex];

  let booked: { bookingId: Id<"bookings"> };
  try {
    booked = await createBookingHandler(ctx, {
      slug: eventType.slug,
      startTime: lottery.slotStart,
      endTime: lottery.slotEnd,
      bookerTimeZone: winner.timeZone ?? "UTC",
      holderToken: "",
      // Deterministic per lottery → a re-run draw dedupes to the same booking.
      idempotencyKey: `lottery:${lottery._id}`,
      attendee: {
        name: winner.name,
        email: winner.email,
        timeZone: winner.timeZone ?? "UTC",
        notes: winner.notes,
      },
      intakeResponses: winner.intakeResponses,
      fromLotteryDraw: true,
      nowMs: now,
    });
  } catch (err) {
    const kind =
      err instanceof ConvexError
        ? ((err.data as { kind?: string })?.kind ?? "create_failed")
        : "create_failed";
    return cancel(kind);
  }

  await ctx.db.patch(lottery._id, {
    status: "drawn",
    winnerEntryId: winner._id,
    bookingId: booked.bookingId,
    winnerIndex,
    entrantCountAtDraw: entries.length,
    drawnAt: now,
    updatedAt: now,
  });

  if (ref?.sendLotteryEmails && ctx.scheduler?.runAfter) {
    const winnerEmail = winner.email as string;
    await ctx.scheduler.runAfter(0, ref.sendLotteryEmails, {
      kind: "won",
      recipients: recipients.filter((r: Ctx) => r.email === winnerEmail),
      ...emailMeta,
    });
    const losers = recipients.filter((r: Ctx) => r.email !== winnerEmail);
    if (losers.length > 0) {
      await ctx.scheduler.runAfter(0, ref.sendLotteryEmails, {
        kind: "lost",
        recipients: losers,
        ...emailMeta,
      });
    }
  }

  return {
    outcome: "drawn",
    bookingId: booked.bookingId,
    winnerEntryId: winner._id as Id<"slotLotteryEntries">,
  };
}

export const drawSlotLottery = internalMutation({
  args: { lotteryId: v.id("slotLotteries") },
  handler: async (ctx, { lotteryId }) => drawSlotLotteryImpl(ctx, { lotteryId }),
});

// ─── WAVE-2 APPLICATION: the owner's pick ─────────────────────────────────────

export interface PickResult {
  outcome: "picked" | "not_found" | "bad_token" | "not_awaiting" | "cancelled";
  bookingId?: Id<"bookings">;
  winnerName?: string;
  reason?: string;
}

// Resolve an awaiting_pick application round: the owner clicked a signed
// one-click link from the close email. Books the winner through the REAL
// createBookingHandler (fromLotteryDraw bypass), declines everyone else, burns
// the token. Slot-unfulfillable at pick time → round cancelled + apologies.
export async function pickApplicationWinnerImpl(
  ctx: Ctx,
  args: {
    lotteryId: Id<"slotLotteries">;
    entryId: Id<"slotLotteryEntries">;
    token: string;
    nowMs?: number;
  },
): Promise<PickResult> {
  const now = args.nowMs ?? Date.now();
  const lottery = await ctx.db.get(args.lotteryId);
  if (!lottery) return { outcome: "not_found" };
  if (lottery.status !== "awaiting_pick") return { outcome: "not_awaiting" };
  if (!args.token || lottery.pickToken !== args.token) {
    return { outcome: "bad_token" };
  }
  const winner = await ctx.db.get(args.entryId);
  if (!winner || String(winner.lotteryId) !== String(lottery._id)) {
    return { outcome: "not_found" };
  }
  const eventType = await ctx.db.get(lottery.eventTypeId);
  const entries = await ctx.db
    .query("slotLotteryEntries")
    .withIndex("by_lottery", (q: Ctx) => q.eq("lotteryId", lottery._id))
    .collect();
  const recipients = entries.map((e: Ctx) => ({
    email: e.email as string,
    name: e.name as string,
    timeZone: (e.timeZone as string) ?? "UTC",
  }));
  const ref = selfRef();
  const emailMeta = {
    eventTitle: (eventType?.title as string) ?? "Session",
    slotStartMs: lottery.slotStart as number,
    slotEndMs: lottery.slotEnd as number,
    lotteryId: String(lottery._id),
  };

  let booked: { bookingId: Id<"bookings"> };
  try {
    booked = await createBookingHandler(ctx, {
      slug: (eventType?.slug as string) ?? "",
      startTime: lottery.slotStart,
      endTime: lottery.slotEnd,
      bookerTimeZone: winner.timeZone ?? "UTC",
      holderToken: "",
      idempotencyKey: `lottery:${lottery._id}`,
      attendee: {
        name: winner.name,
        email: winner.email,
        timeZone: winner.timeZone ?? "UTC",
        notes: winner.notes,
      },
      intakeResponses: winner.intakeResponses,
      fromLotteryDraw: true,
      nowMs: now,
    });
  } catch (err) {
    const kind =
      err instanceof ConvexError
        ? ((err.data as { kind?: string })?.kind ?? "create_failed")
        : "create_failed";
    await ctx.db.patch(lottery._id, {
      status: "cancelled",
      pickToken: undefined,
      updatedAt: now,
    });
    if (ref?.sendLotteryEmails && ctx.scheduler?.runAfter && recipients.length) {
      await ctx.scheduler.runAfter(0, ref.sendLotteryEmails, {
        kind: "cancelled",
        recipients,
        ...emailMeta,
      });
    }
    return { outcome: "cancelled", reason: kind };
  }

  await ctx.db.patch(lottery._id, {
    status: "drawn",
    winnerEntryId: winner._id,
    bookingId: booked.bookingId,
    entrantCountAtDraw: entries.length,
    drawnAt: now,
    pickToken: undefined,
    updatedAt: now,
  });

  if (ref?.sendLotteryEmails && ctx.scheduler?.runAfter) {
    const winnerEmail = winner.email as string;
    await ctx.scheduler.runAfter(0, ref.sendLotteryEmails, {
      kind: "application_won",
      recipients: recipients.filter((r: Ctx) => r.email === winnerEmail),
      ...emailMeta,
    });
    const losers = recipients.filter((r: Ctx) => r.email !== winnerEmail);
    if (losers.length > 0) {
      await ctx.scheduler.runAfter(0, ref.sendLotteryEmails, {
        kind: "application_lost",
        recipients: losers,
        ...emailMeta,
      });
    }
  }
  return {
    outcome: "picked",
    bookingId: booked.bookingId,
    winnerName: winner.name as string,
  };
}

export const _pickApplicationWinner = internalMutation({
  args: {
    lotteryId: v.id("slotLotteries"),
    entryId: v.id("slotLotteryEntries"),
    token: v.string(),
  },
  handler: async (ctx, args) => pickApplicationWinnerImpl(ctx, args),
});

// ─── WAVE-2 PAIR: registered wrappers over the booking.ts impls ───────────────

export const expirePairBooking = internalMutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, { bookingId }) => expirePairBookingImpl(ctx, { bookingId }),
});

export const sweepExpiredPairHolds = internalMutation({
  args: {},
  handler: async (ctx) => sweepExpiredPairHoldsImpl(ctx),
});

export const _joinPair = internalMutation({
  args: {
    token: v.string(),
    name: v.string(),
    email: v.string(),
    timeZone: v.optional(v.string()),
  },
  handler: async (ctx, args) => joinPairBookingImpl(ctx, args),
});

export const _publicPair = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => getPairPublicImpl(ctx, token),
});

// ─── L3: hourly sweep backstop ────────────────────────────────────────────────

// Draws any open lottery past its closesAt that the exact-time scheduler missed
// (deploy gap, scheduler loss, flag re-enable after a dark window). Bounded per
// tick. Outcomes are individually logged; a deferred draw stays open.
export async function sweepDueSlotLotteriesImpl(
  ctx: Ctx,
  nowMs?: number,
): Promise<{ scanned: number; drawn: number }> {
  const now = nowMs ?? Date.now();
  const due = await ctx.db
    .query("slotLotteries")
    .withIndex("by_status_closesAt", (q: Ctx) =>
      q.eq("status", "open").lte("closesAt", now),
    )
    .take(25);
  let drawn = 0;
  for (const lottery of due) {
    const res = await drawSlotLotteryImpl(ctx, {
      lotteryId: lottery._id as Id<"slotLotteries">,
      nowMs: now,
    });
    if (res.outcome === "drawn") drawn += 1;
    if (res.outcome === "deferred") break; // flags dark — stop scanning
  }

  // WAVE-2 APPLICATION expiry — awaiting_pick rounds whose slot has started
  // without an owner pick: cancel + apologize to every applicant.
  const stalePicks = await ctx.db
    .query("slotLotteries")
    .withIndex("by_status_closesAt", (q: Ctx) =>
      q.eq("status", "awaiting_pick").lte("closesAt", now),
    )
    .take(25);
  for (const round of stalePicks) {
    if ((round.slotStart as number) > now) continue;
    const entries = await ctx.db
      .query("slotLotteryEntries")
      .withIndex("by_lottery", (q: Ctx) => q.eq("lotteryId", round._id))
      .collect();
    await ctx.db.patch(round._id, {
      status: "cancelled",
      pickToken: undefined,
      updatedAt: now,
    });
    const ref = selfRef();
    const eventType = await ctx.db.get(round.eventTypeId);
    if (ref?.sendLotteryEmails && ctx.scheduler?.runAfter && entries.length) {
      await ctx.scheduler.runAfter(0, ref.sendLotteryEmails, {
        kind: "cancelled",
        recipients: entries.map((e: Ctx) => ({
          email: e.email as string,
          name: e.name as string,
          timeZone: (e.timeZone as string) ?? "UTC",
        })),
        eventTitle: (eventType?.title as string) ?? "Session",
        slotStartMs: round.slotStart as number,
        slotEndMs: round.slotEnd as number,
        lotteryId: String(round._id),
      });
    }
  }

  // WAVE-2 PAIR expiry backstop (exact-time check is primary).
  await sweepExpiredPairHoldsImpl(ctx, now);

  return { scanned: due.length, drawn };
}

export const sweepDueSlotLotteries = internalMutation({
  args: {},
  handler: async (ctx) => sweepDueSlotLotteriesImpl(ctx),
});

// ─── Emails (internalAction; Brevo via notify.ts, key-gated) ──────────────────

function fmtWhen(ms: number, timeZone: string): string {
  try {
    return new Date(ms).toLocaleString("en-US", {
      timeZone,
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return new Date(ms).toUTCString();
  }
}

function lotteryStatusUrl(lotteryId: string): string {
  const base = process.env.BOOK_PUBLIC_URL ?? "https://book.dibslist.app";
  return `${base.replace(/\/$/, "")}/lottery/${lotteryId}`;
}

export type InteractionEmailKind =
  | "entered"
  | "won"
  | "lost"
  | "cancelled"
  | "application_received"
  | "application_won"
  | "application_lost"
  | "application_owner_pick"
  | "threshold_confirmed"
  | "threshold_cancelled"
  | "pair_held"
  | "pair_joined"
  | "pair_expired";

export interface ApplicantSummary {
  entryId: string;
  name: string;
  summary: string;
}

function pairJoinUrl(token: string): string {
  const base = process.env.BOOK_PUBLIC_URL ?? "https://book.dibslist.app";
  return `${base.replace(/\/$/, "")}/pair/${token}`;
}

function pickUrl(lotteryId: string, entryId: string, token: string): string {
  const base =
    process.env.CONVEX_SITE_URL ?? "https://jovial-meadowlark-781.convex.site";
  return `${base.replace(/\/$/, "")}/book/api/application/pick?round=${encodeURIComponent(
    lotteryId,
  )}&entry=${encodeURIComponent(entryId)}&token=${encodeURIComponent(token)}`;
}

export function buildLotteryEmail(args: {
  kind: InteractionEmailKind;
  name: string;
  timeZone: string;
  eventTitle: string;
  slotStartMs: number;
  closesAtMs?: number;
  lotteryId: string;
  token?: string;
  deadlineMs?: number;
  applicants?: ApplicantSummary[];
  pickToken?: string;
}): { subject: string; htmlContent: string } {
  const when = fmtWhen(args.slotStartMs, args.timeZone);
  const url = lotteryStatusUrl(args.lotteryId);
  switch (args.kind) {
    case "application_received":
      return {
        subject: `Application received — ${args.eventTitle}`,
        htmlContent:
          `<p>Hi ${args.name},</p>` +
          `<p>Your application for <strong>${args.eventTitle}</strong> at <strong>${when}</strong> is in.</p>` +
          (args.closesAtMs
            ? `<p>Applications close ${fmtWhen(args.closesAtMs, args.timeZone)}; the host then picks one applicant. You'll get an email either way.</p>`
            : "") +
          `<p><a href="${url}">Watch the status here</a>.</p>`,
      };
    case "application_won":
      return {
        subject: `🎉 You were picked — ${args.eventTitle}`,
        htmlContent:
          `<p>Hi ${args.name},</p>` +
          `<p>The host picked YOUR application for <strong>${args.eventTitle}</strong> at <strong>${when}</strong> — the time is yours.</p>` +
          `<p>Your booking confirmation is on its way in a separate email.</p>`,
      };
    case "application_lost":
      return {
        subject: `Application result — ${args.eventTitle}`,
        htmlContent:
          `<p>Hi ${args.name},</p>` +
          `<p>The host went with another application for <strong>${args.eventTitle}</strong> at <strong>${when}</strong> this time. Thanks for pitching — keep an eye out for future times.</p>`,
      };
    case "application_owner_pick": {
      const rows = (args.applicants ?? [])
        .map(
          (a) =>
            `<li style="margin-bottom:10px"><strong>${a.name}</strong>` +
            (a.summary ? `<br/><span style="color:#555">${a.summary}</span>` : "") +
            (args.pickToken
              ? `<br/><a href="${pickUrl(args.lotteryId, a.entryId, args.pickToken)}">✅ Pick ${a.name}</a>`
              : "") +
            `</li>`,
        )
        .join("");
      return {
        subject: `Pick a winner — ${args.eventTitle} (${args.applicants?.length ?? 0} applications)`,
        htmlContent:
          `<p>Applications for <strong>${args.eventTitle}</strong> at <strong>${when}</strong> are closed.</p>` +
          `<p>One click books them and politely declines the rest:</p>` +
          `<ul>${rows}</ul>` +
          `<p>If you do nothing before the slot starts, the round cancels itself and everyone is notified.</p>`,
      };
    }
    case "threshold_confirmed":
      return {
        subject: `It's on! — ${args.eventTitle}`,
        htmlContent:
          `<p>Hi ${args.name},</p>` +
          `<p><strong>${args.eventTitle}</strong> at <strong>${when}</strong> reached the minimum group size — the session is CONFIRMED. See you there!</p>`,
      };
    case "threshold_cancelled":
      return {
        subject: `Didn't reach the minimum — ${args.eventTitle}`,
        htmlContent:
          `<p>Hi ${args.name},</p>` +
          `<p><strong>${args.eventTitle}</strong> at <strong>${when}</strong> didn't reach the minimum group size, so it's been cancelled and your booking released. Nothing else to do.</p>`,
      };
    case "pair_held":
      return {
        subject: `Your spot is held — partner needed (${args.eventTitle})`,
        htmlContent:
          `<p>Hi ${args.name},</p>` +
          `<p>Your spot for <strong>${args.eventTitle}</strong> at <strong>${when}</strong> is HELD — it confirms as soon as your partner joins.</p>` +
          (args.token
            ? `<p>Forward them this link: <a href="${pairJoinUrl(args.token)}">${pairJoinUrl(args.token)}</a></p>`
            : "") +
          (args.deadlineMs
            ? `<p>The hold expires ${fmtWhen(args.deadlineMs, args.timeZone)} if nobody joins.</p>`
            : ""),
      };
    case "pair_joined":
      return {
        subject: `You're both in — ${args.eventTitle}`,
        htmlContent:
          `<p>Hi ${args.name},</p>` +
          `<p>Your partner joined — <strong>${args.eventTitle}</strong> at <strong>${when}</strong> is confirmed for the two of you.</p>`,
      };
    case "pair_expired":
      return {
        subject: `Hold expired — ${args.eventTitle}`,
        htmlContent:
          `<p>Hi ${args.name},</p>` +
          `<p>Nobody joined your held spot for <strong>${args.eventTitle}</strong> at <strong>${when}</strong>, so it's been released. You can book again any time.</p>`,
      };
    case "entered":
      return {
        subject: `You're in the drawing — ${args.eventTitle}`,
        htmlContent:
          `<p>Hi ${args.name},</p>` +
          `<p>You're entered in the drawing for <strong>${args.eventTitle}</strong> at <strong>${when}</strong>.</p>` +
          (args.closesAtMs
            ? `<p>Entries close ${fmtWhen(args.closesAtMs, args.timeZone)} — the winner is picked automatically right then.</p>`
            : "") +
          `<p><a href="${url}">Watch the countdown</a>. You'll get an email either way when the drawing ends.</p>`,
      };
    case "won":
      return {
        subject: `🎉 You got the slot — ${args.eventTitle}`,
        htmlContent:
          `<p>Hi ${args.name},</p>` +
          `<p>You won the drawing for <strong>${args.eventTitle}</strong> at <strong>${when}</strong> — the time is yours.</p>` +
          `<p>Your booking confirmation (with a calendar invite) is on its way in a separate email.</p>`,
      };
    case "lost":
      return {
        subject: `Drawing result — ${args.eventTitle}`,
        htmlContent:
          `<p>Hi ${args.name},</p>` +
          `<p>The drawing for <strong>${args.eventTitle}</strong> at <strong>${when}</strong> has ended and another entrant was selected this time.</p>` +
          `<p>Thanks for entering — keep an eye out for future times.</p>`,
      };
    case "cancelled":
      return {
        subject: `Drawing cancelled — ${args.eventTitle}`,
        htmlContent:
          `<p>Hi ${args.name},</p>` +
          `<p>The drawing for <strong>${args.eventTitle}</strong> at <strong>${when}</strong> was cancelled because the time is no longer available. Sorry about that — no action is needed.</p>`,
      };
  }
}

export const sendLotteryEmails = internalAction({
  args: {
    kind: v.union(
      v.literal("entered"),
      v.literal("won"),
      v.literal("lost"),
      v.literal("cancelled"),
      v.literal("application_received"),
      v.literal("application_won"),
      v.literal("application_lost"),
      v.literal("application_owner_pick"),
      v.literal("threshold_confirmed"),
      v.literal("threshold_cancelled"),
      v.literal("pair_held"),
      v.literal("pair_joined"),
      v.literal("pair_expired"),
    ),
    recipients: v.array(
      v.object({
        email: v.string(),
        name: v.string(),
        timeZone: v.string(),
      }),
    ),
    eventTitle: v.string(),
    slotStartMs: v.number(),
    slotEndMs: v.number(),
    closesAtMs: v.optional(v.number()),
    lotteryId: v.optional(v.string()),
    token: v.optional(v.string()),
    deadlineMs: v.optional(v.number()),
    pickToken: v.optional(v.string()),
    applicants: v.optional(
      v.array(
        v.object({
          entryId: v.string(),
          name: v.string(),
          summary: v.string(),
        }),
      ),
    ),
  },
  handler: async (_ctx, args) => {
    let sent = 0;
    for (const r of args.recipients) {
      const { subject, htmlContent } = buildLotteryEmail({
        kind: args.kind,
        name: r.name,
        timeZone: r.timeZone,
        eventTitle: args.eventTitle,
        slotStartMs: args.slotStartMs,
        closesAtMs: args.closesAtMs,
        lotteryId: args.lotteryId ?? "",
        token: args.token,
        deadlineMs: args.deadlineMs,
        pickToken: args.pickToken,
        applicants: args.applicants,
      });
      try {
        const res = await sendBrevoEmail({
          toEmail: r.email,
          toName: r.name,
          subject,
          htmlContent,
        });
        if (!res.skipped) sent += 1;
      } catch (err) {
        log.warn("booking.lottery.email_failed", {
          kind: args.kind,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { sent, of: args.recipients.length };
  },
});
