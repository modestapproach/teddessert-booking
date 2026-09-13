// BOOKING / E4 — tests for anti-abuse hardening of the public booking surface
// (`scheduling/antiAbuse.ts` + the `createBookingHandler` gates in
// `scheduling/booking.ts`).
//
// HARNESS: the repo FakeDb + bare-handler convention (lifted from
// scheduling/booking.test.ts). The REAL handlers run against an in-memory ctx;
// the Turnstile siteverify boundary is a mocked injectable `fetch`. The OTP
// code is injected via `codeOverride` so the hashed-storage + correct/wrong/
// expired assertions are deterministic.
//
// LOAD-BEARING ASSERTIONS (the E4 task):
//   (a) requireEmailVerification ON → booking WITHOUT a valid code is REJECTED
//       (email_verification_required); WITH the right code → SUCCEEDS; a WRONG
//       code is bounded (attempts) + rejected; an EXPIRED code is rejected.
//   (b) the code is stored HASHED, never plaintext.
//   (c) a single-use link BURNS after one booking (the 2nd booking → gone).
//   (d) Turnstile verify is CALLED when key+toggle are set, and is a NO-OP
//       (returns true, no fetch) when TURNSTILE_SECRET_KEY is unset.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ConvexError } from "convex/values";
import { createBookingHandler } from "./booking";
import {
  requestVerificationCodeImpl,
  assertEmailVerified,
  resolveSingleUseToken,
  burnSingleUseToken,
  singleUseLinkIsGone,
  verifyTurnstileToken,
  generateSixDigitCode,
  constantTimeEqual,
  MAX_VERIFY_ATTEMPTS,
  VERIFY_CODE_TTL_MS,
} from "./antiAbuse";
import { sha256Hex } from "../extensionAuth";

// ─────────────────────────────────────────────────────────────
// FakeDb (eq + range chaining) + FakeScheduler  (lifted from booking.test.ts)
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
      gte(field: string, value: any) {
        preds.push((r) => r[field] >= value);
        return q;
      },
      lte(field: string, value: any) {
        preds.push((r) => r[field] <= value);
        return q;
      },
      gt(field: string, value: any) {
        preds.push((r) => r[field] > value);
        return q;
      },
      lt(field: string, value: any) {
        preds.push((r) => r[field] < value);
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
  async take(n: number): Promise<Doc[]> {
    return this.rows.slice(0, n);
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

class FakeScheduler {
  calls: Array<{ delayMs: number; args: any }> = [];
  async runAfter(delayMs: number, _ref: any, args: any) {
    this.calls.push({ delayMs, args });
  }
}

function makeCtx() {
  return { db: new FakeDb(), scheduler: new FakeScheduler() } as any;
}

// ─────────────────────────────────────────────────────────────
// Seed helpers — UTC schedule, weekday 9–17, one collective host.
// ─────────────────────────────────────────────────────────────

const HOST = "host_a";
const OWNER = "owner_x";
const TZ = "UTC";
const SLUG = "intro";

// 2026-06-01 is a Monday. 10:00–10:30Z is inside 9–17 working hours.
const SLOT_START = Date.UTC(2026, 5, 1, 10, 0, 0);
const SLOT_END = Date.UTC(2026, 5, 1, 10, 30, 0);
const NOW = Date.UTC(2026, 5, 1, 9, 0, 0);

const ATTENDEE = {
  name: "Casey Candidate",
  email: "casey@example.com",
  timeZone: TZ,
  notes: "looking forward",
};

async function enableBooking(ctx: any) {
  await ctx.db.insert("featureFlags", {
    key: "booking_enabled",
    value: true,
    updatedAt: Date.now(),
    updatedBy: "test",
  });
}

// Seed a collective event type with optional anti-abuse toggles.
async function seedEventType(
  ctx: any,
  opts: {
    requireEmailVerification?: boolean;
    isSingleUse?: boolean;
    slug?: string;
  } = {},
): Promise<string> {
  const scheduleId = await ctx.db.insert("schedules", {
    ownerAuthUserId: HOST,
    name: "Working hours",
    timeZone: TZ,
    isDefault: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await ctx.db.insert("availability", {
    scheduleId,
    days: [1, 2, 3, 4, 5],
    startMinute: 540, // 09:00
    endMinute: 1020, // 17:00
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const eventTypeId = await ctx.db.insert("eventTypes", {
    ownerAuthUserId: OWNER,
    slug: opts.slug ?? SLUG,
    title: "Intro",
    durationMinutes: 30,
    schedulingType: "collective",
    minimumBookingNoticeMinutes: 0,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    requireEmailVerification: opts.requireEmailVerification ?? false,
    isSingleUse: opts.isSingleUse,
    hidden: false,
    active: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await ctx.db.insert("eventTypeHosts", {
    eventTypeId,
    ownerAuthUserId: OWNER,
    hostAuthUserId: HOST,
    isFixed: true,
    createdAt: Date.now(),
  });
  return eventTypeId;
}

let ctx: any;
const SAVED = { ...process.env };
beforeEach(async () => {
  ctx = makeCtx();
  await enableBooking(ctx);
});
afterEach(() => {
  process.env = { ...SAVED };
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────
// (a) EMAIL VERIFICATION GATE
// ─────────────────────────────────────────────────────────────

describe("E4 email verification — booking gate", () => {
  it("requireEmailVerification ON → booking WITHOUT a code is REJECTED (email_verification_required)", async () => {
    await seedEventType(ctx, { requireEmailVerification: true });

    let kind = "";
    try {
      await createBookingHandler(ctx, {
        slug: SLUG,
        startTime: SLOT_START,
        endTime: SLOT_END,
        bookerTimeZone: TZ,
        holderToken: "tok",
        idempotencyKey: "key-no-code",
        attendee: ATTENDEE,
        nowMs: NOW,
        // no verificationCode supplied
      });
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("email_verification_required");

    // No booking row was written.
    const bookings = await ctx.db.query("bookings").collect();
    expect(bookings).toHaveLength(0);
  });

  it("requireEmailVerification ON → booking WITH the RIGHT code SUCCEEDS + stamps emailVerifiedAt + consumes the code", async () => {
    await seedEventType(ctx, { requireEmailVerification: true });

    // Mint a deterministic code for the booker.
    const minted = await requestVerificationCodeImpl(ctx, {
      slug: SLUG,
      email: ATTENDEE.email,
      nowMs: NOW,
      codeOverride: "123456",
    });
    expect(minted).not.toBeNull();
    expect(minted!.code).toBe("123456");

    const res = await createBookingHandler(ctx, {
      slug: SLUG,
      startTime: SLOT_START,
      endTime: SLOT_END,
      bookerTimeZone: TZ,
      holderToken: "tok",
      idempotencyKey: "key-ok",
      attendee: ATTENDEE,
      verificationCode: "123456",
      nowMs: NOW,
    });
    expect(res.status).toBe("accepted");

    // The booker attendee row is stamped emailVerifiedAt.
    const attendees = await ctx.db.query("bookingAttendees").collect();
    const booker = attendees.find((a: any) => a.role === "booker");
    expect(booker.emailVerifiedAt).toBe(NOW);

    // The code row was CONSUMED (single-use) on success.
    const codes = await ctx.db.query("bookingVerificationCodes").collect();
    expect(codes).toHaveLength(0);
  });

  it("WRONG code is bounded (attempts) + rejected; on the final miss the row is locked out (deleted)", async () => {
    const eventTypeId = await seedEventType(ctx, {
      requireEmailVerification: true,
    });
    await requestVerificationCodeImpl(ctx, {
      slug: SLUG,
      email: ATTENDEE.email,
      nowMs: NOW,
      codeOverride: "111111",
    });

    // Guess wrong MAX_VERIFY_ATTEMPTS - 1 times: each is rejected, attempts climb,
    // the row survives.
    for (let i = 1; i < MAX_VERIFY_ATTEMPTS; i += 1) {
      let kind = "";
      try {
        await assertEmailVerified(ctx, {
          eventTypeId,
          email: ATTENDEE.email,
          code: "999999",
          nowMs: NOW,
        });
      } catch (e) {
        if (e instanceof ConvexError) kind = (e.data as any)?.kind;
      }
      expect(kind).toBe("email_verification_required");
      const rows = await ctx.db.query("bookingVerificationCodes").collect();
      expect(rows).toHaveLength(1);
      expect(rows[0].attempts).toBe(i);
    }

    // The FINAL wrong guess locks out: still rejected, and the row is gone.
    let finalKind = "";
    try {
      await assertEmailVerified(ctx, {
        eventTypeId,
        email: ATTENDEE.email,
        code: "999999",
        nowMs: NOW,
      });
    } catch (e) {
      if (e instanceof ConvexError) finalKind = (e.data as any)?.kind;
    }
    expect(finalKind).toBe("email_verification_required");
    const after = await ctx.db.query("bookingVerificationCodes").collect();
    expect(after).toHaveLength(0);

    // Even the CORRECT code now fails (row is burned) — no oracle, no bypass.
    let postKind = "";
    try {
      await assertEmailVerified(ctx, {
        eventTypeId,
        email: ATTENDEE.email,
        code: "111111",
        nowMs: NOW,
      });
    } catch (e) {
      if (e instanceof ConvexError) postKind = (e.data as any)?.kind;
    }
    expect(postKind).toBe("email_verification_required");
  });

  it("EXPIRED code is rejected (even when otherwise correct)", async () => {
    const eventTypeId = await seedEventType(ctx, {
      requireEmailVerification: true,
    });
    await requestVerificationCodeImpl(ctx, {
      slug: SLUG,
      email: ATTENDEE.email,
      nowMs: NOW,
      codeOverride: "222333",
    });

    // Validate AFTER the TTL has elapsed → rejected + consumed.
    const later = NOW + VERIFY_CODE_TTL_MS + 1;
    let kind = "";
    try {
      await assertEmailVerified(ctx, {
        eventTypeId,
        email: ATTENDEE.email,
        code: "222333",
        nowMs: later,
      });
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("email_verification_required");
    const rows = await ctx.db.query("bookingVerificationCodes").collect();
    expect(rows).toHaveLength(0);
  });

  it("a re-request RESETS attempts + replaces the prior pending row (no pile-up)", async () => {
    const eventTypeId = await seedEventType(ctx, {
      requireEmailVerification: true,
    });
    await requestVerificationCodeImpl(ctx, {
      slug: SLUG,
      email: ATTENDEE.email,
      nowMs: NOW,
      codeOverride: "100000",
    });
    // Burn an attempt with a wrong guess.
    await assertEmailVerified(ctx, {
      eventTypeId,
      email: ATTENDEE.email,
      code: "000000",
      nowMs: NOW,
    }).catch(() => {});
    // Re-request → exactly ONE row, attempts back to 0, new code valid.
    await requestVerificationCodeImpl(ctx, {
      slug: SLUG,
      email: ATTENDEE.email,
      nowMs: NOW,
      codeOverride: "200000",
    });
    const rows = await ctx.db.query("bookingVerificationCodes").collect();
    expect(rows).toHaveLength(1);
    expect(rows[0].attempts).toBe(0);
    // The new code verifies cleanly (consumes the row).
    await assertEmailVerified(ctx, {
      eventTypeId,
      email: ATTENDEE.email,
      code: "200000",
      nowMs: NOW,
    });
    expect(await ctx.db.query("bookingVerificationCodes").collect()).toHaveLength(
      0,
    );
  });
});

// ─────────────────────────────────────────────────────────────
// (b) CODE IS STORED HASHED, NOT PLAINTEXT
// ─────────────────────────────────────────────────────────────

describe("E4 email verification — code is stored HASHED, never plaintext", () => {
  it("the persisted row carries codeHash (SHA-256), and the plaintext code is absent", async () => {
    await seedEventType(ctx, { requireEmailVerification: true });
    const CODE = "654321";
    await requestVerificationCodeImpl(ctx, {
      slug: SLUG,
      email: ATTENDEE.email,
      nowMs: NOW,
      codeOverride: CODE,
    });

    const rows = await ctx.db.query("bookingVerificationCodes").collect();
    expect(rows).toHaveLength(1);
    const row = rows[0];

    // The stored value is the SHA-256 hex of the code — NOT the code.
    const expectedHash = await sha256Hex(CODE);
    expect(row.codeHash).toBe(expectedHash);
    expect(row.codeHash).not.toBe(CODE);
    // No plaintext `code` field exists on the row, and no field equals the code.
    expect(row.code).toBeUndefined();
    expect(Object.values(row)).not.toContain(CODE);
  });

  it("requestVerificationCodeImpl no-ops (writes no row) when the event type does NOT require verification", async () => {
    await seedEventType(ctx, { requireEmailVerification: false });
    const minted = await requestVerificationCodeImpl(ctx, {
      slug: SLUG,
      email: ATTENDEE.email,
      nowMs: NOW,
      codeOverride: "123123",
    });
    expect(minted).toBeNull();
    expect(await ctx.db.query("bookingVerificationCodes").collect()).toHaveLength(
      0,
    );
  });

  it("generateSixDigitCode yields a 6-char numeric string; constantTimeEqual is exact", () => {
    for (let i = 0; i < 50; i += 1) {
      const c = generateSixDigitCode();
      expect(c).toMatch(/^\d{6}$/);
    }
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "ab")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// (c) SINGLE-USE LINK BURNS AFTER ONE BOOKING
// ─────────────────────────────────────────────────────────────

describe("E4 single-use link — burns after one booking", () => {
  it("first booking via the token SUCCEEDS; the 2nd booking via the same token → GONE", async () => {
    const eventTypeId = await seedEventType(ctx, { isSingleUse: true });
    const TOKEN = "single-use-abc";
    await ctx.db.insert("singleUseTokens", {
      token: TOKEN,
      eventTypeId,
      createdByAuthUserId: OWNER,
      createdAt: NOW,
    });

    // First booking burns the token.
    const first = await createBookingHandler(ctx, {
      slug: SLUG,
      startTime: SLOT_START,
      endTime: SLOT_END,
      bookerTimeZone: TZ,
      holderToken: "tok",
      idempotencyKey: "key-1",
      attendee: ATTENDEE,
      singleUseToken: TOKEN,
      nowMs: NOW,
    });
    expect(first.status).toBe("accepted");

    // The token row is now burned (usedAt + usedByBookingId set).
    const tokenRow = (await ctx.db.query("singleUseTokens").collect())[0];
    expect(tokenRow.usedAt).toBe(NOW);
    expect(tokenRow.usedByBookingId).toBe(first.bookingId);

    // A second booking (a different, free slot) via the SAME token → gone.
    let kind = "";
    try {
      await createBookingHandler(ctx, {
        slug: SLUG,
        startTime: Date.UTC(2026, 5, 1, 11, 0, 0),
        endTime: Date.UTC(2026, 5, 1, 11, 30, 0),
        bookerTimeZone: TZ,
        holderToken: "tok2",
        idempotencyKey: "key-2",
        attendee: { ...ATTENDEE, email: "second@example.com" },
        singleUseToken: TOKEN,
        nowMs: NOW,
      });
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("single_use_consumed");

    // Still exactly ONE booking.
    expect(await ctx.db.query("bookings").collect()).toHaveLength(1);
  });

  it("a single-use event type with NO token supplied → single_use_required (403)", async () => {
    await seedEventType(ctx, { isSingleUse: true });
    let kind = "";
    try {
      await createBookingHandler(ctx, {
        slug: SLUG,
        startTime: SLOT_START,
        endTime: SLOT_END,
        bookerTimeZone: TZ,
        holderToken: "tok",
        idempotencyKey: "key-x",
        attendee: ATTENDEE,
        nowMs: NOW,
      });
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("single_use_required");
  });

  it("singleUseLinkIsGone: false for a live token, true once burned (the slot-read 410 gate)", async () => {
    const eventTypeId = await seedEventType(ctx, { isSingleUse: true });
    const TOKEN = "tok-live";
    const tokenId = await ctx.db.insert("singleUseTokens", {
      token: TOKEN,
      eventTypeId,
      createdByAuthUserId: OWNER,
      createdAt: NOW,
    });
    const et = await ctx.db.get(eventTypeId);

    // Live token resolves; not gone.
    const row = await resolveSingleUseToken(ctx, { eventType: et, token: TOKEN });
    expect(row).not.toBeNull();
    expect(await singleUseLinkIsGone(ctx, { eventType: et, token: TOKEN })).toBe(
      false,
    );

    // Burn it → the slot-read gate now reports gone.
    await burnSingleUseToken(ctx, tokenId, "bookings|999", NOW);
    expect(await singleUseLinkIsGone(ctx, { eventType: et, token: TOKEN })).toBe(
      true,
    );
  });

  it("a non-single-use event type ignores tokens entirely (resolve → null)", async () => {
    const eventTypeId = await seedEventType(ctx, { isSingleUse: false });
    const et = await ctx.db.get(eventTypeId);
    expect(
      await resolveSingleUseToken(ctx, { eventType: et, token: undefined }),
    ).toBeNull();
    expect(
      await singleUseLinkIsGone(ctx, { eventType: et, token: undefined }),
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// (d) OPTIONAL TURNSTILE
// ─────────────────────────────────────────────────────────────

describe("E4 Turnstile — verify called when key set; no-op when unset", () => {
  it("CALLS siteverify (returns the success flag) when TURNSTILE_SECRET_KEY is set", async () => {
    process.env.TURNSTILE_SECRET_KEY = "turnstile-test-secret";
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true }),
    })) as any;

    const ok = await verifyTurnstileToken("client-token", "1.2.3.4", fetchImpl);
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    );
    // The POST body carries the secret + the client response token + remoteip.
    expect(init.method).toBe("POST");
    expect(init.body).toContain("secret=turnstile-test-secret");
    expect(init.body).toContain("response=client-token");
    expect(init.body).toContain("remoteip=1.2.3.4");
  });

  it("returns FALSE (rejected) when siteverify reports success:false", async () => {
    process.env.TURNSTILE_SECRET_KEY = "turnstile-test-secret";
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: false, "error-codes": ["invalid-input-response"] }),
    })) as any;
    expect(await verifyTurnstileToken("bad", undefined, fetchImpl)).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns FALSE on a siteverify network error (fail-closed)", async () => {
    process.env.TURNSTILE_SECRET_KEY = "turnstile-test-secret";
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as any;
    expect(await verifyTurnstileToken("tok", undefined, fetchImpl)).toBe(false);
  });

  it("is a NO-OP (returns true, NO fetch) when TURNSTILE_SECRET_KEY is UNSET", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: false }),
    })) as any;
    // No secret → short-circuit true, the round-trip is never made.
    expect(await verifyTurnstileToken("anything", "9.9.9.9", fetchImpl)).toBe(
      true,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
