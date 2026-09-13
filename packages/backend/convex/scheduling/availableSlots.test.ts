// Unit tests for `scheduling/availableSlots.ts` (BOOKING A6 — collective slots
// orchestrator). Follows the repo FakeDb + bare-handler convention.
//
// Scenario backbone: two hosts (A, B) each on a UTC 9–17 weekday schedule,
// staffing one COLLECTIVE event type. Collective => slots exist only where BOTH
// are simultaneously free. We assert CONCRETE slot start times, not just counts.

import { describe, it, expect, beforeEach } from "vitest";
import { getAvailableSlotsHandler } from "./availableSlots";
import { dayjs } from "@dibslist/scheduling-engine";

// ─────────────────────────────────────────────────────────────
// FakeDb with eq + range chaining (same as availability.test.ts)
// ─────────────────────────────────────────────────────────────

type Doc = Record<string, any> & { _id: string; _creationTime: number };

class FakeQuery {
  private rows: Doc[];
  constructor(rows: Doc[]) {
    this.rows = rows;
  }
  withIndex(_name: string, fn?: (q: any) => any) {
    if (!fn) return this;
    const preds: Array<(r: Doc) => boolean> = [];
    const q = {
      eq(field: string, value: any) {
        preds.push((r) => r[field] === value);
        return q;
      },
      gte(field: string, value: any) {
        preds.push((r) => r[field] >= value);
        return q;
      },
      lte(field: string, value: any) {
        preds.push((r) => r[field] <= value);
        return q;
      },
      gt(field: string, value: any) {
        preds.push((r) => r[field] > value);
        return q;
      },
      lt(field: string, value: any) {
        preds.push((r) => r[field] < value);
        return q;
      },
    };
    fn(q);
    this.rows = this.rows.filter((r) => preds.every((p) => p(r)));
    return this;
  }
  async collect(): Promise<Doc[]> {
    return [...this.rows];
  }
  async unique(): Promise<Doc | null> {
    if (this.rows.length > 1) throw new Error("unique(): more than one row");
    return this.rows[0] ?? null;
  }
  async first(): Promise<Doc | null> {
    return this.rows[0] ?? null;
  }
}

class FakeDb {
  tables: Record<string, Map<string, Doc>> = {};
  private seq = 0;
  private table(name: string): Map<string, Doc> {
    if (!this.tables[name]) this.tables[name] = new Map();
    return this.tables[name];
  }
  private tableOfId(id: string): string {
    return id.split("|")[0];
  }
  async insert(table: string, doc: Record<string, any>): Promise<string> {
    this.seq += 1;
    const _id = `${table}|${this.seq}`;
    const row: Doc = { ...doc, _id, _creationTime: Date.now() + this.seq };
    this.table(table).set(_id, row);
    return _id;
  }
  async get(id: string): Promise<Doc | null> {
    return this.table(this.tableOfId(id)).get(id) ?? null;
  }
  query(table: string) {
    return new FakeQuery([...this.table(table).values()]);
  }
}

function makeCtx() {
  return { db: new FakeDb() } as any;
}

// ─────────────────────────────────────────────────────────────
// Constants + seed helpers
// ─────────────────────────────────────────────────────────────

const TZ = "UTC";
const HOST_A = "host_a";
const HOST_B = "host_b";

// 2027-06-07 is a Monday. We deliberately use a FAR-FUTURE window so the engine's
// `getSlots`, which applies minimumBookingNotice against the REAL wall-clock
// (`dayjs.utc()`), never trims our window — only our injected `nowMs` does.
const WINDOW_START = Date.UTC(2027, 5, 7, 0, 0, 0); // Mon 00:00Z
const WINDOW_END = Date.UTC(2027, 5, 8, 0, 0, 0); // Tue 00:00Z
// "now" well before the window so min-notice doesn't trim by default.
const NOW = Date.UTC(2027, 4, 7, 0, 0, 0); // 2027-05-07

const WEEKDAYS = [1, 2, 3, 4, 5];
const NINE = 9 * 60;
const ONE_PM = 13 * 60;
const FIVE_PM = 17 * 60;
const EIGHT_PM = 20 * 60;

async function seedScheduleWithHours(
  ctx: any,
  owner: string,
  startMinute: number,
  endMinute: number,
): Promise<string> {
  const sched = await ctx.db.insert("schedules", {
    ownerAuthUserId: owner,
    name: "Working hours",
    timeZone: TZ,
    isDefault: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await ctx.db.insert("availability", {
    scheduleId: sched,
    ownerAuthUserId: owner,
    days: WEEKDAYS,
    startMinute,
    endMinute,
    createdAt: Date.now(),
  });
  return sched;
}

async function seedEventType(
  ctx: any,
  opts: {
    durationMinutes?: number;
    minNotice?: number;
    slug?: string;
    schedulingType?: "collective" | "round_robin";
    seatsPerSlot?: number;
  } = {},
): Promise<string> {
  return ctx.db.insert("eventTypes", {
    ownerAuthUserId: HOST_A,
    slug: opts.slug ?? "panel",
    title: "Panel Interview",
    durationMinutes: opts.durationMinutes ?? 60,
    schedulingType: opts.schedulingType ?? "collective",
    minimumBookingNoticeMinutes: opts.minNotice ?? 0,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    requireEmailVerification: false,
    // E3 GROUP: undefined unless the test opts into group capacity.
    seatsPerSlot: opts.seatsPerSlot,
    hidden: false,
    active: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

async function seedHost(
  ctx: any,
  eventTypeId: string,
  hostAuthUserId: string,
  opts: { isFixed?: boolean } = {},
) {
  await ctx.db.insert("eventTypeHosts", {
    eventTypeId,
    ownerAuthUserId: HOST_A,
    hostAuthUserId,
    isFixed: opts.isFixed ?? true,
    createdAt: Date.now(),
  });
}

// Flatten slotsByDate to a sorted list of ISO start strings for assertions.
function isoStarts(result: { slotsByDate: Record<string, any[]> }): string[] {
  return Object.values(result.slotsByDate)
    .flat()
    .map((s) => dayjs(s.startMs).toISOString())
    .sort();
}

let ctx: any;
beforeEach(() => {
  ctx = makeCtx();
});

// ─────────────────────────────────────────────────────────────
// (a) no bookings → collective slots = intersection across both hosts
// ─────────────────────────────────────────────────────────────

describe("getAvailableSlots — collective intersection", () => {
  it("(a) with no bookings, slots = intersection of A(9-17) and B(13-20)", async () => {
    await seedScheduleWithHours(ctx, HOST_A, NINE, FIVE_PM); // 9–17
    await seedScheduleWithHours(ctx, HOST_B, ONE_PM, EIGHT_PM); // 13–20
    const et = await seedEventType(ctx);
    await seedHost(ctx, et, HOST_A);
    await seedHost(ctx, et, HOST_B);

    const res = await getAvailableSlotsHandler(ctx, {
      eventTypeId: et as any,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      viewerTimeZone: TZ,
      nowMs: NOW,
    });

    // Intersection is 13:00–17:00; 60-min slots stepping every 60 min:
    // 13,14,15,16 (16:00 ends 17:00, fits; 17:00 would end 18:00, excluded).
    expect(isoStarts(res)).toEqual([
      "2027-06-07T13:00:00.000Z",
      "2027-06-07T14:00:00.000Z",
      "2027-06-07T15:00:00.000Z",
      "2027-06-07T16:00:00.000Z",
    ]);
    expect(res.hosts.map((h) => h.authUserId).sort()).toEqual([HOST_A, HOST_B]);
    expect(res.eventTypeDurationMinutes).toBe(60);
  });

  // ───────────────────────────────────────────────────────────
  // (e) headline: a slot survives ONLY when BOTH hosts are free
  // ───────────────────────────────────────────────────────────

  it("(e) BOTH-FREE: a 12:00 slot exists only because both A and B are free then", async () => {
    // A: 9–17, B: 9–17 → full overlap 9–17.
    await seedScheduleWithHours(ctx, HOST_A, NINE, FIVE_PM);
    await seedScheduleWithHours(ctx, HOST_B, NINE, FIVE_PM);
    const et = await seedEventType(ctx);
    await seedHost(ctx, et, HOST_A);
    await seedHost(ctx, et, HOST_B);

    const res = await getAvailableSlotsHandler(ctx, {
      eventTypeId: et as any,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      viewerTimeZone: TZ,
      nowMs: NOW,
    });

    const starts = isoStarts(res);
    // The headline assertion: 12:00 is offered because BOTH hosts are free.
    expect(starts).toContain("2027-06-07T12:00:00.000Z");

    // Now block host A 12:00–13:00 with an accepted booking. Because this is a
    // COLLECTIVE event, the 12:00 slot must DISAPPEAR — host B alone is not
    // enough; the slot only survives when BOTH are free.
    await ctx.db.insert("bookings", {
      eventTypeId: et,
      ownerAuthUserId: HOST_A,
      assignedHostAuthUserId: HOST_A,
      startTime: Date.UTC(2027, 5, 7, 12, 0, 0),
      endTime: Date.UTC(2027, 5, 7, 13, 0, 0),
      timeZone: TZ,
      status: "accepted",
      idempotencyKey: "block-a-12",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const after = await getAvailableSlotsHandler(ctx, {
      eventTypeId: et as any,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      viewerTimeZone: TZ,
      nowMs: NOW,
    });
    expect(isoStarts(after)).not.toContain("2027-06-07T12:00:00.000Z");
  });
});

// ─────────────────────────────────────────────────────────────
// (b) accepted booking on host A removes the collective slot
// ─────────────────────────────────────────────────────────────

describe("getAvailableSlots — booking subtraction", () => {
  it("(b) an accepted booking blocking host A 10–11 removes the 10:00 collective slot", async () => {
    await seedScheduleWithHours(ctx, HOST_A, NINE, FIVE_PM);
    await seedScheduleWithHours(ctx, HOST_B, NINE, FIVE_PM);
    const et = await seedEventType(ctx);
    await seedHost(ctx, et, HOST_A);
    await seedHost(ctx, et, HOST_B);

    await ctx.db.insert("bookings", {
      eventTypeId: et,
      ownerAuthUserId: HOST_A,
      assignedHostAuthUserId: HOST_A,
      startTime: Date.UTC(2027, 5, 7, 10, 0, 0),
      endTime: Date.UTC(2027, 5, 7, 11, 0, 0),
      timeZone: TZ,
      status: "accepted",
      idempotencyKey: "k-a-10",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const res = await getAvailableSlotsHandler(ctx, {
      eventTypeId: et as any,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      viewerTimeZone: TZ,
      nowMs: NOW,
    });

    const starts = isoStarts(res);
    expect(starts).not.toContain("2027-06-07T10:00:00.000Z");
    // 09:00 still present (ends 10:00, fits before the booking); 11:00 present.
    expect(starts).toContain("2027-06-07T09:00:00.000Z");
    expect(starts).toContain("2027-06-07T11:00:00.000Z");
  });
});

// ─────────────────────────────────────────────────────────────
// (c) active bookingHold excludes the held slot
// ─────────────────────────────────────────────────────────────

describe("getAvailableSlots — bookingHolds", () => {
  it("(c) a non-expired hold on 14:00 excludes that slot; an expired hold does not", async () => {
    await seedScheduleWithHours(ctx, HOST_A, NINE, FIVE_PM);
    await seedScheduleWithHours(ctx, HOST_B, NINE, FIVE_PM);
    const et = await seedEventType(ctx);
    await seedHost(ctx, et, HOST_A);
    await seedHost(ctx, et, HOST_B);

    const held = Date.UTC(2027, 5, 7, 14, 0, 0);
    await ctx.db.insert("bookingHolds", {
      eventTypeId: et,
      startTime: held,
      endTime: held + 60 * 60_000,
      holderToken: "tok-active",
      expiresAt: NOW + 5 * 60_000, // not yet expired (relative to NOW)
      createdAt: Date.now(),
    });
    // An expired hold on 15:00 must NOT remove that slot.
    const expired = Date.UTC(2027, 5, 7, 15, 0, 0);
    await ctx.db.insert("bookingHolds", {
      eventTypeId: et,
      startTime: expired,
      endTime: expired + 60 * 60_000,
      holderToken: "tok-expired",
      expiresAt: NOW - 1, // already expired
      createdAt: Date.now(),
    });

    const res = await getAvailableSlotsHandler(ctx, {
      eventTypeId: et as any,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      viewerTimeZone: TZ,
      nowMs: NOW,
    });

    const starts = isoStarts(res);
    expect(starts).not.toContain("2027-06-07T14:00:00.000Z");
    expect(starts).toContain("2027-06-07T15:00:00.000Z");
  });
});

// ─────────────────────────────────────────────────────────────
// (d) minimumBookingNotice cutoff respected
// ─────────────────────────────────────────────────────────────

describe("getAvailableSlots — minimum booking notice", () => {
  it("(d) slots before now+minNotice are excluded", async () => {
    await seedScheduleWithHours(ctx, HOST_A, NINE, FIVE_PM);
    await seedScheduleWithHours(ctx, HOST_B, NINE, FIVE_PM);
    // min notice = enough to push past 11:00 on the booking day.
    const et = await seedEventType(ctx, { minNotice: 120 });
    await seedHost(ctx, et, HOST_A);
    await seedHost(ctx, et, HOST_B);

    // now = Mon 09:00Z → earliest bookable = 11:00Z. So 09:00 and 10:00 drop.
    const nowOnDay = Date.UTC(2027, 5, 7, 9, 0, 0);

    const res = await getAvailableSlotsHandler(ctx, {
      eventTypeId: et as any,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      viewerTimeZone: TZ,
      nowMs: nowOnDay,
    });

    const starts = isoStarts(res);
    expect(starts).not.toContain("2027-06-07T09:00:00.000Z");
    expect(starts).not.toContain("2027-06-07T10:00:00.000Z");
    expect(starts).toContain("2027-06-07T11:00:00.000Z");
  });
});

// ─────────────────────────────────────────────────────────────
// E1 (round-robin): a slot is offered if ANY host is free (union), vs
// collective which requires ALL hosts free (intersection).
// ─────────────────────────────────────────────────────────────

describe("getAvailableSlots — round-robin union (E1)", () => {
  it("RR offers a slot when ANY ONE host is free; collective would offer none", async () => {
    // DISJOINT schedules: A free 9–12, B free 14–17. No overlap at all.
    await seedScheduleWithHours(ctx, HOST_A, NINE, 12 * 60); // 9–12
    await seedScheduleWithHours(ctx, HOST_B, 14 * 60, FIVE_PM); // 14–17

    // COLLECTIVE first: intersection is empty → ZERO slots.
    const collEt = await seedEventType(ctx, { slug: "coll", schedulingType: "collective" });
    await seedHost(ctx, collEt, HOST_A);
    await seedHost(ctx, collEt, HOST_B);
    const coll = await getAvailableSlotsHandler(ctx, {
      slug: "coll",
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      viewerTimeZone: TZ,
      nowMs: NOW,
    });
    expect(isoStarts(coll)).toEqual([]); // no slot where BOTH are free

    // ROUND_ROBIN: union → slots exist in A's 9–12 AND B's 14–17 windows.
    const rrEt = await seedEventType(ctx, { slug: "rr", schedulingType: "round_robin" });
    await seedHost(ctx, rrEt, HOST_A, { isFixed: false });
    await seedHost(ctx, rrEt, HOST_B, { isFixed: false });
    const rr = await getAvailableSlotsHandler(ctx, {
      slug: "rr",
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      viewerTimeZone: TZ,
      nowMs: NOW,
    });
    const rrStarts = isoStarts(rr);
    // A free 9–12 → 9,10,11 (11 ends 12). B free 14–17 → 14,15,16.
    expect(rrStarts).toContain("2027-06-07T09:00:00.000Z"); // only A free
    expect(rrStarts).toContain("2027-06-07T16:00:00.000Z"); // only B free
    // Nothing in the dead 12–14 zone.
    expect(rrStarts).not.toContain("2027-06-07T12:00:00.000Z");
    expect(rrStarts).not.toContain("2027-06-07T13:00:00.000Z");
  });

  it("RR attaches per-slot eligibleHostIdxs (which hosts can staff each slot)", async () => {
    // A free 9–12, B free 14–17 (disjoint).
    await seedScheduleWithHours(ctx, HOST_A, NINE, 12 * 60);
    await seedScheduleWithHours(ctx, HOST_B, 14 * 60, FIVE_PM);
    const et = await seedEventType(ctx, { slug: "rr2", schedulingType: "round_robin" });
    await seedHost(ctx, et, HOST_A, { isFixed: false }); // host index 0
    await seedHost(ctx, et, HOST_B, { isFixed: false }); // host index 1

    const res = await getAvailableSlotsHandler(ctx, {
      slug: "rr2",
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      viewerTimeZone: TZ,
      nowMs: NOW,
    });
    const all = Object.values(res.slotsByDate).flat();
    const at = (iso: string) =>
      all.find((s: any) => dayjs(s.startMs).toISOString() === iso);

    // 09:00 → only host A (idx 0) free.
    expect(at("2027-06-07T09:00:00.000Z")?.eligibleHostIdxs).toEqual([0]);
    // 16:00 → only host B (idx 1) free.
    expect(at("2027-06-07T16:00:00.000Z")?.eligibleHostIdxs).toEqual([1]);
  });
});

// ─────────────────────────────────────────────────────────────
// validation: inactive / missing event type throws
// ─────────────────────────────────────────────────────────────

describe("getAvailableSlots — validation", () => {
  it("throws Not found for an inactive event type", async () => {
    const et = await ctx.db.insert("eventTypes", {
      ownerAuthUserId: HOST_A,
      slug: "off",
      title: "Off",
      durationMinutes: 60,
      schedulingType: "collective",
      minimumBookingNoticeMinutes: 0,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      requireEmailVerification: false,
      hidden: false,
      active: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await expect(
      getAvailableSlotsHandler(ctx, {
        eventTypeId: et as any,
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        viewerTimeZone: TZ,
        nowMs: NOW,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("resolves the event type by slug", async () => {
    await seedScheduleWithHours(ctx, HOST_A, NINE, FIVE_PM);
    await seedScheduleWithHours(ctx, HOST_B, NINE, FIVE_PM);
    const et = await seedEventType(ctx, { slug: "by-slug" });
    await seedHost(ctx, et, HOST_A);
    await seedHost(ctx, et, HOST_B);

    const res = await getAvailableSlotsHandler(ctx, {
      slug: "by-slug",
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      viewerTimeZone: TZ,
      nowMs: NOW,
    });
    expect(isoStarts(res).length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────
// E3 — GROUP capacity (seatsRemaining). A group slot exposes the remaining
// seats and disappears only once it's full; remaining decrements per booking.
// ─────────────────────────────────────────────────────────────

describe("getAvailableSlots — group capacity (seatsRemaining)", () => {
  // The first surviving slot's start, for a single-host 9–17 group event.
  const TARGET = WINDOW_START + 9 * 60 * 60_000; // 09:00Z (60-min slots step 60)

  function slotAt(
    result: { slotsByDate: Record<string, any[]> },
    startMs: number,
  ): any | undefined {
    return Object.values(result.slotsByDate)
      .flat()
      .find((s) => s.startMs === startMs);
  }

  async function insertGroupBooking(etId: string, startMs: number, key: string) {
    await ctx.db.insert("bookings", {
      eventTypeId: etId,
      ownerAuthUserId: HOST_A,
      assignedHostAuthUserId: HOST_A,
      startTime: startMs,
      endTime: startMs + 60 * 60_000,
      timeZone: TZ,
      status: "accepted",
      idempotencyKey: key,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  it("exposes seatsRemaining, decrements per booking, and hides the slot when full", async () => {
    const CAPACITY = 2;
    await seedScheduleWithHours(ctx, HOST_A, NINE, FIVE_PM); // 9–17
    const et = await seedEventType(ctx, { slug: "grp-slots", seatsPerSlot: CAPACITY });
    await seedHost(ctx, et, HOST_A);

    // No bookings yet → the slot exists with FULL capacity remaining.
    let res = await getAvailableSlotsHandler(ctx, {
      eventTypeId: et as any,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      viewerTimeZone: TZ,
      nowMs: NOW,
    });
    expect(slotAt(res, TARGET)?.seatsRemaining).toBe(CAPACITY);

    // One booking into the target slot → it STILL appears, remaining decremented.
    await insertGroupBooking(et, TARGET, "g-1");
    res = await getAvailableSlotsHandler(ctx, {
      eventTypeId: et as any,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      viewerTimeZone: TZ,
      nowMs: NOW,
    });
    expect(slotAt(res, TARGET)?.seatsRemaining).toBe(CAPACITY - 1);

    // Fill to capacity → the slot DISAPPEARS (full); other slots remain.
    await insertGroupBooking(et, TARGET, "g-2");
    res = await getAvailableSlotsHandler(ctx, {
      eventTypeId: et as any,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      viewerTimeZone: TZ,
      nowMs: NOW,
    });
    expect(slotAt(res, TARGET)).toBeUndefined();
    expect(isoStarts(res).length).toBeGreaterThan(0); // later slots still offered
  });

  it("solo event types do NOT carry seatsRemaining (regression)", async () => {
    await seedScheduleWithHours(ctx, HOST_A, NINE, FIVE_PM);
    const et = await seedEventType(ctx, { slug: "solo-slots" }); // no seatsPerSlot
    await seedHost(ctx, et, HOST_A);
    const res = await getAvailableSlotsHandler(ctx, {
      eventTypeId: et as any,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      viewerTimeZone: TZ,
      nowMs: NOW,
    });
    const first = Object.values(res.slotsByDate).flat()[0];
    expect(first).toBeTruthy();
    expect(first.seatsRemaining).toBeUndefined();
  });
});
