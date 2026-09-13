// BOOKING / A7 — short-lived slot holds (`claimHold` / `releaseHold`) + the
// expired-hold sweep cron impl (`sweepExpiredHolds`).
//
// A hold is the "SET NX"-style soft reservation a candidate takes the moment
// they pick a slot, BEFORE they fill in the attendee form. It blocks the same
// slot from being offered to (or held by) anyone else for ~5 minutes while the
// candidate completes the form. It is NOT the authoritative booking guard — the
// `createBooking` write-time conflict re-check (booking.ts step 3) is. The hold
// just avoids two candidates racing into the same `createBooking` and one of
// them losing after typing everything in.
//
// PUBLIC/CANDIDATE PATH: like `getAvailableSlots` and `createBooking`, these are
// the unauthenticated candidate surface — NO `requireAuthUserId`. Identity is
// the opaque `holderToken` the client generates + persists in sessionStorage.
// Writes still gate on the DEFAULT-OFF `booking_enabled` flag.
//
// SERIALIZABILITY: Convex mutations are serializable, so two concurrent
// `claimHold` calls for the same (eventTypeId, startTime) are sequenced — the
// second reads the first's just-inserted row and throws `slot_held`. No Redis
// SET NX needed.
//
// TESTABILITY: each handler is exported as a bare async function so the *.test.ts
// can exercise it against an in-memory fake ctx (the repo convention — see
// availability.test.ts / eventTypes.test.ts). The registered mutation wrappers
// also expose `._handler`.
//
// SCHEMA NOTE: the `bookingHolds` / `eventTypes` / `eventTypeHosts` / `bookings`
// tables are NEW (schema pushed, codegen operator-gated). String table names
// typecheck against the schema at runtime; tsc under the stale `_generated`
// types may flag them until codegen runs — EXPECTED, see the A4/A5 modules.

import { ConvexError, v } from "convex/values";
import { mutation, internalMutation } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { requireFlagEnabled } from "../_helpers/featureFlag";
import { getUserAvailabilityRangesHandler } from "./availability";
import { checkForConflicts, dayjs } from "@dibslist/scheduling-engine";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

// 5-minute hold TTL (matches the lifecycle spec §1.1).
export const HOLD_TTL_MS = 5 * 60 * 1000;

const BOOKING_FLAG_GATE = {
  kind: "booking_disabled",
  message: "Booking is not available.",
  defaultValue: false as const,
};

async function gateBooking(ctx: Ctx): Promise<void> {
  const gate = await requireFlagEnabled(ctx, "booking_enabled", BOOKING_FLAG_GATE);
  if (!gate.ok) throw new ConvexError({ kind: gate.kind, message: gate.message });
}

// Re-usable collective free-slot check: confirm [startTime, endTime) is fully
// inside a free range for EVERY fixed host on the event type. Shared by claimHold
// and createBooking. `excludeBookingId` lets reschedule skip the booking being
// replaced when it re-checks the NEW slot.
export async function assertSlotFreeForAllHosts(
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
  const { eventType, startTime, endTime, viewerTimeZone, nowMs } = args;

  let hostRows: Array<Record<string, any>> = await ctx.db
    .query("eventTypeHosts")
    .withIndex("by_eventType", (q: Ctx) => q.eq("eventTypeId", eventType._id))
    .collect();

  // Solo/personal event type: cal.com keeps the owner in the `users` relation, NOT in `hosts`.
  // Synthesize a single fixed host from the denormalized event-type owner so the slot-free check
  // runs against the OWNER's schedule (mirrors the availableSlots.ts read-path fallback). Without
  // this, solo events were unbookable — slots SHOWED but every submit failed `slot_unavailable`,
  // which is why no booking ever succeeded.
  if (hostRows.length === 0) {
    hostRows = [
      {
        hostAuthUserId: eventType.ownerAuthUserId,
        isFixed: true,
        scheduleId: eventType.scheduleId ?? undefined,
        groupId: null,
      },
    ];
  }

  const bufferBefore = (eventType.bufferBeforeMinutes ?? 0) * 60_000;
  const bufferAfter = (eventType.bufferAfterMinutes ?? 0) * 60_000;

  for (const host of hostRows) {
    // (1) Working-hours / overrides / own-booking free ranges from the engine
    //     pipeline. This already subtracts accepted + pending bookings.
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
    if (!slotIsFree) {
      throw new ConvexError({
        kind: "slot_unavailable",
        message: "This slot is no longer available.",
      });
    }

    // (2) Lower-level engine `checkForConflicts` against this host's own
    //     accepted/pending bookings, with the SAME 24h widened lower bound as
    //     availability.ts so a booking that STARTS before the window but ends
    //     inside it still registers as busy. The reschedule path passes
    //     excludeBookingId so the booking being replaced doesn't self-conflict.
    const rawBookings: Array<Record<string, any>> = await ctx.db
      .query("bookings")
      .withIndex("by_assignedHost_startTime", (q: Ctx) =>
        q
          .eq("assignedHostAuthUserId", host.hostAuthUserId)
          .gte("startTime", startTime - 24 * 60 * 60 * 1000)
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
        // `checkForConflicts` types busy intervals as { start|end: string|Date };
        // it internally does `dayjs.utc(x).valueOf()`, so we hand it Date objects
        // (epoch-ms ± buffer) rather than raw numbers to satisfy the engine type.
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
    if (hasConflict) {
      throw new ConvexError({
        kind: "slot_unavailable",
        message: "This slot is no longer available.",
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────
// claimHold — mutation (public/candidate; flag-gated)
// ─────────────────────────────────────────────────────────────

export interface ClaimHoldArgs {
  eventTypeId: Id<"eventTypes">;
  startTime: number;
  endTime: number;
  holderToken: string;
  viewerTimeZone: string;
  nowMs?: number;
}

export async function claimHoldHandler(
  ctx: Ctx,
  args: ClaimHoldArgs,
): Promise<{ holdId: Id<"bookingHolds">; holderToken: string }> {
  await gateBooking(ctx);
  const now = args.nowMs ?? Date.now();

  // Load + validate the event type.
  const eventType = await ctx.db.get(args.eventTypeId);
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

  // Existing live holds for this exact (eventTypeId, startTime).
  const holds: Array<Record<string, any>> = await ctx.db
    .query("bookingHolds")
    .withIndex("by_eventType_start", (q: Ctx) =>
      q.eq("eventTypeId", args.eventTypeId).eq("startTime", args.startTime),
    )
    .collect();

  const liveHolds = holds.filter((h) => (h.expiresAt as number) > now);

  // Idempotent re-claim: caller already owns a live hold for this slot.
  const own = liveHolds.find((h) => h.holderToken === args.holderToken);
  if (own) {
    return { holdId: own._id as Id<"bookingHolds">, holderToken: args.holderToken };
  }

  // Someone ELSE holds this slot → blocked (the serialized SET NX equivalent).
  if (liveHolds.length > 0) {
    throw new ConvexError({
      kind: "slot_held",
      message: "This slot is currently being booked by someone else.",
    });
  }

  // Defense-in-depth: confirm the slot is actually free across all fixed hosts
  // (working hours + no overlapping accepted/pending booking) before holding.
  await assertSlotFreeForAllHosts(ctx, {
    eventType,
    startTime: args.startTime,
    endTime: args.endTime,
    viewerTimeZone: args.viewerTimeZone,
    nowMs: now,
  });

  const holdId = await ctx.db.insert("bookingHolds", {
    eventTypeId: args.eventTypeId,
    startTime: args.startTime,
    endTime: args.endTime,
    holderToken: args.holderToken,
    expiresAt: now + HOLD_TTL_MS,
    createdAt: now,
  });

  return { holdId: holdId as Id<"bookingHolds">, holderToken: args.holderToken };
}

export const claimHold = mutation({
  args: {
    eventTypeId: v.id("eventTypes"),
    startTime: v.number(),
    endTime: v.number(),
    holderToken: v.string(),
    viewerTimeZone: v.string(),
    nowMs: v.optional(v.number()),
  },
  handler: claimHoldHandler,
});

// ─────────────────────────────────────────────────────────────
// releaseHold — mutation (public/candidate; flag-gated)
// ─────────────────────────────────────────────────────────────

export async function releaseHoldHandler(
  ctx: Ctx,
  args: { holdId: Id<"bookingHolds">; holderToken: string },
): Promise<null> {
  await gateBooking(ctx);

  const hold = await ctx.db.get(args.holdId);
  // Already gone (swept / consumed by a booking) → idempotent no-op.
  if (!hold) return null;
  if (hold.holderToken !== args.holderToken) {
    throw new ConvexError({ kind: "unauthorized", message: "Not found." });
  }
  await ctx.db.delete(args.holdId);
  return null;
}

export const releaseHold = mutation({
  args: {
    holdId: v.id("bookingHolds"),
    holderToken: v.string(),
  },
  handler: releaseHoldHandler,
});

// ─────────────────────────────────────────────────────────────
// sweepExpiredHolds — internalMutation (hold-sweep cron impl)
// ─────────────────────────────────────────────────────────────
//
// Range-scans `bookingHolds.by_expiresAt` for rows whose TTL has elapsed and
// deletes them. Bounded per tick so a backlog drains across the hourly cadence
// without holding one long transaction. Registered as `booking-hold-sweep` in
// crons.ts. Not flag-gated — sweeping dead rows is always safe (and if the flag
// is OFF the table is simply empty, so the sweep no-ops).

const SWEEP_BATCH = 200;

export async function sweepExpiredHoldsHandler(
  ctx: Ctx,
  args: { nowMs?: number },
): Promise<{ deleted: number }> {
  const now = args.nowMs ?? Date.now();
  const expired: Array<Record<string, any>> = await ctx.db
    .query("bookingHolds")
    .withIndex("by_expiresAt", (q: Ctx) => q.lte("expiresAt", now))
    .take(SWEEP_BATCH);

  for (const hold of expired) {
    await ctx.db.delete(hold._id);
  }
  return { deleted: expired.length };
}

export const sweepExpiredHolds = internalMutation({
  args: { nowMs: v.optional(v.number()) },
  handler: sweepExpiredHoldsHandler,
});
