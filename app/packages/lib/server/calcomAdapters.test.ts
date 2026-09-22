import { describe, expect, it } from "vitest";

import { toCalSchedule } from "./calcomAdapters";

describe("toCalSchedule", () => {
  it("orders each day's slots by time even though Convex ranks them best-first", () => {
    // Convex E2 ranking: 1:00pm first, then alternating outward — exactly what
    // the public Booker showed before the adapter re-sorted.
    const at = (h: number, m: number) => Date.UTC(2026, 8, 24, h, m);
    const ranked = [at(13, 0), at(12, 45), at(13, 15), at(12, 30), at(13, 30), at(11, 45)];
    const result = toCalSchedule({
      slotsByDate: { "2026-09-24": ranked.map((startMs) => ({ startMs, endMs: startMs + 30 * 60_000 })) },
      hosts: [{ authUserId: "owner" }],
      eventTypeDurationMinutes: 30,
    });
    expect(result.slots["2026-09-24"].map((s) => s.time)).toEqual(
      [at(11, 45), at(12, 30), at(12, 45), at(13, 0), at(13, 15), at(13, 30)].map((ms) => new Date(ms).toISOString())
    );
  });

  it("does not mutate the Convex result", () => {
    const daySlots = [{ startMs: 2, endMs: 3 }, { startMs: 1, endMs: 2 }];
    toCalSchedule({ slotsByDate: { d: daySlots }, hosts: [], eventTypeDurationMinutes: 30 });
    expect(daySlots.map((s) => s.startMs)).toEqual([2, 1]);
  });
});
