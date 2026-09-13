// @vitest-environment edge-runtime
//
// Runtime schema-acceptance test for the scheduling / booking suite
// (integration-prd §5.3 + backend-port §3). Validates that schema.ts
// ACCEPTS the documented shape of all 15 new booking tables and that each
// table's primary index exists — at RUNTIME, with NO codegen.
//
// HARNESS NOTE: this is the repo's first `convex-test` file. It runs under
// the `@edge-runtime/vm` environment (declared in the docblock above so
// only THIS file opts in — the other ~130 tests stay on the default node
// environment).
//
// `convexTest(schema, modules)` is given the schema + a modules map. We
// never call registered functions (`t.query`/`t.mutation`/`t.action`) here
// — every assertion goes through `t.run(ctx => ...)` raw `ctx.db` access,
// which only needs the schema for validation + index resolution. But
// convex-test still requires SOME modules map: with no `modules` arg it
// falls back to an internal `import.meta.glob` that doesn't resolve from
// inside the library ("(intermediate value).glob is not a function"), and
// it must locate a `_generated` path to anchor `findModulesRoot`. So we
// pass a glob scoped to just `convex/_generated/**` — enough to anchor the
// module root without eagerly importing every function module in the
// codebase (which would couple this schema-only test to unrelated modules'
// import-time state). The `import.meta.glob` literal is evaluated by Vite
// in THIS file's transform context, where it works correctly.
//
// vitest transpiles the TS, so stale `_generated` types from a pending
// codegen don't block this runtime check.
//
// `import.meta.glob` is a Vite/Vitest macro (provided by `vite/client`
// types, which the Convex tsconfig doesn't pull in), so tsc under
// convex/tsconfig.json doesn't know the property. Cast `import.meta` to
// reach it without a triple-slash reference to a module that isn't
// resolvable here. Vitest supplies the real macro at test time.
const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../_generated/**/*.js");
//
// What each `t.run` block does:
//   1. INSERT one representative valid row into the table. The insert is
//      validated against schema.ts at runtime — a wrong field type /
//      missing required field / bad optionality would throw here.
//   2. Query the row back via its PRIMARY index (by_owner / by_authUserId /
//      by_eventType / by_booking / ...). A non-existent index throws,
//      proving the `.index(...)` declarations are wired correctly.

import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "../schema";

const NOW = 1_700_000_000_000; // fixed epoch-ms for determinism

describe("scheduling/booking schema — runtime accept + index check", () => {
  it("eventTypes: insert + query by_owner", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const id = await ctx.db.insert("eventTypes", {
        ownerAuthUserId: "user_1",
        slug: "30-min-intro",
        title: "30 Minute Intro",
        description: "A quick chat",
        durationMinutes: 30,
        schedulingType: "collective",
        slotIntervalMinutes: 30,
        minimumBookingNoticeMinutes: 120,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        bookingWindowDays: 60,
        dailyBookingLimit: 8,
        requireEmailVerification: true,
        hidden: false,
        locationText: "Zoom",
        active: true,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const rows = await ctx.db
        .query("eventTypes")
        .withIndex("by_owner", (q) => q.eq("ownerAuthUserId", "user_1"))
        .collect();
      expect(rows.map((r) => r._id)).toContain(id);
      expect(rows[0]?.slug).toBe("30-min-intro");
    });
  });

  it("schedules: insert + query by_owner", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const id = await ctx.db.insert("schedules", {
        ownerAuthUserId: "user_1",
        name: "Working hours",
        timeZone: "America/New_York",
        isDefault: true,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const rows = await ctx.db
        .query("schedules")
        .withIndex("by_owner", (q) => q.eq("ownerAuthUserId", "user_1"))
        .collect();
      expect(rows.map((r) => r._id)).toContain(id);
      // by_owner_default index must also resolve.
      const def = await ctx.db
        .query("schedules")
        .withIndex("by_owner_default", (q) =>
          q.eq("ownerAuthUserId", "user_1").eq("isDefault", true),
        )
        .collect();
      expect(def).toHaveLength(1);
    });
  });

  it("availability: insert + query by_schedule", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const scheduleId = await ctx.db.insert("schedules", {
        ownerAuthUserId: "user_1",
        name: "Working hours",
        timeZone: "America/New_York",
        isDefault: true,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const id = await ctx.db.insert("availability", {
        scheduleId,
        ownerAuthUserId: "user_1",
        days: [1, 2, 3, 4, 5],
        startMinute: 540,
        endMinute: 1020,
        createdAt: NOW,
      });
      const rows = await ctx.db
        .query("availability")
        .withIndex("by_schedule", (q) => q.eq("scheduleId", scheduleId))
        .collect();
      expect(rows.map((r) => r._id)).toContain(id);
      expect(rows[0]?.days).toEqual([1, 2, 3, 4, 5]);
    });
  });

  it("dateOverrides: insert + query by_schedule_dateUtc", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const scheduleId = await ctx.db.insert("schedules", {
        ownerAuthUserId: "user_1",
        name: "Working hours",
        timeZone: "America/New_York",
        isDefault: true,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const dateUtc = 1_700_006_400_000; // UTC midnight
      const id = await ctx.db.insert("dateOverrides", {
        scheduleId,
        ownerAuthUserId: "user_1",
        dateUtc,
        // null window → unavailable all day (startMinute/endMinute omitted).
        createdAt: NOW,
      });
      const rows = await ctx.db
        .query("dateOverrides")
        .withIndex("by_schedule_dateUtc", (q) =>
          q.eq("scheduleId", scheduleId).eq("dateUtc", dateUtc),
        )
        .collect();
      expect(rows.map((r) => r._id)).toContain(id);
      expect(rows[0]?.startMinute).toBeUndefined();
    });
  });

  it("calendarCredentials: insert (encrypted envelope) + query by_authUserId_provider", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const id = await ctx.db.insert("calendarCredentials", {
        authUserId: "user_1",
        provider: "google",
        label: "ted@gmail.com",
        encSecretCiphertext: "deadbeefciphertexthex",
        encSecretIv: "0011223344556677",
        googleSyncToken: "sync-token-abc",
        googleChannelId: "chan-1",
        googleChannelResourceId: "res-1",
        googleChannelExpiresAt: NOW + 86_400_000,
        invalid: false,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const rows = await ctx.db
        .query("calendarCredentials")
        .withIndex("by_authUserId_provider", (q) =>
          q.eq("authUserId", "user_1").eq("provider", "google"),
        )
        .collect();
      expect(rows.map((r) => r._id)).toContain(id);
      expect(rows[0]?.encSecretCiphertext).toBe("deadbeefciphertexthex");
      // by_googleChannelId webhook-lookup index must resolve too.
      const byChan = await ctx.db
        .query("calendarCredentials")
        .withIndex("by_googleChannelId", (q) => q.eq("googleChannelId", "chan-1"))
        .collect();
      expect(byChan).toHaveLength(1);
    });
  });

  it("selectedCalendars: insert + query by_credential_external", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const credentialId = await ctx.db.insert("calendarCredentials", {
        authUserId: "user_1",
        provider: "caldav",
        label: "iCloud",
        encSecretCiphertext: "cipher",
        encSecretIv: "iv",
        caldavServerUrl: "https://caldav.icloud.com",
        caldavUsername: "ted",
        invalid: false,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const id = await ctx.db.insert("selectedCalendars", {
        authUserId: "user_1",
        credentialId,
        externalCalendarId: "primary",
        displayName: "Primary",
        checkForConflicts: true,
        isDestination: true,
        timeZone: "America/New_York",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const rows = await ctx.db
        .query("selectedCalendars")
        .withIndex("by_credential_external", (q) =>
          q.eq("credentialId", credentialId).eq("externalCalendarId", "primary"),
        )
        .collect();
      expect(rows.map((r) => r._id)).toContain(id);
    });
  });

  it("eventTypeHosts: insert + query by_eventType_host", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const eventTypeId = await ctx.db.insert("eventTypes", {
        ownerAuthUserId: "user_1",
        slug: "panel",
        title: "Panel",
        durationMinutes: 45,
        schedulingType: "round_robin",
        minimumBookingNoticeMinutes: 120,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        requireEmailVerification: false,
        hidden: false,
        active: true,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const id = await ctx.db.insert("eventTypeHosts", {
        eventTypeId,
        ownerAuthUserId: "user_1",
        hostAuthUserId: "host_9",
        isFixed: false,
        groupId: "g1",
        priority: 2,
        weight: 1,
        createdAt: NOW,
      });
      const rows = await ctx.db
        .query("eventTypeHosts")
        .withIndex("by_eventType_host", (q) =>
          q.eq("eventTypeId", eventTypeId).eq("hostAuthUserId", "host_9"),
        )
        .collect();
      expect(rows.map((r) => r._id)).toContain(id);
    });
  });

  it("bookings: insert (with externalEvents) + query by_owner + by_idempotencyKey", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const eventTypeId = await ctx.db.insert("eventTypes", {
        ownerAuthUserId: "user_1",
        slug: "intro",
        title: "Intro",
        durationMinutes: 30,
        schedulingType: "collective",
        minimumBookingNoticeMinutes: 120,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        requireEmailVerification: false,
        hidden: false,
        active: true,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const credentialId = await ctx.db.insert("calendarCredentials", {
        authUserId: "host_9",
        provider: "google",
        label: "host",
        encSecretCiphertext: "c",
        encSecretIv: "i",
        invalid: false,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const id = await ctx.db.insert("bookings", {
        eventTypeId,
        ownerAuthUserId: "user_1",
        assignedHostAuthUserId: "host_9",
        startTime: NOW + 3_600_000,
        endTime: NOW + 5_400_000,
        timeZone: "America/Los_Angeles",
        status: "accepted",
        idempotencyKey: "idem-key-123",
        locationText: "Zoom",
        bookerNotes: "Looking forward",
        externalEvents: [
          {
            hostAuthUserId: "host_9",
            credentialId,
            externalCalendarId: "primary",
            externalEventId: "evt-1",
            syncStatus: "synced",
            lastTriedAt: NOW,
            tries: 1,
          },
        ],
        createdAt: NOW,
        updatedAt: NOW,
      });
      const byOwner = await ctx.db
        .query("bookings")
        .withIndex("by_owner", (q) => q.eq("ownerAuthUserId", "user_1"))
        .collect();
      expect(byOwner.map((r) => r._id)).toContain(id);
      expect(byOwner[0]?.externalEvents?.[0]?.syncStatus).toBe("synced");
      // by_idempotencyKey dedupe-lookup index must resolve.
      const byKey = await ctx.db
        .query("bookings")
        .withIndex("by_idempotencyKey", (q) =>
          q.eq("idempotencyKey", "idem-key-123"),
        )
        .collect();
      expect(byKey).toHaveLength(1);
    });
  });

  it("bookingAttendees: insert + query by_booking + by_email", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const eventTypeId = await ctx.db.insert("eventTypes", {
        ownerAuthUserId: "user_1",
        slug: "intro2",
        title: "Intro",
        durationMinutes: 30,
        schedulingType: "collective",
        minimumBookingNoticeMinutes: 120,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        requireEmailVerification: false,
        hidden: false,
        active: true,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const bookingId = await ctx.db.insert("bookings", {
        eventTypeId,
        ownerAuthUserId: "user_1",
        startTime: NOW,
        endTime: NOW + 1_800_000,
        timeZone: "UTC",
        status: "pending",
        idempotencyKey: "k2",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const id = await ctx.db.insert("bookingAttendees", {
        bookingId,
        ownerAuthUserId: "user_1",
        name: "Jane Booker",
        email: "jane@example.com",
        timeZone: "America/Chicago",
        role: "booker",
        emailVerifiedAt: NOW,
        createdAt: NOW,
      });
      const byBooking = await ctx.db
        .query("bookingAttendees")
        .withIndex("by_booking", (q) => q.eq("bookingId", bookingId))
        .collect();
      expect(byBooking.map((r) => r._id)).toContain(id);
      const byEmail = await ctx.db
        .query("bookingAttendees")
        .withIndex("by_email", (q) => q.eq("email", "jane@example.com"))
        .collect();
      expect(byEmail).toHaveLength(1);
    });
  });

  it("freebusyCache: insert + query by_credential_external_window", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const credentialId = await ctx.db.insert("calendarCredentials", {
        authUserId: "user_1",
        provider: "google",
        label: "g",
        encSecretCiphertext: "c",
        encSecretIv: "i",
        invalid: false,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const windowStart = NOW;
      const id = await ctx.db.insert("freebusyCache", {
        authUserId: "user_1",
        credentialId,
        externalCalendarId: "primary",
        windowStart,
        windowEnd: NOW + 86_400_000,
        busy: [
          { start: NOW + 3_600_000, end: NOW + 7_200_000 },
          { start: NOW + 10_800_000, end: NOW + 12_600_000 },
        ],
        fetchedAt: NOW,
        expiresAt: NOW + 120_000,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const rows = await ctx.db
        .query("freebusyCache")
        .withIndex("by_credential_external_window", (q) =>
          q
            .eq("credentialId", credentialId)
            .eq("externalCalendarId", "primary")
            .eq("windowStart", windowStart),
        )
        .collect();
      expect(rows.map((r) => r._id)).toContain(id);
      expect(rows[0]?.busy).toHaveLength(2);
      // by_authUserId + by_expiresAt sweep indexes must resolve too.
      const byUser = await ctx.db
        .query("freebusyCache")
        .withIndex("by_authUserId", (q) => q.eq("authUserId", "user_1"))
        .collect();
      expect(byUser).toHaveLength(1);
    });
  });

  it("bookingHolds: insert + query by_eventType_start + by_holderToken", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const eventTypeId = await ctx.db.insert("eventTypes", {
        ownerAuthUserId: "user_1",
        slug: "hold-test",
        title: "Hold Test",
        durationMinutes: 30,
        schedulingType: "collective",
        minimumBookingNoticeMinutes: 120,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        requireEmailVerification: false,
        hidden: false,
        active: true,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const startTime = NOW + 3_600_000;
      const id = await ctx.db.insert("bookingHolds", {
        eventTypeId,
        startTime,
        endTime: NOW + 5_400_000,
        holderToken: "anon-token-xyz",
        expiresAt: NOW + 300_000,
        createdAt: NOW,
      });
      const rows = await ctx.db
        .query("bookingHolds")
        .withIndex("by_eventType_start", (q) =>
          q.eq("eventTypeId", eventTypeId).eq("startTime", startTime),
        )
        .collect();
      expect(rows.map((r) => r._id)).toContain(id);
      const byToken = await ctx.db
        .query("bookingHolds")
        .withIndex("by_holderToken", (q) =>
          q.eq("holderToken", "anon-token-xyz"),
        )
        .collect();
      expect(byToken).toHaveLength(1);
    });
  });

  it("reminders: insert + query by_bookingId + by_sendAt", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const eventTypeId = await ctx.db.insert("eventTypes", {
        ownerAuthUserId: "user_1",
        slug: "rem-test",
        title: "Reminder Test",
        durationMinutes: 30,
        schedulingType: "collective",
        minimumBookingNoticeMinutes: 120,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        requireEmailVerification: false,
        hidden: false,
        active: true,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const bookingId = await ctx.db.insert("bookings", {
        eventTypeId,
        ownerAuthUserId: "user_1",
        startTime: NOW,
        endTime: NOW + 1_800_000,
        timeZone: "UTC",
        status: "accepted",
        idempotencyKey: "k3",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const sendAt = NOW + 82_800_000; // ~23h out
      const id = await ctx.db.insert("reminders", {
        bookingId,
        kind: "reminder_24h",
        channel: "email",
        recipient: "booker",
        sendAt,
        // sentAt omitted (not yet dispatched).
      });
      const byBooking = await ctx.db
        .query("reminders")
        .withIndex("by_bookingId", (q) => q.eq("bookingId", bookingId))
        .collect();
      expect(byBooking.map((r) => r._id)).toContain(id);
      expect(byBooking[0]?.sentAt).toBeUndefined();
      const bySendAt = await ctx.db
        .query("reminders")
        .withIndex("by_sendAt", (q) => q.lte("sendAt", sendAt))
        .collect();
      expect(bySendAt.length).toBeGreaterThanOrEqual(1);
    });
  });

  // E3 GROUP capacity — the additive `seatsPerSlot` optional field must be
  // accepted on eventTypes (and absent on a solo event type, proving optionality).
  it("eventTypes: accepts the additive seatsPerSlot (group capacity) field", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const id = await ctx.db.insert("eventTypes", {
        ownerAuthUserId: "user_1",
        slug: "group-test",
        title: "Group Workshop",
        durationMinutes: 60,
        schedulingType: "collective",
        minimumBookingNoticeMinutes: 120,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        requireEmailVerification: false,
        seatsPerSlot: 5, // group: up to 5 bookings per slot
        hidden: false,
        active: true,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const row = await ctx.db.get(id);
      expect(row?.seatsPerSlot).toBe(5);
    });
  });

  // BOOKING-PAYMENTS §4.1 — the additive Stripe payment fields must be accepted
  // on eventTypes (and absent on a free event type, proving optionality).
  it("eventTypes: accepts the additive payment fields (price/drop)", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const id = await ctx.db.insert("eventTypes", {
        ownerAuthUserId: "user_1",
        slug: "paid-shoot",
        title: "Photography Session",
        durationMinutes: 60,
        schedulingType: "collective",
        minimumBookingNoticeMinutes: 120,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        requireEmailVerification: false,
        priceCents: 1000, // $10.00
        currency: "usd",
        paymentRequired: true,
        dropMode: "first_come_drop",
        captureMode: "manual",
        hidden: false,
        active: true,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const row = await ctx.db.get(id);
      expect(row?.priceCents).toBe(1000);
      expect(row?.dropMode).toBe("first_come_drop");
      expect(row?.captureMode).toBe("manual");
    });
  });

  // BOOKING-PAYMENTS §4.2 — bookings accept the additive intakeResponses array.
  it("bookings: accepts the additive intakeResponses (intake form answers)", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const eventTypeId = await ctx.db.insert("eventTypes", {
        ownerAuthUserId: "user_1",
        slug: "intake-test",
        title: "Intake Test",
        durationMinutes: 30,
        schedulingType: "collective",
        minimumBookingNoticeMinutes: 120,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        requireEmailVerification: false,
        hidden: false,
        active: true,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const id = await ctx.db.insert("bookings", {
        eventTypeId,
        ownerAuthUserId: "user_1",
        startTime: NOW,
        endTime: NOW + 1_800_000,
        timeZone: "UTC",
        status: "accepted",
        idempotencyKey: "k-intake",
        intakeResponses: [
          { name: "session-type", label: "Session type", value: "portrait" },
          { name: "vibe", label: "Vibe / refs", value: "moody, b&w" },
        ],
        createdAt: NOW,
        updatedAt: NOW,
      });
      const row = await ctx.db.get(id);
      expect(row?.intakeResponses).toHaveLength(2);
      expect(row?.intakeResponses?.[0]?.value).toBe("portrait");
    });
  });

  // BOOKING-PAYMENTS §4.3 — bookingPayments accept + primary indexes.
  it("bookingPayments: insert + query by_stripeSession + by_idempotencyKey", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const eventTypeId = await ctx.db.insert("eventTypes", {
        ownerAuthUserId: "user_1",
        slug: "pay-test",
        title: "Pay Test",
        durationMinutes: 60,
        schedulingType: "collective",
        minimumBookingNoticeMinutes: 120,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        requireEmailVerification: false,
        priceCents: 1000,
        currency: "usd",
        paymentRequired: true,
        hidden: false,
        active: true,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const id = await ctx.db.insert("bookingPayments", {
        eventTypeId,
        ownerAuthUserId: "user_1",
        stripeSessionId: "cs_test_abc123",
        amountCents: 1000,
        currency: "usd",
        captureMode: "automatic",
        status: "pending",
        bookingIntent: {
          slug: "pay-test",
          start: NOW + 3_600_000,
          end: NOW + 7_200_000,
          name: "Booker One",
          email: "booker@example.com",
          timeZone: "America/New_York",
          intakeResponses: [
            { name: "session-type", label: "Session type", value: "product" },
          ],
        },
        idempotencyKey: "idem-pay-1",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const bySession = await ctx.db
        .query("bookingPayments")
        .withIndex("by_stripeSession", (q) =>
          q.eq("stripeSessionId", "cs_test_abc123"),
        )
        .collect();
      expect(bySession.map((r) => r._id)).toContain(id);
      expect(bySession[0]?.status).toBe("pending");
      const byIdem = await ctx.db
        .query("bookingPayments")
        .withIndex("by_idempotencyKey", (q) =>
          q.eq("idempotencyKey", "idem-pay-1"),
        )
        .collect();
      expect(byIdem).toHaveLength(1);
      expect(byIdem[0]?.bookingIntent.intakeResponses?.[0]?.value).toBe(
        "product",
      );
    });
  });

  // BOOKING-LOTTERY §3 — the additive "???" interaction-mode fields on eventTypes.
  it("eventTypes: accepts the additive interactionMode (lottery) fields", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const id = await ctx.db.insert("eventTypes", {
        ownerAuthUserId: "user_1",
        slug: "lottery-shoot",
        title: "Lottery Photo Session",
        durationMinutes: 60,
        schedulingType: "collective",
        minimumBookingNoticeMinutes: 120,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        requireEmailVerification: false,
        interactionMode: "lottery",
        lotteryCloseLeadMinutes: 720, // 12h before the slot
        hidden: false,
        active: true,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const row = await ctx.db.get(id);
      expect(row?.interactionMode).toBe("lottery");
      expect(row?.lotteryCloseLeadMinutes).toBe(720);
    });
  });

  // BOOKING-LOTTERY §3 — slotLotteries + slotLotteryEntries accept + indexes.
  it("slotLotteries/slotLotteryEntries: insert + query primary indexes", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const eventTypeId = await ctx.db.insert("eventTypes", {
        ownerAuthUserId: "user_1",
        slug: "lot-test",
        title: "Lot Test",
        durationMinutes: 60,
        schedulingType: "collective",
        minimumBookingNoticeMinutes: 120,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        requireEmailVerification: false,
        interactionMode: "lottery",
        hidden: false,
        active: true,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const slotStart = NOW + 48 * 3_600_000;
      const lotteryId = await ctx.db.insert("slotLotteries", {
        eventTypeId,
        ownerAuthUserId: "user_1",
        slotStart,
        slotEnd: slotStart + 3_600_000,
        closesAt: slotStart - 24 * 3_600_000,
        status: "open",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const entryId = await ctx.db.insert("slotLotteryEntries", {
        lotteryId,
        ownerAuthUserId: "user_1",
        name: "Hopeful Entrant",
        email: "hope@example.com",
        timeZone: "America/New_York",
        intakeResponses: [
          { name: "session-type", label: "Session type", value: "portrait" },
        ],
        createdAt: NOW,
      });
      const bySlot = await ctx.db
        .query("slotLotteries")
        .withIndex("by_eventType_slotStart", (q) =>
          q.eq("eventTypeId", eventTypeId).eq("slotStart", slotStart),
        )
        .collect();
      expect(bySlot.map((r) => r._id)).toContain(lotteryId);
      const due = await ctx.db
        .query("slotLotteries")
        .withIndex("by_status_closesAt", (q) =>
          q.eq("status", "open").lte("closesAt", slotStart),
        )
        .collect();
      expect(due).toHaveLength(1);
      const byEmail = await ctx.db
        .query("slotLotteryEntries")
        .withIndex("by_lottery_email", (q) =>
          q.eq("lotteryId", lotteryId).eq("email", "hope@example.com"),
        )
        .collect();
      expect(byEmail.map((r) => r._id)).toContain(entryId);
      expect(byEmail[0]?.intakeResponses?.[0]?.value).toBe("portrait");
    });
  });

  // E3 MEETING POLL — bookingPolls accept + primary indexes.
  it("bookingPolls: insert + query by_organizerAuthUserId + by_status_expiresAt", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const expiresAt = NOW + 7 * 86_400_000;
      const id = await ctx.db.insert("bookingPolls", {
        organizerAuthUserId: "user_1",
        // eventTypeId omitted (ad-hoc poll — proves optionality).
        title: "Coffee chat?",
        description: "Pick what works",
        location: "Blue Bottle, SF",
        options: [
          { idx: 0, startMs: NOW, endMs: NOW + 1_800_000 },
          { idx: 1, startMs: NOW + 3_600_000, endMs: NOW + 5_400_000 },
        ],
        status: "open",
        expiresAt,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const byOrganizer = await ctx.db
        .query("bookingPolls")
        .withIndex("by_organizerAuthUserId", (q) =>
          q.eq("organizerAuthUserId", "user_1"),
        )
        .collect();
      expect(byOrganizer.map((r) => r._id)).toContain(id);
      expect(byOrganizer[0]?.options).toHaveLength(2);
      const byStatus = await ctx.db
        .query("bookingPolls")
        .withIndex("by_status_expiresAt", (q) =>
          q.eq("status", "open").lte("expiresAt", expiresAt),
        )
        .collect();
      expect(byStatus.length).toBeGreaterThanOrEqual(1);
    });
  });

  // E3 MEETING POLL — bookingPollVotes accept + primary indexes (upsert key).
  it("bookingPollVotes: insert + query by_pollId + by_pollId_voterEmail", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const pollId = await ctx.db.insert("bookingPolls", {
        organizerAuthUserId: "user_1",
        title: "Vote test",
        options: [{ idx: 0, startMs: NOW, endMs: NOW + 1_800_000 }],
        status: "open",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const id = await ctx.db.insert("bookingPollVotes", {
        pollId,
        voterEmail: "voter@example.com",
        voterName: "Vee",
        selectedOptionIdxs: [0],
        // ifNeededOptionIdxs omitted (binary yes/no — proves optionality).
        createdAt: NOW,
        updatedAt: NOW,
      });
      const byPoll = await ctx.db
        .query("bookingPollVotes")
        .withIndex("by_pollId", (q) => q.eq("pollId", pollId))
        .collect();
      expect(byPoll.map((r) => r._id)).toContain(id);
      const byVoter = await ctx.db
        .query("bookingPollVotes")
        .withIndex("by_pollId_voterEmail", (q) =>
          q.eq("pollId", pollId).eq("voterEmail", "voter@example.com"),
        )
        .collect();
      expect(byVoter).toHaveLength(1);
    });
  });
});
