import { describe, expect, it } from "vitest";

import { publicEventTypeRows, toPublicEventTypeRow } from "./publicEventTypesFromConvex";

const fallbackId = (id: string) => id.length;

describe("toPublicEventTypeRow", () => {
  it("maps a Convex row onto cal's profile shape", () => {
    const row = toPublicEventTypeRow(
      { _id: "abc", calId: 2, slug: "30", title: "30 min meeting", durationMinutes: 30, schedulingType: "collective", hidden: false, active: true },
      fallbackId
    );
    expect(row).toEqual({
      id: 2,
      title: "30 min meeting",
      description: null,
      length: 30,
      schedulingType: "COLLECTIVE",
      recurringEvent: null,
      slug: "30",
      hidden: false,
      price: 0,
      currency: "usd",
      lockTimeZoneToggleOnBookingPage: false,
      lockedTimeZone: null,
      requiresConfirmation: false,
      requiresBookerEmailVerification: false,
      canSendCalVideoTranscriptionEmails: false,
      seatsPerTimeSlot: null,
      metadata: {},
    });
  });

  it("falls back to a derived id when the row carries no calId, and keeps seats only for group events", () => {
    const row = toPublicEventTypeRow({ _id: "xyz1", slug: "grp", title: "Group", durationMinutes: 60, seatsPerSlot: 5, requireEmailVerification: true }, fallbackId);
    expect(row.id).toBe(4);
    expect(row.seatsPerTimeSlot).toBe(5);
    expect(row.requiresBookerEmailVerification).toBe(true);
    expect(row.schedulingType).toBeNull();
    expect(toPublicEventTypeRow({ _id: "s", slug: "solo", title: "Solo", durationMinutes: 15, seatsPerSlot: 1 }, fallbackId).seatsPerTimeSlot).toBeNull();
  });
});

describe("publicEventTypeRows", () => {
  it("drops soft-deleted rows, keeps hidden ones for the caller to filter, and orders by id", () => {
    const rows = publicEventTypeRows(
      [
        { _id: "d", calId: 4, slug: "meet-with-ted", title: "Meet with Ted", durationMinutes: 30, active: true },
        { _id: "c", calId: 3, slug: "secret", title: "Secret", durationMinutes: 15, hidden: true, active: true },
        { _id: "b", calId: 2, slug: "30", title: "30 min", durationMinutes: 30, active: true },
        { _id: "a", calId: 1, slug: "15", title: "15 min", durationMinutes: 15, active: true },
        { _id: "z", calId: 9, slug: "old", title: "Retired", durationMinutes: 10, active: false },
      ],
      fallbackId
    );
    expect(rows.map((r) => r.slug)).toEqual(["15", "30", "secret", "meet-with-ted"]);
    expect(rows.find((r) => r.slug === "secret")?.hidden).toBe(true);
  });
});
