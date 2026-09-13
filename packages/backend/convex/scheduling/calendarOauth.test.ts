// B2 / B3 — mutation/internalMutation-level tests for `calendarOauth.ts`.
//
// HARNESS: same as schedules.test.ts — mock `requireAuthUserId`, call the real
// registered handlers' `._handler(ctx, args)` against an in-memory FakeDb, and
// drive the DEFAULT-OFF `booking_enabled` flag through the real
// `_helpers/featureFlag.ts` read path (seed a `featureFlags` row to enable).
//
// Covers:
//   - _upsertSelectedCalendars maps an enumerated calendarList → selectedCalendars
//     rows: primary defaults checkForConflicts=true + isDestination=true;
//     non-primary defaults isDestination=false. Re-enumeration is idempotent and
//     PRESERVES the user's toggles.
//   - _upsertGoogleCalCredential upserts one Google credential per user (encrypts
//     the refresh token; re-connect overwrites + clears invalid).
//   - setCalendarConflictFlag toggles checkForConflicts, owner-scoped (a foreign
//     credential/row → Not found.).
//   - markCredentialInvalid flips invalid=true (credential refresh-failure path).

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
import { decryptAtRest } from "../_helpers/cryptoEnvelope";

// ─── In-memory fake ctx (db with withIndex eq-filter + first/unique) ─────────

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
  upsertCred: (ctx: any, a: any) =>
    (calendarOauth._upsertGoogleCalCredential as any)._handler(ctx, a),
  upsertCals: (ctx: any, a: any) =>
    (calendarOauth._upsertSelectedCalendars as any)._handler(ctx, a),
  setFlag: (ctx: any, a: any) =>
    (calendarOauth.setCalendarConflictFlag as any)._handler(ctx, a),
  markInvalid: (ctx: any, a: any) =>
    (calendarOauth.markCredentialInvalid as any)._handler(ctx, a),
  listConnected: (ctx: any) =>
    (calendarOauth.listConnectedCalendars as any)._handler(ctx, {}),
};

const ME = "user_me";
const OTHER = "user_other";

let ctx: any;
beforeEach(() => {
  ctx = makeCtx(ME);
});

// ─────────────────────────────────────────────────────────────
// _upsertGoogleCalCredential (B2)
// ─────────────────────────────────────────────────────────────

describe("_upsertGoogleCalCredential", () => {
  it("inserts one encrypted Google credential and re-connect overwrites it", async () => {
    const id1 = await call.upsertCred(ctx, {
      authUserId: ME,
      refreshToken: "1//first-refresh",
      label: "ted@gmail.com",
    });
    const row1 = await ctx.db.get(id1);
    expect(row1.provider).toBe("google");
    expect(row1.label).toBe("ted@gmail.com");
    expect(row1.invalid).toBe(false);
    // Secret is encrypted at rest; round-trips back to the plaintext token.
    expect(await decryptAtRest({
      ciphertext: row1.encSecretCiphertext,
      iv: row1.encSecretIv,
    })).toBe("1//first-refresh");

    // Re-connect: same row id, new ciphertext, invalid cleared.
    await ctx.db.patch(id1, { invalid: true });
    const id2 = await call.upsertCred(ctx, {
      authUserId: ME,
      refreshToken: "1//second-refresh",
      label: "",
    });
    expect(id2).toBe(id1); // upsert by (authUserId, provider)
    const row2 = await ctx.db.get(id1);
    expect(row2.invalid).toBe(false); // cleared on reconnect
    expect(row2.label).toBe("ted@gmail.com"); // empty label keeps prior
    expect(await decryptAtRest({
      ciphertext: row2.encSecretCiphertext,
      iv: row2.encSecretIv,
    })).toBe("1//second-refresh");
  });
});

// ─────────────────────────────────────────────────────────────
// _upsertSelectedCalendars (B3 — enumeration mapping)
// ─────────────────────────────────────────────────────────────

describe("_upsertSelectedCalendars (enumeration → selectedCalendars)", () => {
  it("maps a calendarList to rows with the primary flagged as conflict+destination", async () => {
    const credId = await call.upsertCred(ctx, {
      authUserId: ME,
      refreshToken: "1//r",
      label: "ted@gmail.com",
    });

    const res = await call.upsertCals(ctx, {
      authUserId: ME,
      credentialId: credId,
      calendars: [
        {
          externalCalendarId: "primary",
          displayName: "Personal",
          primary: true,
          timeZone: "America/New_York",
        },
        {
          externalCalendarId: "team@example.com",
          displayName: "Team",
          primary: false,
          timeZone: undefined,
        },
      ],
    });
    expect(res).toEqual({ upserted: 2 });

    const rows = (await ctx.db.query("selectedCalendars").collect()) as any[];
    const primary = rows.find((r) => r.externalCalendarId === "primary");
    const team = rows.find((r) => r.externalCalendarId === "team@example.com");

    // Primary → conflict-checked AND the write destination.
    expect(primary.checkForConflicts).toBe(true);
    expect(primary.isDestination).toBe(true);
    expect(primary.displayName).toBe("Personal");
    expect(primary.timeZone).toBe("America/New_York");
    expect(primary.authUserId).toBe(ME);

    // Non-primary → conflict-checked but NOT the destination.
    expect(team.checkForConflicts).toBe(true);
    expect(team.isDestination).toBe(false);
  });

  it("re-enumeration is idempotent and PRESERVES the user's toggle choices", async () => {
    const credId = await call.upsertCred(ctx, {
      authUserId: ME,
      refreshToken: "1//r",
      label: "x",
    });
    await call.upsertCals(ctx, {
      authUserId: ME,
      credentialId: credId,
      calendars: [
        { externalCalendarId: "primary", displayName: "P", primary: true },
      ],
    });
    // User turns conflict-checking OFF on the primary.
    const rowsBefore = (await ctx.db.query("selectedCalendars").collect()) as any[];
    await ctx.db.patch(rowsBefore[0]._id, { checkForConflicts: false });

    // Re-enumerate (e.g. a refresh): only metadata patches; the toggle stays.
    await call.upsertCals(ctx, {
      authUserId: ME,
      credentialId: credId,
      calendars: [
        {
          externalCalendarId: "primary",
          displayName: "Personal (renamed)",
          primary: true,
        },
      ],
    });
    const rowsAfter = (await ctx.db.query("selectedCalendars").collect()) as any[];
    expect(rowsAfter).toHaveLength(1); // no duplicate row
    expect(rowsAfter[0].checkForConflicts).toBe(false); // preserved
    expect(rowsAfter[0].displayName).toBe("Personal (renamed)"); // metadata refreshed
  });
});

// ─────────────────────────────────────────────────────────────
// setCalendarConflictFlag (B3 toggle) — owner-scoped + flag-gated
// ─────────────────────────────────────────────────────────────

describe("setCalendarConflictFlag", () => {
  beforeEach(async () => {
    await enableBooking(ctx);
  });

  async function seedCalendar(owner: string) {
    const credId = await call.upsertCred(ctx, {
      authUserId: owner,
      refreshToken: "1//r",
      label: "x",
    });
    await call.upsertCals(ctx, {
      authUserId: owner,
      credentialId: credId,
      calendars: [
        { externalCalendarId: "primary", displayName: "P", primary: true },
      ],
    });
    return credId;
  }

  it("toggles checkForConflicts on the owner's calendar", async () => {
    const credId = await seedCalendar(ME);
    const r1 = await call.setFlag(ctx, {
      credentialId: credId,
      externalCalendarId: "primary",
      checkForConflicts: false,
    });
    expect(r1).toEqual({ ok: true, changed: true });
    const rows = (await ctx.db.query("selectedCalendars").collect()) as any[];
    expect(rows[0].checkForConflicts).toBe(false);

    // Idempotent no-op when already at the requested value.
    const r2 = await call.setFlag(ctx, {
      credentialId: credId,
      externalCalendarId: "primary",
      checkForConflicts: false,
    });
    expect(r2).toEqual({ ok: true, changed: false });
  });

  it("rejects toggling a calendar owned by another user (Not found.)", async () => {
    const foreignCredId = await seedCalendar(OTHER);
    await expect(
      call.setFlag(ctx, {
        credentialId: foreignCredId,
        externalCalendarId: "primary",
        checkForConflicts: false,
      }),
    ).rejects.toThrow(/Not found/);
  });

  it("requires authentication", async () => {
    const anonCtx = makeCtx(null);
    await expect(
      call.setFlag(anonCtx, {
        credentialId: "calendarCredentials|1",
        externalCalendarId: "primary",
        checkForConflicts: true,
      }),
    ).rejects.toThrow(/Not authenticated/);
  });

  it("is gated behind the DEFAULT-OFF booking flag", async () => {
    const noFlagCtx = makeCtx(ME); // no enableBooking
    const credId = await (calendarOauth._upsertGoogleCalCredential as any)._handler(
      noFlagCtx,
      { authUserId: ME, refreshToken: "1//r", label: "x" },
    );
    await (calendarOauth._upsertSelectedCalendars as any)._handler(noFlagCtx, {
      authUserId: ME,
      credentialId: credId,
      calendars: [
        { externalCalendarId: "primary", displayName: "P", primary: true },
      ],
    });
    await expect(
      call.setFlag(noFlagCtx, {
        credentialId: credId,
        externalCalendarId: "primary",
        checkForConflicts: false,
      }),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// markCredentialInvalid (refresh-failure path)
// ─────────────────────────────────────────────────────────────

describe("markCredentialInvalid", () => {
  it("flips invalid=true on a credential (credential refresh-failure)", async () => {
    const credId = await call.upsertCred(ctx, {
      authUserId: ME,
      refreshToken: "1//r",
      label: "x",
    });
    expect((await ctx.db.get(credId)).invalid).toBe(false);
    await call.markInvalid(ctx, { credentialId: credId });
    expect((await ctx.db.get(credId)).invalid).toBe(true);
  });

  it("is a no-op for a missing credential", async () => {
    await expect(
      call.markInvalid(ctx, { credentialId: "calendarCredentials|999" }),
    ).resolves.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// listConnectedCalendars (C5 — owner-scoped read for the settings UI)
// ─────────────────────────────────────────────────────────────

describe("listConnectedCalendars", () => {
  async function seedCalendar(owner: string, external = "primary") {
    const credId = await call.upsertCred(ctx, {
      authUserId: owner,
      refreshToken: "1//r",
      label: `${owner}@gmail.com`,
    });
    await call.upsertCals(ctx, {
      authUserId: owner,
      credentialId: credId,
      calendars: [
        { externalCalendarId: external, displayName: "Personal", primary: true },
      ],
    });
    return credId;
  }

  it("returns the caller's credentials with embedded calendars and NEVER leaks the secret envelope", async () => {
    await seedCalendar(ME);
    const result = await call.listConnected(ctx);
    expect(result).toHaveLength(1);
    const cred = result[0];
    expect(cred.provider).toBe("google");
    expect(cred.label).toBe(`${ME}@gmail.com`);
    expect(cred.invalid).toBe(false);
    // Secrets must NOT be projected.
    expect(cred).not.toHaveProperty("encSecretCiphertext");
    expect(cred).not.toHaveProperty("encSecretIv");
    // Children embedded, display-safe fields only.
    expect(cred.calendars).toHaveLength(1);
    const cal = cred.calendars[0];
    expect(cal.externalCalendarId).toBe("primary");
    expect(cal.displayName).toBe("Personal");
    expect(cal.checkForConflicts).toBe(true);
    expect(cal.isDestination).toBe(true);
    expect(cal).not.toHaveProperty("encSecretCiphertext");
  });

  it("is owner-scoped — does not return another user's connected calendars", async () => {
    await seedCalendar(ME);
    await seedCalendar(OTHER);
    const mine = await call.listConnected(ctx);
    expect(mine).toHaveLength(1);
    expect(mine[0].label).toBe(`${ME}@gmail.com`);
  });

  it("returns an empty array when the caller has connected nothing", async () => {
    const result = await call.listConnected(ctx);
    expect(result).toEqual([]);
  });

  it("requires authentication", async () => {
    const anonCtx = makeCtx(null);
    await expect(call.listConnected(anonCtx)).rejects.toThrow(
      /Not authenticated/,
    );
  });
});
