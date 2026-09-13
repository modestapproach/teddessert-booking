// E2 — PURE slot-ranking scorer (no Convex, no I/O).
//
// `scoreSlot(slot, ctx, weights)` produces a `[0,1]` desirability score for one
// enumerated slot from a weighted sum of independent component terms; `rankSlots`
// scores every feasible slot, sorts best-first deterministically, and truncates
// to top-K. Every term returns `[0,1]` *before* weighting — penalty terms are
// inverted (`1 - penalty`) so all weights are positive and the total stays in
// `[0,1]` when the weights sum to 1.
//
// The scorer reads ONLY pre-fetched plain data on `RankingContext`; the caller
// (a Convex query) is responsible for loading freebusy / working-hours / booking
// counts from the DB before calling. tz conversions use the engine's `dayjs`
// (utc + timezone plugins already registered) — never Temporal, per PRD §4.1.
//
// Implements the weighted sum from the ranking-scorer spec (PRD §3):
//   score = w_early   * earliness
//         + w_frag    * (1 - fragmentation)
//         + w_btb     * (1 - backToBackPenalty)
//         + w_focus   * (1 - focusViolation)
//         + w_load    * (1 - loadImbalance)
//         + w_tzfair  * tzFairness
//         + w_pref    * interviewerPreference
//         + w_dur     * bufferComfort
import dayjs from "./dayjs";

// ── Public types ────────────────────────────────────────────────────────────

// One enumerated, already-feasible slot. Times are UTC epoch-ms. For round-robin
// `eligibleHostIds` carries every host free at this slot; for collective it
// carries the full required (all-fixed) roster.
export interface EnumeratedSlot {
  start: number; // UTC epoch-ms
  end: number; // UTC epoch-ms
  eligibleHostIds: string[];
}

export interface RankedSlot extends EnumeratedSlot {
  score: number;
}

// A busy / focus interval in UTC epoch-ms.
export interface BusyInterval {
  start: number;
  end: number;
}

// An optional per-host "preferred availability" mask (SavvyCal-style ranked
// availability). `days` are JS weekday numbers (0=Sun..6=Sat) interpreted in the
// candidate tz; `startMinute`/`endMinute` are minutes-from-midnight local.
export interface PreferredWindow {
  days: number[];
  startMinute: number;
  endMinute: number;
}

export interface RankingContext {
  now: number; // epoch-ms
  windowEnd: number; // epoch-ms (end of the booking window)
  candidateTz: string; // IANA tz id
  // The hosts whose calendars matter for THIS slot's required roster. For
  // collective this is every fixed host; for round-robin the picker passes the
  // eligible set (any-one-free). Used as the denominator for the fraction terms.
  requiredHostIds: string[];
  hostBusyByDay: Map<string, BusyInterval[]>; // per host, scoped to the slot day
  hostFocusBlocksByDay: Map<string, BusyInterval[]>; // focus-time blocks
  hostWorkingHoursByDay: Map<string, { start: number; end: number }>; // ms bounds
  hostPreferredWindows: Map<string, PreferredWindow[]>; // optional
  hostBookingCounts: Map<string, number>; // rolling weekly counts (load)
  // Whether load imbalance applies. Round-robin = a host gets PICKED, so the
  // slot's load term reflects the best (lowest-load) eligible host. Collective =
  // no host choice, so the load term contributes nothing (loadScore = 0).
  roundRobin: boolean;
  eventType: {
    durationMinutes: number;
    bufferBeforeMs: number;
    bufferAfterMs: number;
  };
}

export interface ScoringWeights {
  w_early: number;
  w_frag: number;
  w_btb: number;
  w_focus: number;
  w_load: number;
  w_tzfair: number;
  w_pref: number;
  w_dur: number;
}

// Tunable defaults. Must sum to 1.0 so a fully-weighted score stays in [0,1].
// Stored fixed for now; per-event-type / global tuning is a later open question
// (PRD §13.5).
export const DEFAULT_WEIGHTS: ScoringWeights = {
  w_early: 0.3,
  w_frag: 0.2,
  w_btb: 0.1,
  w_focus: 0.15,
  w_load: 0.1,
  w_tzfair: 0.1,
  w_pref: 0.03,
  w_dur: 0.02,
};

// ── Tunable constants ────────────────────────────────────────────────────────

const MS_PER_MIN = 60_000;
// Free gaps smaller than this (after inserting the slot) are "stranded" stubs.
export const MIN_USEFUL_GAP_MS = 30 * MS_PER_MIN;
// Breathing-room target the bufferComfort term saturates at.
export const TARGET_COMFORT_GAP_MS = 30 * MS_PER_MIN;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

// ── Component terms (each returns [0,1]) ─────────────────────────────────────

// 1. Earliness — earlier in the booking window AND earlier in the workday ranks
// higher. Blend 70% window-decay + 30% within-day.
export function earliness(slot: EnumeratedSlot, ctx: RankingContext): number {
  const span = ctx.windowEnd - ctx.now;
  const windowDecay =
    span > 0 ? clamp01(1 - (slot.start - ctx.now) / span) : 1;

  // Within-day: prefer earlier-in-workday starts, using the earliest host's
  // workday bounds. Absent bounds → neutral 0.5.
  let withinDay = 0.5;
  const firstHost = ctx.requiredHostIds[0];
  const wh = firstHost ? ctx.hostWorkingHoursByDay.get(firstHost) : undefined;
  if (wh && wh.end > wh.start) {
    const dur = wh.end - wh.start;
    withinDay = clamp01(1 - (slot.start - wh.start) / dur);
  }

  return clamp01(0.7 * windowDecay + 0.3 * withinDay);
}

// Subtract a set of busy intervals from one [start,end) range, returning the
// surviving free sub-ranges. Used by the fragmentation simulation.
function subtractIntervals(
  rangeStart: number,
  rangeEnd: number,
  busy: BusyInterval[],
): BusyInterval[] {
  let free: BusyInterval[] = [{ start: rangeStart, end: rangeEnd }];
  for (const b of busy) {
    const next: BusyInterval[] = [];
    for (const f of free) {
      if (b.end <= f.start || b.start >= f.end) {
        next.push(f); // no overlap
        continue;
      }
      if (b.start > f.start) next.push({ start: f.start, end: b.start });
      if (b.end < f.end) next.push({ start: b.end, end: f.end });
    }
    free = next;
  }
  return free.filter((f) => f.end > f.start);
}

// 2. Fragmentation (penalty) — simulate inserting the slot (+buffers) into each
// host's day; sum the sizes of the resulting tiny residual gaps (< MIN_USEFUL).
// Normalized by total working minutes. Higher = more fragmented.
export function fragmentation(
  slot: EnumeratedSlot,
  ctx: RankingContext,
): number {
  const slotBlock: BusyInterval = {
    start: slot.start - ctx.eventType.bufferBeforeMs,
    end: slot.end + ctx.eventType.bufferAfterMs,
  };
  let residual = 0;
  let worstCase = 0;
  for (const hostId of ctx.requiredHostIds) {
    const wh = ctx.hostWorkingHoursByDay.get(hostId);
    if (!wh || wh.end <= wh.start) continue;
    worstCase += wh.end - wh.start;
    const busy = [...(ctx.hostBusyByDay.get(hostId) ?? []), slotBlock];
    const gaps = subtractIntervals(wh.start, wh.end, busy);
    for (const g of gaps) {
      const size = g.end - g.start;
      if (size > 0 && size < MIN_USEFUL_GAP_MS) residual += size;
    }
  }
  if (worstCase <= 0) return 0;
  return clamp01(residual / worstCase);
}

// 3. Back-to-back (penalty) — fraction of required hosts whose existing meetings
// abut the slot (+buffers) with ZERO margin (an existing meeting ends within
// bufferBefore of slot.start, or starts within bufferAfter of slot.end).
export function backToBackPenalty(
  slot: EnumeratedSlot,
  ctx: RankingContext,
): number {
  const total = ctx.requiredHostIds.length;
  if (total === 0) return 0;
  const before = ctx.eventType.bufferBeforeMs;
  const after = ctx.eventType.bufferAfterMs;
  let adjacent = 0;
  for (const hostId of ctx.requiredHostIds) {
    const busy = ctx.hostBusyByDay.get(hostId) ?? [];
    const abuts = busy.some(
      (b) =>
        (b.end <= slot.start && slot.start - b.end <= before) ||
        (b.start >= slot.end && b.start - slot.end <= after),
    );
    if (abuts) adjacent += 1;
  }
  return clamp01(adjacent / total);
}

// 4. Focus violation (penalty) — fraction of required hosts whose focus-time
// blocks overlap the buffered slot window. Focus is treated as soft-busy: the
// slot is still feasible, just penalized.
export function focusViolation(
  slot: EnumeratedSlot,
  ctx: RankingContext,
): number {
  const total = ctx.requiredHostIds.length;
  if (total === 0) return 0;
  const winStart = slot.start - ctx.eventType.bufferBeforeMs;
  const winEnd = slot.end + ctx.eventType.bufferAfterMs;
  let violating = 0;
  for (const hostId of ctx.requiredHostIds) {
    const blocks = ctx.hostFocusBlocksByDay.get(hostId) ?? [];
    const overlaps = blocks.some((b) => b.start < winEnd && b.end > winStart);
    if (overlaps) violating += 1;
  }
  return clamp01(violating / total);
}

// 5. Load imbalance (penalty) — round-robin only. The slot's load reflects the
// BEST (lowest-load) eligible host, since that host is who gets picked at confirm.
// Normalized by the busiest pool member. Collective => 0 (no host choice).
export function loadImbalance(
  slot: EnumeratedSlot,
  ctx: RankingContext,
): number {
  if (!ctx.roundRobin) return 0;
  const ids = slot.eligibleHostIds;
  if (ids.length === 0) return 0;
  let bestLoad = Infinity;
  for (const id of ids) {
    const load = ctx.hostBookingCounts.get(id) ?? 0;
    if (load < bestLoad) bestLoad = load;
  }
  let maxLoad = 0;
  for (const v of ctx.hostBookingCounts.values()) {
    if (v > maxLoad) maxLoad = v;
  }
  if (!Number.isFinite(bestLoad)) return 0;
  return clamp01(bestLoad / (maxLoad || 1));
}

// 6. Tz fairness — convert slot.start to candidate local wall-clock; score by
// proximity to a civilized 08:00–18:00 window, peaking at 13:00 local. Outside
// the window → 0.
export function tzFairness(slot: EnumeratedSlot, ctx: RankingContext): number {
  const local = dayjs(slot.start).tz(ctx.candidateTz);
  const localHour = local.hour() + local.minute() / 60;
  if (localHour >= 8 && localHour < 18) {
    return clamp01(1 - Math.abs(localHour - 13) / 5);
  }
  return 0;
}

// 7. Interviewer preference — fraction of required hosts whose preferred window
// covers slot.start (in candidate tz). No preferences defined anywhere → neutral
// 0.5 so the term doesn't distort ranking.
export function interviewerPreference(
  slot: EnumeratedSlot,
  ctx: RankingContext,
): number {
  const total = ctx.requiredHostIds.length;
  if (total === 0) return 0.5;
  const local = dayjs(slot.start).tz(ctx.candidateTz);
  const day = local.day(); // 0=Sun..6=Sat
  const minutes = local.hour() * 60 + local.minute();

  let anyDefined = false;
  let covering = 0;
  for (const hostId of ctx.requiredHostIds) {
    const windows = ctx.hostPreferredWindows.get(hostId);
    if (!windows || windows.length === 0) continue;
    anyDefined = true;
    const covers = windows.some(
      (w) =>
        w.days.includes(day) &&
        minutes >= w.startMinute &&
        minutes < w.endMinute,
    );
    if (covers) covering += 1;
  }
  if (!anyDefined) return 0.5;
  return clamp01(covering / total);
}

// 8. Buffer comfort — reward extra breathing room beyond the minimum buffer.
// Score by the nearest neighbouring meeting across all required hosts (within
// the workday); saturates at TARGET_COMFORT_GAP_MS. No neighbours → full comfort.
export function bufferComfort(
  slot: EnumeratedSlot,
  ctx: RankingContext,
): number {
  let nearest = Infinity;
  for (const hostId of ctx.requiredHostIds) {
    const busy = ctx.hostBusyByDay.get(hostId) ?? [];
    for (const b of busy) {
      if (b.end <= slot.start) {
        nearest = Math.min(nearest, slot.start - b.end);
      } else if (b.start >= slot.end) {
        nearest = Math.min(nearest, b.start - slot.end);
      } else {
        nearest = 0; // overlapping (shouldn't happen for feasible slots)
      }
    }
  }
  if (!Number.isFinite(nearest)) return 1; // no neighbours → maximally comfy
  return clamp01(nearest / TARGET_COMFORT_GAP_MS);
}

// ── Weighted sum ─────────────────────────────────────────────────────────────

export function scoreSlot(
  slot: EnumeratedSlot,
  ctx: RankingContext,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): number {
  const score =
    weights.w_early * earliness(slot, ctx) +
    weights.w_frag * (1 - fragmentation(slot, ctx)) +
    weights.w_btb * (1 - backToBackPenalty(slot, ctx)) +
    weights.w_focus * (1 - focusViolation(slot, ctx)) +
    weights.w_load * (1 - loadImbalance(slot, ctx)) +
    weights.w_tzfair * tzFairness(slot, ctx) +
    weights.w_pref * interviewerPreference(slot, ctx) +
    weights.w_dur * bufferComfort(slot, ctx);
  return clamp01(score);
}

// ── rankSlots — score, sort best-first deterministically, top-K ──────────────

export function rankSlots(
  slots: EnumeratedSlot[],
  ctx: RankingContext,
  opts: { topK?: number; weights?: ScoringWeights } = {},
): RankedSlot[] {
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const scored: RankedSlot[] = slots.map((slot) => ({
    ...slot,
    score: scoreSlot(slot, ctx, weights),
  }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score; // descending score
    if (a.start !== b.start) return a.start - b.start; // earliest start
    // Fully deterministic tie-break (cache correctness, PRD §3.3).
    const ah = a.eligibleHostIds[0] ?? "";
    const bh = b.eligibleHostIds[0] ?? "";
    return ah < bh ? -1 : ah > bh ? 1 : 0;
  });
  if (opts.topK !== undefined && opts.topK >= 0) {
    return scored.slice(0, opts.topK);
  }
  return scored;
}
