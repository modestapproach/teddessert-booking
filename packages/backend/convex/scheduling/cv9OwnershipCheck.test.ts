// CV-9 — lightweight event-type ownership check (adminCheckEventTypeOwner).
//
// This query backs the fork's createEventPbacProcedure tRPC middleware — the gate
// on the entire event-type editor lifecycle (get/update/delete/duplicate + the
// host sub-queries). The middleware USED to do an unconditional
// `ctx.prisma.eventType.findUnique` before its owner check, which throws on the
// no-Postgres fork (500ing the editor before the Convex-rewired handler bodies
// run). CV-9 rewires the middleware to call this instead.
//
// We prove the three branches the personal-owner middleware needs:
//   - owner match            → { found:true, owned:true }   (middleware proceeds)
//   - cross-owner reject     → { found:true, owned:false }  (middleware → FORBIDDEN)
//   - not-found              → { found:false, owned:false } (middleware → NOT_FOUND)
// plus that the check uses ONLY the id-map row (the denormalised ownerAuthUserId),
// never a second eventTypes fetch, and is owner-scoped (leaks nothing cross-owner).
//
// HARNESS: the repo in-memory FakeDb + bare-Impl/_handler convention (mirrors
// cv8DataCleanup.test.ts). The id-map is seeded via resolveEventTypeCalIdImpl so
// the test exercises the SAME by_calId path the production middleware hits.

import { describe, it, expect, beforeEach } from "vitest";

import { resolveEventTypeCalIdImpl } from "./calcomIdMaps";
import { adminCheckEventTypeOwner } from "./calcomAdmin";

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

// Call the registered query's handler directly with the FakeDb ctx (no Convex
// identity — the s2s wrappers carry none, exactly like the fork's anonymous
// ConvexHttpClient).
const checkOwner = (ctx: any, ownerAuthUserId: string, calEventTypeId: number) =>
  (adminCheckEventTypeOwner as any)._handler(ctx, { ownerAuthUserId, calEventTypeId });

const ME = "auth_user_me";
const OTHER = "auth_user_other";

// Seed an event type owned by `owner` + mint its stable cal int via the SAME
// id-map path the production middleware resolves through.
async function seedEventTypeWithCalId(ctx: any, owner: string, slug: string): Promise<number> {
  const now = Date.now();
  const convexId = await ctx.db.insert("eventTypes", {
    ownerAuthUserId: owner,
    slug,
    title: slug,
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
  const { calId } = await resolveEventTypeCalIdImpl(ctx, convexId, owner);
  return calId;
}

describe("CV-9 — adminCheckEventTypeOwner (event-type pbac middleware backing)", () => {
  let ctx: any;
  let myCalId: number;

  beforeEach(async () => {
    ctx = makeCtx();
    myCalId = await seedEventTypeWithCalId(ctx, ME, "intro-call");
  });

  it("owner match → { found:true, owned:true }", async () => {
    const res = await checkOwner(ctx, ME, myCalId);
    expect(res).toEqual({ found: true, owned: true });
  });

  it("cross-owner → { found:true, owned:false } (would 403 in the middleware)", async () => {
    const res = await checkOwner(ctx, OTHER, myCalId);
    expect(res).toEqual({ found: true, owned: false });
  });

  it("unknown cal int → { found:false, owned:false } (would 404 in the middleware)", async () => {
    const res = await checkOwner(ctx, ME, 9_999_999);
    expect(res).toEqual({ found: false, owned: false });
  });

  it("a SECOND owner's event type is owned by them, not by ME (no cross-owner leak)", async () => {
    const otherCalId = await seedEventTypeWithCalId(ctx, OTHER, "other-call");
    // OTHER owns theirs; ME does not.
    expect(await checkOwner(ctx, OTHER, otherCalId)).toEqual({ found: true, owned: true });
    expect(await checkOwner(ctx, ME, otherCalId)).toEqual({ found: true, owned: false });
    // And ME still owns mine.
    expect(await checkOwner(ctx, ME, myCalId)).toEqual({ found: true, owned: true });
  });

  it("resolves via the id-map row alone (works without touching the eventTypes table)", async () => {
    // Drop the underlying eventTypes row but keep the id-map row: the check must
    // still succeed off the denormalised ownerAuthUserId on the map (proving it
    // does no second eventTypes fetch).
    const mapRow = await ctx.db.query("eventTypeIdMap").first();
    expect(mapRow).not.toBeNull();
    await ctx.db.delete(mapRow.convexId);
    const res = await checkOwner(ctx, ME, myCalId);
    expect(res).toEqual({ found: true, owned: true });
  });
});
