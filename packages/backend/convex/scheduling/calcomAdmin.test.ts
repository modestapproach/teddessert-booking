// CV-2b — tests for the SERVER-TO-SERVER owner-admin surface (calcomAdmin.ts).
//
// These prove the s2s layer the forked cal.com app calls via getConvex():
//   - resolves the owner from the EXPLICIT `ownerAuthUserId` arg (NOT a Convex
//     identity) — i.e. it works with a ctx that carries NO `__identity`, which is
//     exactly the anonymous ConvexHttpClient the fork uses;
//   - delegates to the same post-auth cores, so the booking_enabled flag gate +
//     ownership checks still apply (a write with the flag off throws
//     booking_disabled; a read for someone else's row returns null/throws);
//   - round-trips create→list→get for event types and create→setAvailability→get
//     for schedules.
//
// Harness: the same FakeDb the sibling tests use. We do NOT mock requireAuthUserId
// here on purpose — the s2s fns never call it (they call the *Core fns directly),
// so an un-mocked auth would only matter if a core accidentally re-entered the
// auth path. Importing the real module confirms it does not.

import { describe, it, expect, beforeEach } from "vitest";
import { ConvexError } from "convex/values";
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

// Note: NO `__identity` — the s2s layer must not need a Convex identity.
function makeCtx() {
  return { db: new FakeDb() } as any;
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
  createEt: (ctx: any, a: any) => (admin.adminCreateEventType as any)._handler(ctx, a),
  updateEt: (ctx: any, a: any) => (admin.adminUpdateEventType as any)._handler(ctx, a),
  listEt: (ctx: any, a: any) => (admin.adminListEventTypes as any)._handler(ctx, a),
  getEt: (ctx: any, a: any) => (admin.adminGetEventType as any)._handler(ctx, a),
  getEtBySlug: (ctx: any, a: any) => (admin.adminGetEventTypeBySlug as any)._handler(ctx, a),
  createSched: (ctx: any, a: any) => (admin.adminCreateSchedule as any)._handler(ctx, a),
  listSched: (ctx: any, a: any) => (admin.adminListSchedules as any)._handler(ctx, a),
  getSched: (ctx: any, a: any) => (admin.adminGetSchedule as any)._handler(ctx, a),
  setAvail: (ctx: any, a: any) => (admin.adminSetAvailability as any)._handler(ctx, a),
  listConnected: (ctx: any, a: any) =>
    (admin.adminListConnectedCalendars as any)._handler(ctx, a),
};

const ME = "auth_user_me";
const OTHER = "auth_user_other";

function validEtArgs(owner: string, overrides: Record<string, any> = {}) {
  return {
    ownerAuthUserId: owner,
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
beforeEach(async () => {
  ctx = makeCtx();
  await enableBooking(ctx);
});

describe("calcomAdmin — event types (s2s, explicit owner, no Convex identity)", () => {
  it("create → list → get round-trips with an explicit ownerAuthUserId", async () => {
    // CV-2c: create now returns { _id, calId } so the fork can round-trip the int.
    const { _id: id, calId } = await call.createEt(ctx, validEtArgs(ME));
    expect(id).toBeTruthy();
    expect(typeof calId).toBe("number");

    const list = await call.listEt(ctx, { ownerAuthUserId: ME });
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("30 Minute Intro");
    expect(list[0].ownerAuthUserId).toBe(ME);
    // CV-2c: list rows now carry the stable cal int id.
    expect(list[0].calId).toBe(calId);

    const got = await call.getEt(ctx, { ownerAuthUserId: ME, id });
    expect(got.slug).toBe("30-min-intro");
    expect(got.calId).toBe(calId);

    const bySlug = await call.getEtBySlug(ctx, { ownerAuthUserId: ME, slug: "30-min-intro" });
    expect(bySlug?._id).toBe(id);
  });

  it("update patches fields for the owner", async () => {
    const { _id: id } = await call.createEt(ctx, validEtArgs(ME));
    await call.updateEt(ctx, { ownerAuthUserId: ME, id, title: "Renamed" });
    const got = await call.getEt(ctx, { ownerAuthUserId: ME, id });
    expect(got.title).toBe("Renamed");
  });

  it("enforces ownership — another owner cannot read the row", async () => {
    const { _id: id } = await call.createEt(ctx, validEtArgs(ME));
    // Wrong owner: getEventTypeCore throws "Not found."
    await expect(call.getEt(ctx, { ownerAuthUserId: OTHER, id })).rejects.toThrow();
    // By-slug returns null (not a throw) for a non-owner.
    const bySlug = await call.getEtBySlug(ctx, { ownerAuthUserId: OTHER, slug: "30-min-intro" });
    expect(bySlug).toBeNull();
    // The other owner's list is empty.
    const list = await call.listEt(ctx, { ownerAuthUserId: OTHER });
    expect(list).toHaveLength(0);
  });

  it("respects the booking_enabled flag gate on WRITES (flag off → booking_disabled)", async () => {
    const off = makeCtx(); // no enableBooking
    let kind = "";
    try {
      await call.createEt(off, validEtArgs(ME));
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("booking_disabled");
  });

  it("soft-delete via adminUpdateEventType(active:false) — cal delete maps to this", async () => {
    const { _id: id } = await call.createEt(ctx, validEtArgs(ME));
    await call.updateEt(ctx, { ownerAuthUserId: ME, id, active: false });
    const activeOnly = await call.listEt(ctx, { ownerAuthUserId: ME, activeOnly: true });
    expect(activeOnly).toHaveLength(0);
    const all = await call.listEt(ctx, { ownerAuthUserId: ME });
    expect(all).toHaveLength(1);
    expect(all[0].active).toBe(false);
  });

  // CV-2c — int↔string round-trip via the cal int id (the editor flow:
  // create → GET returns calId → editor saves by feeding the SAME calId back).
  it("round-trips by cal INT id: create → update(calEventTypeId) → get(calEventTypeId)", async () => {
    const { _id: id, calId } = await call.createEt(ctx, validEtArgs(ME));
    // The editor only holds the int — update by calEventTypeId (no Convex id).
    await call.updateEt(ctx, {
      ownerAuthUserId: ME,
      calEventTypeId: calId,
      title: "Round-tripped",
    });
    const byInt = await call.getEt(ctx, { ownerAuthUserId: ME, calEventTypeId: calId });
    expect(byInt.title).toBe("Round-tripped");
    expect(byInt._id).toBe(id); // same underlying Convex row
    expect(byInt.calId).toBe(calId);
  });

  it("soft-delete by cal INT id (adminDeleteEventType) round-trips", async () => {
    const deleteEt = (c: any, a: any) =>
      (admin.adminDeleteEventType as any)._handler(c, a);
    const { calId } = await call.createEt(ctx, validEtArgs(ME));
    await deleteEt(ctx, { ownerAuthUserId: ME, calEventTypeId: calId });
    const activeOnly = await call.listEt(ctx, { ownerAuthUserId: ME, activeOnly: true });
    expect(activeOnly).toHaveLength(0);
  });
});

describe("calcomAdmin — schedules (s2s, explicit owner)", () => {
  it("create → setAvailability → get embeds the weekly windows", async () => {
    // CV-2c: createSched now returns { _id, calId }.
    const { _id: sid, calId } = await call.createSched(ctx, {
      ownerAuthUserId: ME,
      name: "Working hours",
      timeZone: "UTC",
      isDefault: true,
    });
    expect(typeof calId).toBe("number");
    await call.setAvail(ctx, {
      ownerAuthUserId: ME,
      scheduleId: sid,
      windows: [{ days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1020 }],
    });
    const sched = await call.getSched(ctx, { ownerAuthUserId: ME, id: sid });
    expect(sched.name).toBe("Working hours");
    expect((sched.availability as any[])).toHaveLength(1);
    expect((sched.availability as any[])[0].startMinute).toBe(540);
    expect(sched.calId).toBe(calId);

    const list = await call.listSched(ctx, { ownerAuthUserId: ME });
    expect(list).toHaveLength(1);
    expect(list[0].isDefault).toBe(true);
    expect(list[0].calId).toBe(calId);
  });

  it("round-trips by cal INT id: setAvailability(calScheduleId) → get(calScheduleId)", async () => {
    const { calId } = await call.createSched(ctx, {
      ownerAuthUserId: ME,
      name: "Working hours",
      timeZone: "UTC",
      isDefault: true,
    });
    await call.setAvail(ctx, {
      ownerAuthUserId: ME,
      calScheduleId: calId,
      windows: [{ days: [1], startMinute: 600, endMinute: 660 }],
    });
    const sched = await call.getSched(ctx, { ownerAuthUserId: ME, calScheduleId: calId });
    expect((sched.availability as any[])).toHaveLength(1);
    expect((sched.availability as any[])[0].startMinute).toBe(600);
    expect(sched.calId).toBe(calId);
  });

  it("enforces ownership — another owner cannot read the schedule", async () => {
    const { _id: sid } = await call.createSched(ctx, {
      ownerAuthUserId: ME,
      name: "Working hours",
      timeZone: "UTC",
      isDefault: true,
    });
    await expect(call.getSched(ctx, { ownerAuthUserId: OTHER, id: sid })).rejects.toThrow();
  });
});

describe("calcomAdmin — connected calendars (s2s, explicit owner) — CV-2c", () => {
  it("lists the owner's calendar credentials + selected sub-calendars, owner-scoped", async () => {
    const c = makeCtx();
    // Seed one credential + a selected calendar for ME and one for OTHER.
    const credMe = await c.db.insert("calendarCredentials", {
      authUserId: ME,
      provider: "google",
      label: "me@dibslist.app",
      invalid: false,
    });
    await c.db.insert("selectedCalendars", {
      authUserId: ME,
      credentialId: credMe,
      externalCalendarId: "me@dibslist.app",
      displayName: "Me",
      checkForConflicts: true,
      isDestination: true,
    });
    const credOther = await c.db.insert("calendarCredentials", {
      authUserId: OTHER,
      provider: "google",
      label: "other@dibslist.app",
      invalid: false,
    });
    await c.db.insert("selectedCalendars", {
      authUserId: OTHER,
      credentialId: credOther,
      externalCalendarId: "other@dibslist.app",
      checkForConflicts: false,
      isDestination: false,
    });

    const mine = await call.listConnected(c, { ownerAuthUserId: ME });
    expect(mine).toHaveLength(1);
    expect(mine[0].label).toBe("me@dibslist.app");
    expect(mine[0].calendars).toHaveLength(1);
    expect(mine[0].calendars[0].isDestination).toBe(true);
    expect(mine[0].calendars[0].checkForConflicts).toBe(true);

    // OTHER's credentials never leak into ME's list.
    const theirs = await call.listConnected(c, { ownerAuthUserId: OTHER });
    expect(theirs).toHaveLength(1);
    expect(theirs[0].label).toBe("other@dibslist.app");
  });
});
