// CV-2c — tests for the int↔string id maps (calcomIdMaps.ts).
//
// Proves the bijection the cal editor round-trip needs:
//   - resolve(convexId) mints a stable cal int on first sight (seeding the seq);
//   - it is IDEMPOTENT — re-resolving the same convexId returns the SAME calId,
//     created=false, no new row, and does NOT advance the counter;
//   - the int is STABLE + MONOTONIC + DISTINCT across rows;
//   - by_calId reverse-lookup recovers the EXACT convexId (round-trip);
//   - event-type and schedule maps have INDEPENDENT counters;
//   - the counter never decrements (no reuse even if a row is "deleted").
//
// Harness: the same FakeDb the sibling tests use (eq + unique + first + collect +
// insert/patch/delete). No auth mock — these fns carry no requireAuthUserId.

import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveEventTypeCalIdImpl,
  getEventTypeByCalIdImpl,
  getEventTypeCalIdByConvexIdImpl,
  resolveScheduleCalIdImpl,
  getScheduleByCalIdImpl,
  getScheduleCalIdByConvexIdImpl,
  resolveCalendarCredentialCalIdImpl,
  getCalendarCredentialByCalIdImpl,
  getCalendarCredentialCalIdByConvexIdImpl,
} from "./calcomIdMaps";

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

function makeCtx() {
  return { db: new FakeDb() } as any;
}

const OWNER = "auth_user_owner";
// Stable, opaque-looking Convex ids (the FakeDb keys on `table|n`, but these
// strings are only ever passed through as opaque values here).
const ET_A = "eventTypes|aaa" as any;
const ET_B = "eventTypes|bbb" as any;
const SCH_A = "schedules|xxx" as any;
const SCH_B = "schedules|yyy" as any;
const CRED_A = "calendarCredentials|c1" as any;
const CRED_B = "calendarCredentials|c2" as any;

describe("eventType id-map", () => {
  let ctx: any;
  beforeEach(() => {
    ctx = makeCtx();
  });

  it("mints calId=1 on first resolve, seeding eventTypeIdSeq to 2", async () => {
    const res = await resolveEventTypeCalIdImpl(ctx, ET_A, OWNER);
    expect(res.created).toBe(true);
    expect(res.calId).toBe(1);

    const row = ctx.db.tables["eventTypeIdMap"].get(res.mapId);
    expect(row.convexId).toBe(ET_A);
    expect(row.calId).toBe(1);
    expect(row.ownerAuthUserId).toBe(OWNER);
    expect(typeof row.createdAt).toBe("number");

    const seq = [...ctx.db.tables["eventTypeIdSeq"].values()][0];
    expect(seq.nextId).toBe(2);
  });

  it("is idempotent: re-resolving the same convexId returns the SAME calId, created=false, no new row, no counter bump", async () => {
    const first = await resolveEventTypeCalIdImpl(ctx, ET_A, OWNER);
    const second = await resolveEventTypeCalIdImpl(ctx, ET_A, OWNER);
    expect(second.created).toBe(false);
    expect(second.calId).toBe(first.calId);
    expect(second.mapId).toBe(first.mapId);
    expect(ctx.db.tables["eventTypeIdMap"].size).toBe(1);
    const seq = [...ctx.db.tables["eventTypeIdSeq"].values()][0];
    expect(seq.nextId).toBe(2);
  });

  it("assigns stable, monotonic, distinct calIds across rows", async () => {
    const a = await resolveEventTypeCalIdImpl(ctx, ET_A, OWNER);
    const b = await resolveEventTypeCalIdImpl(ctx, ET_B, OWNER);
    expect(a.calId).toBe(1);
    expect(b.calId).toBe(2);
    expect(a.calId).not.toBe(b.calId);
    // Re-resolve A — still 1 even after B was minted.
    const aAgain = await resolveEventTypeCalIdImpl(ctx, ET_A, OWNER);
    expect(aAgain.calId).toBe(1);
    const seq = [...ctx.db.tables["eventTypeIdSeq"].values()][0];
    expect(seq.nextId).toBe(3);
  });

  it("BIJECTION round-trip: convexId → calId → convexId recovers the exact id", async () => {
    const { calId } = await resolveEventTypeCalIdImpl(ctx, ET_A, OWNER);
    const byCal = await getEventTypeByCalIdImpl(ctx, calId);
    expect(byCal?.convexId).toBe(ET_A);
    const byConvex = await getEventTypeCalIdByConvexIdImpl(ctx, ET_A);
    expect(byConvex?.calId).toBe(calId);
  });

  it("getEventTypeByCalId returns null for an unknown int", async () => {
    expect(await getEventTypeByCalIdImpl(ctx, 99999)).toBeNull();
  });

  it("counter does NOT decrement after a row is deleted (no reuse)", async () => {
    const a = await resolveEventTypeCalIdImpl(ctx, ET_A, OWNER);
    // Simulate a tombstone/cascade of the map row.
    await ctx.db.delete(a.mapId);
    const b = await resolveEventTypeCalIdImpl(ctx, ET_B, OWNER);
    expect(b.calId).toBe(2); // NOT 1 — the counter advanced past the deleted row.
  });
});

describe("schedule id-map", () => {
  let ctx: any;
  beforeEach(() => {
    ctx = makeCtx();
  });

  it("mints calId=1 on first resolve, seeding scheduleIdSeq to 2", async () => {
    const res = await resolveScheduleCalIdImpl(ctx, SCH_A, OWNER);
    expect(res.created).toBe(true);
    expect(res.calId).toBe(1);
    const seq = [...ctx.db.tables["scheduleIdSeq"].values()][0];
    expect(seq.nextId).toBe(2);
  });

  it("is idempotent + BIJECTION round-trips", async () => {
    const first = await resolveScheduleCalIdImpl(ctx, SCH_A, OWNER);
    const second = await resolveScheduleCalIdImpl(ctx, SCH_A, OWNER);
    expect(second.calId).toBe(first.calId);
    expect(second.created).toBe(false);
    const byCal = await getScheduleByCalIdImpl(ctx, first.calId);
    expect(byCal?.convexId).toBe(SCH_A);
    const byConvex = await getScheduleCalIdByConvexIdImpl(ctx, SCH_A);
    expect(byConvex?.calId).toBe(first.calId);
  });

  it("getScheduleByCalId returns null for an unknown int", async () => {
    expect(await getScheduleByCalIdImpl(ctx, 12345)).toBeNull();
  });
});

describe("independent counters", () => {
  it("event-type and schedule maps allocate from SEPARATE seq rows", async () => {
    const ctx = makeCtx();
    const et = await resolveEventTypeCalIdImpl(ctx, ET_A, OWNER);
    const sch = await resolveScheduleCalIdImpl(ctx, SCH_A, OWNER);
    // Both start at 1 — they do NOT share a counter (would be 1 then 2 if shared).
    expect(et.calId).toBe(1);
    expect(sch.calId).toBe(1);
    const etSeq = [...ctx.db.tables["eventTypeIdSeq"].values()][0];
    const schSeq = [...ctx.db.tables["scheduleIdSeq"].values()][0];
    expect(etSeq.nextId).toBe(2);
    expect(schSeq.nextId).toBe(2);
  });
});

// CV-5 — calendar credential id-map (mirrors the eventType/schedule maps). The
// disconnect + conflict-toggle writes round-trip the int credential id, so the
// bijection must hold for credentials too.
describe("calendarCredential id-map (CV-5)", () => {
  let ctx: any;
  beforeEach(() => {
    ctx = makeCtx();
  });

  it("mints calId=1 on first resolve, seeding calendarCredentialIdSeq to 2", async () => {
    const res = await resolveCalendarCredentialCalIdImpl(ctx, CRED_A, OWNER);
    expect(res.created).toBe(true);
    expect(res.calId).toBe(1);
    const row = ctx.db.tables["calendarCredentialIdMap"].get(res.mapId);
    expect(row.convexId).toBe(CRED_A);
    expect(row.ownerAuthUserId).toBe(OWNER);
    const seq = [...ctx.db.tables["calendarCredentialIdSeq"].values()][0];
    expect(seq.nextId).toBe(2);
  });

  it("is idempotent + BIJECTION round-trips (int → _id → int)", async () => {
    const first = await resolveCalendarCredentialCalIdImpl(ctx, CRED_A, OWNER);
    const second = await resolveCalendarCredentialCalIdImpl(ctx, CRED_A, OWNER);
    expect(second.created).toBe(false);
    expect(second.calId).toBe(first.calId);
    expect(second.mapId).toBe(first.mapId);
    expect(ctx.db.tables["calendarCredentialIdMap"].size).toBe(1);

    const byCal = await getCalendarCredentialByCalIdImpl(ctx, first.calId);
    expect(byCal?.convexId).toBe(CRED_A);
    const byConvex = await getCalendarCredentialCalIdByConvexIdImpl(ctx, CRED_A);
    expect(byConvex?.calId).toBe(first.calId);
  });

  it("assigns monotonic distinct ids + counter never reuses after delete", async () => {
    const a = await resolveCalendarCredentialCalIdImpl(ctx, CRED_A, OWNER);
    const b = await resolveCalendarCredentialCalIdImpl(ctx, CRED_B, OWNER);
    expect(a.calId).toBe(1);
    expect(b.calId).toBe(2);
    // Tombstone A's map row, then resolve a brand-new credential — must NOT reuse 1.
    await ctx.db.delete(a.mapId);
    const c = await resolveCalendarCredentialCalIdImpl(
      ctx,
      "calendarCredentials|c3" as any,
      OWNER,
    );
    expect(c.calId).toBe(3);
  });

  it("getCalendarCredentialByCalId returns null for an unknown int", async () => {
    expect(await getCalendarCredentialByCalIdImpl(ctx, 4242)).toBeNull();
  });

  it("credential, event-type, and schedule maps have INDEPENDENT counters", async () => {
    const cred = await resolveCalendarCredentialCalIdImpl(ctx, CRED_A, OWNER);
    const et = await resolveEventTypeCalIdImpl(ctx, ET_A, OWNER);
    const sch = await resolveScheduleCalIdImpl(ctx, SCH_A, OWNER);
    expect(cred.calId).toBe(1);
    expect(et.calId).toBe(1);
    expect(sch.calId).toBe(1);
  });
});
