import { log } from "./log";

// AUDIT-iter32 M2 — shared sliding-window rate-limit helper.
//
// Generalizes the iter-16 itemImages.ts / iter-31 extensionVision.ts
// pattern into one call site so chat / wishes / bids / checkout don't
// each ship a near-identical copy of the index scan + window math.
//
// Storage model: ONE `apiCallLog` table (see schema.ts), discriminated by
// the caller-supplied `kind` string. A composite index
// `by_authUserId_kind` keeps the per-user-per-kind scan cost bounded
// regardless of how many other kinds the user has hit in the window.
//
// Concurrency safety: the helper reads the index slice for
// (authUserId, kind) and the caller writes back into the same slice via
// `logApiCall`. Convex OCC detects the read-write conflict between two
// concurrent mutations and retries the loser, so the count converges to
// the limit + small overshoot tolerance under contention rather than
// arbitrarily exceeding it. Mirrors itemImages.ts's reasoning at
// SECURITY-AUDIT-iter17 M6.
//
// Caller contract:
//   const gate = await checkRateLimit(ctx, {
//     authUserId: me,
//     kind: "chat.sendMessage",
//     windowMs: 60_000,
//     limit: 60,
//   });
//   if (!gate.ok) throw new ConvexError(
//     `Rate limit reached — try again in ${Math.ceil(gate.resetInMs / 1000)}s.`
//   );
//   // … do the work …
//   await logApiCall(ctx, me, "chat.sendMessage");
//
// We split check + log so the caller can decide whether to charge the
// quota slot on success-only or always. itemImages.ts charges on success
// only (insert AFTER patch) — same convention here.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

export type RateLimitGateOk = { ok: true; remaining: number };
export type RateLimitGateBlocked = {
  ok: false;
  resetInMs: number;
  resetMinutes: number;
};
export type RateLimitGate = RateLimitGateOk | RateLimitGateBlocked;

export async function checkRateLimit(
  ctx: Ctx,
  args: {
    authUserId: string;
    kind: string;
    windowMs: number;
    limit: number;
  },
): Promise<RateLimitGate> {
  const windowStart = Date.now() - args.windowMs;
  // .take(limit + 1) so we can detect "exactly at limit" vs "over" with
  // a bounded scan. Order desc → newest first → early-exit on first row
  // older than the window via the in-handler filter below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recent = await ctx.db
    .query("apiCallLog")
    .withIndex("by_authUserId_kind", (q: any) =>
      q.eq("authUserId", args.authUserId).eq("kind", args.kind),
    )
    .order("desc")
    .take(args.limit + 1);
  // Type the row shape locally to avoid a generic plumbing dance — the
  // only field we read is `_creationTime`, present on every Convex doc.
  const inWindow = (recent as Array<{ _creationTime: number }>).filter(
    (row) => row._creationTime >= windowStart,
  );
  if (inWindow.length >= args.limit) {
    const oldest = inWindow[inWindow.length - 1];
    const resetAt = oldest._creationTime + args.windowMs;
    const resetInMs = Math.max(0, resetAt - Date.now());
    const resetMinutes = Math.max(1, Math.ceil(resetInMs / 60_000));
    // LOG-QUALITY-AUDIT-iter77 M4 — emit one structured warn for every
    // refused call so operators can answer "are we under attack?" /
    // "is a buggy client retry-looping?" without joining apiCallLog
    // against the absence of follow-up writes. Closes iter-41 F15.
    // WARN (not INFO — exceeding is the unhappy path; not ERROR —
    // expected user behaviour with a fast recovery).
    log.warn("rateLimit.exceeded", {
      userId: args.authUserId,
      kind: args.kind,
      limit: args.limit,
      windowMs: args.windowMs,
      observed: inWindow.length,
      resetInMs,
    });
    return { ok: false, resetInMs, resetMinutes };
  }
  return { ok: true, remaining: args.limit - inWindow.length };
}

export async function logApiCall(
  ctx: Ctx,
  authUserId: string,
  kind: string,
): Promise<void> {
  await ctx.db.insert("apiCallLog", { authUserId, kind });
}

// ERROR-MSG-UX-AUDIT-iter76 I4 (iter-81) — single canonical user-facing
// rate-limit message. Was previously 4 distinct prefixes
// ("Too many X", "Sending too fast", "X rate limit reached", "You can …")
// and 2 time-unit conventions (`Xs` vs `N minute(s)`) and 2 plural
// patterns (`minute(s)` vs `minutes`) across 14 sites. Operators chasing
// the same throttle saw subtly different copy in screenshots.
//
// Canonical shape: `"Slow down — try again in {Xs|N minutes}."` plus an
// optional noun (`bids`, `messages`, …) to disambiguate when several
// kinds are in flight simultaneously.
//
// Time-unit policy: under 60s render seconds (gives the user a concrete
// "I can wait that out" feel); 60s+ render minutes (no fractional second
// false-precision for hour-long windows). Ceiling everywhere so the user
// is never told "0s" / "0 minutes".
//
// Plural policy: "1 minute" / "N minutes" — no `minute(s)` parens shorthand.
export function rateLimitMessage(args: {
  /** Optional noun describing what was throttled: "bids", "messages",
   *  "uploads", etc. Embedded as "… too many {noun} — …" when supplied;
   *  omitted prefix when undefined. */
  noun?: string;
  /** Milliseconds until one quota slot frees up. From RateLimitGateBlocked.resetInMs. */
  resetInMs: number;
}): string {
  const ms = Math.max(0, args.resetInMs);
  let unit: string;
  if (ms < 60_000) {
    const secs = Math.max(1, Math.ceil(ms / 1_000));
    unit = `${secs}s`;
  } else {
    const mins = Math.max(1, Math.ceil(ms / 60_000));
    unit = mins === 1 ? "1 minute" : `${mins} minutes`;
  }
  const prefix = args.noun ? `Too many ${args.noun} — try again` : "Slow down — try again";
  return `${prefix} in ${unit}.`;
}

// AUDIT-iter32 M2 — combined check + log for httpAction callers.
// httpActions cannot touch ctx.db directly; they must call into an
// internal mutation. Rather than have every consumer module ship its
// own checkAndLog wrapper, define one in the helper (called from a
// thin internal mutation in the caller — see extensionBids.checkAndLogRateLimitInternal).
// Returns the same RateLimitGate shape; on `ok: true` the call has been
// logged. On `ok: false` no log row is written (no quota slot burned on
// a rejected request).
export async function checkAndLogRateLimit(
  ctx: Ctx,
  args: {
    authUserId: string;
    kind: string;
    windowMs: number;
    limit: number;
  },
): Promise<RateLimitGate> {
  const gate = await checkRateLimit(ctx, args);
  if (gate.ok) await logApiCall(ctx, args.authUserId, args.kind);
  return gate;
}

// AUTH-SESSION-AUDIT-iter85 C3 — per-IP variant of `checkAndLogRateLimit`.
//
// The 4 `/extension/auth/*` HTTP routes (exchange/refresh/me/sign-out)
// are pre-auth — the caller has no `authUserId` yet — so the existing
// per-user gate doesn't apply. We reuse the same `apiCallLog` table but
// key on a hashed IP string prefixed with `"ip:"` to avoid colliding
// with real auth-user IDs. The helper itself is identical otherwise;
// this thin wrapper just (a) hashes the raw IP before storage so we
// don't pile raw IPs in the DB and (b) namespaces the key so a future
// audit can `grep "^ip:"` to find unauthenticated-rate-limit slots.
//
// The hash is non-cryptographic-strength-needed: it's a best-effort
// deterministic key, not a security-sensitive secret. We use the same
// SHA-256 the auth tokens use (already imported in extensionAuth.ts).
//
// Caller contract:
//   const ip = extractClientIp(req);
//   const gate = await checkAndLogRateLimitByIp(ctx, {
//     ipHash: await sha256Hex(ip),
//     kind: "auth.refresh",
//     windowMs: 60 * 60 * 1000,
//     limit: 60,
//   });
export async function checkAndLogRateLimitByIp(
  ctx: Ctx,
  args: {
    /** Hex-encoded SHA-256 of the source IP (X-Forwarded-For first hop). */
    ipHash: string;
    kind: string;
    windowMs: number;
    limit: number;
  },
): Promise<RateLimitGate> {
  return await checkAndLogRateLimit(ctx, {
    authUserId: `ip:${args.ipHash}`,
    kind: args.kind,
    windowMs: args.windowMs,
    limit: args.limit,
  });
}

// AUTH-SESSION-AUDIT-iter85 C3 — extract the client's source IP from an
// HTTP request. Convex sits behind one or more proxies, so the routable
// IP is the FIRST entry of `X-Forwarded-For` (or `X-Real-IP` as a
// fallback). When neither header is present we fall back to a fixed
// sentinel — the rate limit still applies per-sentinel, so an attacker
// that strips both headers all races against themselves, which is the
// conservative default.
//
// Returns the raw IP string; caller is responsible for hashing if
// they don't want the raw value persisted (we recommend it; see
// `checkAndLogRateLimitByIp`).
export function extractClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    // The first entry is the originating client; downstream proxies
    // append their own IPs. Trim whitespace because the comma-list is
    // conventionally "ip1, ip2, ip3".
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = req.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

