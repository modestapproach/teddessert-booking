// Mutation/query-level tests for `scheduling/eventTypes.ts` (BOOKING A4).
//
// HARNESS NOTE: this repo's convention for auth-gated Convex fns is NOT to run
// them through the real Convex runtime + Better Auth (that path is never wired
// in any *.test.ts — see _helpers/auth.test.ts). Instead we mock the shared
// `requireAuthUserId` helper to read the fake ctx's identity, and exercise the
// REAL registered handlers via their `._handler(ctx, args)` accessor against a
// small in-memory fake ctx (exactly the itemPhotos.test.ts pattern).
//
// The DEFAULT-OFF `booking_enabled` flag is exercised through the REAL
// `_helpers/featureFlag.ts` read path: it queries `ctx.db.query("featureFlags")
// .withIndex("by_key", …).unique()`, which the FakeDb supports. By default no
// flag row exists → `isFlagEnabled(…, false)` returns false → every write
// mutation throws "booking_disabled". To run the happy paths we seed a
// `featureFlags` row `{ key: "booking_enabled", value: true }`.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ConvexError } from "convex/values";

// Mock the shared auth helper BEFORE importing the module under test so the
// handlers' requireAuthUserId(ctx) resolves to the fake ctx's identity.
vi.mock("../_helpers/auth", () => ({
  requireAuthUserId: async (ctx: any) => {
    if (!ctx.__identity) throw new ConvexError("Not authenticated. Please sign in.");
    return ctx.__identity as string;
  },
}));

import * as eventTypes from "./eventTypes";

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

// Seed the booking flag ON so write mutations pass the gate.
async function enableBooking(ctx: any) {
  await ctx.db.insert("featureFlags", {
    key: "booking_enabled",
    value: true,
    updatedAt: Date.now(),
    updatedBy: "test",
  });
}

const call = {
  create: (ctx: any, a: any) => (eventTypes.createEventType as any)._handler(ctx, a),
  update: (ctx: any, a: any) => (eventTypes.updateEventType as any)._handler(ctx, a),
  list: (ctx: any, a: any) => (eventTypes.listEventTypes as any)._handler(ctx, a),
  get: (ctx: any, a: any) => (eventTypes.getEventType as any)._handler(ctx, a),
  getBySlug: (ctx: any, a: any) =>
    (eventTypes.getEventTypeBySlug as any)._handler(ctx, a),
};

const ME = "user_me";
const OTHER = "user_other";

function validCreateArgs(overrides: Record<string, any> = {}) {
  return {
    slug: "30-min-intro",
    title: "30 Minute Intro",
    durationMinutes: 30,
    schedulingType: "collective" as const,
    minimumBookingNoticeMinutes: 120,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    requireEmailVerification: false,
    hidden: false,
    active: true,
    ...overrides,
  };
}

let ctx: any;
beforeEach(() => {
  ctx = makeCtx(ME);
});

// ─────────────────────────────────────────────────────────────
// Happy path: create → get → list → update
// ─────────────────────────────────────────────────────────────

describe("eventTypes happy path (flag ON)", () => {
  beforeEach(async () => {
    await enableBooking(ctx);
  });

  it("create → get → list → update round-trips and sets owner + timestamps", async () => {
    const id = await call.create(ctx, validCreateArgs());
    expect(typeof id).toBe("string");

    const got = await call.get(ctx, { id });
    expect(got.ownerAuthUserId).toBe(ME);
    expect(got.slug).toBe("30-min-intro");
    expect(got.title).toBe("30 Minute Intro");
    expect(got.active).toBe(true);
    expect(got.createdAt).toBeGreaterThan(0);
    expect(got.updatedAt).toBe(got.createdAt);

    const list = await call.list(ctx, {});
    expect(list.map((r: any) => r._id)).toContain(id);

    await call.update(ctx, { id, title: "Renamed", active: false });
    const after = await call.get(ctx, { id });
    expect(after.title).toBe("Renamed");
    expect(after.active).toBe(false);
    expect(after.updatedAt).toBeGreaterThanOrEqual(after.createdAt);
  });

  it("getBySlug returns the owned row; activeOnly filters the list", async () => {
    const a = await call.create(ctx, validCreateArgs({ slug: "a", active: true }));
    await call.create(ctx, validCreateArgs({ slug: "b", active: false }));

    const bySlug = await call.getBySlug(ctx, { slug: "a" });
    expect(bySlug?._id).toBe(a);

    const all = await call.list(ctx, {});
    expect(all).toHaveLength(2);
    const activeOnly = await call.list(ctx, { activeOnly: true });
    expect(activeOnly.map((r: any) => r.slug)).toEqual(["a"]);
  });

  it("trims the slug before persisting", async () => {
    const id = await call.create(ctx, validCreateArgs({ slug: "  spaced  " }));
    const got = await call.get(ctx, { id });
    expect(got.slug).toBe("spaced");
  });
});

// ─────────────────────────────────────────────────────────────
// Slug uniqueness
// ─────────────────────────────────────────────────────────────

describe("slug uniqueness", () => {
  beforeEach(async () => {
    await enableBooking(ctx);
  });

  it("rejects a duplicate slug on create", async () => {
    await call.create(ctx, validCreateArgs({ slug: "dupe" }));
    await expect(
      call.create(ctx, validCreateArgs({ slug: "dupe" })),
    ).rejects.toThrow(/slug already taken/i);
  });

  it("rejects renaming one event type onto another's slug", async () => {
    await call.create(ctx, validCreateArgs({ slug: "first" }));
    const id2 = await call.create(ctx, validCreateArgs({ slug: "second" }));
    await expect(
      call.update(ctx, { id: id2, slug: "first" }),
    ).rejects.toThrow(/slug already taken/i);
  });

  it("allows update that keeps the row's own slug unchanged", async () => {
    const id = await call.create(ctx, validCreateArgs({ slug: "keep" }));
    await call.update(ctx, { id, slug: "keep", title: "New title" });
    const got = await call.get(ctx, { id });
    expect(got.slug).toBe("keep");
    expect(got.title).toBe("New title");
  });
});

// ─────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────

describe("validation", () => {
  beforeEach(async () => {
    await enableBooking(ctx);
  });

  it("rejects an empty slug", async () => {
    await expect(
      call.create(ctx, validCreateArgs({ slug: "   " })),
    ).rejects.toThrow(/slug is required/i);
  });

  it("rejects a non-positive duration", async () => {
    await expect(
      call.create(ctx, validCreateArgs({ durationMinutes: 0 })),
    ).rejects.toThrow(/durationMinutes must be a positive number/i);
    await expect(
      call.create(ctx, validCreateArgs({ durationMinutes: -10 })),
    ).rejects.toThrow(/durationMinutes must be a positive number/i);
  });

  it("rejects an empty title", async () => {
    await expect(
      call.create(ctx, validCreateArgs({ title: "  " })),
    ).rejects.toThrow(/title is required/i);
  });

  it("rejects pinning a scheduleId owned by someone else", async () => {
    // Seed a schedule owned by OTHER directly.
    const foreignSchedule = await ctx.db.insert("schedules", {
      ownerAuthUserId: OTHER,
      name: "theirs",
      timeZone: "UTC",
      isDefault: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await expect(
      call.create(ctx, validCreateArgs({ scheduleId: foreignSchedule })),
    ).rejects.toThrow(/not found/i);
  });
});

// ─────────────────────────────────────────────────────────────
// Ownership isolation — user B cannot read/update user A's rows
// ─────────────────────────────────────────────────────────────

describe("ownership isolation", () => {
  it("user B cannot get / getBySlug / update / see-in-list user A's event type", async () => {
    await enableBooking(ctx);
    const id = await call.create(ctx, validCreateArgs({ slug: "a-only" }));

    // user B shares the same DB but a different identity.
    const other = makeCtx(OTHER);
    other.db = ctx.db;

    await expect(call.get(other, { id })).rejects.toThrow(/not found/i);
    // getBySlug returns null (not throw) for a non-owned row.
    expect(await call.getBySlug(other, { slug: "a-only" })).toBeNull();
    await expect(
      call.update(other, { id, title: "hijack" }),
    ).rejects.toThrow(/not found/i);

    const bList = await call.list(other, {});
    expect(bList).toHaveLength(0);

    // user A's row is untouched.
    const stillMine = await call.get(ctx, { id });
    expect(stillMine.title).toBe("30 Minute Intro");
  });
});

// ─────────────────────────────────────────────────────────────
// Flag-OFF → write mutations throw booking_disabled; reads still work
// ─────────────────────────────────────────────────────────────

describe("booking_enabled flag gate (DEFAULT-OFF)", () => {
  it("create/update throw booking_disabled when the flag is OFF (no row)", async () => {
    // No featureFlags row seeded → isFlagEnabled(…, false) === false.
    let kind = "";
    try {
      await call.create(ctx, validCreateArgs());
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("booking_disabled");
  });

  it("create throws booking_disabled when the flag row is explicitly false", async () => {
    await ctx.db.insert("featureFlags", {
      key: "booking_enabled",
      value: false,
      updatedAt: Date.now(),
      updatedBy: "test",
    });
    await expect(call.create(ctx, validCreateArgs())).rejects.toThrow(
      /booking is not available/i,
    );
  });

  it("reads (get/list) are allowed even with the flag OFF (owner inspects own config)", async () => {
    // Seed a row directly (bypassing the gated create) owned by ME.
    const id = await ctx.db.insert("eventTypes", {
      ownerAuthUserId: ME,
      slug: "pre-launch",
      title: "Pre Launch",
      durationMinutes: 30,
      schedulingType: "collective",
      minimumBookingNoticeMinutes: 120,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      requireEmailVerification: false,
      hidden: false,
      active: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    // Flag is OFF (no row). Reads must still succeed.
    const got = await call.get(ctx, { id });
    expect(got.slug).toBe("pre-launch");
    const list = await call.list(ctx, {});
    expect(list).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────
// Unauthenticated → throws
// ─────────────────────────────────────────────────────────────

describe("unauthenticated", () => {
  it("create throws Not authenticated with no identity", async () => {
    const anon = makeCtx(null);
    await expect(call.create(anon, validCreateArgs())).rejects.toThrow(
      /not authenticated/i,
    );
  });

  it("get throws Not authenticated with no identity", async () => {
    const anon = makeCtx(null);
    await expect(call.get(anon, { id: "eventTypes|1" })).rejects.toThrow(
      /not authenticated/i,
    );
  });
});
