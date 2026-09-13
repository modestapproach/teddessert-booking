// BOOKING / E4 — anti-abuse hardening of the PUBLIC booking surface.
//
// THREE defenses, all additive + per-event-type opt-in:
//
//   1. Email verification (eventTypes.requireEmailVerification === true).
//      `POST /book/api/request-code` ({slug,email}) mints a 6-digit OTP, stores
//      ONLY its SHA-256 hash + a short expiry (10 min) in
//      `bookingVerificationCodes`, and dispatches the code via the email channel
//      (sendBrevoEmail). The booking POST then REQUIRES a matching, unexpired,
//      unconsumed code (bounded `attempts`; constant-time hashed compare;
//      consumed on success → single-use). Wrong / expired / too-many-attempts
//      all surface as the SAME RFC-9457 problem (no oracle leak: a caller can't
//      distinguish "wrong code" from "no code on file" from "locked out").
//
//   2. Single-use / personalized links (eventTypes.isSingleUse === true). The
//      booking page requires a `singleUseTokens` row; it is BURNED (usedAt +
//      usedByBookingId set) on the first confirmed booking, so a re-load /
//      re-book via the same link returns 410/gone.
//
//   3. Optional Cloudflare Turnstile (eventTypes.requireCaptcha === true AND
//      process.env.TURNSTILE_SECRET_KEY set). The booking POST verifies the
//      `turnstileToken` from the body server-side via siteverify. NO-OP when the
//      secret is unset — captcha is optional infrastructure.
//
// TESTABILITY: like the rest of the booking suite (publicApi.ts / booking.ts),
// the DB-touching logic is factored into plain async `*Impl` functions that take
// a thin `ctx` (db + scheduler) so they unit-test against the repo FakeDb. The
// Turnstile siteverify boundary is an injectable `fetch` (defaults to global
// fetch in prod) so the test mocks it. The email-dispatch boundary is the same
// injectable-fetch `sendBrevoEmail` already used by notify.ts.
//
// CODEGEN-PENDING REFS: `bookingVerificationCodes` / `singleUseTokens` are NEW
// tables; the string table names typecheck at runtime and a deploy regenerates
// the `_generated` types. (Same precedent as booking.ts / publicApi.ts.)
//
// [R] runtime-unverified: live OTP email delivery needs EMAIL_API_KEY + a
// deploy; live Turnstile verification needs TURNSTILE_SECRET_KEY + a real
// browser challenge. Both are verified here with convex-test (mocked fetch).

import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import { sha256Hex } from "../extensionAuth";
import { log } from "../_helpers/log";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

// ─── Tunables ────────────────────────────────────────────────────────────────

/** OTP lifetime. Short window keeps the brute-force surface tiny. */
export const VERIFY_CODE_TTL_MS = 10 * 60_000; // 10 minutes
/** Max wrong guesses before the code row is dead (lock-out). */
export const MAX_VERIFY_ATTEMPTS = 5;

// ─── 6-digit code generation (crypto-random, leading-zero safe) ───────────────

// Generate a uniformly-random 6-digit decimal string ("000000".."999999"). Uses
// crypto.getRandomValues for unpredictability (Math.random is NOT acceptable for
// a security token). Rejection-sampling avoids the modulo bias of `% 1_000_000`.
export function generateSixDigitCode(): string {
  const buf = new Uint32Array(1);
  // 4_294_000_000 is the largest multiple of 1_000_000 below 2^32; sampling
  // above it would bias the low buckets, so we resample.
  const LIMIT = 4_294_000_000;
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= LIMIT);
  return String(n % 1_000_000).padStart(6, "0");
}

// Normalize an email for the verification lookup key. Lower-cases + trims so a
// request for "Casey@Example.com " matches the booking's "casey@example.com".
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Constant-time hex-string compare. Both inputs are SHA-256 hex digests (fixed
// 64 chars), so length is not secret; we still fold every char to avoid an
// early-exit timing side channel that could leak a prefix match.
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ─── request-code core (mint + store hash + dispatch) ─────────────────────────

export interface RequestCodeArgs {
  slug: string;
  email: string;
  // Injected so the test can assert the dispatch + a deterministic code. In prod
  // the httpAction omits both: a fresh random code + the scheduled email action.
  nowMs?: number;
  codeOverride?: string;
}

// Mint a code for (event type, email): generate → hash → upsert a single pending
// row (replacing any prior pending row for the same key so a re-request resets
// the attempts counter + expiry). Returns the PLAINTEXT code so the caller can
// dispatch it (the httpAction schedules the email; tests assert it). The code is
// NEVER returned to the public client.
//
// Enumeration-safe by construction: the caller (httpAction) returns
// `{ sent: true }` unconditionally and never reveals whether the slug/email is
// real. A missing/inactive event type still returns a code here, but the
// httpAction's response is identical — so this function throwing for a bad slug
// would leak existence; instead we tolerate a missing event type by returning
// null (no row written, nothing to send) and the caller STILL says `sent:true`.
export async function requestVerificationCodeImpl(
  ctx: Ctx,
  args: RequestCodeArgs,
): Promise<{ code: string; eventTypeId: string; email: string } | null> {
  const now = args.nowMs ?? Date.now();
  const email = normalizeEmail(args.email);

  const eventType = await ctx.db
    .query("eventTypes")
    .withIndex("by_slug", (q: Ctx) => q.eq("slug", args.slug))
    .unique();
  // No oracle: silently no-op for a missing/inactive event type (caller still
  // returns sent:true). Only mint a code for a real, active, verification-
  // requiring event type.
  if (!eventType || eventType.active === false) return null;
  if (eventType.requireEmailVerification !== true) return null;

  const code = args.codeOverride ?? generateSixDigitCode();
  const codeHash = await sha256Hex(code);

  // Replace any prior pending row for this (email, eventType) so a re-request
  // resets attempts + expiry rather than letting stale rows pile up.
  const existing: Array<Record<string, any>> = await ctx.db
    .query("bookingVerificationCodes")
    .withIndex("by_email_eventType", (q: Ctx) =>
      q.eq("email", email).eq("eventTypeId", eventType._id),
    )
    .collect();
  for (const row of existing) await ctx.db.delete(row._id);

  await ctx.db.insert("bookingVerificationCodes", {
    email,
    eventTypeId: eventType._id,
    codeHash,
    expiresAt: now + VERIFY_CODE_TTL_MS,
    attempts: 0,
    createdAt: now,
  });

  return { code, eventTypeId: String(eventType._id), email };
}

// ─── verify gate (consume on success) ─────────────────────────────────────────

// Assert the booker's email has a matching, unexpired, unconsumed verification
// code for this event type. On success the row is DELETED (single-use) and the
// caller stamps the attendee's `emailVerifiedAt`. On any failure throws a single
// ConvexError kind — `email_verification_required` — so the public surface can't
// be used as an oracle (wrong code, expired, locked-out, and no-code-on-file are
// indistinguishable to the caller).
//
// A wrong guess increments `attempts`; at MAX_VERIFY_ATTEMPTS the row is dead
// (deleted) so a brute-force attacker gets at most N tries per minted code.
export async function assertEmailVerified(
  ctx: Ctx,
  args: {
    eventTypeId: string;
    email: string;
    code: string;
    nowMs?: number;
  },
): Promise<void> {
  const now = args.nowMs ?? Date.now();
  const email = normalizeEmail(args.email);
  const fail = () => {
    throw new ConvexError({
      kind: "email_verification_required",
      message: "A valid email verification code is required to book.",
    });
  };

  const candidate = (args.code ?? "").trim();
  if (!candidate) fail();

  const rows: Array<Record<string, any>> = await ctx.db
    .query("bookingVerificationCodes")
    .withIndex("by_email_eventType", (q: Ctx) =>
      q.eq("email", email).eq("eventTypeId", args.eventTypeId),
    )
    .collect();
  // Most-recent first (a re-request replaced prior rows, but be defensive).
  rows.sort((a, b) => (b.createdAt as number) - (a.createdAt as number));
  const row = rows[0];
  if (!row) fail();

  // Expired → consume + fail (don't let a stale row linger as an oracle).
  if ((row.expiresAt as number) <= now) {
    await ctx.db.delete(row._id);
    fail();
  }

  // Locked out → consume + fail.
  if ((row.attempts as number) >= MAX_VERIFY_ATTEMPTS) {
    await ctx.db.delete(row._id);
    fail();
  }

  const candidateHash = await sha256Hex(candidate);
  if (!constantTimeEqual(candidateHash, row.codeHash as string)) {
    // Wrong guess: increment attempts; delete (lock out) on the final miss.
    const next = (row.attempts as number) + 1;
    if (next >= MAX_VERIFY_ATTEMPTS) {
      await ctx.db.delete(row._id);
    } else {
      await ctx.db.patch(row._id, { attempts: next });
    }
    fail();
  }

  // Success → consume the code (single-use).
  await ctx.db.delete(row._id);
}

// ─── single-use link gate (validate + burn) ───────────────────────────────────

// Resolve + validate a single-use token for an event type. Throws
// `single_use_consumed` (→ 410 gone) when the token is already burned or
// expired, and `single_use_required` (→ 403) when the event type requires a
// token but none/an unknown one was supplied. Returns the live token row (caller
// burns it after the booking row is inserted). When the event type is NOT
// single-use this is a no-op (returns null).
export async function resolveSingleUseToken(
  ctx: Ctx,
  args: {
    eventType: Record<string, any>;
    token: string | undefined;
    nowMs?: number;
  },
): Promise<Record<string, any> | null> {
  if (args.eventType.isSingleUse !== true) return null;
  const now = args.nowMs ?? Date.now();
  const token = (args.token ?? "").trim();
  if (!token) {
    throw new ConvexError({
      kind: "single_use_required",
      message: "This booking link requires a valid single-use token.",
    });
  }
  const row = await ctx.db
    .query("singleUseTokens")
    .withIndex("by_token", (q: Ctx) => q.eq("token", token))
    .unique();
  if (!row || row.eventTypeId !== args.eventType._id) {
    throw new ConvexError({
      kind: "single_use_required",
      message: "This booking link requires a valid single-use token.",
    });
  }
  if (row.usedAt !== undefined && row.usedAt !== null) {
    throw new ConvexError({
      kind: "single_use_consumed",
      message: "This booking link has already been used.",
    });
  }
  if (
    row.expiresAt !== undefined &&
    row.expiresAt !== null &&
    (row.expiresAt as number) <= now
  ) {
    throw new ConvexError({
      kind: "single_use_consumed",
      message: "This booking link has expired.",
    });
  }
  return row;
}

// Burn a single-use token: stamp usedAt + the booking it produced. Idempotent —
// re-burning a row is harmless (the resolve gate already rejected a used token).
export async function burnSingleUseToken(
  ctx: Ctx,
  tokenRowId: string,
  bookingId: string,
  nowMs?: number,
): Promise<void> {
  await ctx.db.patch(tokenRowId, {
    usedAt: nowMs ?? Date.now(),
    usedByBookingId: bookingId,
  });
}

// Read-time check for the slots/event-type GET path: a single-use link whose
// token is already burned/expired/unknown must read as 410 gone so the page
// can't keep showing slots after the one booking. Returns true when the GET
// should be refused (410). When the event type is not single-use, always false.
export async function singleUseLinkIsGone(
  ctx: Ctx,
  args: {
    eventType: Record<string, any>;
    token: string | undefined;
    nowMs?: number;
  },
): Promise<boolean> {
  if (args.eventType.isSingleUse !== true) return false;
  try {
    await resolveSingleUseToken(ctx, args);
    return false;
  } catch (e) {
    if (e instanceof ConvexError) {
      const kind = (e.data as { kind?: string })?.kind;
      // Only "already used / expired" is a 410; a missing token is the 403
      // "required" case which the caller maps separately. For the GET surface
      // we treat both as gone (the page is unusable either way).
      return kind === "single_use_consumed" || kind === "single_use_required";
    }
    throw e;
  }
}

// ─── Turnstile siteverify (injectable fetch; gated on TURNSTILE_SECRET_KEY) ────

// Verify a Cloudflare Turnstile token server-side. NO-OP (returns true) when
// TURNSTILE_SECRET_KEY is unset — captcha is optional infrastructure. A
// `success: false` response or a network error is a failed challenge (false).
export async function verifyTurnstileToken(
  token: string,
  remoteIp: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // ← no-op when unset
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);
  try {
    const res = await fetchImpl(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      },
    );
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    log.warn("booking.turnstile.error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// internalAction wrapper so the httpAction (no fetch in a mutation) can run the
// siteverify round-trip. Resolves to a boolean — the caller maps false → 403.
export const _verifyTurnstile = internalAction({
  args: { token: v.string(), remoteIp: v.optional(v.string()) },
  handler: async (_ctx, { token, remoteIp }): Promise<boolean> =>
    verifyTurnstileToken(token, remoteIp),
});

// ─── expired-code sweep (cron impl) ────────────────────────────────────────────

const SWEEP_BATCH = 200;

// Range-scan `bookingVerificationCodes.by_expiresAt` for expired rows + delete.
// Bounded per tick. Mirrors `sweepExpiredHolds`. Not flag-gated — sweeping dead
// rows is always safe (a dark booking flag means the table is empty).
export async function sweepExpiredVerificationCodesHandler(
  ctx: Ctx,
  args: { nowMs?: number },
): Promise<{ deleted: number }> {
  const now = args.nowMs ?? Date.now();
  const expired: Array<Record<string, any>> = await ctx.db
    .query("bookingVerificationCodes")
    .withIndex("by_expiresAt", (q: Ctx) => q.lte("expiresAt", now))
    .take(SWEEP_BATCH);
  for (const row of expired) await ctx.db.delete(row._id);
  return { deleted: expired.length };
}

export const sweepExpiredVerificationCodes = internalMutation({
  args: { nowMs: v.optional(v.number()) },
  handler: sweepExpiredVerificationCodesHandler,
});
