// BOOKING / A7 — tests for `scheduling/holds.ts` (claimHold / releaseHold /
// sweepExpiredHolds).
//
// HARNESS: repo FakeDb + bare-handler convention (see availability.test.ts).
// The FakeQuery supports eq + gte/lte/gt/lt range chaining + `.take()`. No auth
// mock is needed — holds are the unauthenticated candidate path (no
// requireAuthUserId). The DEFAULT-OFF `booking_enabled` flag is exercised through
// the REAL `_helpers/featureFlag.ts` read path (queries featureFlags by_key); we
// seed a `{ key: "booking_enabled", value: true }` row to open the gate.

import { describe, it, expect, beforeEach } from "vitest";
import { ConvexError } from "convex/values";
import {
  claimHoldHandler,
  releaseHoldHandler,
  sweepExpiredHoldsHandler,
  HOLD_TTL_MS,
} from "./holds";

// ─────────────────────────────────────────────────────────────
// FakeDb (eq + range + take)
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
  async take(n: number): Promise<Doc[]> {
    return this.rows.slice(0, n);
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
  async patch(id: string, patch: Record<string, any>): Promise<void> {
    const row = this.table(this.tableOfId(id)).get(id);
    if (!row) throw new Error(`patch: missing ${id}`);
    for (const [k, val] of Object.entries(patch)) {
      if (val === undefined) delete row[k];
      else row[k] = val;
    }
  }
  async delete(id: string): Promise<void> {
    this.table(this.tableOfId(id)).delete(id);
  }
  query(table: string) {
    return new FakeQuery([...this.table(table).values()]);
  }
}

function makeCtx() {
  return { db: new FakeDb() } as any;
}

// ─────────────────────────────────────────────────────────────
// Seed helpers — UTC schedule, weekday 9–17 working hours, one host
// ─────────────────────────────────────────────────────────────

const HOST = "host_a";
const OWNER = "owner_x";
const TZ = "UTC";

// 2026-06-01 is a Monday. Slot 10:00–10:30Z is inside 9–17 working hours.
const SLOT_START = Date.UTC(2026, 5, 1, 10, 0, 0);
const SLOT_END = Date.UTC(2026, 5, 1, 10, 30, 0);
// "now" = the prior Friday so the slot is comfortably past min-notice.
const NOW = Date.UTC(2026, 5, 1, 9, 0, 0);

async function enableBooking(ctx: any) {
  await ctx.db.insert("featureFlags", {
    key: "booking_enabled",
    value: true,
    updatedAt: Date.now(),
    updatedBy: "test",
  });
}

async function seedAvailableEventType(
  ctx: any,
  opts: { active?: boolean } = {},
): Promise<any> {
  const scheduleId = await ctx.db.insert("schedules", {
    ownerAuthUserId: HOST,
    name: "Working hours",
    timeZone: TZ,
    isDefault: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  // Mon–Fri (1..5) 09:00–17:00 (540..1020 minutes).
  await ctx.db.insert("availability", {
    scheduleId,
    days: [1, 2, 3, 4, 5],
    startMinute: 540,
    endMinute: 1020,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const eventTypeId = await ctx.db.insert("eventTypes", {
    ownerAuthUserId: OWNER,
    slug: "intro",
    title: "Intro",
    durationMinutes: 30,
    schedulingType: "collective",
    minimumBookingNoticeMinutes: 0,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    requireEmailVerification: false,
    hidden: false,
    active: opts.active ?? true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await ctx.db.insert("eventTypeHosts", {
    eventTypeId,
    ownerAuthUserId: OWNER,
    hostAuthUserId: HOST,
    isFixed: true,
    createdAt: Date.now(),
  });
  return eventTypeId;
}

let ctx: any;
beforeEach(async () => {
  ctx = makeCtx();
  await enableBooking(ctx);
});

// ─────────────────────────────────────────────────────────────
// claimHold — happy path + overlap block + idempotent re-claim
// ─────────────────────────────────────────────────────────────

describe("claimHold", () => {
  it("claims a free slot and writes a hold with a ~5-min TTL", async () => {
    const eventTypeId = await seedAvailableEventType(ctx);
    const res = await claimHoldHandler(ctx, {
      eventTypeId,
      startTime: SLOT_START,
      endTime: SLOT_END,
      holderToken: "tok-A",
      viewerTimeZone: TZ,
      nowMs: NOW,
    });
    expect(typeof res.holdId).toBe("string");
    expect(res.holderToken).toBe("tok-A");

    const hold = await ctx.db.get(res.holdId);
    expect(hold.eventTypeId).toBe(eventTypeId);
    expect(hold.startTime).toBe(SLOT_START);
    expect(hold.expiresAt).toBe(NOW + HOLD_TTL_MS);
  });

  it("blocks a DIFFERENT holder from claiming the same live slot (slot_held)", async () => {
    const eventTypeId = await seedAvailableEventType(ctx);
    await claimHoldHandler(ctx, {
      eventTypeId,
      startTime: SLOT_START,
      endTime: SLOT_END,
      holderToken: "tok-A",
      viewerTimeZone: TZ,
      nowMs: NOW,
    });

    let kind = "";
    try {
      await claimHoldHandler(ctx, {
        eventTypeId,
        startTime: SLOT_START,
        endTime: SLOT_END,
        holderToken: "tok-B",
        viewerTimeZone: TZ,
        nowMs: NOW,
      });
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("slot_held");

    // Only the first holder's row exists.
    const holds = await ctx.db.query("bookingHolds").collect();
    expect(holds).toHaveLength(1);
    expect(holds[0].holderToken).toBe("tok-A");
  });

  it("is idempotent for the SAME holder re-claiming a live slot", async () => {
    const eventTypeId = await seedAvailableEventType(ctx);
    const first = await claimHoldHandler(ctx, {
      eventTypeId,
      startTime: SLOT_START,
      endTime: SLOT_END,
      holderToken: "tok-A",
      viewerTimeZone: TZ,
      nowMs: NOW,
    });
    const again = await claimHoldHandler(ctx, {
      eventTypeId,
      startTime: SLOT_START,
      endTime: SLOT_END,
      holderToken: "tok-A",
      viewerTimeZone: TZ,
      nowMs: NOW,
    });
    expect(again.holdId).toBe(first.holdId);
    const holds = await ctx.db.query("bookingHolds").collect();
    expect(holds).toHaveLength(1);
  });

  it("an EXPIRED hold is ignored — a new holder can claim the slot", async () => {
    const eventTypeId = await seedAvailableEventType(ctx);
    // Insert a stale hold directly (expired well before NOW).
    await ctx.db.insert("bookingHolds", {
      eventTypeId,
      startTime: SLOT_START,
      endTime: SLOT_END,
      holderToken: "tok-old",
      expiresAt: NOW - 1, // already expired
      createdAt: NOW - HOLD_TTL_MS,
    });

    // A different holder claims successfully (expired hold doesn't block).
    const res = await claimHoldHandler(ctx, {
      eventTypeId,
      startTime: SLOT_START,
      endTime: SLOT_END,
      holderToken: "tok-new",
      viewerTimeZone: TZ,
      nowMs: NOW,
    });
    expect(typeof res.holdId).toBe("string");
  });

  it("rejects a slot OUTSIDE the host's working hours (slot_unavailable)", async () => {
    const eventTypeId = await seedAvailableEventType(ctx);
    // 03:00–03:30Z is before the 09:00 working-hours start.
    const earlyStart = Date.UTC(2026, 5, 1, 3, 0, 0);
    const earlyEnd = Date.UTC(2026, 5, 1, 3, 30, 0);
    let kind = "";
    try {
      await claimHoldHandler(ctx, {
        eventTypeId,
        startTime: earlyStart,
        endTime: earlyEnd,
        holderToken: "tok-A",
        viewerTimeZone: TZ,
        nowMs: NOW,
      });
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("slot_unavailable");
  });

  it("rejects an inactive event type", async () => {
    const eventTypeId = await seedAvailableEventType(ctx, { active: false });
    let kind = "";
    try {
      await claimHoldHandler(ctx, {
        eventTypeId,
        startTime: SLOT_START,
        endTime: SLOT_END,
        holderToken: "tok-A",
        viewerTimeZone: TZ,
        nowMs: NOW,
      });
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("event_type_inactive");
  });

  it("throws booking_disabled when the flag is OFF", async () => {
    const off = makeCtx(); // no flag seeded
    const eventTypeId = await seedAvailableEventType(off);
    let kind = "";
    try {
      await claimHoldHandler(off, {
        eventTypeId,
        startTime: SLOT_START,
        endTime: SLOT_END,
        holderToken: "tok-A",
        viewerTimeZone: TZ,
        nowMs: NOW,
      });
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("booking_disabled");
  });
});

// ─────────────────────────────────────────────────────────────
// releaseHold
// ─────────────────────────────────────────────────────────────

describe("releaseHold", () => {
  it("deletes the caller's own hold", async () => {
    const eventTypeId = await seedAvailableEventType(ctx);
    const { holdId } = await claimHoldHandler(ctx, {
      eventTypeId,
      startTime: SLOT_START,
      endTime: SLOT_END,
      holderToken: "tok-A",
      viewerTimeZone: TZ,
      nowMs: NOW,
    });
    await releaseHoldHandler(ctx, { holdId, holderToken: "tok-A" });
    expect(await ctx.db.get(holdId)).toBeNull();
  });

  it("rejects releasing a hold owned by someone else", async () => {
    const eventTypeId = await seedAvailableEventType(ctx);
    const { holdId } = await claimHoldHandler(ctx, {
      eventTypeId,
      startTime: SLOT_START,
      endTime: SLOT_END,
      holderToken: "tok-A",
      viewerTimeZone: TZ,
      nowMs: NOW,
    });
    await expect(
      releaseHoldHandler(ctx, { holdId, holderToken: "tok-B" }),
    ).rejects.toThrow(ConvexError);
    // Untouched.
    expect(await ctx.db.get(holdId)).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// sweepExpiredHolds (cron impl)
// ─────────────────────────────────────────────────────────────

describe("sweepExpiredHolds", () => {
  it("deletes only expired holds and leaves live ones", async () => {
    const eventTypeId = await seedAvailableEventType(ctx);
    // Live hold.
    const live = await ctx.db.insert("bookingHolds", {
      eventTypeId,
      startTime: SLOT_START,
      endTime: SLOT_END,
      holderToken: "live",
      expiresAt: NOW + HOLD_TTL_MS,
      createdAt: NOW,
    });
    // Two expired holds.
    await ctx.db.insert("bookingHolds", {
      eventTypeId,
      startTime: SLOT_START + 1,
      endTime: SLOT_END + 1,
      holderToken: "dead1",
      expiresAt: NOW - 1000,
      createdAt: NOW - HOLD_TTL_MS,
    });
    await ctx.db.insert("bookingHolds", {
      eventTypeId,
      startTime: SLOT_START + 2,
      endTime: SLOT_END + 2,
      holderToken: "dead2",
      expiresAt: NOW - 5000,
      createdAt: NOW - HOLD_TTL_MS,
    });

    const res = await sweepExpiredHoldsHandler(ctx, { nowMs: NOW });
    expect(res.deleted).toBe(2);

    const remaining = await ctx.db.query("bookingHolds").collect();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]._id).toBe(live);
  });
});
