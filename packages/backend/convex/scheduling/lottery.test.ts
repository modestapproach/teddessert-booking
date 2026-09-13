// @vitest-environment edge-runtime
//
// BOOKING-LOTTERY (L2–L3) — enter/draw/sweep against a real in-memory Convex
// (convexTest + t.run). The draw runs the REAL createBookingHandler, so the
// slot conflict re-check + lottery_only enforcement are exercised for real.
// Email/scheduler side effects are ref-guarded (skipped under the stale
// committed _generated) — tests drive the Impl functions directly.

import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import { ConvexError } from "convex/values";
import schema from "../schema";
import type { Id } from "../_generated/dataModel";
import {
  enterSlotLotteryImpl,
  drawSlotLotteryImpl,
  sweepDueSlotLotteriesImpl,
  getSlotLotteryPublicImpl,
  computeClosesAt,
  buildLotteryEmail,
  DEFAULT_CLOSE_LEAD_MINUTES,
} from "./lottery";
import { createBookingHandler, rescheduleBookingHandler } from "./booking";

const modules = (
  import.meta as unknown as {
    glob: (p: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../_generated/**/*.js");

const OWNER = "owner_x";
const HOST = "host_a";
const TZ = "UTC";
// Slot: Monday 2026-06-01 10:00–11:00Z (inside the seeded Mon–Fri 9–17 hours).
const SLOT_START = Date.UTC(2026, 5, 1, 10, 0, 0);
const SLOT_END = Date.UTC(2026, 5, 1, 11, 0, 0);
// Default lead 24h → closesAt = Sunday 2026-05-31 10:00Z.
const CLOSES_AT = SLOT_START - DEFAULT_CLOSE_LEAD_MINUTES * 60_000;
// Entries happen Friday morning, well before close.
const ENTER_NOW = Date.UTC(2026, 4, 29, 10, 0, 0);

async function enableFlags(ctx: any, opts: { booking?: boolean; lottery?: boolean } = {}) {
  await ctx.db.insert("featureFlags", {
    key: "booking_enabled",
    value: opts.booking ?? true,
    updatedAt: ENTER_NOW,
    updatedBy: "test",
  });
  await ctx.db.insert("featureFlags", {
    key: "booking_lottery_enabled",
    value: opts.lottery ?? true,
    updatedAt: ENTER_NOW,
    updatedBy: "test",
  });
}

async function seedLotteryEvent(
  ctx: any,
  opts: { slug?: string; mode?: "lottery" | undefined; leadMinutes?: number } = {},
): Promise<Id<"eventTypes">> {
  const scheduleId = await ctx.db.insert("schedules", {
    ownerAuthUserId: HOST,
    name: "Working hours",
    timeZone: TZ,
    isDefault: true,
    createdAt: ENTER_NOW,
    updatedAt: ENTER_NOW,
  });
  await ctx.db.insert("availability", {
    scheduleId,
    ownerAuthUserId: HOST,
    days: [1, 2, 3, 4, 5],
    startMinute: 540,
    endMinute: 1020,
    createdAt: ENTER_NOW,
  });
  const eventTypeId = await ctx.db.insert("eventTypes", {
    ownerAuthUserId: OWNER,
    slug: opts.slug ?? "lottery-shoot",
    title: "Lottery Photo Session",
    durationMinutes: 60,
    schedulingType: "collective",
    scheduleId,
    minimumBookingNoticeMinutes: 0,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    requireEmailVerification: false,
    interactionMode: opts.mode === undefined ? "lottery" : opts.mode,
    lotteryCloseLeadMinutes: opts.leadMinutes,
    hidden: false,
    active: true,
    createdAt: ENTER_NOW,
    updatedAt: ENTER_NOW,
  });
  await ctx.db.insert("eventTypeHosts", {
    eventTypeId,
    ownerAuthUserId: OWNER,
    hostAuthUserId: HOST,
    isFixed: true,
    createdAt: ENTER_NOW,
  });
  return eventTypeId;
}

function entryArgs(email: string, name = "Entrant") {
  return {
    slug: "lottery-shoot",
    start: SLOT_START,
    end: SLOT_END,
    name,
    email,
    timeZone: "America/New_York",
    nowMs: ENTER_NOW,
  };
}

describe("computeClosesAt + email copy (pure)", () => {
  it("closesAt = slotStart − max(lead, notice)", () => {
    expect(
      computeClosesAt({ minimumBookingNoticeMinutes: 0 }, SLOT_START),
    ).toBe(SLOT_START - 1440 * 60_000);
    expect(
      computeClosesAt(
        { lotteryCloseLeadMinutes: 60, minimumBookingNoticeMinutes: 120 },
        SLOT_START,
      ),
    ).toBe(SLOT_START - 120 * 60_000); // notice dominates a shorter lead
    expect(
      computeClosesAt(
        { lotteryCloseLeadMinutes: 2880, minimumBookingNoticeMinutes: 0 },
        SLOT_START,
      ),
    ).toBe(SLOT_START - 2880 * 60_000);
  });

  it("buildLotteryEmail covers all four kinds", () => {
    for (const kind of ["entered", "won", "lost", "cancelled"] as const) {
      const { subject, htmlContent } = buildLotteryEmail({
        kind,
        name: "Sam",
        timeZone: "UTC",
        eventTitle: "Photo Session",
        slotStartMs: SLOT_START,
        closesAtMs: CLOSES_AT,
        lotteryId: "abc123",
      });
      expect(subject).toContain("Photo Session");
      expect(htmlContent).toContain("Sam");
    }
  });
});

describe("enterSlotLotteryImpl", () => {
  it("first entry creates the lottery (correct closesAt) + entry", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      await seedLotteryEvent(ctx);
      const res = await enterSlotLotteryImpl(ctx, entryArgs("a@e.com", "Ada"));
      expect(res.alreadyEntered).toBe(false);
      expect(res.entrantCount).toBe(1);
      expect(res.closesAt).toBe(CLOSES_AT);
      const lottery = await ctx.db.get(res.lotteryId);
      expect(lottery?.status).toBe("open");
      expect(lottery?.slotStart).toBe(SLOT_START);
    });
  });

  it("same email is deduped (idempotent); a second entrant counts", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      await seedLotteryEvent(ctx);
      await enterSlotLotteryImpl(ctx, entryArgs("a@e.com"));
      const dup = await enterSlotLotteryImpl(ctx, entryArgs(" A@E.com ")); // normalized
      expect(dup.alreadyEntered).toBe(true);
      expect(dup.entrantCount).toBe(1);
      const second = await enterSlotLotteryImpl(ctx, entryArgs("b@e.com"));
      expect(second.alreadyEntered).toBe(false);
      expect(second.entrantCount).toBe(2);
    });
  });

  it("rejects when entries have closed (slot too near)", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      await seedLotteryEvent(ctx);
      // 'Now' is 1h before the slot — closesAt (24h before) is long past.
      await expect(
        enterSlotLotteryImpl(ctx, {
          ...entryArgs("late@e.com"),
          nowMs: SLOT_START - 60 * 60_000,
        }),
      ).rejects.toMatchObject({ data: { kind: "lottery_closed" } });
    });
  });

  it("rejects non-lottery event types + dark flags", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      await seedLotteryEvent(ctx, { slug: "plain", mode: undefined });
      // seedLotteryEvent(mode: undefined) still sets "lottery" per default arg
      // handling — build a plain event explicitly instead:
      const scheduleId = await ctx.db.insert("schedules", {
        ownerAuthUserId: HOST,
        name: "W",
        timeZone: TZ,
        isDefault: false,
        createdAt: ENTER_NOW,
        updatedAt: ENTER_NOW,
      });
      await ctx.db.insert("eventTypes", {
        ownerAuthUserId: OWNER,
        slug: "really-plain",
        title: "Plain",
        durationMinutes: 60,
        schedulingType: "collective",
        scheduleId,
        minimumBookingNoticeMinutes: 0,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        requireEmailVerification: false,
        hidden: false,
        active: true,
        createdAt: ENTER_NOW,
        updatedAt: ENTER_NOW,
      });
      await expect(
        enterSlotLotteryImpl(ctx, { ...entryArgs("x@e.com"), slug: "really-plain" }),
      ).rejects.toMatchObject({ data: { kind: "not_a_lottery_event" } });
    });

    const dark = convexTest(schema, modules);
    await dark.run(async (ctx) => {
      await enableFlags(ctx, { lottery: false });
      await seedLotteryEvent(ctx);
      await expect(
        enterSlotLotteryImpl(ctx, entryArgs("x@e.com")),
      ).rejects.toMatchObject({ data: { kind: "lottery_disabled" } });
    });
  });

  it("reschedule onto a lottery event is rejected (lottery_only) — winners can't slot-hop", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      await seedLotteryEvent(ctx);
      // Win slot A via the draw (the only legitimate way to a booking).
      const res = await enterSlotLotteryImpl(ctx, entryArgs("winner@e.com", "Winner"));
      const drawn = await drawSlotLotteryImpl(ctx, {
        lotteryId: res.lotteryId,
        nowMs: CLOSES_AT,
      });
      expect(drawn.outcome).toBe("drawn");
      // Now try to self-reschedule the won booking onto a different slot —
      // reschedule bypasses createBookingHandler, so it needs its own gate.
      const nextSlotStart = SLOT_START + 7 * 86_400_000; // next Monday 10:00
      await expect(
        rescheduleBookingHandler(ctx, {
          oldBookingId: drawn.bookingId!,
          newStartTime: nextSlotStart,
          newEndTime: nextSlotStart + 3_600_000,
          newBookerTimeZone: TZ,
          holderToken: "",
          idempotencyKey: "resched-hop-1",
          attendee: { name: "Winner", email: "winner@e.com", timeZone: TZ },
          nowMs: CLOSES_AT + 60_000,
        }),
      ).rejects.toMatchObject({ data: { kind: "lottery_only" } });
      // The won booking is untouched (still accepted on its original slot).
      const booking = await ctx.db.get(drawn.bookingId!);
      expect(booking?.status).toBe("accepted");
      expect(booking?.startTime).toBe(SLOT_START);
    });
  });

  it("first_come mode: direct booking is ALLOWED (claim = instant book); lottery enter rejects it", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      // Same seed as the lottery event but in first_come mode.
      const scheduleId = await ctx.db.insert("schedules", {
        ownerAuthUserId: HOST,
        name: "Working hours",
        timeZone: TZ,
        isDefault: true,
        createdAt: ENTER_NOW,
        updatedAt: ENTER_NOW,
      });
      await ctx.db.insert("availability", {
        scheduleId,
        ownerAuthUserId: HOST,
        days: [1, 2, 3, 4, 5],
        startMinute: 540,
        endMinute: 1020,
        createdAt: ENTER_NOW,
      });
      const eventTypeId = await ctx.db.insert("eventTypes", {
        ownerAuthUserId: OWNER,
        slug: "claim-shoot",
        title: "Claim Photo Session",
        durationMinutes: 60,
        schedulingType: "collective",
        scheduleId,
        minimumBookingNoticeMinutes: 0,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        requireEmailVerification: false,
        interactionMode: "first_come",
        hidden: false,
        active: true,
        createdAt: ENTER_NOW,
        updatedAt: ENTER_NOW,
      });
      await ctx.db.insert("eventTypeHosts", {
        eventTypeId,
        ownerAuthUserId: OWNER,
        hostAuthUserId: HOST,
        isFixed: true,
        createdAt: ENTER_NOW,
      });
      // First claim books instantly through the normal create path.
      const first = await createBookingHandler(ctx, {
        slug: "claim-shoot",
        startTime: SLOT_START,
        endTime: SLOT_END,
        bookerTimeZone: TZ,
        holderToken: "",
        idempotencyKey: "claim-1",
        attendee: { name: "Fast Felix", email: "felix@e.com", timeZone: TZ },
        nowMs: ENTER_NOW,
      });
      expect(first.status).toBe("accepted");
      // Second claimant on the same slot loses the race (standard conflict).
      await expect(
        createBookingHandler(ctx, {
          slug: "claim-shoot",
          startTime: SLOT_START,
          endTime: SLOT_END,
          bookerTimeZone: TZ,
          holderToken: "",
          idempotencyKey: "claim-2",
          attendee: { name: "Slow Sam", email: "sam@e.com", timeZone: TZ },
          nowMs: ENTER_NOW,
        }),
      ).rejects.toMatchObject({ data: { kind: "slot_unavailable" } });
      // The lottery enter path refuses a first_come event.
      await expect(
        enterSlotLotteryImpl(ctx, { ...entryArgs("x@e.com"), slug: "claim-shoot" }),
      ).rejects.toMatchObject({ data: { kind: "not_a_lottery_event" } });
    });
  });

  it("direct booking on a lottery event is rejected (lottery_only)", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      await seedLotteryEvent(ctx);
      await expect(
        createBookingHandler(ctx, {
          slug: "lottery-shoot",
          startTime: SLOT_START,
          endTime: SLOT_END,
          bookerTimeZone: TZ,
          holderToken: "",
          idempotencyKey: "direct-1",
          attendee: { name: "Sneaky", email: "s@e.com", timeZone: TZ },
          nowMs: ENTER_NOW,
        }),
      ).rejects.toMatchObject({ data: { kind: "lottery_only" } });
    });
  });
});

describe("getSlotLotteryPublicImpl", () => {
  it("returns the public-safe DTO; null for garbage ids", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      await seedLotteryEvent(ctx);
      const res = await enterSlotLotteryImpl(ctx, entryArgs("a@e.com", "Ada"));
      const dto = await getSlotLotteryPublicImpl(ctx, String(res.lotteryId));
      expect(dto).toMatchObject({
        eventSlug: "lottery-shoot",
        eventTitle: "Lottery Photo Session",
        status: "open",
        entrantCount: 1,
        slotStart: SLOT_START,
        closesAt: CLOSES_AT,
      });
      // PUBLIC-SAFE: no entrant identities anywhere in the DTO.
      expect(JSON.stringify(dto)).not.toContain("a@e.com");
      expect(JSON.stringify(dto)).not.toContain("Ada");
      expect(await getSlotLotteryPublicImpl(ctx, "garbage-id")).toBeNull();
    });
  });
});

describe("drawSlotLotteryImpl", () => {
  it("draws a winner: real booking created (intake threaded), audit persisted, redelivery noop", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      await seedLotteryEvent(ctx);
      const res = await enterSlotLotteryImpl(ctx, {
        ...entryArgs("solo@e.com", "Solo"),
        intakeResponses: [
          { name: "session-type", label: "Session type", value: "portrait" },
        ],
      });
      const drawn = await drawSlotLotteryImpl(ctx, {
        lotteryId: res.lotteryId,
        nowMs: CLOSES_AT,
      });
      expect(drawn.outcome).toBe("drawn");
      const lottery = await ctx.db.get(res.lotteryId);
      expect(lottery?.status).toBe("drawn");
      expect(lottery?.entrantCountAtDraw).toBe(1);
      expect(lottery?.winnerIndex).toBe(0);
      expect(lottery?.bookingId).toBeTruthy();
      const booking = await ctx.db.get(lottery!.bookingId!);
      expect(booking?.startTime).toBe(SLOT_START);
      expect(booking?.status).toBe("accepted");
      expect(booking?.intakeResponses?.[0]?.value).toBe("portrait");
      // Redelivery (scheduler + sweep double-fire) → idempotent noop.
      const again = await drawSlotLotteryImpl(ctx, {
        lotteryId: res.lotteryId,
        nowMs: CLOSES_AT + 1,
      });
      expect(again.outcome).toBe("noop");
    });
  });

  it("winner is one of the entrants; everyone else stays unbooked", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      await seedLotteryEvent(ctx);
      const emails = ["a@e.com", "b@e.com", "c@e.com"];
      let lotteryId!: Id<"slotLotteries">;
      for (const email of emails) {
        const r = await enterSlotLotteryImpl(ctx, entryArgs(email, email));
        lotteryId = r.lotteryId;
      }
      const drawn = await drawSlotLotteryImpl(ctx, { lotteryId, nowMs: CLOSES_AT });
      expect(drawn.outcome).toBe("drawn");
      const lottery = await ctx.db.get(lotteryId);
      const winnerEntry = await ctx.db.get(lottery!.winnerEntryId!);
      expect(emails).toContain(winnerEntry?.email);
      const attendees = await ctx.db
        .query("bookingAttendees")
        .withIndex("by_booking", (q) => q.eq("bookingId", lottery!.bookingId!))
        .collect();
      const booker = attendees.find((a) => a.role === "booker");
      expect(booker?.email).toBe(winnerEntry?.email);
      // Exactly ONE booking exists for the slot.
      const bookings = await ctx.db.query("bookings").collect();
      expect(bookings.filter((b) => b.startTime === SLOT_START)).toHaveLength(1);
    });
  });

  it("too_early before closesAt; deferred when flags are dark (stays open)", async () => {
    const t = convexTest(schema, modules);
    let lotteryId!: Id<"slotLotteries">;
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      await seedLotteryEvent(ctx);
      const res = await enterSlotLotteryImpl(ctx, entryArgs("a@e.com"));
      lotteryId = res.lotteryId;
      expect(
        (await drawSlotLotteryImpl(ctx, { lotteryId, nowMs: CLOSES_AT - 1 }))
          .outcome,
      ).toBe("too_early");
      // Flip the lottery flag off for the next request.
      const flag = await ctx.db
        .query("featureFlags")
        .withIndex("by_key", (q) => q.eq("key", "booking_lottery_enabled"))
        .unique();
      await ctx.db.patch(flag!._id, { value: false });
    });
    // FRESH ctx (isFlagEnabled memoizes per-request on the ctx object — in
    // production the draw is its own mutation, so a fresh read is the real
    // behavior): draw defers, lottery stays open.
    await t.run(async (ctx) => {
      const deferred = await drawSlotLotteryImpl(ctx, {
        lotteryId,
        nowMs: CLOSES_AT,
      });
      expect(deferred.outcome).toBe("deferred");
      expect((await ctx.db.get(lotteryId))?.status).toBe("open");
    });
  });

  it("cancelled (not booked) when the slot was taken before the draw", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      const eventTypeId = await seedLotteryEvent(ctx);
      const res = await enterSlotLotteryImpl(ctx, entryArgs("a@e.com"));
      // The slot gets taken out from under the lottery (e.g. owner-side write).
      await ctx.db.insert("bookings", {
        eventTypeId,
        ownerAuthUserId: OWNER,
        assignedHostAuthUserId: HOST,
        startTime: SLOT_START,
        endTime: SLOT_END,
        timeZone: TZ,
        status: "accepted",
        idempotencyKey: "preexisting",
        createdAt: ENTER_NOW,
        updatedAt: ENTER_NOW,
      });
      const drawn = await drawSlotLotteryImpl(ctx, {
        lotteryId: res.lotteryId,
        nowMs: CLOSES_AT,
      });
      expect(drawn.outcome).toBe("cancelled");
      expect(drawn.reason).toBe("slot_unavailable");
      expect((await ctx.db.get(res.lotteryId))?.status).toBe("cancelled");
    });
  });

  it("expired when a lottery has zero entries at draw time", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      const eventTypeId = await seedLotteryEvent(ctx);
      const lotteryId = await ctx.db.insert("slotLotteries", {
        eventTypeId,
        ownerAuthUserId: OWNER,
        slotStart: SLOT_START,
        slotEnd: SLOT_END,
        closesAt: CLOSES_AT,
        status: "open",
        createdAt: ENTER_NOW,
        updatedAt: ENTER_NOW,
      });
      const drawn = await drawSlotLotteryImpl(ctx, { lotteryId, nowMs: CLOSES_AT });
      expect(drawn.outcome).toBe("expired");
      expect((await ctx.db.get(lotteryId))?.status).toBe("expired");
    });
  });
});

describe("sweepDueSlotLotteriesImpl", () => {
  it("draws due lotteries the scheduler missed; skips not-yet-due ones", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      await seedLotteryEvent(ctx);
      const due = await enterSlotLotteryImpl(ctx, entryArgs("a@e.com"));
      // A second lottery on a later slot — NOT yet due at sweep time.
      const laterStart = SLOT_START + 7 * 86_400_000;
      const later = await enterSlotLotteryImpl(ctx, {
        ...entryArgs("b@e.com"),
        start: laterStart,
        end: laterStart + 3_600_000,
      });
      const res = await sweepDueSlotLotteriesImpl(ctx, CLOSES_AT + 60_000);
      expect(res.drawn).toBe(1);
      expect((await ctx.db.get(due.lotteryId))?.status).toBe("drawn");
      expect((await ctx.db.get(later.lotteryId))?.status).toBe("open");
    });
  });
});
