import { describe, expect, it } from "vitest";

import {
  filterRedundantDateRanges,
  getAggregatedAvailability,
  mergeOverlappingDateRanges,
} from "./aggregate";
import dayjs from "./dayjs";
import type { DateRange } from "./types";

function range(start: string, end: string): DateRange {
  return { start: dayjs.utc(start), end: dayjs.utc(end) };
}

function hostAvailability(ranges: DateRange[], user?: { isFixed?: boolean; groupId?: string | null }) {
  return { dateRanges: ranges, oooExcludedDateRanges: ranges, user };
}

describe("getAggregatedAvailability - COLLECTIVE", () => {
  it("returns the intersection of two collective (fixed) hosts", () => {
    const hostA = hostAvailability([range("2025-06-04T09:00:00Z", "2025-06-04T15:00:00Z")], {
      isFixed: true,
    });
    const hostB = hostAvailability([range("2025-06-04T12:00:00Z", "2025-06-04T18:00:00Z")], {
      isFixed: true,
    });

    const result = getAggregatedAvailability([hostA, hostB], "COLLECTIVE");

    expect(result).toHaveLength(1);
    expect(result[0].start.toISOString()).toBe("2025-06-04T12:00:00.000Z");
    expect(result[0].end.toISOString()).toBe("2025-06-04T15:00:00.000Z");
  });

  it("returns empty when non-overlapping hosts are all fixed", () => {
    // Fixed hosts must ALL be free (intersection). A host without an explicit
    // isFixed flag is also treated as round-robin by the grouping step, so to
    // exercise pure intersection-only behavior the hosts must be isFixed: true.
    const hostA = hostAvailability([range("2025-06-04T09:00:00Z", "2025-06-04T11:00:00Z")], {
      isFixed: true,
    });
    const hostB = hostAvailability([range("2025-06-04T13:00:00Z", "2025-06-04T15:00:00Z")], {
      isFixed: true,
    });

    const result = getAggregatedAvailability([hostA, hostB], "COLLECTIVE");
    expect(result).toHaveLength(0);
  });

  it("intersects across multiple separate windows per host", () => {
    const hostA = hostAvailability(
      [
        range("2025-06-04T09:00:00Z", "2025-06-04T12:00:00Z"),
        range("2025-06-04T14:00:00Z", "2025-06-04T17:00:00Z"),
      ],
      { isFixed: true }
    );
    const hostB = hostAvailability([range("2025-06-04T11:00:00Z", "2025-06-04T15:00:00Z")], {
      isFixed: true,
    });

    const result = getAggregatedAvailability([hostA, hostB], "COLLECTIVE");
    expect(result).toHaveLength(2);
    expect(result[0].start.toISOString()).toBe("2025-06-04T11:00:00.000Z");
    expect(result[0].end.toISOString()).toBe("2025-06-04T12:00:00.000Z");
    expect(result[1].start.toISOString()).toBe("2025-06-04T14:00:00.000Z");
    expect(result[1].end.toISOString()).toBe("2025-06-04T15:00:00.000Z");
  });
});

describe("getAggregatedAvailability - ROUND_ROBIN", () => {
  it("unions round-robin hosts in the default group", () => {
    // Round-robin: at least one host per group must be free, so the group's
    // availability is the union of its hosts' ranges.
    const hostA = hostAvailability(
      [range("2025-06-04T09:00:00Z", "2025-06-04T11:00:00Z")],
      { isFixed: false }
    );
    const hostB = hostAvailability(
      [range("2025-06-04T13:00:00Z", "2025-06-04T15:00:00Z")],
      { isFixed: false }
    );

    const result = getAggregatedAvailability([hostA, hostB], "ROUND_ROBIN");
    // Both windows should survive as bookable (someone is free in each).
    const iso = result.map((r) => [r.start.toISOString(), r.end.toISOString()]);
    expect(iso).toContainEqual(["2025-06-04T09:00:00.000Z", "2025-06-04T11:00:00.000Z"]);
    expect(iso).toContainEqual(["2025-06-04T13:00:00.000Z", "2025-06-04T15:00:00.000Z"]);
  });
});

describe("mergeOverlappingDateRanges", () => {
  it("merges overlapping ranges into one", () => {
    const merged = mergeOverlappingDateRanges([
      range("2025-06-04T09:00:00Z", "2025-06-04T12:00:00Z"),
      range("2025-06-04T11:00:00Z", "2025-06-04T14:00:00Z"),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].start.toISOString()).toBe("2025-06-04T09:00:00.000Z");
    expect(merged[0].end.toISOString()).toBe("2025-06-04T14:00:00.000Z");
  });

  it("keeps disjoint ranges separate", () => {
    const merged = mergeOverlappingDateRanges([
      range("2025-06-04T09:00:00Z", "2025-06-04T10:00:00Z"),
      range("2025-06-04T12:00:00Z", "2025-06-04T13:00:00Z"),
    ]);
    expect(merged).toHaveLength(2);
  });
});

describe("filterRedundantDateRanges", () => {
  it("removes a range fully contained by another", () => {
    const filtered = filterRedundantDateRanges([
      range("2025-06-04T09:00:00Z", "2025-06-04T17:00:00Z"),
      range("2025-06-04T10:00:00Z", "2025-06-04T12:00:00Z"),
    ]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].start.toISOString()).toBe("2025-06-04T09:00:00.000Z");
    expect(filtered[0].end.toISOString()).toBe("2025-06-04T17:00:00.000Z");
  });

  it("keeps merely-overlapping (non-contained) ranges", () => {
    const filtered = filterRedundantDateRanges([
      range("2025-06-04T09:00:00Z", "2025-06-04T12:00:00Z"),
      range("2025-06-04T11:00:00Z", "2025-06-04T14:00:00Z"),
    ]);
    expect(filtered).toHaveLength(2);
  });
});
