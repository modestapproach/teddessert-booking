// CV-7 — resolve-a-co-host-by-email tests (the headline UI backing).
//
// Proves the email → co-host resolution seam that the fork's event-type editor
// co-host picker calls (server-to-server, owner-scoped):
//   - a mapped email (has a calcomUserMap row, i.e. has signed into booking) →
//     status "assignable" with the minted cal int the picker emits into hosts[];
//   - an UNmapped email that DOES belong to a Better-Auth (dibslist) account →
//     status "needs_signin", calUserId null (picker shows the sign-in nudge,
//     does NOT add them);
//   - an unknown email (no dibslist account at all) → found:false / "not_found";
//   - the owner's OWN email → status "self" (can't co-host yourself).
//
// Also proves the END-TO-END headline still holds downstream: an "assignable"
// cal int round-trips through adminSetEventTypeHosts → adminListEventTypeHosts
// on a COLLECTIVE event type with BOTH hosts forced isFixed:true (both founders
// free — the availability intersection input). That collective→isFixed→
// intersection chain is exercised end-to-end in cv6EventTypeHosts.test.ts +
// availableSlots.test.ts; here we assert the resolve→hosts[] handoff that feeds it.
//
// HARNESS: repo FakeDb + bare-Impl convention (mirrors cv6EventTypeHosts.test.ts /
// calcomUsers.test.ts). The Better-Auth user table is a Convex component, reached
// via ctx.runQuery(components.betterAuth.adapter.findMany); the fake ctx routes
// that reference against an in-memory `betterAuthUsers` list.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ConvexError } from "convex/values";

// The *Core direct-call tests of the s2s wrapper need requireAuthUserId mocked
// (same as cv6EventTypeHosts.test.ts); resolveCoHostByEmail itself never hits it.
vi.mock("../_helpers/auth", () => ({
  requireAuthUserId: async (ctx: any) => {
    if (!ctx.__identity) throw new ConvexError("Not authenticated. Please sign in.");
    return ctx.__identity as string;
  },
}));

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

// A fake Better-Auth user row (the shape the adapter.findMany page returns).
interface BAUser {
  _id: string;
  email: string;
  name?: string;
  image?: string;
}

// Build a fake ctx whose runQuery routes the betterAuth adapter.findMany against
// an in-memory user list (exact, case-insensitive email match — mirroring the
// component's "eq"/"insensitive" behaviour).
function makeCtx(betterAuthUsers: BAUser[] = [], identity: string | null = null) {
  const db = new FakeDb();
  const runQuery = vi.fn(async (_ref: any, args: any) => {
    // Only the user-by-email lookup is exercised here.
    const where = (args?.where ?? []) as Array<{ field: string; value: string }>;
    const emailPred = where.find((w) => w.field === "email");
    const want = (emailPred?.value ?? "").toLowerCase();
    const matches = betterAuthUsers.filter((u) => u.email.toLowerCase() === want);
    const numItems = args?.paginationOpts?.numItems ?? matches.length;
    return { page: matches.slice(0, numItems), isDone: true, continueCursor: null };
  });
  return { db, runQuery, __identity: identity } as any;
}

async function seedCalUser(ctx: any, authUserId: string, calId: number, email: string) {
  const now = Date.now();
  await ctx.db.insert("calcomUserMap", {
    authUserId,
    calId,
    email,
    name: authUserId,
    username: authUserId,
    avatarUrl: `https://avatars.example/${authUserId}.png`,
    createdAt: now,
    updatedAt: now,
  });
}

const resolve = (ctx: any, owner: string, email: string) =>
  admin.resolveCoHostByEmailImpl(ctx, owner, email);

const ME = "auth_user_me";
const FOUNDER_B = "auth_user_founder_b";

describe("CV-7 — resolveCoHostByEmail (email → co-host)", () => {
  it("resolves a MAPPED email → status 'assignable' with the minted cal int", async () => {
    const ctx = makeCtx([{ _id: FOUNDER_B, email: "b@dibslist.app", name: "Founder B" }]);
    await seedCalUser(ctx, FOUNDER_B, 102, "b@dibslist.app");

    const res = await resolve(ctx, ME, "b@dibslist.app");
    expect(res.found).toBe(true);
    expect(res.status).toBe("assignable");
    expect(res.calUserId).toBe(102);
    expect(res.authUserId).toBe(FOUNDER_B);
    expect(res.avatar).toContain(FOUNDER_B);
  });

  it("is case-insensitive on the email (mapped path)", async () => {
    const ctx = makeCtx();
    await seedCalUser(ctx, FOUNDER_B, 103, "b@dibslist.app");
    const res = await resolve(ctx, ME, "  B@DibsList.App  ");
    expect(res.status).toBe("assignable");
    expect(res.calUserId).toBe(103);
  });

  it("returns 'needs_signin' for a real dibslist account with NO booking mint yet", async () => {
    // Better-Auth user exists, but no calcomUserMap row → not assignable yet.
    const ctx = makeCtx([{ _id: FOUNDER_B, email: "b@dibslist.app", name: "Founder B", image: "x.png" }]);
    const res = await resolve(ctx, ME, "b@dibslist.app");
    expect(res.found).toBe(true);
    expect(res.status).toBe("needs_signin");
    expect(res.calUserId).toBeNull(); // MUST be null — an unminted int would be dropped
    expect(res.authUserId).toBe(FOUNDER_B);
    expect(res.name).toBe("Founder B");
    expect(res.avatar).toBe("x.png");
  });

  it("returns found:false / 'not_found' for an email with no dibslist account", async () => {
    const ctx = makeCtx([{ _id: FOUNDER_B, email: "b@dibslist.app" }]);
    const res = await resolve(ctx, ME, "stranger@example.com");
    expect(res.found).toBe(false);
    expect(res.status).toBe("not_found");
    expect(res.calUserId).toBeNull();
    expect(res.authUserId).toBeNull();
  });

  it("returns 'not_found' for empty/whitespace email without hitting Better-Auth", async () => {
    const ctx = makeCtx([{ _id: FOUNDER_B, email: "b@dibslist.app" }]);
    const res = await resolve(ctx, ME, "   ");
    expect(res.found).toBe(false);
    expect(res.status).toBe("not_found");
    expect(ctx.runQuery).not.toHaveBeenCalled();
  });

  it("flags the OWNER's own email as 'self' (mapped) — can't co-host yourself", async () => {
    const ctx = makeCtx();
    await seedCalUser(ctx, ME, 100, "me@dibslist.app");
    const res = await resolve(ctx, ME, "me@dibslist.app");
    expect(res.found).toBe(true);
    expect(res.status).toBe("self");
  });

  it("flags the owner's own email as 'self' even when only Better-Auth knows them", async () => {
    const ctx = makeCtx([{ _id: ME, email: "me@dibslist.app", name: "Me" }]);
    const res = await resolve(ctx, ME, "me@dibslist.app");
    expect(res.status).toBe("self");
    expect(res.authUserId).toBe(ME);
  });

  it("registered query wrapper delegates to the impl", async () => {
    const ctx = makeCtx();
    await seedCalUser(ctx, FOUNDER_B, 104, "b@dibslist.app");
    const res = await (admin.resolveCoHostByEmail as any)._handler(ctx, {
      ownerAuthUserId: ME,
      email: "b@dibslist.app",
    });
    expect(res.status).toBe("assignable");
    expect(res.calUserId).toBe(104);
  });
});

// ─────────────────────────────────────────────────────────────
// END-TO-END HEADLINE: an "assignable" resolution → emitted into hosts[] →
// persisted as TWO collective co-hosts, both forced isFixed:true (both founders
// free). This asserts the resolve→hosts[] handoff the picker performs, then the
// CV-6 s2s write/read round-trip on a COLLECTIVE event type. The downstream
// availability INTERSECTION over those fixed hosts is covered in
// availableSlots.test.ts ("collective => intersection of fixed hosts").
// ─────────────────────────────────────────────────────────────

describe("CV-7 — resolved co-hosts persist as collective hosts[] (both-founders-free)", () => {
  let ctx: any;
  beforeEach(async () => {
    ctx = makeCtx([
      { _id: ME, email: "me@dibslist.app", name: "Me" },
      { _id: FOUNDER_B, email: "b@dibslist.app", name: "Founder B" },
    ]);
    // booking_enabled ON so the host WRITE passes its flag gate.
    await ctx.db.insert("featureFlags", {
      key: "booking_enabled",
      value: true,
      updatedAt: Date.now(),
      updatedBy: "test",
    });
    // Both the owner AND the co-host have signed into booking (minted cal ints).
    await seedCalUser(ctx, ME, 100, "me@dibslist.app");
    await seedCalUser(ctx, FOUNDER_B, 102, "b@dibslist.app");
  });

  it("resolve(email) → calUserId → adminSetEventTypeHosts → both forced isFixed:true", async () => {
    // 1) Owner creates a COLLECTIVE event type.
    const { calId: etCalId } = await (admin.adminCreateEventType as any)._handler(ctx, {
      ownerAuthUserId: ME,
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
    });

    // 2) The picker resolves the owner + the co-host by email.
    const ownerHost = await resolve(ctx, ME, "me@dibslist.app");
    const coHost = await resolve(ctx, ME, "b@dibslist.app");
    expect(ownerHost.status).toBe("self"); // surfaced as the implicit host
    expect(coHost.status).toBe("assignable");
    expect(coHost.calUserId).toBe(102);

    // 3) The picker emits BOTH resolved cal ints into hosts[] (isFixed:false to
    //    prove collective FORCES it true), and the CV-6 Save persists them.
    const setRes = await (admin.adminSetEventTypeHosts as any)._handler(ctx, {
      ownerAuthUserId: ME,
      calEventTypeId: etCalId,
      hosts: [
        { calHostUserId: 100, isFixed: false }, // owner
        { calHostUserId: coHost.calUserId, isFixed: false }, // resolved co-host
      ],
    });
    expect(setRes.assigned).toBe(2);

    // 4) Read-back: BOTH hosts present, BOTH forced isFixed:true (intersection input).
    const rows = await (admin.adminListEventTypeHosts as any)._handler(ctx, {
      ownerAuthUserId: ME,
      calEventTypeId: etCalId,
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.isFixed === true)).toBe(true);
    expect(rows.map((r: any) => r.calHostUserId).sort()).toEqual([100, 102]);
  });

  it("a 'needs_signin' co-host yields no calUserId, so the picker never emits an unminted int", async () => {
    // A real dibslist user who has NOT signed into booking: Better-Auth knows
    // them, but there's no calcomUserMap row → calUserId null. Even if the UI
    // tried to add them, adminSetEventTypeHosts would skip the unknown int.
    const ctx2 = makeCtx([{ _id: "auth_user_unsigned", email: "new@dibslist.app", name: "New" }]);
    await ctx2.db.insert("featureFlags", {
      key: "booking_enabled",
      value: true,
      updatedAt: Date.now(),
      updatedBy: "test",
    });
    await seedCalUser(ctx2, ME, 100, "me@dibslist.app");
    const { calId: etCalId } = await (admin.adminCreateEventType as any)._handler(ctx2, {
      ownerAuthUserId: ME,
      slug: "panel-2",
      title: "Panel 2",
      durationMinutes: 30,
      schedulingType: "collective" as const,
      minimumBookingNoticeMinutes: 120,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      requireEmailVerification: false,
      hidden: false,
      active: true,
    });

    const unsigned = await resolve(ctx2, ME, "new@dibslist.app");
    expect(unsigned.status).toBe("needs_signin");
    expect(unsigned.calUserId).toBeNull();

    // Picker emits ONLY the owner (the unsigned co-host has no int to emit).
    const setRes = await (admin.adminSetEventTypeHosts as any)._handler(ctx2, {
      ownerAuthUserId: ME,
      calEventTypeId: etCalId,
      hosts: [{ calHostUserId: 100 }],
    });
    expect(setRes.assigned).toBe(1);
  });
});
