import { describe, expect, it } from "vitest";

import { checkForConflicts } from "./conflicts";
import dayjs from "./dayjs";

describe("checkForConflicts", () => {
  it("returns false when there are no busy times", () => {
    expect(
      checkForConflicts({
        busy: [],
        time: dayjs.utc("2025-06-04T10:00:00Z"),
        eventLength: 60,
      })
    ).toBe(false);
  });

  it("returns true when the slot overlaps a busy block", () => {
    expect(
      checkForConflicts({
        busy: [{ start: "2025-06-04T10:30:00Z", end: "2025-06-04T11:30:00Z" }],
        time: dayjs.utc("2025-06-04T10:00:00Z"),
        eventLength: 60, // 10:00-11:00 overlaps 10:30-11:30
      })
    ).toBe(true);
  });

  it("returns false when busy is strictly before the slot", () => {
    expect(
      checkForConflicts({
        busy: [{ start: "2025-06-04T08:00:00Z", end: "2025-06-04T10:00:00Z" }],
        time: dayjs.utc("2025-06-04T10:00:00Z"),
        eventLength: 60, // 10:00-11:00, busy ends exactly at 10:00
      })
    ).toBe(false);
  });

  it("returns false when busy is strictly after the slot", () => {
    expect(
      checkForConflicts({
        busy: [{ start: "2025-06-04T11:00:00Z", end: "2025-06-04T12:00:00Z" }],
        time: dayjs.utc("2025-06-04T10:00:00Z"),
        eventLength: 60, // slot ends exactly at 11:00
      })
    ).toBe(false);
  });

  it("returns false when a seat already exists at the slot time", () => {
    expect(
      checkForConflicts({
        busy: [{ start: "2025-06-04T10:00:00Z", end: "2025-06-04T11:00:00Z" }],
        time: dayjs.utc("2025-06-04T10:00:00Z"),
        eventLength: 60,
        currentSeats: [{ startTime: new Date("2025-06-04T10:00:00Z") }],
      })
    ).toBe(false);
  });

  it("accepts Date-typed busy bounds", () => {
    expect(
      checkForConflicts({
        busy: [{ start: new Date("2025-06-04T10:30:00Z"), end: new Date("2025-06-04T11:30:00Z") }],
        time: dayjs.utc("2025-06-04T10:00:00Z"),
        eventLength: 60,
      })
    ).toBe(true);
  });
});
