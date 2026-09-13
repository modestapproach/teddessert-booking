// CV-6 — co-host assignment (event-type host roster) round-trip tests.
//
// Proves the headline "both founders free" collective setup persists:
//   - setEventTypeHostsCore reconciles eventTypeHosts rows (insert / patch /
//     delete) for the owner, owner-rechecked + flag-gated;
//   - collective ⇒ all hosts forced isFixed:true; round_robin honors the caller;
//   - the s2s wrapper (adminSetEventTypeHosts) reverse-resolves cal USER ints →
//     authUserId (calcomUserMap) + cal SCHEDULE ints → Convex `_id`, and the read
//     wrapper (adminListEventTypeHosts) enriches each row with calHostUserId.
//
// Harness mirrors calcomAdmin.test.ts / eventTypes.test.ts (in-memory FakeDb).
// The s2s layer takes NO Convex identity (the fork's anonymous ConvexHttpClient).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ConvexError } from "convex/values";

// For the *Core direct-call tests, mock the shared auth helper (same as
// eventTypes.test.ts). The s2s wrapper tests never hit requireAuthUserId.
vi.mock("../_helpers/auth", () => ({
  requireAuthUserId: async (ctx: any) => {
    if (!ctx.__identity) throw new ConvexError("Not authenticated. Please sign in.");
    return ctx.__identity as string;
  },
}));

import * as eventTypes from "./eventTypes";
import * as admin from "./calcomAdmin";

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

function makeCtx(identity: string | null = null) {
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

const ME = "auth_user_me";
const FOUNDER_A = "auth_user_founder_a";
const FOUNDER_B = "auth_user_founder_b";
const OTHER = "auth_user_other";

const setHostsCore = (ctx: any, owner: string, a: any) =>
  eventTypes.setEventTypeHostsCore(ctx, owner, a);
const listHostsCore = (ctx: any, owner: string, a: any) =>
  eventTypes.listEventTypeHostsCore(ctx, owner, a);

const call = {
  createEt: (ctx: any, a: any) => (admin.adminCreateEventType as any)._handler(ctx, a),
  setHosts: (ctx: any, a: any) => (admin.adminSetEventTypeHosts as any)._handler(ctx, a),
  listHosts: (ctx: any, a: any) => (admin.adminListEventTypeHosts as any)._handler(ctx, a),
};

function validEtArgs(owner: string, overrides: Record<string, any> = {}) {
  return {
    ownerAuthUserId: owner,
    slug: "panel-interview",
    title: "Panel Interview",
    durationMinutes: 45,
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

// Seed a calcomUserMap row so the s2s wrapper can reverse-resolve cal int→authUserId.
async function seedCalUser(ctx: any, authUserId: string, calId: number) {
  const now = Date.now();
  await ctx.db.insert("calcomUserMap", {
    authUserId,
    calId,
    email: `${authUserId}@dibslist.app`,
    name: authUserId,
    username: authUserId,
    createdAt: now,
    updatedAt: now,
  });
}

describe("CV-6 — setEventTypeHostsCore (post-auth core)", () => {
  let ctx: any;
  let etId: string;
  beforeEach(async () => {
    ctx = makeCtx(ME);
    await enableBooking(ctx);
    etId = await eventTypes.createEventTypeCore(ctx, ME, {
      slug: "panel",
      title: "Panel",
      durationMinutes: 45,
      schedulingType: "collective",
      minimumBookingNoticeMinutes: 120,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      requireEmailVerification: false,
      hidden: false,
      active: true,
    });
  });

  it("assigns two collective co-hosts, both forced isFixed:true (both founders free)", async () => {
    const res = await setHostsCore(ctx, ME, {
      eventTypeId: etId,
      // pass isFixed:false to prove collective FORCES it true regardless.
      hosts: [
        { hostAuthUserId: FOUNDER_A, isFixed: false },
        { hostAuthUserId: FOUNDER_B },
      ],
    });
    expect(res.assigned).toBe(2);
    const rows = await listHostsCore(ctx, ME, { eventTypeId: etId });
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.isFixed === true)).toBe(true);
    expect(rows.map((r: any) => r.hostAuthUserId).sort()).toEqual(
      [FOUNDER_A, FOUNDER_B].sort(),
    );
    expect(rows.every((r: any) => r.ownerAuthUserId === ME)).toBe(true);
  });

  it("reconciles: re-setting the roster inserts new, patches changed, deletes removed", async () => {
    await setHostsCore(ctx, ME, {
      eventTypeId: etId,
      hosts: [{ hostAuthUserId: FOUNDER_A }, { hostAuthUserId: FOUNDER_B }],
    });
    // Now drop B, keep A (with a priority change), add OTHER.
    await setHostsCore(ctx, ME, {
      eventTypeId: etId,
      hosts: [
        { hostAuthUserId: FOUNDER_A, priority: 3 },
        { hostAuthUserId: OTHER },
      ],
    });
    const rows = await listHostsCore(ctx, ME, { eventTypeId: etId });
    expect(rows.map((r: any) => r.hostAuthUserId).sort()).toEqual(
      [FOUNDER_A, OTHER].sort(),
    );
    const a = rows.find((r: any) => r.hostAuthUserId === FOUNDER_A) as any;
    expect(a.priority).toBe(3);
    expect(rows.find((r: any) => r.hostAuthUserId === FOUNDER_B)).toBeUndefined();
  });

  it("round_robin honors caller isFixed (default false → RR pool)", async () => {
    const rrId = await eventTypes.createEventTypeCore(ctx, ME, {
      slug: "rr",
      title: "RR",
      durationMinutes: 30,
      schedulingType: "round_robin",
      minimumBookingNoticeMinutes: 120,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      requireEmailVerification: false,
      hidden: false,
      active: true,
    });
    await setHostsCore(ctx, ME, {
      eventTypeId: rrId,
      hosts: [
        { hostAuthUserId: FOUNDER_A }, // default false
        { hostAuthUserId: FOUNDER_B, isFixed: true },
      ],
    });
    const rows = await listHostsCore(ctx, ME, { eventTypeId: rrId });
    const a = rows.find((r: any) => r.hostAuthUserId === FOUNDER_A) as any;
    const b = rows.find((r: any) => r.hostAuthUserId === FOUNDER_B) as any;
    expect(a.isFixed).toBe(false);
    expect(b.isFixed).toBe(true);
  });

  it("de-dupes a host listed twice (last write wins)", async () => {
    await setHostsCore(ctx, ME, {
      eventTypeId: etId,
      hosts: [
        { hostAuthUserId: FOUNDER_A, priority: 1 },
        { hostAuthUserId: FOUNDER_A, priority: 4 },
      ],
    });
    const rows = await listHostsCore(ctx, ME, { eventTypeId: etId });
    expect(rows).toHaveLength(1);
    expect(rows[0].priority).toBe(4);
  });

  it("empty roster clears all hosts", async () => {
    await setHostsCore(ctx, ME, {
      eventTypeId: etId,
      hosts: [{ hostAuthUserId: FOUNDER_A }],
    });
    await setHostsCore(ctx, ME, { eventTypeId: etId, hosts: [] });
    const rows = await listHostsCore(ctx, ME, { eventTypeId: etId });
    expect(rows).toHaveLength(0);
  });

  it("enforces ownership — a non-owner cannot set or read hosts", async () => {
    await expect(
      setHostsCore(ctx, OTHER, { eventTypeId: etId, hosts: [{ hostAuthUserId: FOUNDER_A }] }),
    ).rejects.toThrow();
    await expect(listHostsCore(ctx, OTHER, { eventTypeId: etId })).rejects.toThrow();
  });

  it("respects the booking_enabled flag gate (flag off → booking_disabled)", async () => {
    // Seed an event type while the flag is ON, then turn it OFF for the setHosts call.
    const offCtx = makeCtx(ME);
    let kind = "";
    try {
      // No enableBooking on offCtx → the very first gate in setEventTypeHostsCore throws.
      await setHostsCore(offCtx, ME, {
        eventTypeId: etId,
        hosts: [{ hostAuthUserId: FOUNDER_A }],
      });
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind ?? "";
    }
    expect(kind).toBe("booking_disabled");
  });

  it("rejects a per-host schedule the owner does not own", async () => {
    const foreignSched = await ctx.db.insert("schedules", {
      ownerAuthUserId: OTHER,
      name: "theirs",
      timeZone: "UTC",
      isDefault: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await expect(
      setHostsCore(ctx, ME, {
        eventTypeId: etId,
        hosts: [{ hostAuthUserId: FOUNDER_A, scheduleId: foreignSched }],
      }),
    ).rejects.toThrow();
  });
});

describe("CV-6 — adminSetEventTypeHosts (s2s, cal-int reverse-resolution)", () => {
  let ctx: any;
  beforeEach(async () => {
    ctx = makeCtx(); // NO Convex identity — the fork's anonymous client.
    await enableBooking(ctx);
  });

  it("reverse-resolves cal USER ints → authUserId and persists the roster", async () => {
    await seedCalUser(ctx, FOUNDER_A, 101);
    await seedCalUser(ctx, FOUNDER_B, 102);
    const { _id: id, calId } = await call.createEt(ctx, validEtArgs(ME));

    const res = await call.setHosts(ctx, {
      ownerAuthUserId: ME,
      calEventTypeId: calId,
      hosts: [{ calHostUserId: 101 }, { calHostUserId: 102 }],
    });
    expect(res.assigned).toBe(2);

    // Read back via the s2s read wrapper — each row carries calHostUserId.
    const rows = await call.listHosts(ctx, { ownerAuthUserId: ME, id });
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.calHostUserId).sort()).toEqual([101, 102]);
    expect(rows.every((r: any) => r.isFixed === true)).toBe(true); // collective
  });

  it("resolves a per-host cal SCHEDULE int and stores its Convex scheduleId", async () => {
    await seedCalUser(ctx, FOUNDER_A, 201);
    const { calId } = await call.createEt(ctx, validEtArgs(ME, { slug: "panel-2" }));
    // Create a schedule so it gets a cal int via the id-map.
    const { calId: schedCalId } = await (admin.adminCreateSchedule as any)._handler(ctx, {
      ownerAuthUserId: ME,
      name: "A hours",
      timeZone: "UTC",
      isDefault: true,
    });

    await call.setHosts(ctx, {
      ownerAuthUserId: ME,
      calEventTypeId: calId,
      hosts: [{ calHostUserId: 201, calScheduleId: schedCalId }],
    });
    const rows = await call.listHosts(ctx, { ownerAuthUserId: ME, calEventTypeId: calId });
    expect(rows).toHaveLength(1);
    expect(rows[0].calScheduleId).toBe(schedCalId);
    expect(rows[0].scheduleId).toBeTruthy();
  });

  it("skips an unknown cal user int (no calcomUserMap row) rather than throwing", async () => {
    await seedCalUser(ctx, FOUNDER_A, 301);
    const { calId } = await call.createEt(ctx, validEtArgs(ME, { slug: "panel-3" }));
    const res = await call.setHosts(ctx, {
      ownerAuthUserId: ME,
      calEventTypeId: calId,
      hosts: [{ calHostUserId: 301 }, { calHostUserId: 999 /* never minted */ }],
    });
    expect(res.assigned).toBe(1);
    const rows = await call.listHosts(ctx, { ownerAuthUserId: ME, calEventTypeId: calId });
    expect(rows).toHaveLength(1);
    expect(rows[0].calHostUserId).toBe(301);
  });
});
