// @vitest-environment edge-runtime
//
// BOOKING-PAYMENTS (M2–M4) — finalize/prepare logic against a real in-memory
// Convex (convexTest + `t.run`). The finalize path runs the REAL
// createBookingHandler, so the authoritative slot conflict re-check (the race
// guard that makes payment unable to bypass double-booking) is exercised for
// real. No Stripe network is touched here — the impls return a PLAN; the webhook
// httpAction performs capture/void/refund (covered by stripeBookingRest.test.ts).

import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import { ConvexError } from "convex/values";
import schema from "../schema";
import type { Id } from "../_generated/dataModel";
import {
  prepareBookingCheckoutImpl,
  finalizeBookingPaymentImpl,
  bookingIdempotencyKey,
  effectiveCaptureMode,
} from "./payments";

const modules = (
  import.meta as unknown as {
    glob: (p: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../_generated/**/*.js");

const OWNER = "owner_x";
const HOST = "host_a";
const TZ = "UTC";
// 2026-06-01 is a Monday; 10:00–10:30Z is inside 9–17 working hours.
const SLOT_START = Date.UTC(2026, 5, 1, 10, 0, 0);
const SLOT_END = Date.UTC(2026, 5, 1, 10, 30, 0);
const NOW = Date.UTC(2026, 5, 1, 9, 0, 0);

async function enableFlags(ctx: any, payments = true) {
  await ctx.db.insert("featureFlags", {
    key: "booking_enabled",
    value: true,
    updatedAt: NOW,
    updatedBy: "test",
  });
  await ctx.db.insert("featureFlags", {
    key: "booking_payments_enabled",
    value: payments,
    updatedAt: NOW,
    updatedBy: "test",
  });
}

async function seedPaidEvent(
  ctx: any,
  opts: { slug: string; drop?: boolean; paymentRequired?: boolean },
): Promise<Id<"eventTypes">> {
  const scheduleId = await ctx.db.insert("schedules", {
    ownerAuthUserId: HOST,
    name: "Working hours",
    timeZone: TZ,
    isDefault: true,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await ctx.db.insert("availability", {
    scheduleId,
    ownerAuthUserId: HOST,
    days: [1, 2, 3, 4, 5],
    startMinute: 540,
    endMinute: 1020,
    createdAt: NOW,
  });
  const eventTypeId = await ctx.db.insert("eventTypes", {
    ownerAuthUserId: OWNER,
    slug: opts.slug,
    title: "Photo Session",
    durationMinutes: 30,
    schedulingType: "collective",
    scheduleId,
    minimumBookingNoticeMinutes: 0,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    requireEmailVerification: false,
    priceCents: 1000,
    currency: "usd",
    paymentRequired: opts.paymentRequired ?? true,
    dropMode: opts.drop ? "first_come_drop" : undefined,
    captureMode: opts.drop ? "manual" : undefined,
    hidden: false,
    active: true,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await ctx.db.insert("eventTypeHosts", {
    eventTypeId,
    ownerAuthUserId: OWNER,
    hostAuthUserId: HOST,
    isFixed: true,
    createdAt: NOW,
  });
  return eventTypeId;
}

async function seedPayment(
  ctx: any,
  args: {
    eventTypeId: string;
    slug: string;
    email: string;
    sessionId: string;
    drop?: boolean;
    intake?: Array<{ name: string; label: string; value: string }>;
  },
): Promise<Id<"bookingPayments">> {
  return ctx.db.insert("bookingPayments", {
    eventTypeId: args.eventTypeId,
    ownerAuthUserId: OWNER,
    stripeSessionId: args.sessionId,
    amountCents: 1000,
    currency: "usd",
    captureMode: args.drop ? "manual" : "automatic",
    status: "pending",
    bookingIntent: {
      slug: args.slug,
      start: SLOT_START,
      end: SLOT_END,
      name: "Booker",
      email: args.email,
      timeZone: TZ,
      intakeResponses: args.intake,
    },
    idempotencyKey: bookingIdempotencyKey(args.slug, SLOT_START, args.email),
    createdAt: NOW,
    updatedAt: NOW,
  });
}

describe("booking payments — pure helpers", () => {
  it("bookingIdempotencyKey is deterministic + email-normalized", () => {
    expect(bookingIdempotencyKey("intro", 100, " A@B.com ")).toBe(
      bookingIdempotencyKey("intro", 100, "a@b.com"),
    );
    expect(bookingIdempotencyKey("intro", 100, "a@b.com")).not.toBe(
      bookingIdempotencyKey("intro", 200, "a@b.com"),
    );
  });

  it("effectiveCaptureMode: drop ⇒ manual, else automatic, explicit wins", () => {
    expect(effectiveCaptureMode({})).toBe("automatic");
    expect(effectiveCaptureMode({ dropMode: "first_come_drop" })).toBe("manual");
    expect(effectiveCaptureMode({ captureMode: "automatic", dropMode: "first_come_drop" })).toBe("automatic");
  });
});

describe("prepareBookingCheckoutImpl", () => {
  it("validates a paid event + writes a pending payment row", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      const eventTypeId = await seedPaidEvent(ctx, { slug: "paid" });
      const res = await prepareBookingCheckoutImpl(ctx, {
        slug: "paid",
        start: SLOT_START,
        end: SLOT_END,
        name: "Booker",
        email: "booker@example.com",
        timeZone: TZ,
        intakeResponses: [{ name: "type", label: "Type", value: "portrait" }],
      });
      expect(res.amountCents).toBe(1000);
      expect(res.captureMode).toBe("automatic");
      const row = await ctx.db.get(res.paymentId);
      expect(row?.status).toBe("pending");
      expect(row?.eventTypeId).toBe(eventTypeId);
      expect(row?.bookingIntent.intakeResponses?.[0]?.value).toBe("portrait");
    });
  });

  it("rejects a non-paid event type", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      await seedPaidEvent(ctx, { slug: "free", paymentRequired: false });
      await expect(
        prepareBookingCheckoutImpl(ctx, {
          slug: "free",
          start: SLOT_START,
          end: SLOT_END,
          name: "B",
          email: "b@e.com",
          timeZone: TZ,
        }),
      ).rejects.toBeInstanceOf(ConvexError);
    });
  });

  it("404s (payments_disabled) when the flag is off", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx, false); // payments OFF
      await seedPaidEvent(ctx, { slug: "paid" });
      await expect(
        prepareBookingCheckoutImpl(ctx, {
          slug: "paid",
          start: SLOT_START,
          end: SLOT_END,
          name: "B",
          email: "b@e.com",
          timeZone: TZ,
        }),
      ).rejects.toMatchObject({ data: { kind: "payments_disabled" } });
    });
  });
});

describe("finalizeBookingPaymentImpl — standard (automatic capture)", () => {
  it("won_auto: creates the booking, persists intake, marks paid", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      const eventTypeId = await seedPaidEvent(ctx, { slug: "paid" });
      const paymentId = await seedPayment(ctx, {
        eventTypeId,
        slug: "paid",
        email: "win@example.com",
        sessionId: "cs_win",
        intake: [{ name: "type", label: "Type", value: "product" }],
      });
      const res = await finalizeBookingPaymentImpl(ctx, {
        stripeSessionId: "cs_win",
        paymentIntentId: "pi_win",
        paidAtMs: NOW,
      });
      expect(res.outcome).toBe("won_auto");
      const payment = await ctx.db.get(paymentId);
      expect(payment?.status).toBe("paid");
      expect(payment?.bookingId).toBeTruthy();
      const booking = await ctx.db.get(payment!.bookingId!);
      expect(booking?.startTime).toBe(SLOT_START);
      expect(booking?.intakeResponses?.[0]?.value).toBe("product");
    });
  });

  it("noop on Stripe redelivery (idempotent)", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      const eventTypeId = await seedPaidEvent(ctx, { slug: "paid" });
      await seedPayment(ctx, { eventTypeId, slug: "paid", email: "x@e.com", sessionId: "cs_x" });
      const first = await finalizeBookingPaymentImpl(ctx, { stripeSessionId: "cs_x", paymentIntentId: "pi_x", paidAtMs: NOW });
      expect(first.outcome).toBe("won_auto");
      const second = await finalizeBookingPaymentImpl(ctx, { stripeSessionId: "cs_x", paymentIntentId: "pi_x", paidAtMs: NOW });
      expect(second.outcome).toBe("noop");
    });
  });

  it("needs_refund when the slot was taken in a race", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      const eventTypeId = await seedPaidEvent(ctx, { slug: "paid" });
      await seedPayment(ctx, { eventTypeId, slug: "paid", email: "a@e.com", sessionId: "cs_a" });
      await seedPayment(ctx, { eventTypeId, slug: "paid", email: "b@e.com", sessionId: "cs_b" });
      const a = await finalizeBookingPaymentImpl(ctx, { stripeSessionId: "cs_a", paymentIntentId: "pi_a", paidAtMs: NOW });
      expect(a.outcome).toBe("won_auto");
      const b = await finalizeBookingPaymentImpl(ctx, { stripeSessionId: "cs_b", paymentIntentId: "pi_b", paidAtMs: NOW });
      expect(b.outcome).toBe("needs_refund");
      expect(b.reason).toBe("slot_unavailable");
      expect(b.customerEmail).toBe("b@e.com");
    });
  });

  it("needs_refund for a duplicate payment (same booker, same slot)", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      const eventTypeId = await seedPaidEvent(ctx, { slug: "paid" });
      // Two sessions, SAME email ⇒ same idempotency key.
      await seedPayment(ctx, { eventTypeId, slug: "paid", email: "dup@e.com", sessionId: "cs_d1" });
      await seedPayment(ctx, { eventTypeId, slug: "paid", email: "dup@e.com", sessionId: "cs_d2" });
      const one = await finalizeBookingPaymentImpl(ctx, { stripeSessionId: "cs_d1", paymentIntentId: "pi_d1", paidAtMs: NOW });
      expect(one.outcome).toBe("won_auto");
      const two = await finalizeBookingPaymentImpl(ctx, { stripeSessionId: "cs_d2", paymentIntentId: "pi_d2", paidAtMs: NOW });
      expect(two.outcome).toBe("needs_refund");
      expect(two.reason).toBe("duplicate_payment");
    });
  });

  it("not_ours for an unknown session (instabuy / foreign)", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      const res = await finalizeBookingPaymentImpl(ctx, { stripeSessionId: "cs_unknown", paymentIntentId: "pi_z", paidAtMs: NOW });
      expect(res.outcome).toBe("not_ours");
    });
  });
});

describe("finalizeBookingPaymentImpl — competitive drop (manual capture)", () => {
  it("winner ⇒ needs_capture + authorized; loser ⇒ needs_void", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      const eventTypeId = await seedPaidEvent(ctx, { slug: "drop", drop: true });
      await seedPayment(ctx, { eventTypeId, slug: "drop", email: "w@e.com", sessionId: "cs_w", drop: true });
      await seedPayment(ctx, { eventTypeId, slug: "drop", email: "l@e.com", sessionId: "cs_l", drop: true });

      const winner = await finalizeBookingPaymentImpl(ctx, { stripeSessionId: "cs_w", paymentIntentId: "pi_w", paidAtMs: NOW });
      expect(winner.outcome).toBe("needs_capture");
      expect(winner.paymentIntentId).toBe("pi_w");
      const wRow = await ctx.db.get(winner.paymentId!);
      expect(wRow?.status).toBe("authorized"); // NOT yet captured
      expect(wRow?.bookingId).toBeTruthy();

      const loser = await finalizeBookingPaymentImpl(ctx, { stripeSessionId: "cs_l", paymentIntentId: "pi_l", paidAtMs: NOW });
      expect(loser.outcome).toBe("needs_void");
      expect(loser.paymentIntentId).toBe("pi_l");
    });
  });

  it("re-delivery of a winner whose capture was not yet recorded ⇒ needs_capture again", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      const eventTypeId = await seedPaidEvent(ctx, { slug: "drop", drop: true });
      await seedPayment(ctx, { eventTypeId, slug: "drop", email: "w@e.com", sessionId: "cs_w", drop: true });
      const first = await finalizeBookingPaymentImpl(ctx, { stripeSessionId: "cs_w", paymentIntentId: "pi_w", paidAtMs: NOW });
      expect(first.outcome).toBe("needs_capture");
      // Webhook crashed before marking paid → status still "authorized". Redelivery:
      const again = await finalizeBookingPaymentImpl(ctx, { stripeSessionId: "cs_w", paymentIntentId: "pi_w", paidAtMs: NOW });
      expect(again.outcome).toBe("needs_capture");
    });
  });
});
