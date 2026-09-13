// BOOKING / A6 — collective-slots orchestrator (`getAvailableSlots`).
//
// Public read path for the candidate-facing picker. Given an event type (by id
// OR public slug) and a [windowStart, windowEnd) window in the viewer's tz, it:
//   1. loads + validates the event type (must exist + be active),
//   2. clamps the window to bookingWindowDays and enforces minimumBookingNotice,
//   3. fans out per-host `getUserAvailabilityRanges` over its eventTypeHosts,
//   4. aggregates across hosts via the lifted `getAggregatedAvailability`
//      (COLLECTIVE = intersection: every host free simultaneously),
//   5. enumerates slots via the lifted `getSlots` with the event type's
//      duration / interval / buffers / min-notice,
//   6. subtracts active (non-expired) `bookingHolds` for that event type,
//   7. groups surviving slots by calendar date (ISO) in the viewer's tz.
//
// NOT flag-gated: reads bypass the `booking_enabled` flag (consistent with
// eventTypes.ts / schedules.ts read handlers). The flag gates only writes.
//
// Phase A: host busy = own accepted/pending bookings only (calendar freebusy is
// layered into getUserAvailabilityRanges in Phase B).
//
// E1 (round-robin): the ROUND_ROBIN branch offers a slot when ANY ONE eligible
// host (per group) is free — `getAggregatedAvailability(..., "ROUND_ROBIN")`
// already produces the union-then-intersect ranges, and here we additionally
// compute the per-slot `eligibleHostIdxs` (which hosts can actually staff each
// surviving slot) so the confirm-time getLuckyUser pick has a candidate set.
// The actual host assignment is deferred to confirm time (booking.ts).
//
// E2 (ranking): every surviving slot is scored by the pure `rankSlots` scorer
// and surfaced best-first within each date group (collective too). When the
// event type sets a `rankTopK`, the global result is truncated to the top-K
// best slots; otherwise ALL slots are returned, just ordered.

import { ConvexError, v } from "convex/values";
import { query } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import {
  getAggregatedAvailability,
  getSlots,
  rankSlots,
  dayjs,
  type DateRange,
  type SchedulingType,
  type EnumeratedSlot,
  type RankingContext,
  type BusyInterval,
  type PreferredWindow,
} from "@dibslist/scheduling-engine";
import {
  getUserAvailabilityRangesHandler,
  type SerializedDateRange,
} from "./availability";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;

// Map the eventTypes schema's lowercase scheduling type to the engine's enum.
function toEngineSchedulingType(t: string): SchedulingType | null {
  if (t === "collective") return "COLLECTIVE";
  if (t === "round_robin") return "ROUND_ROBIN";
  if (t === "managed") return "MANAGED";
  return null;
}

export interface AvailableSlotsArgs {
  eventTypeId?: Id<"eventTypes">;
  slug?: string;
  windowStart: number; // UTC epoch-ms
  windowEnd: number; // UTC epoch-ms
  viewerTimeZone: string; // IANA tz id
  nowMs?: number;
}

export interface AvailableSlot {
  startMs: number;
  endMs: number;
  eligibleHostIdxs?: number[];
  // E3 GROUP capacity: remaining free seats for this slot. Undefined in solo
  // mode (seatsPerSlot undefined/1); a positive integer when the event type is
  // a group (seatsPerSlot > 1). A slot disappears (is omitted) only when full.
  seatsRemaining?: number;
}

export interface AvailableSlotsResult {
  slotsByDate: Record<string, AvailableSlot[]>;
  hosts: Array<{ authUserId: string }>;
  eventTypeDurationMinutes: number;
}

export async function getAvailableSlotsHandler(
  ctx: Ctx,
  args: AvailableSlotsArgs,
): Promise<AvailableSlotsResult> {
  const now = args.nowMs ?? Date.now();

  // 1. Load + validate the event type.
  let eventType: Record<string, any> | null = null;
  if (args.slug !== undefined) {
    eventType = await ctx.db
      .query("eventTypes")
      .withIndex("by_slug", (q: Ctx) => q.eq("slug", args.slug))
      .unique();
  } else if (args.eventTypeId !== undefined) {
    eventType = await ctx.db.get(args.eventTypeId);
  }
  if (!eventType || eventType.active === false) {
    throw new ConvexError("Not found.");
  }

  const durationMinutes: number = eventType.durationMinutes;

  // 2. Clamp the window to bookingWindowDays; enforce min-notice on the start.
  let windowStart = args.windowStart;
  let windowEnd = args.windowEnd;
  if (
    eventType.bookingWindowDays !== undefined &&
    eventType.bookingWindowDays !== null
  ) {
    const horizon = now + eventType.bookingWindowDays * MS_PER_DAY;
    windowEnd = Math.min(windowEnd, horizon);
  }
  const earliest = now + eventType.minimumBookingNoticeMinutes * MS_PER_MINUTE;
  windowStart = Math.max(windowStart, earliest);

  // Empty/inverted window -> nothing bookable.
  if (windowEnd <= windowStart) {
    return {
      slotsByDate: {},
      hosts: [],
      eventTypeDurationMinutes: durationMinutes,
    };
  }

  // 3. Load hosts.
  let hostRows: Array<Record<string, any>> = await ctx.db
    .query("eventTypeHosts")
    .withIndex("by_eventType", (q: Ctx) => q.eq("eventTypeId", eventType!._id))
    .collect();

  // Solo/personal event type: cal.com keeps the owner in the `users` relation, NOT in `hosts`
  // (hosts is only populated for team collective/round-robin events). Without a fallback the
  // engine returned zero slots → personal events were unbookable. Synthesize a single fixed
  // host from the denormalized event-type owner so solo events yield slots from the owner's
  // pinned (or default) schedule.
  if (hostRows.length === 0) {
    hostRows = [
      {
        hostAuthUserId: eventType!.ownerAuthUserId,
        isFixed: true,
        scheduleId: eventType!.scheduleId ?? undefined,
        groupId: null,
      },
    ];
  }

  const hosts = hostRows.map((h) => ({ authUserId: h.hostAuthUserId as string }));

  // E3 GROUP capacity: seatsPerSlot > 1 = group. In group mode the host attends
  // every booking of a slot, so the host-availability subtraction must IGNORE
  // this event type's own bookings (otherwise the first group booking would make
  // the slot vanish for everyone). Capacity is then enforced per slot below.
  const capacity: number = eventType.seatsPerSlot ?? 1;
  const isGroup = capacity > 1;

  // 3b. Per-host free ranges (direct in-isolate handler call; no RPC).
  const perHost: SerializedDateRange[][] = [];
  for (const h of hostRows) {
    const ranges = await getUserAvailabilityRangesHandler(ctx, {
      hostAuthUserId: h.hostAuthUserId,
      scheduleId: h.scheduleId ?? undefined,
      windowStart,
      windowEnd,
      viewerTimeZone: args.viewerTimeZone,
      nowMs: now,
      // Group only: don't let this event type's own bookings shrink the host's
      // availability (solo/RR pass nothing → unchanged behavior).
      excludeOwnBookingsForEventTypeId: isGroup ? eventType._id : undefined,
    });
    perHost.push(ranges);
  }

  // 4. Aggregate across hosts. COLLECTIVE => all fixed => intersection.
  const engineType = toEngineSchedulingType(eventType.schedulingType);
  const userAvailability = hostRows.map((h, idx) => {
    const ranges: DateRange[] = perHost[idx].map((r) => ({
      start: dayjs(r.start),
      end: dayjs(r.end),
    }));
    return {
      dateRanges: ranges,
      oooExcludedDateRanges: ranges,
      user: {
        isFixed: h.isFixed === true || eventType!.schedulingType === "collective",
        groupId: h.groupId ?? null,
      },
    };
  });

  const aggregated: DateRange[] = getAggregatedAvailability(
    userAvailability,
    engineType,
  );

  // 5. Enumerate slots.
  const frequency = eventType.slotIntervalMinutes ?? durationMinutes;
  const rawSlots = getSlots({
    inviteeDate: dayjs(windowStart).tz(args.viewerTimeZone),
    frequency,
    eventLength: durationMinutes,
    minimumBookingNotice: eventType.minimumBookingNoticeMinutes,
    dateRanges: aggregated,
    offsetStart: 0,
    datesOutOfOffice: {},
  });

  const isRoundRobin = eventType.schedulingType === "round_robin";

  // Per-host free intervals as epoch-ms (reused for the RR eligible-host test
  // and for building the ranking context's per-host busy/working-hours maps).
  const perHostMs: BusyInterval[][] = perHost.map((ranges) =>
    ranges.map((r) => ({ start: r.start, end: r.end })),
  );
  // A host can staff a slot if [startMs,endMs) is fully inside one of its free
  // intervals.
  const hostCoversSlot = (idx: number, startMs: number, endMs: number): boolean =>
    perHostMs[idx].some((r) => r.start <= startMs && r.end >= endMs);

  // 6. Subtract active (non-expired) holds for this event type, matched on the
  //    slot's exact startTime (slots are enumerated at a fixed granularity so no
  //    two distinct slots share a startTime for one event type). For ROUND_ROBIN
  //    we also attach the indices of the hosts that can actually staff the slot
  //    (the candidate set the confirm-time getLuckyUser pick draws from).
  // E3 GROUP capacity: for a group event type (seatsPerSlot > 1) expose the
  // remaining seats per slot and omit a slot only when it is fully booked. We
  // load the event type's accepted/pending bookings ONCE here and count per slot
  // in the loop (vs once-per-slot). Solo mode (capacity <= 1) skips this — the
  // existing holds + per-host-availability subtraction already enforces
  // zero-overlap, so the count map stays empty and seatsRemaining stays unset.
  const slotBookingCounts = new Map<number, number>();
  if (isGroup) {
    const etBookings: Array<Record<string, any>> = await ctx.db
      .query("bookings")
      .withIndex("by_eventType", (q: Ctx) => q.eq("eventTypeId", eventType!._id))
      .collect();
    for (const b of etBookings) {
      if (b.status === "accepted" || b.status === "pending") {
        const st = b.startTime as number;
        slotBookingCounts.set(st, (slotBookingCounts.get(st) ?? 0) + 1);
      }
    }
  }

  const surviving: AvailableSlot[] = [];
  for (const slot of rawSlots) {
    const startMs = slot.time.valueOf();
    // Slots outside the (clamped) window can't be offered.
    if (startMs < windowStart || startMs >= windowEnd) continue;
    const endMs = startMs + durationMinutes * MS_PER_MINUTE;

    const holds: Array<Record<string, any>> = await ctx.db
      .query("bookingHolds")
      .withIndex("by_eventType_start", (q: Ctx) =>
        q.eq("eventTypeId", eventType!._id).eq("startTime", startMs),
      )
      .collect();
    const heldActive = holds.some((hold) => (hold.expiresAt as number) > now);
    if (heldActive) continue;

    const entry: AvailableSlot = { startMs, endMs };

    // E3 GROUP: compute remaining seats; skip the slot only when it's full.
    if (isGroup) {
      const remaining = capacity - (slotBookingCounts.get(startMs) ?? 0);
      if (remaining <= 0) continue; // fully booked — slot disappears
      entry.seatsRemaining = remaining;
    }

    if (isRoundRobin) {
      const eligibleHostIdxs: number[] = [];
      for (let i = 0; i < hostRows.length; i++) {
        if (hostCoversSlot(i, startMs, endMs)) eligibleHostIdxs.push(i);
      }
      // Defensive: a slot the aggregate engine offered should have ≥1 free host,
      // but if none cover it exactly (boundary rounding) skip it.
      if (eligibleHostIdxs.length === 0) continue;
      entry.eligibleHostIdxs = eligibleHostIdxs;
    }
    surviving.push(entry);
  }

  // 6b. RANK the surviving slots (E2). Build the per-host load (rolling weekly
  //     booking counts) + per-day busy/working-hours maps the pure scorer reads,
  //     then score every slot and order best-first. For collective the eligible
  //     set is the full fixed roster; for RR it is the per-slot free hosts.
  const ranked = await rankSurvivingSlots(ctx, {
    surviving,
    hostRows,
    perHostMs,
    isRoundRobin,
    now,
    windowEnd,
    viewerTimeZone: args.viewerTimeZone,
    durationMinutes,
    bufferBeforeMs: (eventType.bufferBeforeMinutes ?? 0) * MS_PER_MINUTE,
    bufferAfterMs: (eventType.bufferAfterMinutes ?? 0) * MS_PER_MINUTE,
  });

  // Optional global top-K truncation (additive `rankTopK` field; when absent we
  // return ALL slots, just ordered best-first).
  const topK: number | undefined =
    typeof eventType.rankTopK === "number" ? eventType.rankTopK : undefined;
  const finalSlots = topK !== undefined ? ranked.slice(0, topK) : ranked;

  // 7. Group by calendar date in the viewer's tz. Insertion order within each
  //    date group preserves the best-first ranking.
  const slotsByDate: Record<string, AvailableSlot[]> = {};
  for (const slot of finalSlots) {
    const dateKey = dayjs(slot.startMs)
      .tz(args.viewerTimeZone)
      .format("YYYY-MM-DD");
    if (!slotsByDate[dateKey]) slotsByDate[dateKey] = [];
    slotsByDate[dateKey].push(slot);
  }

  return {
    slotsByDate,
    hosts,
    eventTypeDurationMinutes: durationMinutes,
  };
}

// Score + sort surviving slots best-first via the pure engine scorer. Loads each
// host's rolling weekly booking count (load term) and derives per-day busy /
// working-hours from the already-computed free ranges. Returns slots ordered
// best-first; `eligibleHostIdxs` are preserved on each entry.
async function rankSurvivingSlots(
  ctx: Ctx,
  args: {
    surviving: AvailableSlot[];
    hostRows: Array<Record<string, any>>;
    perHostMs: BusyInterval[][];
    isRoundRobin: boolean;
    now: number;
    windowEnd: number;
    viewerTimeZone: string;
    durationMinutes: number;
    bufferBeforeMs: number;
    bufferAfterMs: number;
  },
): Promise<AvailableSlot[]> {
  const { surviving, hostRows, perHostMs, isRoundRobin } = args;
  if (surviving.length === 0) return surviving;

  const WEEK_MS = 7 * MS_PER_DAY;
  const hostIds = hostRows.map((h) => h.hostAuthUserId as string);

  // Rolling weekly booking counts per host (load term). Accepted/pending in the
  // [now, now+7d) horizon. Best-effort: a host with none simply has count 0.
  const hostBookingCounts = new Map<string, number>();
  for (const hostId of hostIds) {
    const rows: Array<Record<string, any>> = await ctx.db
      .query("bookings")
      .withIndex("by_assignedHost_startTime", (q: Ctx) =>
        q
          .eq("assignedHostAuthUserId", hostId)
          .gte("startTime", args.now)
          .lte("startTime", args.now + WEEK_MS),
      )
      .collect();
    const count = rows.filter(
      (b) => b.status === "accepted" || b.status === "pending",
    ).length;
    hostBookingCounts.set(hostId, count);
  }

  // Per-host working-hours envelope (min start / max end across its free ranges)
  // and per-host busy intervals (the COMPLEMENT of the free ranges within that
  // envelope). The scorer only needs relative shapes; this captures the gaps the
  // fragmentation / buffer-comfort terms reason about.
  const hostWorkingHoursByDay = new Map<string, { start: number; end: number }>();
  const hostBusyByDay = new Map<string, BusyInterval[]>();
  hostIds.forEach((hostId, idx) => {
    const ranges = [...perHostMs[idx]].sort((a, b) => a.start - b.start);
    if (ranges.length === 0) {
      hostWorkingHoursByDay.set(hostId, { start: 0, end: 0 });
      hostBusyByDay.set(hostId, []);
      return;
    }
    const start = ranges[0].start;
    const end = ranges[ranges.length - 1].end;
    hostWorkingHoursByDay.set(hostId, { start, end });
    // Busy = the gaps BETWEEN consecutive free ranges (a meeting between them).
    const busy: BusyInterval[] = [];
    for (let i = 1; i < ranges.length; i++) {
      const gapStart = ranges[i - 1].end;
      const gapEnd = ranges[i].start;
      if (gapEnd > gapStart) busy.push({ start: gapStart, end: gapEnd });
    }
    hostBusyByDay.set(hostId, busy);
  });

  const emptyFocus = new Map<string, BusyInterval[]>();
  const emptyPreferred = new Map<string, PreferredWindow[]>();

  const enumerated: EnumeratedSlot[] = surviving.map((s) => {
    const eligibleHostIds = isRoundRobin
      ? (s.eligibleHostIdxs ?? []).map((i) => hostIds[i])
      : hostIds; // collective => full fixed roster
    return { start: s.startMs, end: s.endMs, eligibleHostIds };
  });

  // Required-host denominator for the fraction terms: for collective the full
  // roster matters; for RR we use the union of all eligible hosts so the per-day
  // maps cover everyone the scorer might inspect.
  const requiredHostIds = hostIds;

  const ctxRank: RankingContext = {
    now: args.now,
    windowEnd: args.windowEnd,
    candidateTz: args.viewerTimeZone,
    requiredHostIds,
    hostBusyByDay,
    hostFocusBlocksByDay: emptyFocus,
    hostWorkingHoursByDay,
    hostPreferredWindows: emptyPreferred,
    hostBookingCounts,
    roundRobin: isRoundRobin,
    eventType: {
      durationMinutes: args.durationMinutes,
      bufferBeforeMs: args.bufferBeforeMs,
      bufferAfterMs: args.bufferAfterMs,
    },
  };

  const rankedEnum = rankSlots(enumerated, ctxRank);
  // Map ranked EnumeratedSlots back to AvailableSlot entries (preserve eligibleHostIdxs).
  const byStart = new Map<number, AvailableSlot>();
  for (const s of surviving) byStart.set(s.startMs, s);
  return rankedEnum.map((r) => byStart.get(r.start)!).filter(Boolean);
}

export const getAvailableSlots = query({
  args: {
    eventTypeId: v.optional(v.id("eventTypes")),
    slug: v.optional(v.string()),
    windowStart: v.number(),
    windowEnd: v.number(),
    viewerTimeZone: v.string(),
    nowMs: v.optional(v.number()),
  },
  handler: getAvailableSlotsHandler,
});
