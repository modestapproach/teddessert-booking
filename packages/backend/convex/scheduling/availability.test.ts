// Unit tests for `scheduling/availability.ts` (BOOKING A5 — per-host ranges).
//
// HARNESS: follows the repo's FakeDb + bare-handler convention (see
// eventTypes.test.ts). `getUserAvailabilityRangesHandler` is exercised directly
// against an in-memory fake ctx. The FakeQuery here is a superset of the
// eventTypes one — it additionally supports `.gte()/.lte()/.gt()/.lt()` range
// chaining on indexes, which the availability/dateOverrides/bookings scans use.
//
// No auth mock is needed: getUserAvailabilityRanges is an internal helper with
// no requireAuthUserId call (the public surface gates auth in the orchestrator).

import { describe, it, expect, beforeEach } from "vitest";
import { ConvexError } from "convex/values";
import {
  getUserAvailabilityRangesHandler,
  type SerializedDateRange,
} from "./availability";
import { dayjs } from "@dibslist/scheduling-engine";

// ─────────────────────────────────────────────────────────────
// FakeDb with eq + range (gte/lte/gt/lt) index chaining
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
// Seed helpers — a UTC schedule, 9–17 weekday hours
// ─────────────────────────────────────────────────────────────

const HOST = "host_a";
const TZ = "UTC";

// 2026-06-01 is a Monday.
const MON = Date.UTC(2026, 5, 1, 0, 0, 0); // 2026-06-01T00:00Z
const WINDOW_START = MON;
const WINDOW_END = Date.UTC(2026, 5, 2, 0, 0, 0); // 2026-06-02T00:00Z (Tue 00:00)

async function seedSchedule(
  ctx: any,
  owner: string,
  opts: { isDefault?: boolean; timeZone?: string } = {},
): Promise<string> {
  return ctx.db.insert("schedules", {
    ownerAuthUserId: owner,
    name: "Working hours",
    timeZone: opts.timeZone ?? TZ,
    isDefault: opts.isDefault ?? true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

async function seedWeekly(
  ctx: any,
  scheduleId: string,
  owner: string,
  days: number[],
  startMinute: number,
  endMinute: number,
) {
  await ctx.db.insert("availability", {
    scheduleId,
    ownerAuthUserId: owner,
    days,
    startMinute,
    endMinute,
    createdAt: Date.now(),
  });
}

const NINE = 9 * 60;
const FIVE_PM = 17 * 60;
const WEEKDAYS = [1, 2, 3, 4, 5];

let ctx: any;
beforeEach(() => {
  ctx = makeCtx();
});

describe("getUserAvailabilityRanges — schedule resolution", () => {
  it("returns [] when the host has no schedule", async () => {
    const res = await getUserAvailabilityRangesHandler(ctx, {
      hostAuthUserId: HOST,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      viewerTimeZone: TZ,
    });
    expect(res).toEqual([]);
  });

  it("throws Not found when a pinned scheduleId is owned by someone else", async () => {
    const foreign = await seedSchedule(ctx, "someone_else", { isDefault: false });
    await expect(
      getUserAvailabilityRangesHandler(ctx, {
        hostAuthUserId: HOST,
        scheduleId: foreign as any,
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        viewerTimeZone: TZ,
      }),
    ).rejects.toThrow(ConvexError);
  });
});

describe("getUserAvailabilityRanges — working hours projection", () => {
  it("projects a Mon 9–17 UTC window with no bookings", async () => {
    const sched = await seedSchedule(ctx, HOST);
    await seedWeekly(ctx, sched, HOST, WEEKDAYS, NINE, FIVE_PM);

    const res = await getUserAvailabilityRangesHandler(ctx, {
      hostAuthUserId: HOST,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      viewerTimeZone: TZ,
    });

    expect(res).toHaveLength(1);
    expect(dayjs(res[0].start).toISOString()).toBe("2026-06-01T09:00:00.000Z");
    expect(dayjs(res[0].end).toISOString()).toBe("2026-06-01T17:00:00.000Z");
  });

  it("subtracts an accepted booking, punching a hole in the day", async () => {
    const sched = await seedSchedule(ctx, HOST);
    await seedWeekly(ctx, sched, HOST, WEEKDAYS, NINE, FIVE_PM);

    // accepted booking 10:00–11:00 UTC
    await ctx.db.insert("bookings", {
      eventTypeId: "eventTypes|x",
      ownerAuthUserId: HOST,
      assignedHostAuthUserId: HOST,
      startTime: Date.UTC(2026, 5, 1, 10, 0, 0),
      endTime: Date.UTC(2026, 5, 1, 11, 0, 0),
      timeZone: TZ,
      status: "accepted",
      idempotencyKey: "k1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const res = await getUserAvailabilityRangesHandler(ctx, {
      hostAuthUserId: HOST,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      viewerTimeZone: TZ,
    });

    expect(res.map((r: SerializedDateRange) => dayjs(r.start).toISOString())).toEqual([
      "2026-06-01T09:00:00.000Z",
      "2026-06-01T11:00:00.000Z",
    ]);
    expect(res.map((r: SerializedDateRange) => dayjs(r.end).toISOString())).toEqual([
      "2026-06-01T10:00:00.000Z",
      "2026-06-01T17:00:00.000Z",
    ]);
  });

  it("blocks a booking that STARTS before the window but ENDS inside it (no false-free)", async () => {
    const sched = await seedSchedule(ctx, HOST);
    await seedWeekly(ctx, sched, HOST, WEEKDAYS, NINE, FIVE_PM);

    // Booking Sun 23:00 → Mon 09:30: startTime is BEFORE windowStart (Mon 00:00),
    // so the old `gte(startTime, windowStart)` query would miss it and leave
    // 09:00–09:30 falsely free. The widened lower bound + overlap filter must
    // catch it and block the first half hour.
    await ctx.db.insert("bookings", {
      eventTypeId: "eventTypes|x",
      ownerAuthUserId: HOST,
      assignedHostAuthUserId: HOST,
      startTime: Date.UTC(2026, 4, 31, 23, 0, 0), // Sun 2026-05-31 23:00
      endTime: Date.UTC(2026, 5, 1, 9, 30, 0), // Mon 2026-06-01 09:30
      timeZone: TZ,
      status: "accepted",
      idempotencyKey: "k3",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const res = await getUserAvailabilityRangesHandler(ctx, {
      hostAuthUserId: HOST,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      viewerTimeZone: TZ,
    });

    // First free range must start at 09:30 (not 09:00) — the straddling booking
    // consumed the opening half hour.
    expect(res).toHaveLength(1);
    expect(dayjs(res[0].start).toISOString()).toBe("2026-06-01T09:30:00.000Z");
    expect(dayjs(res[0].end).toISOString()).toBe("2026-06-01T17:00:00.000Z");
  });

  it("ignores cancelled bookings (they do not block availability)", async () => {
    const sched = await seedSchedule(ctx, HOST);
    await seedWeekly(ctx, sched, HOST, WEEKDAYS, NINE, FIVE_PM);

    await ctx.db.insert("bookings", {
      eventTypeId: "eventTypes|x",
      ownerAuthUserId: HOST,
      assignedHostAuthUserId: HOST,
      startTime: Date.UTC(2026, 5, 1, 10, 0, 0),
      endTime: Date.UTC(2026, 5, 1, 11, 0, 0),
      timeZone: TZ,
      status: "cancelled",
      idempotencyKey: "k2",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const res = await getUserAvailabilityRangesHandler(ctx, {
      hostAuthUserId: HOST,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      viewerTimeZone: TZ,
    });

    // Full uninterrupted 9–17 day.
    expect(res).toHaveLength(1);
    expect(dayjs(res[0].start).toISOString()).toBe("2026-06-01T09:00:00.000Z");
    expect(dayjs(res[0].end).toISOString()).toBe("2026-06-01T17:00:00.000Z");
  });
});
