// E2 — unit tests for the pure slot-ranking scorer (`ranking.ts`).
//
// Each term is isolated by zeroing all weights except the one under test, so the
// total score reduces to that single term. We assert ORDERING (which slot ranks
// higher), not exact magnitudes, plus a couple of concrete component values and
// the top-K truncation + deterministic tie-break.
import { describe, it, expect } from "vitest";
import {
  scoreSlot,
  rankSlots,
  earliness,
  fragmentation,
  loadImbalance,
  tzFairness,
  bufferComfort,
  interviewerPreference,
  DEFAULT_WEIGHTS,
  type RankingContext,
  type EnumeratedSlot,
  type ScoringWeights,
  type BusyInterval,
} from "./ranking";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Mon 2027-06-07.
const MON_9 = Date.UTC(2027, 5, 7, 9, 0, 0);
const WINDOW_END = Date.UTC(2027, 5, 14, 0, 0, 0); // one week out
const NOW = Date.UTC(2027, 5, 6, 0, 0, 0); // Sunday before

// Build a context. Defaults give a single host "h1" on a 9–17 UTC workday with no
// busy/focus/preferences and load 0; override per-test.
function makeCtx(over: Partial<RankingContext> = {}): RankingContext {
  const wh = { start: MON_9, end: Date.UTC(2027, 5, 7, 17, 0, 0) };
  return {
    now: NOW,
    windowEnd: WINDOW_END,
    candidateTz: "UTC",
    requiredHostIds: ["h1"],
    hostBusyByDay: new Map([["h1", []]]),
    hostFocusBlocksByDay: new Map([["h1", []]]),
    hostWorkingHoursByDay: new Map([["h1", wh]]),
    hostPreferredWindows: new Map(),
    hostBookingCounts: new Map([["h1", 0]]),
    roundRobin: false,
    eventType: { durationMinutes: 60, bufferBeforeMs: 0, bufferAfterMs: 0 },
    ...over,
  };
}

function slot(start: number, eligible: string[] = ["h1"]): EnumeratedSlot {
  return { start, end: start + HOUR, eligibleHostIds: eligible };
}

// Weights with everything zero except one term set to 1.
function only(term: keyof ScoringWeights): ScoringWeights {
  const w: ScoringWeights = {
    w_early: 0,
    w_frag: 0,
    w_btb: 0,
    w_focus: 0,
    w_load: 0,
    w_tzfair: 0,
    w_pref: 0,
    w_dur: 0,
  };
  w[term] = 1;
  return w;
}

describe("DEFAULT_WEIGHTS", () => {
  it("sum to 1.0 so a fully-weighted score stays in [0,1]", () => {
    const sum = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });
});

describe("earliness", () => {
  it("an EARLIER slot ranks higher than a later one", () => {
    const ctx = makeCtx();
    const early = slot(MON_9); // Mon 09:00
    const late = slot(MON_9 + 3 * DAY); // Thu 09:00 — later in window & same workday start
    expect(earliness(early, ctx)).toBeGreaterThan(earliness(late, ctx));
    // And reflected through the weighted score with only earliness active.
    const w = only("w_early");
    expect(scoreSlot(early, ctx, w)).toBeGreaterThan(scoreSlot(late, ctx, w));
  });

  it("within a day, an earlier-in-workday start ranks higher", () => {
    const ctx = makeCtx();
    const nine = slot(MON_9);
    const four = slot(Date.UTC(2027, 5, 7, 16, 0, 0));
    expect(earliness(nine, ctx)).toBeGreaterThan(earliness(four, ctx));
  });
});

describe("fragmentation", () => {
  it("a slot that strands a lone sub-30min gap ranks LOWER than one that does not", () => {
    // Host busy 10:30–17:00. Workday 9–17.
    // Slot A = 9:00–10:00 → leaves 10:00–10:30 (30min, not < 30) as the only gap;
    //   but the trailing 10:30-17:00 is busy → residual stub = exactly 30 (not <30) → 0 stranded.
    // Slot B = 9:30–10:30 → leaves 9:00–9:30 (30min) before it and nothing useful
    //   after; the 9:00–9:30 stub IS a stranded <30? 30 is NOT < 30, so craft a
    //   tighter case below.
    const busy: BusyInterval[] = [
      { start: Date.UTC(2027, 5, 7, 10, 20, 0), end: Date.UTC(2027, 5, 7, 17, 0, 0) },
    ];
    const ctx = makeCtx({ hostBusyByDay: new Map([["h1", busy]]) });
    // Slot stranding a lone gap: 9:20–10:20 leaves 9:00–9:20 (20min < 30) stranded.
    const strands = slot(Date.UTC(2027, 5, 7, 9, 20, 0));
    // Clean slot: 9:00–10:00 leaves 10:00–10:20 (20min) stranded too — to make a
    // genuinely cleaner comparison, give the clean slot a day with NO busy.
    const cleanCtx = makeCtx();
    const clean = slot(MON_9);
    expect(fragmentation(clean, cleanCtx)).toBe(0);
    expect(fragmentation(strands, ctx)).toBeGreaterThan(0);
    // Lower fragmentation ⇒ higher score (term is inverted in the sum).
    const w = only("w_frag");
    expect(scoreSlot(clean, cleanCtx, w)).toBeGreaterThan(
      scoreSlot(strands, ctx, w),
    );
  });
});

describe("loadImbalance (round-robin load balance)", () => {
  it("prefers the slot whose eligible pool contains the LESS-booked host", () => {
    // Pool: busy host h_busy=5 bookings, idle host h_idle=0.
    const ctx = makeCtx({
      roundRobin: true,
      requiredHostIds: ["h_busy", "h_idle"],
      hostBookingCounts: new Map([
        ["h_busy", 5],
        ["h_idle", 0],
      ]),
      hostWorkingHoursByDay: new Map([
        ["h_busy", { start: MON_9, end: Date.UTC(2027, 5, 7, 17, 0, 0) }],
        ["h_idle", { start: MON_9, end: Date.UTC(2027, 5, 7, 17, 0, 0) }],
      ]),
      hostBusyByDay: new Map([
        ["h_busy", []],
        ["h_idle", []],
      ]),
      hostFocusBlocksByDay: new Map([
        ["h_busy", []],
        ["h_idle", []],
      ]),
    });
    const onlyBusyFree = slot(MON_9, ["h_busy"]); // best load = 5 (high imbalance)
    const idleFree = slot(MON_9, ["h_idle"]); // best load = 0 (no imbalance)
    // idleFree has lower imbalance → after inversion, higher load-score.
    expect(loadImbalance(idleFree, ctx)).toBeLessThan(
      loadImbalance(onlyBusyFree, ctx),
    );
    const w = only("w_load");
    expect(scoreSlot(idleFree, ctx, w)).toBeGreaterThan(
      scoreSlot(onlyBusyFree, ctx, w),
    );
  });

  it("collective contributes no load imbalance (term = 0)", () => {
    const ctx = makeCtx({ roundRobin: false });
    expect(loadImbalance(slot(MON_9), ctx)).toBe(0);
  });
});

describe("tzFairness", () => {
  it("a slot at 13:00 candidate-local beats an early-morning one", () => {
    const ctx = makeCtx({ candidateTz: "UTC" });
    const onePm = slot(Date.UTC(2027, 5, 7, 13, 0, 0));
    const sixAm = slot(Date.UTC(2027, 5, 7, 6, 0, 0)); // outside 08–18 → 0
    expect(tzFairness(onePm, ctx)).toBeGreaterThan(tzFairness(sixAm, ctx));
    expect(tzFairness(onePm, ctx)).toBeCloseTo(1, 6);
    expect(tzFairness(sixAm, ctx)).toBe(0);
  });
});

describe("bufferComfort", () => {
  it("a slot with more breathing room to neighbours ranks higher", () => {
    // Busy 11:00–12:00. Slot ending well before it has more comfort.
    const busy: BusyInterval[] = [
      { start: Date.UTC(2027, 5, 7, 11, 0, 0), end: Date.UTC(2027, 5, 7, 12, 0, 0) },
    ];
    const ctx = makeCtx({ hostBusyByDay: new Map([["h1", busy]]) });
    const cozy = slot(Date.UTC(2027, 5, 7, 9, 0, 0)); // ends 10:00, 60min gap
    const cramped = slot(Date.UTC(2027, 5, 7, 9, 50, 0)); // ends 10:50, 10min gap
    expect(bufferComfort(cozy, ctx)).toBeGreaterThan(bufferComfort(cramped, ctx));
  });
});

describe("interviewerPreference", () => {
  it("returns neutral 0.5 when no host has a preferred window", () => {
    const ctx = makeCtx();
    expect(interviewerPreference(slot(MON_9), ctx)).toBe(0.5);
  });

  it("scores higher when the slot falls in the host's preferred window", () => {
    const ctx = makeCtx({
      hostPreferredWindows: new Map([
        ["h1", [{ days: [1], startMinute: 9 * 60, endMinute: 11 * 60 }]], // Mon 9–11
      ]),
    });
    const inWindow = slot(MON_9); // Mon 09:00 → covered
    const outWindow = slot(Date.UTC(2027, 5, 7, 14, 0, 0)); // Mon 14:00 → not covered
    expect(interviewerPreference(inWindow, ctx)).toBeGreaterThan(
      interviewerPreference(outWindow, ctx),
    );
  });
});

describe("rankSlots", () => {
  it("sorts best-first and truncates to top-K", () => {
    // Hold the local-hour (and thus every term except earliness's window-decay)
    // CONSTANT by placing each candidate at 13:00 local on a DIFFERENT day. Then
    // the only differentiator is how soon the day is → earlier day ranks higher.
    const onePm = (dayOffset: number) =>
      slot(Date.UTC(2027, 5, 7, 13, 0, 0) + dayOffset * DAY);
    const ctx = makeCtx({
      // Working hours span the whole week so within-day earliness is equal at 13:00.
      hostWorkingHoursByDay: new Map([
        ["h1", { start: MON_9, end: Date.UTC(2027, 5, 7, 17, 0, 0) }],
      ]),
    });
    const slots: EnumeratedSlot[] = [onePm(3), onePm(0), onePm(1), onePm(5)];
    const ranked = rankSlots(slots, ctx, { topK: 2 });
    expect(ranked).toHaveLength(2);
    // Best-first: the two soonest days survive, soonest first.
    expect(ranked[0].start).toBe(Date.UTC(2027, 5, 7, 13, 0, 0));
    expect(ranked[1].start).toBe(Date.UTC(2027, 5, 7, 13, 0, 0) + 1 * DAY);
    // Scores are descending.
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score);
  });

  it("breaks score ties by earliest start, then lexicographic host id (deterministic)", () => {
    // Two slots at the SAME start with identical scoring inputs but different
    // host ids → tie-break must be deterministic on eligibleHostIds[0].
    const ctx = makeCtx({
      requiredHostIds: ["hz"],
      hostWorkingHoursByDay: new Map([
        ["hz", { start: MON_9, end: Date.UTC(2027, 5, 7, 17, 0, 0) }],
        ["ha", { start: MON_9, end: Date.UTC(2027, 5, 7, 17, 0, 0) }],
      ]),
      hostBusyByDay: new Map([
        ["hz", []],
        ["ha", []],
      ]),
      hostFocusBlocksByDay: new Map([
        ["hz", []],
        ["ha", []],
      ]),
      hostBookingCounts: new Map([
        ["hz", 0],
        ["ha", 0],
      ]),
    });
    const sZ: EnumeratedSlot = { start: MON_9, end: MON_9 + HOUR, eligibleHostIds: ["hz"] };
    const sA: EnumeratedSlot = { start: MON_9, end: MON_9 + HOUR, eligibleHostIds: ["ha"] };
    const ranked = rankSlots([sZ, sA], ctx);
    // Equal score + equal start → "ha" sorts before "hz".
    expect(ranked[0].eligibleHostIds[0]).toBe("ha");
    expect(ranked[1].eligibleHostIds[0]).toBe("hz");
  });
});
