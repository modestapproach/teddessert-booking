// @vitest-environment edge-runtime
//
// WAVE-2 INTERACTION MODES (booking-interactions-prd.md) — application /
// threshold / pair against a real in-memory Convex (convexTest + t.run).
// Resolution paths run the REAL createBookingHandler / cancelBookingHandler,
// so conflict re-checks and cascades are exercised for real. Email/scheduler
// side effects are ref-guarded (skipped under the stale committed _generated).

import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "../schema";
import type { Id } from "../_generated/dataModel";
import {
  enterSlotLotteryImpl,
  drawSlotLotteryImpl,
  sweepDueSlotLotteriesImpl,
  pickApplicationWinnerImpl,
  getSlotLotteryPublicImpl,
  DEFAULT_CLOSE_LEAD_MINUTES,
} from "./lottery";
import {
  createBookingHandler,
  joinPairBookingImpl,
  expirePairBookingImpl,
  sweepExpiredPairHoldsImpl,
  getPairPublicImpl,
} from "./booking";
import { updateEventTypeCore } from "./eventTypes";

const modules = (
  import.meta as unknown as {
    glob: (p: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../_generated/**/*.js");

const OWNER = "owner_x";
const HOST = "host_a";
const TZ = "UTC";
// Monday 2026-06-01 10:00–11:00Z, inside the seeded Mon–Fri 9–17 hours.
const SLOT_START = Date.UTC(2026, 5, 1, 10, 0, 0);
const SLOT_END = Date.UTC(2026, 5, 1, 11, 0, 0);
const CLOSES_AT = SLOT_START - DEFAULT_CLOSE_LEAD_MINUTES * 60_000;
const ENTER_NOW = Date.UTC(2026, 4, 29, 10, 0, 0); // Friday before

async function enableFlags(
  ctx: any,
  opts: { interactions?: boolean; lottery?: boolean } = {},
) {
  await ctx.db.insert("featureFlags", {
    key: "booking_enabled",
    value: true,
    updatedAt: ENTER_NOW,
    updatedBy: "test",
  });
  await ctx.db.insert("featureFlags", {
    key: "booking_interactions_enabled",
    value: opts.interactions ?? true,
    updatedAt: ENTER_NOW,
    updatedBy: "test",
  });
  await ctx.db.insert("featureFlags", {
    key: "booking_lottery_enabled",
    value: opts.lottery ?? false, // wave-2 must NOT depend on the lottery flag
    updatedAt: ENTER_NOW,
    updatedBy: "test",
  });
}

async function seedEvent(
  ctx: any,
  opts: {
    slug: string;
    mode: "application" | "threshold" | "pair";
    seats?: number;
    minAttendees?: number;
  },
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
    slug: opts.slug,
    title: "W2 Session",
    durationMinutes: 60,
    schedulingType: "collective",
    scheduleId,
    minimumBookingNoticeMinutes: 0,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    requireEmailVerification: false,
    interactionMode: opts.mode,
    seatsPerSlot: opts.seats,
    thresholdMinAttendees: opts.minAttendees,
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

function entryArgs(slug: string, email: string, name = "Applicant") {
  return {
    slug,
    start: SLOT_START,
    end: SLOT_END,
    name,
    email,
    timeZone: TZ,
    nowMs: ENTER_NOW,
  };
}

function bookArgs(slug: string, email: string, key: string) {
  return {
    slug,
    startTime: SLOT_START,
    endTime: SLOT_END,
    bookerTimeZone: TZ,
    holderToken: "",
    idempotencyKey: key,
    attendee: { name: email.split("@")[0].toUpperCase(), email, timeZone: TZ },
    nowMs: ENTER_NOW,
  };
}

describe("APPLICATION mode (owner_pick rounds)", () => {
  it("enter creates an owner_pick round; direct booking is rejected", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      await seedEvent(ctx, { slug: "apply", mode: "application" });
      const res = await enterSlotLotteryImpl(ctx, {
        ...entryArgs("apply", "a@e.com", "Ada"),
        intakeResponses: [{ name: "pitch", label: "Pitch", value: "moody rooftop" }],
      });
      const round = await ctx.db.get(res.lotteryId);
      expect(round?.resolution).toBe("owner_pick");
      expect(round?.status).toBe("open");
      await expect(
        createBookingHandler(ctx, bookArgs("apply", "sneak@e.com", "d1")),
      ).rejects.toMatchObject({ data: { kind: "lottery_only" } });
    });
  });

  it("enter is dark without the interactions flag (lottery flag does NOT open it)", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx, { interactions: false, lottery: true });
      await seedEvent(ctx, { slug: "apply", mode: "application" });
      await expect(
        enterSlotLotteryImpl(ctx, entryArgs("apply", "a@e.com")),
      ).rejects.toMatchObject({ data: { kind: "interactions_disabled" } });
    });
  });

  it("close → awaiting_pick with a pickToken; pick books the winner + burns the token", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      await seedEvent(ctx, { slug: "apply", mode: "application" });
      const a = await enterSlotLotteryImpl(ctx, {
        ...entryArgs("apply", "win@e.com", "Winner"),
        intakeResponses: [{ name: "pitch", label: "Pitch", value: "golden hour" }],
      });
      await enterSlotLotteryImpl(ctx, entryArgs("apply", "lose@e.com", "Runner"));

      const closed = await drawSlotLotteryImpl(ctx, {
        lotteryId: a.lotteryId,
        nowMs: CLOSES_AT,
      });
      expect(closed.outcome).toBe("awaiting_pick");
      const round = await ctx.db.get(a.lotteryId);
      expect(round?.status).toBe("awaiting_pick");
      expect(round?.pickToken).toBeTruthy();

      const entries = await ctx.db
        .query("slotLotteryEntries")
        .withIndex("by_lottery", (q) => q.eq("lotteryId", a.lotteryId))
        .collect();
      const winner = entries.find((e) => e.email === "win@e.com")!;

      // Wrong token rejected.
      expect(
        (
          await pickApplicationWinnerImpl(ctx, {
            lotteryId: a.lotteryId,
            entryId: winner._id,
            token: "wrong",
            nowMs: CLOSES_AT + 1,
          })
        ).outcome,
      ).toBe("bad_token");

      const picked = await pickApplicationWinnerImpl(ctx, {
        lotteryId: a.lotteryId,
        entryId: winner._id,
        token: round!.pickToken!,
        nowMs: CLOSES_AT + 1,
      });
      expect(picked.outcome).toBe("picked");
      const after = await ctx.db.get(a.lotteryId);
      expect(after?.status).toBe("drawn");
      expect(after?.pickToken).toBeUndefined();
      const booking = await ctx.db.get(after!.bookingId!);
      expect(booking?.status).toBe("accepted");
      expect(booking?.intakeResponses?.[0]?.value).toBe("golden hour");

      // Replay → idempotent not_awaiting.
      expect(
        (
          await pickApplicationWinnerImpl(ctx, {
            lotteryId: a.lotteryId,
            entryId: winner._id,
            token: round!.pickToken!,
            nowMs: CLOSES_AT + 2,
          })
        ).outcome,
      ).toBe("not_awaiting");
    });
  });

  it("sweep cancels an awaiting_pick round whose slot started unpicked", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      await seedEvent(ctx, { slug: "apply", mode: "application" });
      const a = await enterSlotLotteryImpl(ctx, entryArgs("apply", "a@e.com"));
      await drawSlotLotteryImpl(ctx, { lotteryId: a.lotteryId, nowMs: CLOSES_AT });
      await sweepDueSlotLotteriesImpl(ctx, SLOT_START + 60_000);
      expect((await ctx.db.get(a.lotteryId))?.status).toBe("cancelled");
    });
  });
});

describe("THRESHOLD mode (min headcount)", () => {
  it("first booking creates the round; below minimum at close cancels everything", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      const eventTypeId = await seedEvent(ctx, {
        slug: "group",
        mode: "threshold",
        seats: 5,
        minAttendees: 3,
      });
      const b1 = await createBookingHandler(ctx, bookArgs("group", "a@e.com", "t1"));
      await createBookingHandler(ctx, bookArgs("group", "b@e.com", "t2"));
      const round = await ctx.db
        .query("slotLotteries")
        .withIndex("by_eventType_slotStart", (q) =>
          q.eq("eventTypeId", eventTypeId).eq("slotStart", SLOT_START),
        )
        .unique();
      expect(round?.resolution).toBe("threshold");

      // Public DTO counts BOOKINGS for threshold rounds.
      const dto = await getSlotLotteryPublicImpl(ctx, String(round!._id));
      expect(dto?.entrantCount).toBe(2);
      expect(dto?.minAttendees).toBe(3);

      const res = await drawSlotLotteryImpl(ctx, {
        lotteryId: round!._id,
        nowMs: CLOSES_AT,
      });
      expect(res.outcome).toBe("cancelled");
      expect((await ctx.db.get(b1.bookingId))?.status).toBe("cancelled");
    });
  });

  it("at or above minimum at close the session confirms (bookings stay accepted)", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      const eventTypeId = await seedEvent(ctx, {
        slug: "group",
        mode: "threshold",
        seats: 5,
        minAttendees: 2,
      });
      const b1 = await createBookingHandler(ctx, bookArgs("group", "a@e.com", "t1"));
      const b2 = await createBookingHandler(ctx, bookArgs("group", "b@e.com", "t2"));
      const round = await ctx.db
        .query("slotLotteries")
        .withIndex("by_eventType_slotStart", (q) =>
          q.eq("eventTypeId", eventTypeId).eq("slotStart", SLOT_START),
        )
        .unique();
      const res = await drawSlotLotteryImpl(ctx, {
        lotteryId: round!._id,
        nowMs: CLOSES_AT,
      });
      expect(res.outcome).toBe("drawn");
      expect((await ctx.db.get(b1.bookingId))?.status).toBe("accepted");
      expect((await ctx.db.get(b2.bookingId))?.status).toBe("accepted");
    });
  });

  it("threshold creates are dark without the interactions flag", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx, { interactions: false });
      await seedEvent(ctx, { slug: "group", mode: "threshold", seats: 5, minAttendees: 3 });
      await expect(
        createBookingHandler(ctx, bookArgs("group", "a@e.com", "t1")),
      ).rejects.toMatchObject({ data: { kind: "interactions_disabled" } });
    });
  });

  it("editor validation: threshold needs min ≥ 2 and seats ≥ min", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      const eventTypeId = await seedEvent(ctx, { slug: "plainish", mode: "pair" });
      await expect(
        updateEventTypeCore(ctx, OWNER, {
          id: eventTypeId,
          interactionMode: "threshold",
          thresholdMinAttendees: 4,
          seatsPerSlot: 3,
        }),
      ).rejects.toThrow();
      // Valid combination saves.
      await updateEventTypeCore(ctx, OWNER, {
        id: eventTypeId,
        interactionMode: "threshold",
        thresholdMinAttendees: 3,
        seatsPerSlot: 5,
      });
      const row = await ctx.db.get(eventTypeId);
      expect(row?.interactionMode).toBe("threshold");
      expect(row?.thresholdMinAttendees).toBe(3);
    });
  });
});

describe("PAIR mode (two-party commit)", () => {
  it("create lands pending with a token + deadline and blocks the slot", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      await seedEvent(ctx, { slug: "duo", mode: "pair" });
      const res = await createBookingHandler(ctx, bookArgs("duo", "a@e.com", "p1"));
      expect(res.status).toBe("pending");
      const booking = await ctx.db.get(res.bookingId);
      expect(booking?.partnerToken).toBeTruthy();
      expect(booking?.partnerDeadline).toBeLessThanOrEqual(SLOT_START);
      // The pending hold occupies the slot.
      await expect(
        createBookingHandler(ctx, bookArgs("duo", "b@e.com", "p2")),
      ).rejects.toMatchObject({ data: { kind: "slot_unavailable" } });
    });
  });

  it("partner join flips to accepted + adds the guest; replay rejects", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      await seedEvent(ctx, { slug: "duo", mode: "pair" });
      const res = await createBookingHandler(ctx, bookArgs("duo", "a@e.com", "p1"));
      const booking = await ctx.db.get(res.bookingId);

      const dto = await getPairPublicImpl(ctx, booking!.partnerToken!);
      expect(dto?.status).toBe("pending");
      expect(JSON.stringify(dto)).not.toContain("a@e.com"); // email never exposed

      const joined = await joinPairBookingImpl(ctx, {
        token: booking!.partnerToken!,
        name: "Buddy",
        email: "buddy@e.com",
        nowMs: ENTER_NOW + 60_000,
      });
      expect(joined.status).toBe("accepted");
      const attendees = await ctx.db
        .query("bookingAttendees")
        .withIndex("by_booking", (q) => q.eq("bookingId", res.bookingId))
        .collect();
      expect(attendees.filter((a) => a.role === "guest")).toHaveLength(1);

      await expect(
        joinPairBookingImpl(ctx, {
          token: booking!.partnerToken!,
          name: "Third",
          email: "third@e.com",
          nowMs: ENTER_NOW + 120_000,
        }),
      ).rejects.toMatchObject({ data: { kind: "pair_already_joined" } });
    });
  });

  it("expiry cancels a still-pending hold (exact-time + sweep), join after → pair_gone", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx);
      await seedEvent(ctx, { slug: "duo", mode: "pair" });
      const res = await createBookingHandler(ctx, bookArgs("duo", "a@e.com", "p1"));
      const booking = await ctx.db.get(res.bookingId);
      const afterDeadline = (booking!.partnerDeadline as number) + 1;

      const expired = await expirePairBookingImpl(ctx, {
        bookingId: res.bookingId,
        nowMs: afterDeadline,
      });
      expect(expired.expired).toBe(true);
      expect((await ctx.db.get(res.bookingId))?.status).toBe("cancelled");

      await expect(
        joinPairBookingImpl(ctx, {
          token: booking!.partnerToken!,
          name: "Late",
          email: "late@e.com",
          nowMs: afterDeadline,
        }),
      ).rejects.toMatchObject({ data: { kind: "pair_gone" } });

      // Sweep is a no-op on the already-cancelled hold.
      const sweep = await sweepExpiredPairHoldsImpl(ctx, afterDeadline);
      expect(sweep.expired).toBe(0);
    });
  });

  it("pair creates are dark without the interactions flag", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await enableFlags(ctx, { interactions: false });
      await seedEvent(ctx, { slug: "duo", mode: "pair" });
      await expect(
        createBookingHandler(ctx, bookArgs("duo", "a@e.com", "p1")),
      ).rejects.toMatchObject({ data: { kind: "interactions_disabled" } });
    });
  });
});
