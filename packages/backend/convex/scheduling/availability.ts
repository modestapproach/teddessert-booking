// BOOKING / A5 — per-host availability projection (`getUserAvailabilityRanges`).
//
// Computes a SINGLE host's free `DateRange[]` within a [windowStart, windowEnd)
// window by:
//   1. resolving the host's schedule (pinned scheduleId or their isDefault one),
//   2. projecting their weekly working-hours rows + in-window date overrides onto
//      concrete UTC ranges via the lifted engine's `buildDateRanges`,
//   3. subtracting their accepted (and pending) bookings as busy via `subtract`.
//
// This is the per-host engine call that the collective/round-robin orchestrator
// (`getAvailableSlots`, F1/A6) fans out over, and that the confirm-time re-check
// (write path) re-runs. It is an `internalQuery` — never exposed publicly; the
// orchestrator always drives it — but its async handler is ALSO exported as a
// bare function (`getUserAvailabilityRangesHandler`) so the orchestrator can call
// it directly in the same V8 isolate (no RPC overhead) and so *.test.ts can
// exercise it against an in-memory fake ctx (the repo convention).
//
// ENGINE SHAPE NOTES (important):
//   - The lifted `WorkingHours`/`DateOverride` interfaces carry `startTime`/
//     `endTime` as midnight-anchored *UTC Date* objects; the engine reads ONLY
//     `.getUTCHours()` / `.getUTCMinutes()` off them. Our `availability` /
//     `dateOverrides` rows store minutes-from-midnight as plain numbers, so we
//     convert each via `minutesToUtcDate` before handing them to the engine.
//   - All time values in/out are UTC epoch-ms; IANA tz IDs travel alongside.

import { ConvexError, v } from "convex/values";
import { internalQuery } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import {
  buildDateRanges,
  subtract,
  dayjs,
  type DateRange,
  type DateOverride,
  type WorkingHours,
} from "@dibslist/scheduling-engine";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

// The `by_assignedHost_startTime` index keys on startTime only, so to catch
// bookings that START before the query window but END inside it we widen the
// lower bound by this slack (then filter to true overlaps). 24h comfortably
// exceeds any realistic interview booking length.
const BOOKING_LOOKBACK_MS = 24 * 60 * 60 * 1000;

// Convert minutes-from-midnight (the storage format on `availability` /
// `dateOverrides`) into the midnight-anchored UTC Date the engine reads
// `.getUTCHours()`/`.getUTCMinutes()` off of. e.g. 540 -> 1970-01-01T09:00:00Z.
function minutesToUtcDate(minutes: number): Date {
  const safe = Number.isFinite(minutes) ? Math.max(0, Math.trunc(minutes)) : 0;
  const hours = Math.floor(safe / 60);
  const mins = safe % 60;
  return new Date(Date.UTC(1970, 0, 1, hours, mins, 0));
}

export interface UserAvailabilityRangesArgs {
  hostAuthUserId: string;
  scheduleId?: Id<"schedules">;
  windowStart: number; // UTC epoch-ms, inclusive
  windowEnd: number; // UTC epoch-ms, exclusive
  viewerTimeZone: string; // reserved for slot rendering by the orchestrator
  nowMs?: number;
  // E3 GROUP capacity (additive; undefined = current behavior). When set, the
  // host-busy subtraction (step 5) IGNORES this host's bookings belonging to
  // the given group event type. Rationale: in a group event the host attends
  // every booking of a slot, so a group booking must NOT shrink the host's
  // availability — capacity is enforced separately by a per-slot count
  // (availableSlots.ts seatsRemaining / booking.ts assertSlotBookableForGroup).
  // Solo + round-robin paths never pass this, so their behavior is unchanged.
  excludeOwnBookingsForEventTypeId?: Id<"eventTypes">;
}

// Serializable DateRange shape returned across the internalQuery boundary.
export interface SerializedDateRange {
  start: number; // UTC epoch-ms
  end: number; // UTC epoch-ms
}

export async function getUserAvailabilityRangesHandler(
  ctx: Ctx,
  args: UserAvailabilityRangesArgs,
): Promise<SerializedDateRange[]> {
  // 1. Resolve the schedule. Pinned id must be owned by the host; otherwise
  //    load their default. Missing schedule => host has no availability config.
  let schedule: Record<string, any> | null = null;
  if (args.scheduleId) {
    const pinned = await ctx.db.get(args.scheduleId);
    if (!pinned || pinned.ownerAuthUserId !== args.hostAuthUserId) {
      throw new ConvexError("Not found.");
    }
    schedule = pinned;
  } else {
    schedule = await ctx.db
      .query("schedules")
      .withIndex("by_owner_default", (q: Ctx) =>
        q.eq("ownerAuthUserId", args.hostAuthUserId).eq("isDefault", true),
      )
      .unique();
  }
  if (!schedule) return [];
  const resolvedScheduleId = schedule._id as Id<"schedules">;
  const timeZone: string = schedule.timeZone;

  // 2. Weekly working-hours rows -> engine WorkingHours[].
  const availabilityRows: Array<Record<string, any>> = await ctx.db
    .query("availability")
    .withIndex("by_schedule", (q: Ctx) => q.eq("scheduleId", resolvedScheduleId))
    .collect();

  const workingHours: WorkingHours[] = availabilityRows.map((row) => ({
    days: row.days as number[],
    startTime: minutesToUtcDate(row.startMinute),
    endTime: minutesToUtcDate(row.endMinute),
  }));

  // 3. In-window date overrides -> engine DateOverride[]. A null window (both
  //    minutes absent) becomes a zero-length 0..0 override the engine treats as
  //    "unavailable all day".
  const overrideRows: Array<Record<string, any>> = await ctx.db
    .query("dateOverrides")
    .withIndex("by_schedule_dateUtc", (q: Ctx) =>
      q
        .eq("scheduleId", resolvedScheduleId)
        .gte("dateUtc", args.windowStart)
        .lte("dateUtc", args.windowEnd),
    )
    .collect();

  const dateOverrides: DateOverride[] = overrideRows.map((row) => ({
    date: dayjs(row.dateUtc).toDate(),
    startTime: minutesToUtcDate(row.startMinute ?? 0),
    endTime: minutesToUtcDate(row.endMinute ?? 0),
  }));

  // 4. Project working hours + overrides onto concrete UTC ranges.
  const { dateRanges } = buildDateRanges({
    timeZone,
    availability: [...workingHours, ...dateOverrides],
    dateFrom: dayjs(args.windowStart).tz(timeZone),
    dateTo: dayjs(args.windowEnd).tz(timeZone),
    travelSchedules: [],
  });

  // 5. Load the host's bookings overlapping the window as busy. Accepted + pending
  //    occupy the slot (pending is the conservative choice); cancelled/rescheduled
  //    do not. The index is on startTime only, so we widen the lower bound by
  //    BOOKING_LOOKBACK_MS to also catch bookings that START before the window but
  //    END inside it (otherwise a straddling booking would leave the host falsely
  //    free for the first slot — the false-free trap), then keep only true overlaps.
  const bookingRows: Array<Record<string, any>> = await ctx.db
    .query("bookings")
    .withIndex("by_assignedHost_startTime", (q: Ctx) =>
      q
        .eq("assignedHostAuthUserId", args.hostAuthUserId)
        .gte("startTime", args.windowStart - BOOKING_LOOKBACK_MS)
        .lte("startTime", args.windowEnd),
    )
    .collect();

  const busyRanges: DateRange[] = bookingRows
    .filter(
      (b) =>
        (b.status === "accepted" || b.status === "pending") &&
        (b.endTime as number) > args.windowStart &&
        // E3 GROUP: a group booking on this very event type does NOT make the
        // host busy (the host attends every booking of the slot; capacity is
        // counted per slot elsewhere). No-op unless the orchestrator passes it.
        !(
          args.excludeOwnBookingsForEventTypeId !== undefined &&
          b.eventTypeId === args.excludeOwnBookingsForEventTypeId
        ),
    )
    .map((b) => ({
      start: dayjs(b.startTime as number),
      end: dayjs(b.endTime as number),
    }));

  // Phase B (booking-calendar-integration-prd B6b): merge EXTERNAL-calendar busy
  // intervals (Google Calendar / CalDAV) from `freebusyCache` into `busyRanges`
  // before the subtract, so a host's real calendar blocks bookable slots (no
  // double-booking). The cache is populated per-credential by `refreshFreebusy`
  // (on connect + cron). Conservative-by-design: we include any cached row that
  // OVERLAPS the window regardless of `expiresAt` — a slightly-stale "busy" is
  // safer than offering a slot the host's calendar already occupies; the cron
  // keeps rows fresh. Hosts with no connected calendar have no rows → no-op, so
  // existing behaviour is unchanged for them.
  const freebusyRows = await ctx.db
    .query("freebusyCache")
    .withIndex("by_authUserId", (q: Ctx) => q.eq("authUserId", args.hostAuthUserId))
    .collect();
  for (const row of freebusyRows) {
    // Skip rows whose cached window doesn't intersect the requested window.
    if (row.windowEnd <= args.windowStart || row.windowStart >= args.windowEnd) continue;
    for (const b of row.busy as Array<{ start: number; end: number }>) {
      if (b.end > args.windowStart && b.start < args.windowEnd) {
        busyRanges.push({ start: dayjs(b.start), end: dayjs(b.end) });
      }
    }
  }

  // 6. Subtract busy from free.
  const freeRanges = subtract(dateRanges, busyRanges);

  // 7. Return as serializable UTC epoch-ms pairs.
  return freeRanges.map((r) => ({
    start: r.start.valueOf(),
    end: r.end.valueOf(),
  }));
}

export const getUserAvailabilityRanges = internalQuery({
  args: {
    hostAuthUserId: v.string(),
    scheduleId: v.optional(v.id("schedules")),
    windowStart: v.number(),
    windowEnd: v.number(),
    viewerTimeZone: v.string(),
    nowMs: v.optional(v.number()),
    excludeOwnBookingsForEventTypeId: v.optional(v.id("eventTypes")),
  },
  handler: getUserAvailabilityRangesHandler,
});
