// CV-8 — residual data-layer cleanup tests (the final reachable throwing WRITE
// paths the fork left on Prisma, now rewired to Convex):
//
//   1. eventTypesHeavy.duplicate  → duplicateEventTypeCore / adminDuplicateEventType
//        clone copies the in-scope template fields + the co-host roster, slug
//        uniquified; ownership rejection; collision auto-suffix.
//   2. availability.schedule.duplicate → duplicateScheduleCore / adminDuplicateSchedule
//        clone copies availability + dateOverrides under "<name> (Copy)", forced
//        non-default; ownership rejection.
//   3. availability.bulkUpdateToDefaultAvailability → bulkUpdateToDefaultAvailabilityCore
//        / adminBulkUpdateToDefaultAvailability — repoints owned event types onto
//        the (selected or current) default; "Default schedule not set" guard;
//        skips not-owned; cal-int resolution via the id-map.
//   4. me.updateProfile booking-prefs subset → updateCalcomUserPrefsImpl /
//        adminUpdateCalcomUserPrefs — patches timeZone/weekStart/timeFormat/locale/
//        defaultScheduleId on the calcomUserMap row; tz propagation to the default
//        schedule; no-op when no map row; defends a forged defaultScheduleId.
//
// HARNESS: repo in-memory FakeDb + bare-Impl/_handler convention (mirrors
// cv6EventTypeHosts.test.ts / cv7CoHostResolve.test.ts). The s2s wrappers take NO
// Convex identity (the fork's anonymous ConvexHttpClient); the *Core direct calls
// mock requireAuthUserId.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ConvexError } from "convex/values";

vi.mock("../_helpers/auth", () => ({
  requireAuthUserId: async (ctx: any) => {
    if (!ctx.__identity) throw new ConvexError("Not authenticated. Please sign in.");
    return ctx.__identity as string;
  },
}));

import * as eventTypes from "./eventTypes";
import * as schedules from "./schedules";
import * as calcomUsers from "./calcomUsers";
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
const OTHER = "auth_user_other";
const FOUNDER_B = "auth_user_founder_b";

// Typed-id-tolerant core wrappers (the cores take Id<"…"> but the FakeDb mints
// string `_id`s; mirror cv6's `a: any` helper convention so tsc stays clean).
const dupEtCore = (ctx: any, owner: string, a: any) =>
  eventTypes.duplicateEventTypeCore(ctx, owner, a);
const setHostsCore = (ctx: any, owner: string, a: any) =>
  eventTypes.setEventTypeHostsCore(ctx, owner, a);
const listHostsCore = (ctx: any, owner: string, a: any) =>
  eventTypes.listEventTypeHostsCore(ctx, owner, a);
const dupSchedCore = (ctx: any, owner: string, a: any) =>
  schedules.duplicateScheduleCore(ctx, owner, a);
const getSchedCore = (ctx: any, owner: string, a: any) =>
  schedules.getScheduleCore(ctx, owner, a);
const bulkCore = (ctx: any, owner: string, a: any) =>
  schedules.bulkUpdateToDefaultAvailabilityCore(ctx, owner, a);
const prefsImpl = (ctx: any, a: any) => calcomUsers.updateCalcomUserPrefsImpl(ctx, a);

// Seed a calcomUserMap row so prefs + host reverse-resolution work.
async function seedCalUser(ctx: any, authUserId: string, calId: number, email: string) {
  const now = Date.now();
  return await ctx.db.insert("calcomUserMap", {
    authUserId,
    calId,
    email,
    name: authUserId,
    username: authUserId,
    createdAt: now,
    updatedAt: now,
  });
}

// ─────────────────────────────────────────────────────────────
// 1. eventTypesHeavy.duplicate → duplicateEventType
// ─────────────────────────────────────────────────────────────

describe("CV-8 — duplicateEventType (clone an event type)", () => {
  let ctx: any;
  let sourceId: string;
  beforeEach(async () => {
    ctx = makeCtx(ME);
    await enableBooking(ctx);
    const now = Date.now();
    sourceId = await ctx.db.insert("eventTypes", {
      ownerAuthUserId: ME,
      slug: "intro-call",
      title: "Intro Call",
      description: "A quick chat",
      durationMinutes: 30,
      schedulingType: "collective",
      slotIntervalMinutes: 15,
      minimumBookingNoticeMinutes: 120,
      bufferBeforeMinutes: 5,
      bufferAfterMinutes: 10,
      requireEmailVerification: false,
      hidden: false,
      locationText: "Zoom",
      active: true,
      createdAt: now,
      updatedAt: now,
    });
  });

  it("clones the in-scope template fields under a new slug/title", async () => {
    const res = await dupEtCore(ctx, ME, {
      id: sourceId,
      slug: "intro-call-copy",
      title: "Intro Call (copy)",
    });
    const clone = await ctx.db.get(res.id);
    expect(clone).not.toBeNull();
    expect(clone.slug).toBe("intro-call-copy");
    expect(clone.title).toBe("Intro Call (copy)");
    // Copied template fields.
    expect(clone.description).toBe("A quick chat");
    expect(clone.durationMinutes).toBe(30);
    expect(clone.schedulingType).toBe("collective");
    expect(clone.slotIntervalMinutes).toBe(15);
    expect(clone.minimumBookingNoticeMinutes).toBe(120);
    expect(clone.bufferBeforeMinutes).toBe(5);
    expect(clone.bufferAfterMinutes).toBe(10);
    expect(clone.locationText).toBe("Zoom");
    expect(clone.active).toBe(true);
    // The source is untouched.
    const src = await ctx.db.get(sourceId);
    expect(src.slug).toBe("intro-call");
  });

  it("honors a dialog-supplied duration override", async () => {
    const res = await dupEtCore(ctx, ME, {
      id: sourceId,
      slug: "intro-call-copy",
      title: "Intro Call (copy)",
      durationMinutes: 60,
    });
    const clone = await ctx.db.get(res.id);
    expect(clone.durationMinutes).toBe(60);
  });

  it("clones the co-host roster (the headline)", async () => {
    await seedCalUser(ctx, ME, 100, "me@dibslist.app");
    await seedCalUser(ctx, FOUNDER_B, 102, "b@dibslist.app");
    // Two collective co-hosts on the source.
    await setHostsCore(ctx, ME, {
      eventTypeId: sourceId,
      hosts: [{ hostAuthUserId: ME }, { hostAuthUserId: FOUNDER_B }],
    });

    const res = await dupEtCore(ctx, ME, {
      id: sourceId,
      slug: "intro-call-copy",
      title: "Intro Call (copy)",
    });
    const cloneHosts = await listHostsCore(ctx, ME, {
      eventTypeId: res.id,
    });
    expect(cloneHosts).toHaveLength(2);
    expect(cloneHosts.every((h: any) => h.isFixed === true)).toBe(true); // collective
    expect(cloneHosts.map((h: any) => h.hostAuthUserId).sort()).toEqual(
      [ME, FOUNDER_B].sort(),
    );
    // The source roster is still intact (reconcile didn't move rows).
    const srcHosts = await listHostsCore(ctx, ME, {
      eventTypeId: sourceId,
    });
    expect(srcHosts).toHaveLength(2);
  });

  it("auto-suffixes the slug when the chosen one already collides", async () => {
    // Pre-seed a row that already holds the desired slug.
    const now = Date.now();
    await ctx.db.insert("eventTypes", {
      ownerAuthUserId: ME,
      slug: "intro-call-copy",
      title: "Existing",
      durationMinutes: 30,
      schedulingType: "collective",
      minimumBookingNoticeMinutes: 120,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      requireEmailVerification: false,
      hidden: false,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    const res = await dupEtCore(ctx, ME, {
      id: sourceId,
      slug: "intro-call-copy",
      title: "Intro Call (copy)",
    });
    expect(res.slug).toBe("intro-call-copy-1");
    const clone = await ctx.db.get(res.id);
    expect(clone.slug).toBe("intro-call-copy-1");
  });

  it("rejects duplicating an event type the caller does not own", async () => {
    await expect(
      dupEtCore(ctx, OTHER, {
        id: sourceId,
        slug: "stolen",
        title: "Stolen",
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("refuses the write while booking_enabled is OFF (flag gate)", async () => {
    const dark = makeCtx(ME); // no enableBooking
    const now = Date.now();
    const id = await dark.db.insert("eventTypes", {
      ownerAuthUserId: ME,
      slug: "x",
      title: "X",
      durationMinutes: 30,
      schedulingType: "collective",
      minimumBookingNoticeMinutes: 120,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      requireEmailVerification: false,
      hidden: false,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    await expect(
      dupEtCore(dark, ME, { id, slug: "x-copy", title: "X copy" }),
    ).rejects.toThrow();
  });

  it("s2s adminDuplicateEventType round-trips the cal int + returns the new clone's cal int", async () => {
    // Mint a cal int for the source.
    const { calId: srcCalId } = await (admin.adminGetEventType as any)._handler(ctx, {
      ownerAuthUserId: ME,
      id: sourceId,
    });
    expect(typeof srcCalId).toBe("number");
    const res = await (admin.adminDuplicateEventType as any)._handler(ctx, {
      ownerAuthUserId: ME,
      calEventTypeId: srcCalId,
      slug: "intro-call-copy",
      title: "Intro Call (copy)",
    });
    expect(typeof res.calId).toBe("number");
    expect(res.calId).not.toBe(srcCalId);
    expect(res.slug).toBe("intro-call-copy");
    const clone = await ctx.db.get(res._id);
    expect(clone.title).toBe("Intro Call (copy)");
  });
});

// ─────────────────────────────────────────────────────────────
// 2. availability.schedule.duplicate → duplicateSchedule
// ─────────────────────────────────────────────────────────────

describe("CV-8 — duplicateSchedule (clone a schedule)", () => {
  let ctx: any;
  let sourceId: string;
  beforeEach(async () => {
    ctx = makeCtx(ME);
    await enableBooking(ctx);
    const now = Date.now();
    sourceId = await ctx.db.insert("schedules", {
      ownerAuthUserId: ME,
      name: "Working Hours",
      timeZone: "America/New_York",
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    // Two weekly windows.
    await ctx.db.insert("availability", {
      scheduleId: sourceId,
      ownerAuthUserId: ME,
      days: [1, 2, 3, 4, 5],
      startMinute: 540,
      endMinute: 1020,
      createdAt: now,
    });
    await ctx.db.insert("availability", {
      scheduleId: sourceId,
      ownerAuthUserId: ME,
      days: [6],
      startMinute: 600,
      endMinute: 720,
      createdAt: now,
    });
    // One date override.
    await ctx.db.insert("dateOverrides", {
      scheduleId: sourceId,
      ownerAuthUserId: ME,
      dateUtc: Date.UTC(2026, 11, 25),
      startMinute: undefined,
      endMinute: undefined,
      createdAt: now,
    });
  });

  it("clones the schedule + availability + overrides under a (Copy) name, NON-default", async () => {
    const res = await dupSchedCore(ctx, ME, { id: sourceId });
    expect(res.name).toBe("Working Hours (Copy)");
    const clone = await getSchedCore(ctx, ME, { id: res.id });
    expect(clone.name).toBe("Working Hours (Copy)");
    expect(clone.timeZone).toBe("America/New_York");
    // NEVER steals the default.
    expect(clone.isDefault).toBe(false);
    // Children cloned.
    expect((clone.availability as any[]).length).toBe(2);
    expect((clone.dateOverrides as any[]).length).toBe(1);
    // Children denormalize the CLONE's owner.
    expect((clone.availability as any[]).every((a) => a.ownerAuthUserId === ME)).toBe(true);
    // The source default flag is untouched.
    const src = await ctx.db.get(sourceId);
    expect(src.isDefault).toBe(true);
  });

  it("rejects duplicating a schedule the caller does not own", async () => {
    await expect(
      dupSchedCore(ctx, OTHER, { id: sourceId }),
    ).rejects.toThrow(/not found/i);
  });

  it("s2s adminDuplicateSchedule round-trips the cal int + returns the clone's cal int", async () => {
    const { calId: srcCalId } = await (admin.adminGetSchedule as any)._handler(ctx, {
      ownerAuthUserId: ME,
      id: sourceId,
    });
    const res = await (admin.adminDuplicateSchedule as any)._handler(ctx, {
      ownerAuthUserId: ME,
      calScheduleId: srcCalId,
    });
    expect(typeof res.calId).toBe("number");
    expect(res.calId).not.toBe(srcCalId);
    expect(res.name).toBe("Working Hours (Copy)");
  });
});

// ─────────────────────────────────────────────────────────────
// 3. availability.bulkUpdateToDefaultAvailability
// ─────────────────────────────────────────────────────────────

describe("CV-8 — bulkUpdateToDefaultAvailability (repoint event types onto default)", () => {
  let ctx: any;
  let defaultSchedId: string;
  let otherSchedId: string;
  let et1: string;
  let et2: string;
  beforeEach(async () => {
    ctx = makeCtx(ME);
    await enableBooking(ctx);
    const now = Date.now();
    otherSchedId = await ctx.db.insert("schedules", {
      ownerAuthUserId: ME,
      name: "Other",
      timeZone: "UTC",
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });
    defaultSchedId = await ctx.db.insert("schedules", {
      ownerAuthUserId: ME,
      name: "Default",
      timeZone: "UTC",
      isDefault: true,
      createdAt: now + 1,
      updatedAt: now + 1,
    });
    const mkEt = async (slug: string, scheduleId: string) =>
      ctx.db.insert("eventTypes", {
        ownerAuthUserId: ME,
        slug,
        title: slug,
        durationMinutes: 30,
        schedulingType: "collective",
        scheduleId,
        minimumBookingNoticeMinutes: 120,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        requireEmailVerification: false,
        hidden: false,
        active: true,
        createdAt: now,
        updatedAt: now,
      });
    et1 = await mkEt("et1", otherSchedId);
    et2 = await mkEt("et2", otherSchedId);
  });

  it("repoints owned event types onto the current default schedule", async () => {
    const res = await bulkCore(ctx, ME, {
      eventTypeIds: [et1, et2],
    });
    expect(res.count).toBe(2);
    expect((await ctx.db.get(et1)).scheduleId).toBe(defaultSchedId);
    expect((await ctx.db.get(et2)).scheduleId).toBe(defaultSchedId);
  });

  it("repoints onto an explicitly selected schedule (must be owned)", async () => {
    const res = await bulkCore(ctx, ME, {
      eventTypeIds: [et1],
      selectedDefaultScheduleId: otherSchedId,
    });
    expect(res.count).toBe(1);
    expect((await ctx.db.get(et1)).scheduleId).toBe(otherSchedId);
  });

  it("throws 'Default schedule not set' when no default + no selection", async () => {
    // Clear the default flag.
    await ctx.db.patch(defaultSchedId, { isDefault: false });
    await expect(
      bulkCore(ctx, ME, { eventTypeIds: [et1] }),
    ).rejects.toThrow(/default schedule not set/i);
  });

  it("skips event types the caller does not own (count reflects only owned)", async () => {
    const now = Date.now();
    const foreignEt = await ctx.db.insert("eventTypes", {
      ownerAuthUserId: OTHER,
      slug: "foreign",
      title: "Foreign",
      durationMinutes: 30,
      schedulingType: "collective",
      scheduleId: otherSchedId,
      minimumBookingNoticeMinutes: 120,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      requireEmailVerification: false,
      hidden: false,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    const res = await bulkCore(ctx, ME, {
      eventTypeIds: [et1, foreignEt],
    });
    expect(res.count).toBe(1); // only et1
    // Foreign row untouched.
    expect((await ctx.db.get(foreignEt)).scheduleId).toBe(otherSchedId);
  });

  it("rejects a selected schedule the caller does not own", async () => {
    const now = Date.now();
    const foreignSched = await ctx.db.insert("schedules", {
      ownerAuthUserId: OTHER,
      name: "Foreign",
      timeZone: "UTC",
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });
    await expect(
      bulkCore(ctx, ME, {
        eventTypeIds: [et1],
        selectedDefaultScheduleId: foreignSched,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("s2s adminBulkUpdateToDefaultAvailability resolves cal ints + repoints", async () => {
    // Mint cal ints for the two event types + the default schedule.
    const { calId: et1Cal } = await (admin.adminGetEventType as any)._handler(ctx, {
      ownerAuthUserId: ME,
      id: et1,
    });
    const { calId: et2Cal } = await (admin.adminGetEventType as any)._handler(ctx, {
      ownerAuthUserId: ME,
      id: et2,
    });
    const { calId: defCal } = await (admin.adminGetSchedule as any)._handler(ctx, {
      ownerAuthUserId: ME,
      id: defaultSchedId,
    });
    const res = await (admin.adminBulkUpdateToDefaultAvailability as any)._handler(ctx, {
      ownerAuthUserId: ME,
      calEventTypeIds: [et1Cal, et2Cal],
      calSelectedDefaultScheduleId: defCal,
    });
    expect(res.count).toBe(2);
    expect((await ctx.db.get(et1)).scheduleId).toBe(defaultSchedId);
  });
});

// ─────────────────────────────────────────────────────────────
// 4. me.updateProfile booking-prefs subset → updateCalcomUserPrefs
// ─────────────────────────────────────────────────────────────

describe("CV-8 — updateCalcomUserPrefs (the me.updateProfile booking-prefs subset)", () => {
  let ctx: any;
  beforeEach(async () => {
    ctx = makeCtx(ME);
    await enableBooking(ctx);
    await seedCalUser(ctx, ME, 100, "me@dibslist.app");
  });

  it("patches timeZone / weekStart / timeFormat / locale onto the map row", async () => {
    const res = await prefsImpl(ctx, {
      authUserId: ME,
      timeZone: "Europe/London",
      weekStart: "Monday",
      timeFormat: 24,
      locale: "en-GB",
    });
    expect(res.updated).toBe(true);
    const row = await calcomUsers.getCalcomUserByAuthUserIdImpl(ctx, ME);
    expect(row.timeZone).toBe("Europe/London");
    expect(row.weekStart).toBe("Monday");
    expect(row.timeFormat).toBe(24);
    expect(row.locale).toBe("en-GB");
    // IDENTITY fields untouched.
    expect(row.email).toBe("me@dibslist.app");
    expect(row.name).toBe(ME);
  });

  it("only writes provided fields (undefined = leave as-is)", async () => {
    await prefsImpl(ctx, { authUserId: ME, timeFormat: 12 });
    let row = await calcomUsers.getCalcomUserByAuthUserIdImpl(ctx, ME);
    expect(row.timeFormat).toBe(12);
    expect(row.timeZone).toBeUndefined(); // never set
    // A second partial save sets only timeZone; timeFormat is preserved.
    await prefsImpl(ctx, { authUserId: ME, timeZone: "UTC" });
    row = await calcomUsers.getCalcomUserByAuthUserIdImpl(ctx, ME);
    expect(row.timeFormat).toBe(12);
    expect(row.timeZone).toBe("UTC");
  });

  it("propagates a tz change onto the owner's default schedule when requested", async () => {
    const now = Date.now();
    const schedId = await ctx.db.insert("schedules", {
      ownerAuthUserId: ME,
      name: "Default",
      timeZone: "America/New_York",
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    await prefsImpl(ctx, {
      authUserId: ME,
      timeZone: "Asia/Tokyo",
      propagateTimeZoneToDefaultSchedule: true,
    });
    expect((await ctx.db.get(schedId)).timeZone).toBe("Asia/Tokyo");
  });

  it("sets defaultScheduleId only when the schedule belongs to the owner", async () => {
    const now = Date.now();
    const mine = await ctx.db.insert("schedules", {
      ownerAuthUserId: ME,
      name: "Mine",
      timeZone: "UTC",
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });
    const foreign = await ctx.db.insert("schedules", {
      ownerAuthUserId: OTHER,
      name: "Foreign",
      timeZone: "UTC",
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });
    await prefsImpl(ctx, {
      authUserId: ME,
      defaultScheduleId: mine,
    });
    expect((await calcomUsers.getCalcomUserByAuthUserIdImpl(ctx, ME)).defaultScheduleId).toBe(
      mine,
    );
    // A forged foreign id is silently dropped (not written).
    await prefsImpl(ctx, {
      authUserId: ME,
      defaultScheduleId: foreign,
    });
    expect((await calcomUsers.getCalcomUserByAuthUserIdImpl(ctx, ME)).defaultScheduleId).toBe(
      mine,
    );
  });

  it("is a clean no-op (updated:false) when the owner has no map row", async () => {
    const res = await prefsImpl(ctx, {
      authUserId: "auth_user_never_signed_in",
      timeZone: "UTC",
    });
    expect(res.updated).toBe(false);
  });

  it("s2s adminUpdateCalcomUserPrefs resolves a cal default-schedule int + patches", async () => {
    const now = Date.now();
    const schedId = await ctx.db.insert("schedules", {
      ownerAuthUserId: ME,
      name: "Default",
      timeZone: "UTC",
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    const { calId: schedCal } = await (admin.adminGetSchedule as any)._handler(ctx, {
      ownerAuthUserId: ME,
      id: schedId,
    });
    const res = await (admin.adminUpdateCalcomUserPrefs as any)._handler(ctx, {
      ownerAuthUserId: ME,
      timeZone: "Europe/Paris",
      weekStart: "Monday",
      timeFormat: 24,
      calDefaultScheduleId: schedCal,
    });
    expect(res.updated).toBe(true);
    const row = await calcomUsers.getCalcomUserByAuthUserIdImpl(ctx, ME);
    expect(row.timeZone).toBe("Europe/Paris");
    expect(row.timeFormat).toBe(24);
    expect(row.defaultScheduleId).toBe(schedId);
  });
});
