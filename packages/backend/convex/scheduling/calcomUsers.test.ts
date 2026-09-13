// CV-1 — tests for `scheduling/calcomUsers.ts`
// (resolveOrCreateCalcomUser create + idempotent re-resolve + stable id +
// lookups + username derivation).
//
// HARNESS: repo FakeDb + bare-handler convention (see holds.test.ts /
// schedules.test.ts). The FakeQuery supports eq + .unique()/.first()/.collect().
// No auth mock is needed — these functions deliberately carry no requireAuthUserId
// (server-to-server identity infra; the cal shim validates the Better-Auth cookie
// before calling). No feature-flag gate either.

import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveOrCreateCalcomUserImpl,
  getCalcomUserByAuthUserIdImpl,
  getCalcomUserByCalIdImpl,
  getCalcomUserByEmailImpl,
  deriveUsername,
} from "./calcomUsers";

// ─────────────────────────────────────────────────────────────
// FakeDb (eq + unique + first + collect + insert/patch/delete)
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
    };
    fn(q);
    this.rows = this.rows.filter((r) => preds.every((p) => p(r)));
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

const USER_A = "betterauth_user_a";
const USER_B = "betterauth_user_b";

// ─────────────────────────────────────────────────────────────
// deriveUsername (pure)
// ─────────────────────────────────────────────────────────────

describe("deriveUsername", () => {
  it("lowercases + slugs the email local-part", () => {
    expect(deriveUsername("Jane.Doe@Example.com")).toBe("jane.doe");
    expect(deriveUsername("WEIRD+tag@x.io")).toBe("weirdtag");
    expect(deriveUsername("a_b-c.d@x.io")).toBe("a_b-c.d");
  });
  it("returns empty string for an unusable local-part", () => {
    expect(deriveUsername("@x.io")).toBe("");
    expect(deriveUsername("!!!@x.io")).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────
// resolveOrCreateCalcomUser
// ─────────────────────────────────────────────────────────────

describe("resolveOrCreateCalcomUser", () => {
  let ctx: any;
  beforeEach(() => {
    ctx = makeCtx();
  });

  it("creates a row + allocates calId=1 on first call, seeding calcomSeq", async () => {
    const res = await resolveOrCreateCalcomUserImpl(ctx, {
      authUserId: USER_A,
      email: "jane@dibslist.app",
      name: "Jane",
    });
    expect(res.created).toBe(true);
    expect(res.calId).toBe(1);

    const row = ctx.db.tables["calcomUserMap"].get(res._id);
    expect(row.authUserId).toBe(USER_A);
    expect(row.calId).toBe(1);
    expect(row.email).toBe("jane@dibslist.app");
    expect(row.name).toBe("Jane");
    expect(row.username).toBe("jane"); // derived from local-part
    expect(typeof row.createdAt).toBe("number");
    expect(row.updatedAt).toBe(row.createdAt);

    // calcomSeq seeded + pre-incremented to 2.
    const seq = [...ctx.db.tables["calcomSeq"].values()][0];
    expect(seq.nextId).toBe(2);
  });

  it("is idempotent: re-resolving the same authUserId returns the SAME calId, created=false, no new row", async () => {
    const first = await resolveOrCreateCalcomUserImpl(ctx, {
      authUserId: USER_A,
      email: "jane@dibslist.app",
      name: "Jane",
    });
    const second = await resolveOrCreateCalcomUserImpl(ctx, {
      authUserId: USER_A,
      email: "jane@dibslist.app",
      name: "Jane",
    });
    expect(second.created).toBe(false);
    expect(second.calId).toBe(first.calId);
    expect(second._id).toBe(first._id);
    expect(ctx.db.tables["calcomUserMap"].size).toBe(1);
    // Counter must NOT advance on a re-resolve.
    const seq = [...ctx.db.tables["calcomSeq"].values()][0];
    expect(seq.nextId).toBe(2);
  });

  it("assigns stable, monotonic, distinct calIds across different users", async () => {
    const a = await resolveOrCreateCalcomUserImpl(ctx, {
      authUserId: USER_A,
      email: "a@dibslist.app",
      name: "A",
    });
    const b = await resolveOrCreateCalcomUserImpl(ctx, {
      authUserId: USER_B,
      email: "b@dibslist.app",
      name: "B",
    });
    expect(a.calId).toBe(1);
    expect(b.calId).toBe(2);
    expect(a.calId).not.toBe(b.calId);

    // Re-resolve A — still 1, even after B was minted.
    const aAgain = await resolveOrCreateCalcomUserImpl(ctx, {
      authUserId: USER_A,
      email: "a@dibslist.app",
      name: "A",
    });
    expect(aAgain.calId).toBe(1);

    const seq = [...ctx.db.tables["calcomSeq"].values()][0];
    expect(seq.nextId).toBe(3); // pre-incremented after two creates
  });

  it("re-syncs profile fields (name/email/avatar/timeZone) on re-resolve without changing calId", async () => {
    const first = await resolveOrCreateCalcomUserImpl(ctx, {
      authUserId: USER_A,
      email: "old@dibslist.app",
      name: "Old Name",
    });
    await resolveOrCreateCalcomUserImpl(ctx, {
      authUserId: USER_A,
      email: "new@dibslist.app",
      name: "New Name",
      avatarUrl: "https://cdn/x.png",
      timeZone: "America/New_York",
      locale: "en",
      weekStart: "Monday",
    });
    const row = ctx.db.tables["calcomUserMap"].get(first._id);
    expect(row.calId).toBe(first.calId);
    expect(row.email).toBe("new@dibslist.app");
    expect(row.name).toBe("New Name");
    expect(row.avatarUrl).toBe("https://cdn/x.png");
    expect(row.timeZone).toBe("America/New_York");
    expect(row.locale).toBe("en");
    expect(row.weekStart).toBe("Monday");
    expect(row.updatedAt).toBeGreaterThanOrEqual(row.createdAt);
  });

  it("honors an explicit username over the derived one", async () => {
    const res = await resolveOrCreateCalcomUserImpl(ctx, {
      authUserId: USER_A,
      email: "jane@dibslist.app",
      name: "Jane",
      username: "jane-the-seller",
    });
    const row = ctx.db.tables["calcomUserMap"].get(res._id);
    expect(row.username).toBe("jane-the-seller");
  });

  it("falls back to a calId-based username when the email has no usable local-part", async () => {
    const res = await resolveOrCreateCalcomUserImpl(ctx, {
      authUserId: USER_A,
      email: "!!!@dibslist.app",
      name: "Weird",
    });
    const row = ctx.db.tables["calcomUserMap"].get(res._id);
    expect(row.username).toBe(`user${res.calId}`);
  });
});

// ─────────────────────────────────────────────────────────────
// Lookups
// ─────────────────────────────────────────────────────────────

describe("calcomUser lookups", () => {
  let ctx: any;
  beforeEach(() => {
    ctx = makeCtx();
  });

  it("getCalcomUserByAuthUserId returns the row, null when absent", async () => {
    const created = await resolveOrCreateCalcomUserImpl(ctx, {
      authUserId: USER_A,
      email: "jane@dibslist.app",
      name: "Jane",
    });
    const found = await getCalcomUserByAuthUserIdImpl(ctx, USER_A);
    expect(found?._id).toBe(created._id);
    expect(found?.calId).toBe(created.calId);
    expect(await getCalcomUserByAuthUserIdImpl(ctx, "nope")).toBeNull();
  });

  it("getCalcomUserByCalId reverse-lookup hydrates the dibslist identity", async () => {
    const created = await resolveOrCreateCalcomUserImpl(ctx, {
      authUserId: USER_A,
      email: "jane@dibslist.app",
      name: "Jane",
    });
    const found = await getCalcomUserByCalIdImpl(ctx, created.calId);
    expect(found?.authUserId).toBe(USER_A);
    expect(await getCalcomUserByCalIdImpl(ctx, 99999)).toBeNull();
  });

  it("getCalcomUserByEmail is case-insensitive, null when absent", async () => {
    await resolveOrCreateCalcomUserImpl(ctx, {
      authUserId: USER_A,
      email: "Jane@Dibslist.app",
      name: "Jane",
    });
    const found = await getCalcomUserByEmailImpl(ctx, "jane@dibslist.app");
    expect(found?.authUserId).toBe(USER_A);
    expect(await getCalcomUserByEmailImpl(ctx, "ghost@x.io")).toBeNull();
  });
});
