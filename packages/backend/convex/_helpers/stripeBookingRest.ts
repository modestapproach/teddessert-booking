// BOOKING-PAYMENTS — minimal Stripe REST client (fetch-based, no SDK).
//
// The repo deliberately never bundles the `stripe` SDK into Convex code (the
// V8 isolate lacks the Node crypto the SDK reaches for — see
// _helpers/stripeWebhook.ts). We mirror that choice: the booking payment flow
// talks to Stripe's REST API directly over `fetch`, which the Convex action
// runtime provides. Only the 4 calls the flow needs are implemented:
//
//   - createCheckoutSession  — start a hosted Checkout (paid booking)
//   - capturePaymentIntent   — capture a manual-capture auth (drop winner)
//   - cancelPaymentIntent    — void an uncaptured auth (drop loser / expiry)
//   - refundPaymentIntent    — refund a captured charge (standard race loser)
//
// `fetchImpl` is injectable so unit tests run with a fake fetch (no network,
// no key). All money amounts are integer minor units (cents).
//
// Auth: Bearer <secret key>. Idempotency: the optional `idempotencyKey` is sent
// as the `Idempotency-Key` header so a retried call (action re-run, Stripe-side
// timeout) never double-creates a session/refund.

const STRIPE_API_BASE = "https://api.stripe.com";

export interface StripeRestConfig {
  secretKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export class StripeRestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly stripeType?: string;
  constructor(args: {
    status: number;
    message: string;
    code?: string;
    stripeType?: string;
  }) {
    super(args.message);
    this.name = "StripeRestError";
    this.status = args.status;
    this.code = args.code;
    this.stripeType = args.stripeType;
  }
}

// Flatten a nested object into Stripe's bracketed form-encoding keys, e.g.
// { line_items: [{ quantity: 1 }] } → "line_items[0][quantity]=1".
function flattenForm(
  value: unknown,
  prefix: string,
  out: Array<[string, string]>,
): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => flattenForm(item, `${prefix}[${i}]`, out));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flattenForm(v, prefix ? `${prefix}[${k}]` : k, out);
    }
    return;
  }
  out.push([prefix, String(value)]);
}

function encodeForm(params: Record<string, unknown>): string {
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(params)) flattenForm(v, k, pairs);
  return pairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

async function stripePost(
  config: StripeRestConfig,
  path: string,
  params: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<Record<string, any>> {
  const f = config.fetchImpl ?? fetch;
  const base = config.baseUrl ?? STRIPE_API_BASE;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.secretKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const res = await f(`${base}${path}`, {
    method: "POST",
    headers,
    body: encodeForm(params),
  });

  const text = await res.text();
  let parsed: Record<string, any> = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }

  if (!res.ok) {
    const err = (parsed?.error ?? {}) as {
      message?: string;
      code?: string;
      type?: string;
    };
    throw new StripeRestError({
      status: res.status,
      message: err.message ?? `Stripe request failed (${res.status})`,
      code: err.code,
      stripeType: err.type,
    });
  }
  return parsed;
}

export interface CreateCheckoutSessionParams {
  amountCents: number;
  currency: string;
  productName: string;
  successUrl: string;
  cancelUrl: string;
  /** Our bookingPayments id, echoed back on the session + payment_intent. */
  clientReferenceId?: string;
  customerEmail?: string;
  metadata?: Record<string, string>;
  /** "manual" for competitive drops (authorize now, capture the winner). */
  captureMethod?: "automatic" | "manual";
  /** Unix seconds; Stripe expires the session (min 30 min, max 24 h out). */
  expiresAt?: number;
  idempotencyKey?: string;
}

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  paymentIntentId: string | null;
  status: string | null;
}

export async function createCheckoutSession(
  config: StripeRestConfig,
  p: CreateCheckoutSessionParams,
): Promise<StripeCheckoutSession> {
  const params: Record<string, unknown> = {
    mode: "payment",
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: p.currency,
          unit_amount: p.amountCents,
          product_data: { name: p.productName },
        },
      },
    ],
  };
  if (p.clientReferenceId) params.client_reference_id = p.clientReferenceId;
  if (p.customerEmail) params.customer_email = p.customerEmail;
  if (p.metadata) params.metadata = p.metadata;
  if (p.expiresAt) params.expires_at = p.expiresAt;
  if (p.captureMethod === "manual") {
    params.payment_intent_data = { capture_method: "manual" };
  }

  const obj = await stripePost(
    config,
    "/v1/checkout/sessions",
    params,
    p.idempotencyKey,
  );
  const pi = obj.payment_intent;
  return {
    id: typeof obj.id === "string" ? obj.id : "",
    url: typeof obj.url === "string" ? obj.url : null,
    paymentIntentId:
      typeof pi === "string"
        ? pi
        : pi && typeof pi === "object" && typeof pi.id === "string"
          ? pi.id
          : null,
    status: typeof obj.status === "string" ? obj.status : null,
  };
}

export async function capturePaymentIntent(
  config: StripeRestConfig,
  paymentIntentId: string,
  idempotencyKey?: string,
): Promise<{ id: string; status: string }> {
  const obj = await stripePost(
    config,
    `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/capture`,
    {},
    idempotencyKey,
  );
  return { id: String(obj.id ?? paymentIntentId), status: String(obj.status ?? "") };
}

export async function cancelPaymentIntent(
  config: StripeRestConfig,
  paymentIntentId: string,
  idempotencyKey?: string,
): Promise<{ id: string; status: string }> {
  const obj = await stripePost(
    config,
    `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/cancel`,
    {},
    idempotencyKey,
  );
  return { id: String(obj.id ?? paymentIntentId), status: String(obj.status ?? "") };
}

export async function refundPaymentIntent(
  config: StripeRestConfig,
  paymentIntentId: string,
  idempotencyKey?: string,
): Promise<{ id: string; status: string }> {
  const obj = await stripePost(
    config,
    "/v1/refunds",
    { payment_intent: paymentIntentId },
    idempotencyKey,
  );
  return { id: String(obj.id ?? ""), status: String(obj.status ?? "") };
}

// Resolve the configured booking Stripe secret key (test or live). Returns null
// when unset so callers can 503/skip rather than crash.
export function getStripeSecretKey(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return env.STRIPE_SECRET_KEY || null;
}
