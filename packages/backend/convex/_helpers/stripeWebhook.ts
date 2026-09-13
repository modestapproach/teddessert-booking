// MONEY-FLOW-AUDIT C2 — real Stripe webhook signature verification +
// event dispatch decision, factored out of `payments.ts` so it can be
// unit-tested without a Convex harness.
//
// Convex `httpAction` runs in the V8 isolate, which has Web Crypto
// (`crypto.subtle`) but not the Node-only `crypto.createHmac` API the
// Stripe SDK's synchronous `webhooks.constructEvent` reaches for. The
// SDK's async variant (`constructEventAsync` + `createSubtleCryptoProvider`)
// would also work, but pulling the full Stripe SDK into the httpAction's
// bundle is heavier than re-implementing the ~30 lines of signature
// verification here. The verification format is fully documented at
// https://docs.stripe.com/webhooks/signature .
//
// Header format:
//   Stripe-Signature: t=<unix-ts>,v1=<hex-sig>[,v1=<hex-sig>...][,v0=<...>]
// Signed payload:
//   `${t}.${rawBody}`
// Algorithm:
//   HMAC-SHA256 keyed by the webhook secret, hex-encoded.
// Verification:
//   1. Reject if header is malformed or missing.
//   2. Reject if any `t` exceeds the tolerance window (default 300s)
//      — protects against replay of an old captured payload.
//   3. Recompute the HMAC, compare against every `v1` value with a
//      constant-time comparison.
//
// The dispatch decision function (`decideStripeDispatch`) is a pure
// switch over `event.type` that returns the internal Convex mutation +
// args the httpAction should run. Keeping it separate from the
// httpAction makes the dispatch table testable in isolation; the
// httpAction just wires the decision to `ctx.runMutation`.

export type StripeSignatureVerifyResult =
  | { ok: true; timestamp: number }
  | { ok: false; error: string };

const DEFAULT_TOLERANCE_SEC = 300;

/**
 * Verify a Stripe webhook signature header against the raw request body.
 *
 * `nowMs` is injected so tests can pin time; production callers omit it
 * and the function uses `Date.now()`. `toleranceSec` defaults to 5 min
 * matching Stripe's own SDK default.
 */
export async function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  opts?: { toleranceSec?: number; nowMs?: number },
): Promise<StripeSignatureVerifyResult> {
  if (!header) return { ok: false, error: "missing Stripe-Signature header" };
  if (!secret) return { ok: false, error: "missing webhook secret" };

  const parsed = parseStripeSignatureHeader(header);
  if (parsed.t === null || parsed.v1.length === 0) {
    return { ok: false, error: "malformed Stripe-Signature header" };
  }

  const toleranceSec = opts?.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const nowSec = Math.floor((opts?.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSec - parsed.t) > toleranceSec) {
    return { ok: false, error: "timestamp outside tolerance window" };
  }

  const expected = await hmacSha256Hex(secret, `${parsed.t}.${rawBody}`);
  const matched = parsed.v1.some((sig) => constantTimeEqual(sig, expected));
  if (!matched) return { ok: false, error: "signature mismatch" };
  return { ok: true, timestamp: parsed.t };
}

type ParsedHeader = { t: number | null; v1: string[] };

export function parseStripeSignatureHeader(header: string): ParsedHeader {
  const out: ParsedHeader = { t: null, v1: [] };
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k || !v) continue;
    if (k === "t") {
      const n = parseInt(v, 10);
      if (Number.isFinite(n)) out.t = n;
    } else if (k === "v1") {
      out.v1.push(v);
    }
  }
  return out;
}

export async function hmacSha256Hex(
  secret: string,
  payload: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ─────────────────────────────────────────────────────────────
// Dispatch decision — pure switch over `event.type`.
//
// The shape mirrors the minimal slice of the Stripe event payload the
// downstream mutations actually need. We don't depend on the Stripe SDK
// types so unit tests don't pull in the full SDK; the runtime parse
// happens in the httpAction with `JSON.parse(rawBody)` and narrows to
// the relevant fields per event type.
// ─────────────────────────────────────────────────────────────

export type StripeEventEnvelope = {
  id: string;
  type: string;
  livemode: boolean;
  created?: number;
  data?: { object?: Record<string, unknown> };
};

export type DispatchPlan =
  | { kind: "checkout.session.completed"; sessionId: string; paymentIntentId: string; paidAtMs: number }
  | { kind: "payment_intent.payment_failed"; paymentIntentId: string; failureCode?: string; failureMessage?: string }
  | { kind: "ignored"; reason: string };

/**
 * Pure switch over the parsed Stripe event. Returns the mutation +
 * args the httpAction should run, or `ignored` for event types we
 * don't currently handle (Stripe sends many; we ACK 200 on ignored).
 */
export function decideStripeDispatch(event: StripeEventEnvelope): DispatchPlan {
  switch (event.type) {
    case "checkout.session.completed": {
      const obj = event.data?.object ?? {};
      const sessionId = typeof obj.id === "string" ? obj.id : "";
      const paymentIntentRaw = obj.payment_intent;
      const paymentIntentId =
        typeof paymentIntentRaw === "string"
          ? paymentIntentRaw
          : typeof paymentIntentRaw === "object" &&
              paymentIntentRaw !== null &&
              "id" in paymentIntentRaw &&
              typeof (paymentIntentRaw as { id?: unknown }).id === "string"
            ? (paymentIntentRaw as { id: string }).id
            : "";
      if (!sessionId || !paymentIntentId) {
        return { kind: "ignored", reason: "checkout.session.completed missing id/payment_intent" };
      }
      const createdSec = typeof event.created === "number" ? event.created : Math.floor(Date.now() / 1000);
      return {
        kind: "checkout.session.completed",
        sessionId,
        paymentIntentId,
        paidAtMs: createdSec * 1000,
      };
    }
    case "payment_intent.payment_failed": {
      const obj = event.data?.object ?? {};
      const paymentIntentId = typeof obj.id === "string" ? obj.id : "";
      if (!paymentIntentId) {
        return { kind: "ignored", reason: "payment_intent.payment_failed missing id" };
      }
      const lpe = obj.last_payment_error as
        | { code?: unknown; message?: unknown }
        | undefined;
      const failureCode = typeof lpe?.code === "string" ? lpe.code : undefined;
      const failureMessage = typeof lpe?.message === "string" ? lpe.message : undefined;
      return {
        kind: "payment_intent.payment_failed",
        paymentIntentId,
        failureCode,
        failureMessage,
      };
    }
    default:
      return { kind: "ignored", reason: `unhandled event type: ${event.type}` };
  }
}

/**
 * Is the current deployment configured to handle live Stripe events?
 * Mirrors the `liveStripeKeyGateTripped` helper in `payments.test.ts` —
 * single source of truth so the simulatePaymentSuccess kill-switch and
 * the webhook handler agree on what "live" means.
 */
export function isStripeLiveMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    !!env.STRIPE_SECRET_KEY?.startsWith("sk_live_") || !!env.STRIPE_LIVE_KEY
  );
}
