// CV-5 — mutation-level tests for the four deferred calendar/schedule WRITE paths
// rewired to Convex: calendar DISCONNECT, SET-DESTINATION, CONFLICT-TOGGLE, and
// SCHEDULE DELETE — plus their s2s owner-admin wrappers (ownership re-check).
//
// HARNESS: same as schedules.test.ts / calendarOauth.test.ts — mock
// `requireAuthUserId`, call the real registered handlers' `._handler(ctx, args)`
// against an in-memory FakeDb (with delete), and drive the DEFAULT-OFF
// `booking_enabled` flag through the real `_helpers/featureFlag.ts` read path.
//
// Covers, for each path:
//   - happy-path write + the exact field it mutates;
//   - OWNERSHIP rejection (a foreign owner → "Not found.");
//   - the id-map round-trip via the s2s wrapper (int credentialId → Convex _id);
//   - the schedule-delete guards (refuse last; promote a new default; cascade
//     children; reassign pinned event types).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ConvexError } from "convex/values";

vi.mock("../_helpers/auth", () => ({
  requireAuthUserId: async (ctx: any) => {
    if (!ctx.__identity)
      throw new ConvexError("Not authenticated. Please sign in.");
    return ctx.__identity as string;
  },
}));

import * as calendarOauth from "./calendarOauth";
import * as schedules from "./schedules";
import * as calcomAdmin from "./calcomAdmin";

// ─── In-memory fake ctx (db with withIndex eq-filter + delete) ───────────────

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

const ME = "user_me";
const OTHER = "user_other";

// Seed a Google credential with two selected calendars for ME.
async function seedCredentialWithCalendars(
  ctx: any,
  owner: string,
  cals: Array<{
    externalCalendarId: string;
    checkForConflicts?: boolean;
    isDestination?: boolean;
  }>,
): Promise<{ credentialId: string; calendarIds: string[] }> {
  const now = Date.now();
  const credentialId = await ctx.db.insert("calendarCredentials", {
    authUserId: owner,
    provider: "google",
    label: `${owner}@gmail.com`,
    encSecretCiphertext: "ct",
    encSecretIv: "iv",
    invalid: false,
    createdAt: now,
    updatedAt: now,
  });
  const calendarIds: string[] = [];
  for (const c of cals) {
    const id = await ctx.db.insert("selectedCalendars", {
      authUserId: owner,
      credentialId,
      externalCalendarId: c.externalCalendarId,
      displayName: c.externalCalendarId,
      checkForConflicts: c.checkForConflicts ?? true,
      isDestination: c.isDestination ?? false,
      createdAt: now,
      updatedAt: now,
    });
    calendarIds.push(id);
  }
  return { credentialId, calendarIds };
}

// ─────────────────────────────────────────────────────────────
// 1. CONFLICT-TOGGLE (setCalendarConflictFlag)
// ─────────────────────────────────────────────────────────────

describe("CV-5 conflict-toggle (setCalendarConflictFlag)", () => {
  let ctx: any;
  beforeEach(async () => {
    ctx = makeCtx(ME);
    await enableBooking(ctx);
  });

  it("flips checkForConflicts on the owner's selected calendar", async () => {
    const { credentialId } = await seedCredentialWithCalendars(ctx, ME, [
      { externalCalendarId: "primary", checkForConflicts: true },
    ]);
    const res = await (calendarOauth.setCalendarConflictFlag as any)._handler(ctx, {
      credentialId,
      externalCalendarId: "primary",
      checkForConflicts: false,
    });
    expect(res).toEqual({ ok: true, changed: true });
    const row = [...ctx.db.tables["selectedCalendars"].values()][0];
    expect(row.checkForConflicts).toBe(false);
  });

  it("changed=false when already at the requested value (idempotent)", async () => {
    const { credentialId } = await seedCredentialWithCalendars(ctx, ME, [
      { externalCalendarId: "primary", checkForConflicts: true },
    ]);
    const res = await (calendarOauth.setCalendarConflictFlag as any)._handler(ctx, {
      credentialId,
      externalCalendarId: "primary",
      checkForConflicts: true,
    });
    expect(res).toEqual({ ok: true, changed: false });
  });

  it("rejects a foreign owner's credential (Not found.)", async () => {
    // Acting identity is ME (from the ctx); seed the credential under OTHER.
    const { credentialId } = await seedCredentialWithCalendars(ctx, OTHER, [
      { externalCalendarId: "primary" },
    ]);
    await expect(
      (calendarOauth.setCalendarConflictFlag as any)._handler(ctx, {
        credentialId,
        externalCalendarId: "primary",
        checkForConflicts: false,
      }),
    ).rejects.toThrow("Not found.");
  });

  it("s2s wrapper resolves the cal int credentialId via the id-map", async () => {
    const { credentialId } = await seedCredentialWithCalendars(ctx, ME, [
      { externalCalendarId: "primary", checkForConflicts: true },
    ]);
    // Mint the round-trippable int (what the read path hands the UI).
    const minted = await (calcomAdmin.adminResolveCredentialCalIds as any)._handler(ctx, {
      ownerAuthUserId: ME,
    });
    const calCredentialId = minted[0].calId;
    // The UI rounds the int back into the conflict-toggle write.
    const res = await (calcomAdmin.adminSetCalendarConflictFlag as any)._handler(ctx, {
      ownerAuthUserId: ME,
      calCredentialId,
      externalCalendarId: "primary",
      checkForConflicts: false,
    });
    expect(res).toEqual({ ok: true, changed: true });
    const row = [...ctx.db.tables["selectedCalendars"].values()][0];
    expect(row.checkForConflicts).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 2. SET-DESTINATION
// ─────────────────────────────────────────────────────────────

describe("CV-5 set-destination (setDestinationCalendar)", () => {
  let ctx: any;
  beforeEach(async () => {
    ctx = makeCtx(ME);
    await enableBooking(ctx);
  });

  it("sets the targeted calendar as destination, clearing the prior one", async () => {
    await seedCredentialWithCalendars(ctx, ME, [
      { externalCalendarId: "primary", isDestination: true },
      { externalCalendarId: "work", isDestination: false },
    ]);
    const res = await (calendarOauth.setDestinationCalendar as any)._handler(ctx, {
      provider: "google",
      externalCalendarId: "work",
    });
    expect(res.ok).toBe(true);
    const rows = [...ctx.db.tables["selectedCalendars"].values()];
    const primary = rows.find((r) => r.externalCalendarId === "primary");
    const work = rows.find((r) => r.externalCalendarId === "work");
    expect(primary.isDestination).toBe(false); // prior destination cleared
    expect(work.isDestination).toBe(true);
  });

  it("throws when the externalCalendarId is not connected", async () => {
    await seedCredentialWithCalendars(ctx, ME, [
      { externalCalendarId: "primary" },
    ]);
    await expect(
      (calendarOauth.setDestinationCalendar as any)._handler(ctx, {
        externalCalendarId: "does-not-exist",
      }),
    ).rejects.toThrow(/Could not find calendar/);
  });

  it("a foreign owner cannot target another user's calendar", async () => {
    await seedCredentialWithCalendars(ctx, OTHER, [
      { externalCalendarId: "primary" },
    ]);
    // ME has no calendars → the target is not found in ME's set.
    await expect(
      (calendarOauth.setDestinationCalendar as any)._handler(ctx, {
        externalCalendarId: "primary",
      }),
    ).rejects.toThrow(/Could not find calendar/);
  });

  it("s2s wrapper keys on (provider, externalCalendarId) — no id-map needed", async () => {
    await seedCredentialWithCalendars(ctx, ME, [
      { externalCalendarId: "primary", isDestination: true },
      { externalCalendarId: "work" },
    ]);
    const res = await (calcomAdmin.adminSetDestinationCalendar as any)._handler(ctx, {
      ownerAuthUserId: ME,
      provider: "google",
      externalCalendarId: "work",
    });
    expect(res.ok).toBe(true);
    const work = [...ctx.db.tables["selectedCalendars"].values()].find(
      (r) => r.externalCalendarId === "work",
    );
    expect(work.isDestination).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 3. DISCONNECT / delete-credential
// ─────────────────────────────────────────────────────────────

describe("CV-5 disconnect (disconnectCalendar)", () => {
  let ctx: any;
  beforeEach(async () => {
    ctx = makeCtx(ME);
    await enableBooking(ctx);
  });

  it("deletes the credential + cascades selectedCalendars + freebusyCache", async () => {
    const { credentialId } = await seedCredentialWithCalendars(ctx, ME, [
      { externalCalendarId: "primary" },
      { externalCalendarId: "work" },
    ]);
    await ctx.db.insert("freebusyCache", {
      authUserId: ME,
      credentialId,
      externalCalendarId: "primary",
      windowStart: 0,
      windowEnd: 1,
      busy: [],
      fetchedAt: 0,
      expiresAt: 0,
      createdAt: 0,
      updatedAt: 0,
    });

    const res = await (calendarOauth.disconnectCalendar as any)._handler(ctx, {
      credentialId,
    });
    expect(res.ok).toBe(true);
    expect(res.deletedSelected).toBe(2);
    expect(res.deletedFreebusy).toBe(1);
    expect(await ctx.db.get(credentialId)).toBeNull();
    expect([...ctx.db.tables["selectedCalendars"].values()].length).toBe(0);
    expect([...ctx.db.tables["freebusyCache"].values()].length).toBe(0);
  });

  it("rejects a foreign owner's credential (Not found.)", async () => {
    const { credentialId } = await seedCredentialWithCalendars(ctx, OTHER, [
      { externalCalendarId: "primary" },
    ]);
    await expect(
      (calendarOauth.disconnectCalendar as any)._handler(ctx, { credentialId }),
    ).rejects.toThrow("Not found.");
    // The foreign credential survives.
    expect(await ctx.db.get(credentialId)).not.toBeNull();
  });

  it("s2s wrapper resolves the bare cal int credentialId via the id-map", async () => {
    const { credentialId } = await seedCredentialWithCalendars(ctx, ME, [
      { externalCalendarId: "primary" },
    ]);
    const minted = await (calcomAdmin.adminResolveCredentialCalIds as any)._handler(ctx, {
      ownerAuthUserId: ME,
    });
    const calCredentialId = minted[0].calId;
    const res = await (calcomAdmin.adminDisconnectCalendar as any)._handler(ctx, {
      ownerAuthUserId: ME,
      calCredentialId,
    });
    expect(res.ok).toBe(true);
    expect(await ctx.db.get(credentialId)).toBeNull();
  });

  it("a stale cal int (credential already gone) resolves to Not found.", async () => {
    const { credentialId } = await seedCredentialWithCalendars(ctx, ME, [
      { externalCalendarId: "primary" },
    ]);
    const minted = await (calcomAdmin.adminResolveCredentialCalIds as any)._handler(ctx, {
      ownerAuthUserId: ME,
    });
    const calCredentialId = minted[0].calId;
    // First disconnect succeeds; the map row remains (calIds never reused).
    await (calcomAdmin.adminDisconnectCalendar as any)._handler(ctx, {
      ownerAuthUserId: ME,
      calCredentialId,
    });
    // Re-using the same int now hits a missing credential → Not found.
    await expect(
      (calcomAdmin.adminDisconnectCalendar as any)._handler(ctx, {
        ownerAuthUserId: ME,
        calCredentialId,
      }),
    ).rejects.toThrow("Not found.");
    expect(credentialId).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────
// 4. SCHEDULE DELETE
// ─────────────────────────────────────────────────────────────

async function seedSchedule(
  ctx: any,
  owner: string,
  opts: { name: string; isDefault?: boolean; createdAt?: number },
): Promise<string> {
  return ctx.db.insert("schedules", {
    ownerAuthUserId: owner,
    name: opts.name,
    timeZone: "UTC",
    isDefault: opts.isDefault ?? false,
    createdAt: opts.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  });
}

describe("CV-5 schedule delete (deleteSchedule)", () => {
  let ctx: any;
  beforeEach(async () => {
    ctx = makeCtx(ME);
    await enableBooking(ctx);
  });

  it("refuses to delete the owner's ONLY schedule (last-schedule guard)", async () => {
    const id = await seedSchedule(ctx, ME, { name: "Working hours", isDefault: true });
    await expect(
      (schedules.deleteSchedule as any)._handler(ctx, { id }),
    ).rejects.toThrow(/only schedule/);
    expect(await ctx.db.get(id)).not.toBeNull();
  });

  it("deletes a non-default schedule + cascades its availability/overrides", async () => {
    const def = await seedSchedule(ctx, ME, {
      name: "Default",
      isDefault: true,
      createdAt: 1,
    });
    const extra = await seedSchedule(ctx, ME, {
      name: "Extra",
      isDefault: false,
      createdAt: 2,
    });
    await ctx.db.insert("availability", {
      scheduleId: extra,
      ownerAuthUserId: ME,
      days: [1, 2],
      startMinute: 540,
      endMinute: 1020,
      createdAt: 0,
    });
    await ctx.db.insert("dateOverrides", {
      scheduleId: extra,
      ownerAuthUserId: ME,
      dateUtc: 0,
      createdAt: 0,
    });

    await (schedules.deleteSchedule as any)._handler(ctx, { id: extra });
    expect(await ctx.db.get(extra)).toBeNull();
    expect(await ctx.db.get(def)).not.toBeNull();
    expect([...ctx.db.tables["availability"].values()].length).toBe(0);
    expect([...ctx.db.tables["dateOverrides"].values()].length).toBe(0);
    // The default was untouched.
    expect((await ctx.db.get(def)).isDefault).toBe(true);
  });

  it("promotes the oldest remaining schedule when deleting the DEFAULT", async () => {
    const def = await seedSchedule(ctx, ME, {
      name: "Default",
      isDefault: true,
      createdAt: 1,
    });
    const older = await seedSchedule(ctx, ME, {
      name: "Older",
      isDefault: false,
      createdAt: 2,
    });
    const newer = await seedSchedule(ctx, ME, {
      name: "Newer",
      isDefault: false,
      createdAt: 3,
    });

    await (schedules.deleteSchedule as any)._handler(ctx, { id: def });
    expect(await ctx.db.get(def)).toBeNull();
    // The OLDEST remaining (older) is promoted to default.
    expect((await ctx.db.get(older)).isDefault).toBe(true);
    expect((await ctx.db.get(newer)).isDefault).toBe(false);
  });

  it("reassigns event types pinned to the deleted schedule onto the new default", async () => {
    const def = await seedSchedule(ctx, ME, {
      name: "Default",
      isDefault: true,
      createdAt: 1,
    });
    const extra = await seedSchedule(ctx, ME, {
      name: "Extra",
      isDefault: false,
      createdAt: 2,
    });
    const et = await ctx.db.insert("eventTypes", {
      ownerAuthUserId: ME,
      slug: "intro",
      title: "Intro",
      durationMinutes: 30,
      schedulingType: "collective",
      scheduleId: extra,
      minimumBookingNoticeMinutes: 120,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      requireEmailVerification: false,
      hidden: false,
      active: true,
      createdAt: 0,
      updatedAt: 0,
    });

    await (schedules.deleteSchedule as any)._handler(ctx, { id: extra });
    // The pinned event type now points at the remaining default.
    expect((await ctx.db.get(et)).scheduleId).toBe(def);
  });

  it("rejects deleting another owner's schedule (Not found.)", async () => {
    const mine = await seedSchedule(ctx, ME, { name: "Mine", isDefault: true });
    await seedSchedule(ctx, ME, { name: "Mine2" });
    const theirs = await seedSchedule(ctx, OTHER, {
      name: "Theirs",
      isDefault: true,
    });
    await expect(
      (schedules.deleteSchedule as any)._handler(ctx, { id: theirs }),
    ).rejects.toThrow("Not found.");
    expect(await ctx.db.get(theirs)).not.toBeNull();
    expect(mine).toBeTruthy();
  });

  it("s2s wrapper resolves the cal int scheduleId via the existing scheduleIdMap", async () => {
    const def = await seedSchedule(ctx, ME, {
      name: "Default",
      isDefault: true,
      createdAt: 1,
    });
    const extra = await seedSchedule(ctx, ME, {
      name: "Extra",
      isDefault: false,
      createdAt: 2,
    });
    // Mint the cal int for `extra` via the existing schedule id-map (the int the
    // editor route param holds), then delete by that int through the s2s wrapper.
    const { resolveScheduleCalIdImpl } = await import("./calcomIdMaps");
    const { calId } = await resolveScheduleCalIdImpl(ctx, extra as any, ME);

    const res = await (calcomAdmin.adminDeleteSchedule as any)._handler(ctx, {
      ownerAuthUserId: ME,
      calScheduleId: calId,
    });
    expect(res.ok).toBe(true);
    expect(await ctx.db.get(extra)).toBeNull();
    expect(await ctx.db.get(def)).not.toBeNull();
  });
});
