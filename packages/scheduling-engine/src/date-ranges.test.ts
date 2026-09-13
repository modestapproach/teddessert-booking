import { describe, expect, it } from "vitest";

import dayjs from "./dayjs";
import {
  buildDateRanges,
  intersect,
  processDateOverride,
  subtract,
} from "./date-ranges";
import type { DateOverride, DateRange, WorkingHours } from "./types";

// Helper: build a wall-clock, midnight-anchored UTC Date for an availability
// start/end time. cal.diy stores `startTime`/`endTime` this way and reads them
// via `.getUTCHours()` / `.getUTCMinutes()`.
function timeUtc(hours: number, minutes = 0): Date {
  return new Date(Date.UTC(1970, 0, 1, hours, minutes));
}

// Helper: a DateRange from two ISO-ish dayjs-parseable inputs in a tz.
function range(start: string, end: string): DateRange {
  return { start: dayjs.utc(start), end: dayjs.utc(end) };
}

describe("intersect", () => {
  it("returns the overlap of two overlapping ranges", () => {
    const result = intersect([
      [range("2025-06-02T09:00:00Z", "2025-06-02T12:00:00Z")],
      [range("2025-06-02T10:00:00Z", "2025-06-02T14:00:00Z")],
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].start.toISOString()).toBe("2025-06-02T10:00:00.000Z");
    expect(result[0].end.toISOString()).toBe("2025-06-02T12:00:00.000Z");
  });

  it("returns empty for adjacent (touching) ranges", () => {
    const result = intersect([
      [range("2025-06-02T09:00:00Z", "2025-06-02T10:00:00Z")],
      [range("2025-06-02T10:00:00Z", "2025-06-02T11:00:00Z")],
    ]);
    expect(result).toHaveLength(0);
  });

  it("returns the contained range when one fully contains the other", () => {
    const result = intersect([
      [range("2025-06-02T08:00:00Z", "2025-06-02T18:00:00Z")],
      [range("2025-06-02T10:00:00Z", "2025-06-02T12:00:00Z")],
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].start.toISOString()).toBe("2025-06-02T10:00:00.000Z");
    expect(result[0].end.toISOString()).toBe("2025-06-02T12:00:00.000Z");
  });

  it("returns empty for non-overlapping ranges", () => {
    const result = intersect([
      [range("2025-06-02T09:00:00Z", "2025-06-02T10:00:00Z")],
      [range("2025-06-02T11:00:00Z", "2025-06-02T12:00:00Z")],
    ]);
    expect(result).toHaveLength(0);
  });
});

describe("subtract", () => {
  it("splits a source range around an excluded range inside it", () => {
    const result = subtract(
      [range("2025-06-02T09:00:00Z", "2025-06-02T17:00:00Z")],
      [range("2025-06-02T12:00:00Z", "2025-06-02T13:00:00Z")]
    );
    expect(result).toHaveLength(2);
    expect(result[0].start.toISOString()).toBe("2025-06-02T09:00:00.000Z");
    expect(result[0].end.toISOString()).toBe("2025-06-02T12:00:00.000Z");
    expect(result[1].start.toISOString()).toBe("2025-06-02T13:00:00.000Z");
    expect(result[1].end.toISOString()).toBe("2025-06-02T17:00:00.000Z");
  });

  it("trims the front when the excluded range overlaps the start", () => {
    const result = subtract(
      [range("2025-06-02T09:00:00Z", "2025-06-02T17:00:00Z")],
      [range("2025-06-02T08:00:00Z", "2025-06-02T11:00:00Z")]
    );
    expect(result).toHaveLength(1);
    expect(result[0].start.toISOString()).toBe("2025-06-02T11:00:00.000Z");
    expect(result[0].end.toISOString()).toBe("2025-06-02T17:00:00.000Z");
  });

  it("leaves the source untouched for an adjacent excluded range", () => {
    const result = subtract(
      [range("2025-06-02T09:00:00Z", "2025-06-02T17:00:00Z")],
      [range("2025-06-02T17:00:00Z", "2025-06-02T18:00:00Z")]
    );
    expect(result).toHaveLength(1);
    expect(result[0].start.toISOString()).toBe("2025-06-02T09:00:00.000Z");
    expect(result[0].end.toISOString()).toBe("2025-06-02T17:00:00.000Z");
  });

  it("removes the whole source when fully contained in an excluded range", () => {
    const result = subtract(
      [range("2025-06-02T10:00:00Z", "2025-06-02T11:00:00Z")],
      [range("2025-06-02T09:00:00Z", "2025-06-02T12:00:00Z")]
    );
    expect(result).toHaveLength(0);
  });

  it("preserves pass-through props on subtracted ranges", () => {
    const result = subtract(
      [{ ...range("2025-06-02T09:00:00Z", "2025-06-02T17:00:00Z"), userId: 42 }],
      [range("2025-06-02T12:00:00Z", "2025-06-02T13:00:00Z")]
    );
    expect(result).toHaveLength(2);
    expect(result[0].userId).toBe(42);
    expect(result[1].userId).toBe(42);
  });

  it("leaves source untouched when there are no exclusions", () => {
    const result = subtract([range("2025-06-02T09:00:00Z", "2025-06-02T17:00:00Z")], []);
    expect(result).toHaveLength(1);
    expect(result[0].start.toISOString()).toBe("2025-06-02T09:00:00.000Z");
    expect(result[0].end.toISOString()).toBe("2025-06-02T17:00:00.000Z");
  });
});

describe("buildDateRanges - working hours", () => {
  // A Mon-Fri 09:00-17:00 schedule. days are 0=Sun..6=Sat.
  const nineToFiveWeekdays: WorkingHours = {
    days: [1, 2, 3, 4, 5],
    startTime: timeUtc(9),
    endTime: timeUtc(17),
  };

  it("produces a 09:00-17:00 local window on a normal weekday", () => {
    // 2025-06-04 is a Wednesday. America/New_York = EDT (UTC-4) in June.
    const { dateRanges } = buildDateRanges({
      availability: [nineToFiveWeekdays],
      timeZone: "America/New_York",
      dateFrom: dayjs.utc("2025-06-04T00:00:00Z").tz("America/New_York"),
      dateTo: dayjs.utc("2025-06-05T00:00:00Z").tz("America/New_York"),
      travelSchedules: [],
    });
    const wed = dateRanges.find((r) => r.start.tz("America/New_York").format("YYYY-MM-DD") === "2025-06-04");
    expect(wed).toBeDefined();
    expect(wed!.start.tz("America/New_York").format("HH:mm")).toBe("09:00");
    expect(wed!.end.tz("America/New_York").format("HH:mm")).toBe("17:00");
    // 09:00 EDT == 13:00 UTC
    expect(wed!.start.toISOString()).toBe("2025-06-04T13:00:00.000Z");
    expect(wed!.end.toISOString()).toBe("2025-06-04T21:00:00.000Z");
  });

  it("keeps wall-clock 09:00-17:00 across the US spring-forward DST day", () => {
    // 2025-03-09 is the US spring-forward day (Sun). 2025-03-10 is Monday.
    // The offsetDiff correction should keep the Monday window at wall-clock 09:00-17:00.
    const { dateRanges } = buildDateRanges({
      availability: [nineToFiveWeekdays],
      timeZone: "America/New_York",
      dateFrom: dayjs.utc("2025-03-07T00:00:00Z").tz("America/New_York"),
      dateTo: dayjs.utc("2025-03-12T00:00:00Z").tz("America/New_York"),
      travelSchedules: [],
    });
    // Friday before DST (EST, UTC-5)
    const fri = dateRanges.find((r) => r.start.tz("America/New_York").format("YYYY-MM-DD") === "2025-03-07");
    // Monday after DST (EDT, UTC-4)
    const mon = dateRanges.find((r) => r.start.tz("America/New_York").format("YYYY-MM-DD") === "2025-03-10");
    expect(fri).toBeDefined();
    expect(mon).toBeDefined();
    expect(fri!.start.tz("America/New_York").format("HH:mm")).toBe("09:00");
    expect(fri!.end.tz("America/New_York").format("HH:mm")).toBe("17:00");
    expect(mon!.start.tz("America/New_York").format("HH:mm")).toBe("09:00");
    expect(mon!.end.tz("America/New_York").format("HH:mm")).toBe("17:00");
    // Confirm the UTC instants actually differ by the DST hour shift.
    expect(fri!.start.toISOString()).toBe("2025-03-07T14:00:00.000Z"); // EST
    expect(mon!.start.toISOString()).toBe("2025-03-10T13:00:00.000Z"); // EDT
  });

  it("keeps wall-clock 09:00-17:00 across the US fall-back DST day", () => {
    // 2025-11-02 is the US fall-back day (Sun). Friday 10-31 EDT, Monday 11-03 EST.
    const { dateRanges } = buildDateRanges({
      availability: [nineToFiveWeekdays],
      timeZone: "America/New_York",
      dateFrom: dayjs.utc("2025-10-31T00:00:00Z").tz("America/New_York"),
      dateTo: dayjs.utc("2025-11-05T00:00:00Z").tz("America/New_York"),
      travelSchedules: [],
    });
    const fri = dateRanges.find((r) => r.start.tz("America/New_York").format("YYYY-MM-DD") === "2025-10-31");
    const mon = dateRanges.find((r) => r.start.tz("America/New_York").format("YYYY-MM-DD") === "2025-11-03");
    expect(fri).toBeDefined();
    expect(mon).toBeDefined();
    expect(fri!.start.tz("America/New_York").format("HH:mm")).toBe("09:00");
    expect(fri!.end.tz("America/New_York").format("HH:mm")).toBe("17:00");
    expect(mon!.start.tz("America/New_York").format("HH:mm")).toBe("09:00");
    expect(mon!.end.tz("America/New_York").format("HH:mm")).toBe("17:00");
    expect(fri!.start.toISOString()).toBe("2025-10-31T13:00:00.000Z"); // EDT
    expect(mon!.start.toISOString()).toBe("2025-11-03T14:00:00.000Z"); // EST
  });

  it("handles a half-hour-offset zone (Asia/Kolkata, GMT+5:30)", () => {
    // 2025-06-04 Wednesday. IST is a fixed UTC+5:30, no DST.
    const { dateRanges } = buildDateRanges({
      availability: [nineToFiveWeekdays],
      timeZone: "Asia/Kolkata",
      dateFrom: dayjs.utc("2025-06-04T00:00:00Z").tz("Asia/Kolkata"),
      dateTo: dayjs.utc("2025-06-05T00:00:00Z").tz("Asia/Kolkata"),
      travelSchedules: [],
    });
    const wed = dateRanges.find((r) => r.start.tz("Asia/Kolkata").format("YYYY-MM-DD") === "2025-06-04");
    expect(wed).toBeDefined();
    expect(wed!.start.tz("Asia/Kolkata").format("HH:mm")).toBe("09:00");
    expect(wed!.end.tz("Asia/Kolkata").format("HH:mm")).toBe("17:00");
    // 09:00 IST == 03:30 UTC ; 17:00 IST == 11:30 UTC
    expect(wed!.start.toISOString()).toBe("2025-06-04T03:30:00.000Z");
    expect(wed!.end.toISOString()).toBe("2025-06-04T11:30:00.000Z");
  });
});

describe("processDateOverride", () => {
  it("produces a windowed range for an extended-hours override", () => {
    const item: DateOverride = {
      date: new Date(Date.UTC(2025, 5, 7)), // 2025-06-07 (a Saturday, normally off)
      startTime: timeUtc(8),
      endTime: timeUtc(20),
    };
    const result = processDateOverride({
      item,
      itemDateAsUtc: dayjs.utc("2025-06-07"),
      timeZone: "America/New_York",
      travelSchedules: [],
    });
    // keepLocalTime (.tz(tz, true)) reinterprets 08:00/20:00 as wall-clock NY.
    expect(result.start.tz("America/New_York").format("YYYY-MM-DD HH:mm")).toBe("2025-06-07 08:00");
    expect(result.end.tz("America/New_York").format("YYYY-MM-DD HH:mm")).toBe("2025-06-07 20:00");
    // 08:00 EDT == 12:00 UTC ; 20:00 EDT == 00:00 next day UTC
    expect(result.start.toISOString()).toBe("2025-06-07T12:00:00.000Z");
    expect(result.end.toISOString()).toBe("2025-06-08T00:00:00.000Z");
  });

  it("collapses a day-off override (00:00-00:00) to a zero-length range", () => {
    // A day-off override is stored as startTime === endTime; buildDateRanges
    // later filters zero-length ranges out to cancel a working day.
    const item: DateOverride = {
      date: new Date(Date.UTC(2025, 5, 4)),
      startTime: timeUtc(0),
      endTime: timeUtc(0),
    };
    const result = processDateOverride({
      item,
      itemDateAsUtc: dayjs.utc("2025-06-04"),
      timeZone: "America/New_York",
      travelSchedules: [],
    });
    expect(result.start.valueOf()).toBe(result.end.valueOf());
  });

  it("cancels a working day via a day-off override in buildDateRanges", () => {
    const nineToFive: WorkingHours = {
      days: [1, 2, 3, 4, 5],
      startTime: timeUtc(9),
      endTime: timeUtc(17),
    };
    const dayOff: DateOverride = {
      date: new Date(Date.UTC(2025, 5, 4)), // cancel Wed 2025-06-04
      startTime: timeUtc(0),
      endTime: timeUtc(0),
    };
    const { dateRanges } = buildDateRanges({
      availability: [nineToFive, dayOff],
      timeZone: "America/New_York",
      dateFrom: dayjs.utc("2025-06-04T00:00:00Z").tz("America/New_York"),
      dateTo: dayjs.utc("2025-06-05T00:00:00Z").tz("America/New_York"),
      travelSchedules: [],
    });
    const wed = dateRanges.find((r) => r.start.tz("America/New_York").format("YYYY-MM-DD") === "2025-06-04");
    expect(wed).toBeUndefined();
  });
});
