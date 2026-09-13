// Mutation/query-level tests for `scheduling/schedules.ts` (BOOKING A4).
//
// Same harness as eventTypes.test.ts: mock `requireAuthUserId`, call the real
// registered handlers' `._handler(ctx, args)` against an in-memory fake ctx,
// and exercise the DEFAULT-OFF `booking_enabled` flag through the real
// `_helpers/featureFlag.ts` read path (seed a `featureFlags` row to enable).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ConvexError } from "convex/values";

vi.mock("../_helpers/auth", () => ({
  requireAuthUserId: async (ctx: any) => {
    if (!ctx.__identity) throw new ConvexError("Not authenticated. Please sign in.");
    return ctx.__identity as string;
  },
}));

import * as schedules from "./schedules";

// ─────────────────────────────────────────────────────────────
// In-memory fake ctx (db with withIndex eq-filter + unique())
// ─────────────────────────────────────────────────────────────

type Doc = Record<string, any> & { _id: string; _creationTime: number };

class FakeQuery {
  private rows: Doc[];
  constructor(rows: Doc[]) {
    this.rows = rows;
  }
  withIndex(_name: string, fn?: (q: any) => any) {
    if (!fn) return this;
    const eqs: Array<[string, any]> = [];
    const q = {
      eq(field: string, value: any) {
        eqs.push([field, value]);
        return q;
      },
    };
    fn(q);
    this.rows = this.rows.filter((r) => eqs.every(([f, val]) => r[f] === val));
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

function makeCtx(identity: string | null) {
  return { db: new FakeDb(), __identity: identity } as any;
}

async function enableBooking(ctx: any) {
  await ctx.db.insert("featureFlags", {
    key: "booking_enabled",
    value: true,
    updatedAt: Date.now(),
    updatedBy: "test",
  });
}

const call = {
  create: (ctx: any, a: any) => (schedules.createSchedule as any)._handler(ctx, a),
  update: (ctx: any, a: any) => (schedules.updateSchedule as any)._handler(ctx, a),
  list: (ctx: any, a: any) => (schedules.listSchedules as any)._handler(ctx, a),
  get: (ctx: any, a: any) => (schedules.getSchedule as any)._handler(ctx, a),
  setAvailability: (ctx: any, a: any) =>
    (schedules.setAvailability as any)._handler(ctx, a),
  addOverride: (ctx: any, a: any) =>
    (schedules.addDateOverride as any)._handler(ctx, a),
  removeOverride: (ctx: any, a: any) =>
    (schedules.removeDateOverride as any)._handler(ctx, a),
};

const ME = "user_me";
const OTHER = "user_other";

let ctx: any;
beforeEach(() => {
  ctx = makeCtx(ME);
});

// ─────────────────────────────────────────────────────────────
// Happy path: create → get → list → update
// ─────────────────────────────────────────────────────────────

describe("schedules happy path (flag ON)", () => {
  beforeEach(async () => {
    await enableBooking(ctx);
  });

  it("create → get → list → update round-trips and sets owner + timestamps", async () => {
    const id = await call.create(ctx, {
      name: "Working hours",
      timeZone: "America/New_York",
      isDefault: true,
    });
    expect(typeof id).toBe("string");

    const got = await call.get(ctx, { id });
    expect(got.ownerAuthUserId).toBe(ME);
    expect(got.name).toBe("Working hours");
    expect(got.isDefault).toBe(true);
    // getSchedule embeds (empty) child arrays.
    expect(got.availability).toEqual([]);
    expect(got.dateOverrides).toEqual([]);

    const list = await call.list(ctx, {});
    expect(list.map((r: any) => r._id)).toContain(id);

    await call.update(ctx, { id, name: "Renamed" });
    const after = await call.get(ctx, { id });
    expect(after.name).toBe("Renamed");
  });

  it("enforces at-most-one-default on create and update", async () => {
    const a = await call.create(ctx, {
      name: "A",
      timeZone: "UTC",
      isDefault: true,
    });
    const b = await call.create(ctx, {
      name: "B",
      timeZone: "UTC",
      isDefault: true,
    });
    // Creating B as default cleared A's default.
    expect((await call.get(ctx, { id: a })).isDefault).toBe(false);
    expect((await call.get(ctx, { id: b })).isDefault).toBe(true);

    // Promoting A back via update clears B.
    await call.update(ctx, { id: a, isDefault: true });
    expect((await call.get(ctx, { id: a })).isDefault).toBe(true);
    expect((await call.get(ctx, { id: b })).isDefault).toBe(false);
  });

  it("listSchedules sorts default-first then oldest→newest", async () => {
    const first = await call.create(ctx, {
      name: "first",
      timeZone: "UTC",
      isDefault: false,
    });
    const second = await call.create(ctx, {
      name: "second",
      timeZone: "UTC",
      isDefault: false,
    });
    const def = await call.create(ctx, {
      name: "default",
      timeZone: "UTC",
      isDefault: true,
    });
    const ordered = await call.list(ctx, {});
    expect(ordered.map((r: any) => r._id)).toEqual([def, first, second]);
  });
});

// ─────────────────────────────────────────────────────────────
// setAvailability — full replace + validation
// ─────────────────────────────────────────────────────────────

describe("setAvailability", () => {
  beforeEach(async () => {
    await enableBooking(ctx);
  });

  it("replaces all weekly windows and denormalizes ownerAuthUserId from the schedule", async () => {
    const id = await call.create(ctx, {
      name: "S",
      timeZone: "UTC",
      isDefault: false,
    });
    await call.setAvailability(ctx, {
      scheduleId: id,
      windows: [{ days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1020 }],
    });
    let got = await call.get(ctx, { id });
    expect(got.availability).toHaveLength(1);
    expect(got.availability[0].days).toEqual([1, 2, 3, 4, 5]);
    expect(got.availability[0].ownerAuthUserId).toBe(ME);

    // Full replace: a second call wipes the prior rows.
    await call.setAvailability(ctx, {
      scheduleId: id,
      windows: [
        { days: [1], startMinute: 600, endMinute: 660 },
        { days: [3], startMinute: 600, endMinute: 660 },
      ],
    });
    got = await call.get(ctx, { id });
    expect(got.availability).toHaveLength(2);
  });

  it("rejects an invalid window", async () => {
    const id = await call.create(ctx, {
      name: "S",
      timeZone: "UTC",
      isDefault: false,
    });
    await expect(
      call.setAvailability(ctx, {
        scheduleId: id,
        windows: [{ days: [1], startMinute: 1020, endMinute: 540 }],
      }),
    ).rejects.toThrow(/invalid window/i);
    await expect(
      call.setAvailability(ctx, {
        scheduleId: id,
        windows: [{ days: [1], startMinute: -1, endMinute: 540 }],
      }),
    ).rejects.toThrow(/invalid window/i);
  });

  it("rejects a window with an out-of-range day or empty days", async () => {
    const id = await call.create(ctx, {
      name: "S",
      timeZone: "UTC",
      isDefault: false,
    });
    await expect(
      call.setAvailability(ctx, {
        scheduleId: id,
        windows: [{ days: [7], startMinute: 540, endMinute: 600 }],
      }),
    ).rejects.toThrow(/\[0, 6\]/);
    await expect(
      call.setAvailability(ctx, {
        scheduleId: id,
        windows: [{ days: [], startMinute: 540, endMinute: 600 }],
      }),
    ).rejects.toThrow(/at least one day/i);
  });
});

// ─────────────────────────────────────────────────────────────
// addDateOverride / removeDateOverride — upsert + validation
// ─────────────────────────────────────────────────────────────

describe("date overrides", () => {
  beforeEach(async () => {
    await enableBooking(ctx);
  });

  it("upserts (one row per date) and allows all-day blocks (no window)", async () => {
    const id = await call.create(ctx, {
      name: "S",
      timeZone: "UTC",
      isDefault: false,
    });
    const dateUtc = 1_700_006_400_000;
    const ov1 = await call.addOverride(ctx, { scheduleId: id, dateUtc });
    // All-day block: no window persisted.
    let got = await call.get(ctx, { id });
    expect(got.dateOverrides).toHaveLength(1);
    expect(got.dateOverrides[0].startMinute).toBeUndefined();
    expect(got.dateOverrides[0].ownerAuthUserId).toBe(ME);

    // Re-set the SAME date with a window → upsert (still one row, same id).
    const ov2 = await call.addOverride(ctx, {
      scheduleId: id,
      dateUtc,
      startMinute: 540,
      endMinute: 600,
    });
    expect(ov2).toBe(ov1);
    got = await call.get(ctx, { id });
    expect(got.dateOverrides).toHaveLength(1);
    expect(got.dateOverrides[0].startMinute).toBe(540);
  });

  it("rejects a partial window (start without end)", async () => {
    const id = await call.create(ctx, {
      name: "S",
      timeZone: "UTC",
      isDefault: false,
    });
    await expect(
      call.addOverride(ctx, {
        scheduleId: id,
        dateUtc: 1_700_006_400_000,
        startMinute: 540,
      }),
    ).rejects.toThrow(/together/i);
  });

  it("removes an override (owner-scoped)", async () => {
    const id = await call.create(ctx, {
      name: "S",
      timeZone: "UTC",
      isDefault: false,
    });
    const ovId = await call.addOverride(ctx, {
      scheduleId: id,
      dateUtc: 1_700_006_400_000,
    });
    await call.removeOverride(ctx, { id: ovId });
    const got = await call.get(ctx, { id });
    expect(got.dateOverrides).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// Ownership isolation
// ─────────────────────────────────────────────────────────────

describe("ownership isolation", () => {
  beforeEach(async () => {
    await enableBooking(ctx);
  });

  it("user B cannot get / update / setAvailability / addOverride on user A's schedule", async () => {
    const id = await call.create(ctx, {
      name: "mine",
      timeZone: "UTC",
      isDefault: false,
    });
    // Share the same DB (which already has booking_enabled ON from beforeEach)
    // so the ownership check — not the flag gate — is what blocks user B.
    const other = makeCtx(OTHER);
    other.db = ctx.db;

    await expect(call.get(other, { id })).rejects.toThrow(/not found/i);
    await expect(
      call.update(other, { id, name: "hijack" }),
    ).rejects.toThrow(/not found/i);
    await expect(
      call.setAvailability(other, {
        scheduleId: id,
        windows: [{ days: [1], startMinute: 540, endMinute: 600 }],
      }),
    ).rejects.toThrow(/not found/i);
    await expect(
      call.addOverride(other, { scheduleId: id, dateUtc: 1_700_006_400_000 }),
    ).rejects.toThrow(/not found/i);

    // user B's list is empty (different owner).
    expect(await call.list(other, {})).toHaveLength(0);
  });

  it("user B cannot removeDateOverride on user A's override", async () => {
    const id = await call.create(ctx, {
      name: "mine",
      timeZone: "UTC",
      isDefault: false,
    });
    const ovId = await call.addOverride(ctx, {
      scheduleId: id,
      dateUtc: 1_700_006_400_000,
    });
    const other = makeCtx(OTHER);
    other.db = ctx.db;
    await expect(
      call.removeOverride(other, { id: ovId }),
    ).rejects.toThrow(/not found/i);
  });
});

// ─────────────────────────────────────────────────────────────
// Flag gate (DEFAULT-OFF)
// ─────────────────────────────────────────────────────────────

describe("booking_enabled flag gate (DEFAULT-OFF)", () => {
  it("write mutations throw booking_disabled when the flag is OFF", async () => {
    // No flag row → OFF.
    let kind = "";
    try {
      await call.create(ctx, { name: "X", timeZone: "UTC", isDefault: false });
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("booking_disabled");
  });

  it("setAvailability throws booking_disabled when OFF even for an owned schedule", async () => {
    // Seed a schedule directly (bypassing the gated create).
    const id = await ctx.db.insert("schedules", {
      ownerAuthUserId: ME,
      name: "pre",
      timeZone: "UTC",
      isDefault: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await expect(
      call.setAvailability(ctx, {
        scheduleId: id,
        windows: [{ days: [1], startMinute: 540, endMinute: 600 }],
      }),
    ).rejects.toThrow(/booking is not available/i);
  });

  it("reads (get/list) are allowed even with the flag OFF", async () => {
    const id = await ctx.db.insert("schedules", {
      ownerAuthUserId: ME,
      name: "pre",
      timeZone: "UTC",
      isDefault: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const got = await call.get(ctx, { id });
    expect(got.name).toBe("pre");
    expect(await call.list(ctx, {})).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────
// Unauthenticated
// ─────────────────────────────────────────────────────────────

describe("unauthenticated", () => {
  it("create throws Not authenticated with no identity", async () => {
    const anon = makeCtx(null);
    await expect(
      call.create(anon, { name: "X", timeZone: "UTC", isDefault: false }),
    ).rejects.toThrow(/not authenticated/i);
  });
});
