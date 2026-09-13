import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import dayjs from "./dayjs";
import { buildSlotsWithDateRanges, getSlots } from "./slots";
import type { DateRange } from "./types";

function range(start: string, end: string): DateRange {
  return { start: dayjs.utc(start), end: dayjs.utc(end) };
}

// Pin "now" far in the past so minimumBookingNotice does not eat future slots
// unless a test explicitly sets it.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2020-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("buildSlotsWithDateRanges - interval alignment", () => {
  it("emits 30-min slots aligned to the half hour in UTC", () => {
    const slots = buildSlotsWithDateRanges({
      dateRanges: [range("2025-06-04T09:00:00Z", "2025-06-04T11:00:00Z")],
      frequency: 30,
      eventLength: 30,
      timeZone: "UTC",
      minimumBookingNotice: 0,
    });
    const times = slots.map((s) => s.time.utc().format("HH:mm"));
    expect(times).toEqual(["09:00", "09:30", "10:00", "10:30"]);
  });

  it("rounds a non-aligned start up to the next clean interval boundary", () => {
    // Range starts 09:05; with a 60-min interval the first slot rounds to 10:00.
    const slots = buildSlotsWithDateRanges({
      dateRanges: [range("2025-06-04T09:05:00Z", "2025-06-04T12:00:00Z")],
      frequency: 60,
      eventLength: 60,
      timeZone: "UTC",
      minimumBookingNotice: 0,
    });
    const times = slots.map((s) => s.time.utc().format("HH:mm"));
    expect(times).toEqual(["10:00", "11:00"]);
  });

  it("aligns minute-boundary checks in a half-hour-offset zone (Asia/Kolkata)", () => {
    // 03:30Z == 09:00 IST. 30-min slots should align to :00/:30 IST, which are
    // :30/:00 in UTC. Without the pre-conversion fix these would be misaligned.
    const slots = buildSlotsWithDateRanges({
      dateRanges: [range("2025-06-04T03:30:00Z", "2025-06-04T05:30:00Z")],
      frequency: 30,
      eventLength: 30,
      timeZone: "Asia/Kolkata",
      minimumBookingNotice: 0,
    });
    const localTimes = slots.map((s) => s.time.tz("Asia/Kolkata").format("HH:mm"));
    expect(localTimes).toEqual(["09:00", "09:30", "10:00", "10:30"]);
  });

  it("includes a slot that ends exactly at range.end (inclusive end boundary)", () => {
    const slots = buildSlotsWithDateRanges({
      dateRanges: [range("2025-06-04T09:00:00Z", "2025-06-04T10:00:00Z")],
      frequency: 60,
      eventLength: 60,
      timeZone: "UTC",
      minimumBookingNotice: 0,
    });
    expect(slots.map((s) => s.time.utc().format("HH:mm"))).toEqual(["09:00"]);
  });

  it("does not emit a slot whose event length overflows the range", () => {
    const slots = buildSlotsWithDateRanges({
      dateRanges: [range("2025-06-04T09:00:00Z", "2025-06-04T09:45:00Z")],
      frequency: 30,
      eventLength: 60,
      timeZone: "UTC",
      minimumBookingNotice: 0,
    });
    expect(slots).toHaveLength(0);
  });
});

describe("buildSlotsWithDateRanges - minimumBookingNotice", () => {
  it("drops slots inside the booking-notice cutoff", () => {
    // now == 2025-06-04T09:00Z (set below); 120-min notice means earliest
    // bookable is 11:00Z. With aligned 60-min slots the 09:00/10:00 slots drop.
    vi.setSystemTime(new Date("2025-06-04T09:00:00Z"));
    const slots = buildSlotsWithDateRanges({
      dateRanges: [range("2025-06-04T09:00:00Z", "2025-06-04T13:00:00Z")],
      frequency: 60,
      eventLength: 60,
      timeZone: "UTC",
      minimumBookingNotice: 120,
    });
    const times = slots.map((s) => s.time.utc().format("HH:mm"));
    expect(times).toEqual(["11:00", "12:00"]);
  });
});

describe("buildSlotsWithDateRanges - buffers (offsetStart)", () => {
  it("offsets the slot start and consumes frequency + offset per slot", () => {
    // 30-min frequency, 10-min offsetStart. Each slot starts 10 min later and
    // advances by 40 min. Aligned start 09:00 -> +10 = 09:10, then 09:50, ...
    const slots = buildSlotsWithDateRanges({
      dateRanges: [range("2025-06-04T09:00:00Z", "2025-06-04T11:00:00Z")],
      frequency: 30,
      eventLength: 30,
      timeZone: "UTC",
      minimumBookingNotice: 0,
      offsetStart: 10,
    });
    const times = slots.map((s) => s.time.utc().format("HH:mm"));
    expect(times).toEqual(["09:10", "09:50", "10:30"]);
  });
});

describe("getSlots", () => {
  it("derives the timezone from the invitee date and returns aligned slots", () => {
    // inviteeDate must carry a tz (getTimeZone reads dayjs internal $x.$timezone).
    const inviteeDate = dayjs.utc("2025-06-04T00:00:00Z").tz("UTC");
    const slots = getSlots({
      inviteeDate,
      frequency: 60,
      eventLength: 60,
      minimumBookingNotice: 0,
      dateRanges: [range("2025-06-04T09:00:00Z", "2025-06-04T12:00:00Z")],
    });
    expect(slots.map((s) => s.time.utc().format("HH:mm"))).toEqual(["09:00", "10:00", "11:00"]);
  });
});
