// BOOKING-PAYMENTS (M2–M4) — Stripe-paid bookings on Convex.
//
// Purpose-built Checkout flow (NOT cal.com's app-store Stripe, which is dead in
// the Convex rewire). Mirrors the dibslist instabuy seam but for the scheduling
// suite, and is fully ISOLATED from it: its own webhook route
// (`/stripe/booking/webhook`), its own signing secret
// (`STRIPE_BOOKING_WEBHOOK_SECRET`), and its own ledger table (`bookingPayments`).
// The instabuy `/stripe/webhook` + `deals`/`instabuyOrders` are untouched.
//
// FLOW (see docs/booking-payments-prd.md §5):
//   1. createBookingCheckout (internalAction, reached via the IP-rate-limited
//      `/book/api/checkout` httpAction): validate flags + event type + slot, write
//      a bookingPayments(pending) row carrying the FULL booking intent, then create
//      a Stripe Checkout Session and return its URL. The booking is NOT created here.
//   2. The booker pays on Stripe's hosted page.
//   3. Stripe → `/stripe/booking/webhook` (handleBookingStripeWebhook): verify the
//      signature, then on `checkout.session.completed` finalize: re-run the
//      authoritative slot conflict check by calling the SAME createBookingHandler
//      the free path uses (so payment never bypasses double-booking protection),
//      persist intake answers, and:
//        - standard (automatic capture): booking created → paid. Race loser
//          (slot already taken) → refund, never confirmed.
//        - drop (manual capture): winner → capture the auth. Loser → cancel
//          (void) the auth so they are NEVER charged.
//
// MONEY-SAFETY: the charge amount is always the SERVER's snapshot of
// eventTypes.priceCents (never client-supplied); the booking idempotencyKey is
// deterministic per (slug,start,email) so a double-pay dedupes to one booking
// (the duplicate is refunded/voided); finalize is idempotent on the
// bookingPayments status machine + Stripe redelivery; capture/cancel/refund all
// carry Idempotency-Key headers.

import { ConvexError, v } from "convex/values";
import {
  httpAction,
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { isFlagEnabled, requireFlagEnabled } from "../_helpers/featureFlag";
import { getOrMintRequestId, withRequestId } from "../_helpers/requestId";
import { log } from "../_helpers/log";
import {
  verifyStripeSignature,
  decideStripeDispatch,
  isStripeLiveMode,
  type StripeEventEnvelope,
} from "../_helpers/stripeWebhook";
import {
  createCheckoutSession,
  capturePaymentIntent,
  cancelPaymentIntent,
  refundPaymentIntent,
  getStripeSecretKey,
} from "../_helpers/stripeBookingRest";
import { createBookingHandler } from "./booking";
import { sendBrevoEmail } from "./notify";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

// ─── Flag gate ────────────────────────────────────────────────────────────────

const PAYMENTS_FLAG = {
  kind: "payments_disabled",
  message: "Paid booking is not available.",
  defaultValue: false as const,
};

export const _bookingPaymentsEnabled = internalQuery({
  args: {},
  handler: async (ctx) => isFlagEnabled(ctx, "booking_payments_enabled", false),
});

// Operator toggle (DEFAULT-OFF). CLI:
// `npx convex run scheduling/payments:_setBookingPaymentsEnabled '{"value":true}'`
export const _setBookingPaymentsEnabled = internalMutation({
  args: { value: v.boolean() },
  handler: async (ctx, { value }) => {
    const existing = await ctx.db
      .query("featureFlags")
      .withIndex("by_key", (q: Ctx) => q.eq("key", "booking_payments_enabled"))
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        value,
        updatedAt: now,
        updatedBy: "cli",
        reason: "booking payments toggle",
      });
    } else {
      await ctx.db.insert("featureFlags", {
        key: "booking_payments_enabled",
        value,
        updatedAt: now,
        updatedBy: "cli",
        reason: "booking payments toggle",
      });
    }
    return { key: "booking_payments_enabled", value };
  },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

export interface IntakeResponse {
  name: string;
  label: string;
  value: string;
}

// Deterministic booking idempotency key. Same (slug,start,email) → same key, so
// a double-payment dedupes to ONE booking (the duplicate is refunded/voided at
// finalize). Different bookers (drop racers) → different keys → the slot
// conflict re-check rejects all but the first.
export function bookingIdempotencyKey(
  slug: string,
  startMs: number,
  email: string,
): string {
  return `book:${slug}:${startMs}:${email.trim().toLowerCase()}`;
}

// Effective capture mode for an event type: explicit override, else manual for
// a competitive drop, else automatic.
export function effectiveCaptureMode(eventType: {
  captureMode?: string;
  dropMode?: string;
}): "automatic" | "manual" {
  if (eventType.captureMode === "manual" || eventType.captureMode === "automatic") {
    return eventType.captureMode;
  }
  return eventType.dropMode === "first_come_drop" ? "manual" : "automatic";
}

const intakeValidator = v.array(
  v.object({ name: v.string(), label: v.string(), value: v.string() }),
);

// ─── M2: prepare checkout (validate + write pending payment) ───────────────────

export interface PrepareCheckoutArgs {
  slug: string;
  start: number;
  end: number;
  name: string;
  email: string;
  notes?: string;
  timeZone: string;
  holderToken?: string;
  intakeResponses?: IntakeResponse[];
}

export async function prepareBookingCheckoutImpl(
  ctx: Ctx,
  args: PrepareCheckoutArgs,
) {
    // Both gates must be ON: we never take a payment for a booking we can't
    // fulfill (createBookingHandler also gates on booking_enabled at finalize).
    const payGate = await requireFlagEnabled(
      ctx,
      "booking_payments_enabled",
      PAYMENTS_FLAG,
    );
    if (!payGate.ok)
      throw new ConvexError({ kind: payGate.kind, message: payGate.message });
    const bookGate = await requireFlagEnabled(ctx, "booking_enabled", {
      kind: "booking_disabled",
      message: "Booking is not available.",
      defaultValue: false,
    });
    if (!bookGate.ok)
      throw new ConvexError({ kind: bookGate.kind, message: bookGate.message });

    const eventType = await ctx.db
      .query("eventTypes")
      .withIndex("by_slug", (q: Ctx) => q.eq("slug", args.slug))
      .unique();
    if (!eventType || eventType.active === false) {
      throw new ConvexError({ kind: "event_type_not_found", message: "Not found." });
    }
    if (eventType.paymentRequired !== true) {
      throw new ConvexError({
        kind: "not_a_paid_event",
        message: "This event type does not require payment.",
      });
    }
    const amountCents = eventType.priceCents;
    if (typeof amountCents !== "number" || amountCents <= 0) {
      throw new ConvexError({
        kind: "invalid_price",
        message: "This paid event type has no price configured.",
      });
    }
    const currency: string = eventType.currency ?? "usd";
    const captureMode = effectiveCaptureMode(eventType);
    const idempotencyKey = bookingIdempotencyKey(args.slug, args.start, args.email);

    // If a payment for this key already reached a terminal-success state, the
    // slot is taken by this booker — don't start a second charge.
    const prior = await ctx.db
      .query("bookingPayments")
      .withIndex("by_idempotencyKey", (q: Ctx) =>
        q.eq("idempotencyKey", idempotencyKey),
      )
      .collect();
    const alreadyPaid = prior.find(
      (p: any) => p.status === "paid" || p.status === "authorized",
    );
    if (alreadyPaid) {
      throw new ConvexError({
        kind: "already_in_progress",
        message: "You already have a payment in progress or completed for this slot.",
      });
    }

    const now = Date.now();
    const paymentId = await ctx.db.insert("bookingPayments", {
      eventTypeId: eventType._id,
      ownerAuthUserId: eventType.ownerAuthUserId,
      amountCents,
      currency,
      captureMode,
      status: "pending",
      bookingIntent: {
        slug: args.slug,
        start: args.start,
        end: args.end,
        name: args.name,
        email: args.email,
        notes: args.notes,
        timeZone: args.timeZone,
        holderToken: args.holderToken,
        intakeResponses: args.intakeResponses,
      },
      idempotencyKey,
      createdAt: now,
      updatedAt: now,
    });

    return {
      paymentId: paymentId as Id<"bookingPayments">,
      amountCents,
      currency,
      captureMode,
      productName: eventType.title as string,
      customerEmail: args.email,
    };
}

export const _prepareBookingCheckout = internalMutation({
  args: {
    slug: v.string(),
    start: v.number(),
    end: v.number(),
    name: v.string(),
    email: v.string(),
    notes: v.optional(v.string()),
    timeZone: v.string(),
    holderToken: v.optional(v.string()),
    intakeResponses: v.optional(intakeValidator),
  },
  handler: async (ctx, args) => prepareBookingCheckoutImpl(ctx, args),
});

export const _attachBookingCheckoutSession = internalMutation({
  args: {
    paymentId: v.id("bookingPayments"),
    stripeSessionId: v.string(),
    paymentIntentId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.paymentId);
    if (!row) return { ok: false as const };
    await ctx.db.patch(args.paymentId, {
      stripeSessionId: args.stripeSessionId,
      paymentIntentId: args.paymentIntentId ?? row.paymentIntentId,
      updatedAt: Date.now(),
    });
    return { ok: true as const };
  },
});

// ─── M2: the checkout action (validate → Stripe session → return URL) ──────────

// Reached server-to-server by the IP-rate-limited `/book/api/checkout` httpAction
// (publicApi.ts). internalAction (not public) so the Convex client can't bypass
// the rate-limit/flag gate.
export const createBookingCheckout = internalAction({
  args: {
    slug: v.string(),
    start: v.number(),
    end: v.number(),
    name: v.string(),
    email: v.string(),
    notes: v.optional(v.string()),
    timeZone: v.optional(v.string()),
    holderToken: v.optional(v.string()),
    intakeResponses: v.optional(intakeValidator),
    successUrl: v.string(),
    cancelUrl: v.string(),
  },
  handler: async (ctx, args): Promise<{ checkoutUrl: string; paymentId: string }> => {
    const secretKey = getStripeSecretKey();
    if (!secretKey) {
      throw new ConvexError({
        kind: "payments_unconfigured",
        message: "Stripe is not configured (STRIPE_SECRET_KEY unset).",
      });
    }
    // Defense-in-depth against open-redirect via Stripe success/cancel URLs:
    // both must be absolute https. (The caller is the trusted fork route, but a
    // bad URL here would otherwise be reflected through Stripe's hosted page.)
    for (const u of [args.successUrl, args.cancelUrl]) {
      let parsed: URL;
      try {
        parsed = new URL(u);
      } catch {
        throw new ConvexError({ kind: "invalid_request", message: "Invalid redirect URL." });
      }
      if (parsed.protocol !== "https:") {
        throw new ConvexError({ kind: "invalid_request", message: "Redirect URL must be https." });
      }
    }

    const prep = await ctx.runMutation(
      (internal as any).scheduling.payments._prepareBookingCheckout,
      {
        slug: args.slug,
        start: args.start,
        end: args.end,
        name: args.name,
        email: args.email,
        notes: args.notes,
        timeZone: args.timeZone ?? "UTC",
        holderToken: args.holderToken,
        intakeResponses: args.intakeResponses,
      },
    );

    const session = await createCheckoutSession(
      { secretKey },
      {
        amountCents: prep.amountCents,
        currency: prep.currency,
        productName: prep.productName,
        successUrl: args.successUrl,
        cancelUrl: args.cancelUrl,
        clientReferenceId: String(prep.paymentId),
        customerEmail: prep.customerEmail,
        metadata: { bookingPaymentId: String(prep.paymentId) },
        captureMethod: prep.captureMode,
        // Idempotency-Key on the session create: an action re-run won't mint a
        // second session for the same payment row.
        idempotencyKey: `checkout:${prep.paymentId}`,
      },
    );

    if (!session.url) {
      throw new ConvexError({
        kind: "stripe_error",
        message: "Stripe did not return a checkout URL.",
      });
    }

    await ctx.runMutation(
      (internal as any).scheduling.payments._attachBookingCheckoutSession,
      {
        paymentId: prep.paymentId,
        stripeSessionId: session.id,
        paymentIntentId: session.paymentIntentId ?? undefined,
      },
    );

    return { checkoutUrl: session.url, paymentId: String(prep.paymentId) };
  },
});

// ─── M3/M4: finalize (webhook → create booking, decide capture/void/refund) ────

export type FinalizeOutcome =
  | "not_ours" // session not in our ledger (e.g. instabuy) → ignore
  | "noop" // already finalized (idempotent redelivery)
  | "won_auto" // standard: booking created, auto-captured → done
  | "needs_capture" // drop: booking created, must capture the auth
  | "needs_void" // drop loser: void the auth (never charged)
  | "needs_refund"; // standard loser / unfulfillable: refund the charge

// Internal: run the authoritative booking create + decide the money action.
// Returns a plan; the webhook httpAction performs the Stripe network call.
export interface FinalizeArgs {
  stripeSessionId: string;
  paymentIntentId: string;
  paidAtMs: number;
}
export interface FinalizeResult {
  outcome: FinalizeOutcome;
  paymentId?: Id<"bookingPayments">;
  paymentIntentId?: string;
  bookingId?: Id<"bookings">;
  customerEmail?: string;
  eventTitle?: string;
  reason?: string;
}

export async function finalizeBookingPaymentImpl(
  ctx: Ctx,
  args: FinalizeArgs,
): Promise<FinalizeResult> {
    const payment = await ctx.db
      .query("bookingPayments")
      .withIndex("by_stripeSession", (q: Ctx) =>
        q.eq("stripeSessionId", args.stripeSessionId),
      )
      .unique();
    if (!payment) return { outcome: "not_ours" };

    // Always record the PI id (the session.completed event is the first place we
    // reliably learn it for some flows).
    if (!payment.paymentIntentId && args.paymentIntentId) {
      await ctx.db.patch(payment._id, {
        paymentIntentId: args.paymentIntentId,
        updatedAt: Date.now(),
      });
    }
    const paymentIntentId = payment.paymentIntentId || args.paymentIntentId;
    const manual = payment.captureMode === "manual";

    // Terminal states → idempotent no-op (Stripe redelivery after we finished).
    if (
      payment.status === "voided" ||
      payment.status === "refunded" ||
      payment.status === "expired" ||
      payment.status === "failed"
    ) {
      return { outcome: "noop" };
    }
    // Standard already-paid → done. Manual already-paid (captured) → done.
    if (payment.status === "paid") return { outcome: "noop" };

    const intent = payment.bookingIntent;
    let res: { bookingId: Id<"bookings">; status: string; deduplicated?: boolean };
    try {
      res = await createBookingHandler(ctx, {
        slug: intent.slug,
        startTime: intent.start,
        endTime: intent.end,
        bookerTimeZone: intent.timeZone,
        holderToken: intent.holderToken ?? "",
        idempotencyKey: payment.idempotencyKey,
        attendee: {
          name: intent.name,
          email: intent.email,
          timeZone: intent.timeZone,
          notes: intent.notes,
        },
        intakeResponses: intent.intakeResponses,
        nowMs: args.paidAtMs,
      });
    } catch (err) {
      // Booking could not be created (slot taken in a race, or any other
      // failure). The money MUST go back: void the auth (drop) or refund (auto).
      const kind =
        err instanceof ConvexError
          ? (err.data as { kind?: string })?.kind
          : undefined;
      await ctx.db.patch(payment._id, { updatedAt: Date.now() });
      return {
        outcome: manual ? "needs_void" : "needs_refund",
        paymentId: payment._id as Id<"bookingPayments">,
        paymentIntentId,
        customerEmail: intent.email,
        reason: kind ?? "booking_create_failed",
      };
    }

    if (res.deduplicated) {
      // The booking already existed under this idempotency key.
      if (
        payment.bookingId &&
        String(payment.bookingId) === String(res.bookingId)
      ) {
        // Redelivery of THIS payment. If manual + not yet captured, retry the
        // capture (idempotent); else nothing to do.
        if (manual && payment.status !== "paid") {
          return {
            outcome: "needs_capture",
            paymentId: payment._id as Id<"bookingPayments">,
            paymentIntentId,
            bookingId: res.bookingId,
          };
        }
        return { outcome: "noop" };
      }
      // A DIFFERENT payment created the booking (same booker paid twice) → this
      // one is a duplicate. Money back.
      return {
        outcome: manual ? "needs_void" : "needs_refund",
        paymentId: payment._id as Id<"bookingPayments">,
        paymentIntentId,
        customerEmail: intent.email,
        reason: "duplicate_payment",
      };
    }

    // We created the booking → winner. Link it; mark paid (auto) or leave
    // authorized until the webhook captures (manual).
    await ctx.db.patch(payment._id, {
      bookingId: res.bookingId,
      status: manual ? "authorized" : "paid",
      updatedAt: Date.now(),
    });
    return {
      outcome: manual ? "needs_capture" : "won_auto",
      paymentId: payment._id as Id<"bookingPayments">,
      paymentIntentId,
      bookingId: res.bookingId,
    };
}

export const _finalizeBookingPayment = internalMutation({
  args: {
    stripeSessionId: v.string(),
    paymentIntentId: v.string(),
    paidAtMs: v.number(),
  },
  handler: async (ctx, args) => finalizeBookingPaymentImpl(ctx, args),
});

// Patch a payment to a terminal status (after the Stripe network action lands).
export const _markBookingPaymentStatus = internalMutation({
  args: {
    paymentId: v.id("bookingPayments"),
    status: v.union(
      v.literal("paid"),
      v.literal("voided"),
      v.literal("refunded"),
      v.literal("expired"),
      v.literal("failed"),
    ),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.paymentId);
    if (!row) return { ok: false as const };
    await ctx.db.patch(args.paymentId, { status: args.status, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

// payment_intent.payment_failed → mark the matching pending/authorized row failed.
export const _markBookingPaymentFailedByIntent = internalMutation({
  args: { paymentIntentId: v.string() },
  handler: async (ctx, { paymentIntentId }) => {
    const row = await ctx.db
      .query("bookingPayments")
      .withIndex("by_paymentIntent", (q: Ctx) =>
        q.eq("paymentIntentId", paymentIntentId),
      )
      .unique();
    if (!row) return { ok: false as const, reason: "not_found" };
    if (row.status === "pending" || row.status === "authorized") {
      await ctx.db.patch(row._id, { status: "failed", updatedAt: Date.now() });
    }
    return { ok: true as const };
  },
});

// ─── M4: stale-auth sweep (cron) ───────────────────────────────────────────────

const STALE_PAYMENT_TTL_MS = 24 * 60 * 60 * 1000; // 24h: Stripe Checkout sessions expire ≤24h

// Find pending/authorized payments older than the TTL whose Checkout never
// completed (abandoned) or whose manual auth was never captured. Returns the PI
// ids the action should cancel; marks the rows expired.
export const _sweepStaleBookingPayments = internalMutation({
  args: { nowMs: v.optional(v.number()) },
  handler: async (ctx, { nowMs }) => {
    const now = nowMs ?? Date.now();
    const cutoff = now - STALE_PAYMENT_TTL_MS;
    const toCancel: Array<{ paymentId: Id<"bookingPayments">; paymentIntentId: string }> = [];
    for (const status of ["pending", "authorized"] as const) {
      const rows = await ctx.db
        .query("bookingPayments")
        .withIndex("by_status_createdAt", (q: Ctx) =>
          q.eq("status", status).lt("createdAt", cutoff),
        )
        .take(100);
      for (const row of rows) {
        await ctx.db.patch(row._id, { status: "expired", updatedAt: now });
        if (row.paymentIntentId) {
          toCancel.push({
            paymentId: row._id as Id<"bookingPayments">,
            paymentIntentId: row.paymentIntentId,
          });
        }
      }
    }
    return { toCancel };
  },
});

// Action wrapper for the cron: sweep + cancel any dangling Stripe auths.
// Explicit annotations break the self-referential inference cycle (the handler
// reaches its own module via the `(internal as any).scheduling.payments` hop,
// which is circular once codegen materializes the real types — TS7022/7023).
export const sweepStaleBookingPayments = internalAction({
  args: {},
  handler: async (ctx): Promise<{ swept: number }> => {
    const secretKey = getStripeSecretKey();
    const { toCancel } = (await ctx.runMutation(
      (internal as any).scheduling.payments._sweepStaleBookingPayments,
      {},
    )) as {
      toCancel: Array<{
        paymentId: Id<"bookingPayments">;
        paymentIntentId: string;
      }>;
    };
    if (!secretKey || toCancel.length === 0) return { swept: toCancel.length };
    for (const c of toCancel) {
      try {
        await cancelPaymentIntent({ secretKey }, c.paymentIntentId, `expire:${c.paymentId}`);
      } catch (err) {
        // Already-canceled / already-captured / unknown PI → log, continue. The
        // row is already marked expired; a dangling auth lapses on Stripe's side.
        log.warn("booking.payment.sweep.cancel_failed", {
          paymentId: String(c.paymentId),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { swept: toCancel.length };
  },
});

// ─── M3/M4: the webhook (its OWN route + secret, isolated from instabuy) ───────

async function sendLoserEmail(
  customerEmail: string | undefined,
  refunded: boolean,
): Promise<void> {
  if (!customerEmail) return;
  try {
    await sendBrevoEmail({
      toEmail: customerEmail,
      toName: customerEmail,
      subject: "Your booking slot was just taken",
      htmlContent: refunded
        ? "<p>That time slot was claimed by someone else just before your payment completed, so your booking didn’t go through. <strong>You have been fully refunded</strong> — no charge will appear (or it will drop off shortly).</p>"
        : "<p>That time slot was claimed by someone else first, so your booking didn’t go through. <strong>You were not charged</strong> — the pending authorization has been released.</p>",
    });
  } catch (err) {
    log.warn("booking.payment.loser_email_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export const handleBookingStripeWebhook = httpAction(async (ctx, req) => {
  const requestId = getOrMintRequestId(req);
  try {
    const secret = process.env.STRIPE_BOOKING_WEBHOOK_SECRET;
    if (!secret) {
      await log.errorDb(
        ctx,
        "booking.payment.webhook.secretMissing",
        new Error("STRIPE_BOOKING_WEBHOOK_SECRET is unset"),
        { requestId, liveMode: isStripeLiveMode(), severity: "critical" },
      );
      return withRequestId(
        new Response(
          JSON.stringify({
            ok: false,
            code: "booking_webhook_secret_missing",
            message:
              "STRIPE_BOOKING_WEBHOOK_SECRET is not configured. Set it via `npx convex env set STRIPE_BOOKING_WEBHOOK_SECRET whsec_…` and add the endpoint in the Stripe Dashboard.",
          }),
          { status: 503, headers: JSON_HEADERS },
        ),
        requestId,
      );
    }

    const rawBody = await req.text();
    const verified = await verifyStripeSignature(
      rawBody,
      req.headers.get("Stripe-Signature"),
      secret,
    );
    if (!verified.ok) {
      await log.errorDb(
        ctx,
        "booking.payment.webhook.signatureFailed",
        new Error(verified.error),
        { requestId, severity: "critical" },
      );
      return withRequestId(
        new Response(
          JSON.stringify({ ok: false, code: "signature_verification_failed" }),
          { status: 400, headers: JSON_HEADERS },
        ),
        requestId,
      );
    }

    let event: StripeEventEnvelope;
    try {
      event = JSON.parse(rawBody) as StripeEventEnvelope;
    } catch {
      return withRequestId(
        new Response(JSON.stringify({ ok: false, code: "json_parse_failed" }), {
          status: 400,
          headers: JSON_HEADERS,
        }),
        requestId,
      );
    }
    if (typeof event?.id !== "string" || typeof event?.type !== "string") {
      return withRequestId(
        new Response(JSON.stringify({ ok: false, code: "malformed_event" }), {
          status: 400,
          headers: JSON_HEADERS,
        }),
        requestId,
      );
    }

    const plan = decideStripeDispatch(event);
    let result = "ok";
    const secretKey = getStripeSecretKey();

    if (plan.kind === "checkout.session.completed") {
      const fin = await ctx.runMutation(
        (internal as any).scheduling.payments._finalizeBookingPayment,
        {
          stripeSessionId: plan.sessionId,
          paymentIntentId: plan.paymentIntentId,
          paidAtMs: plan.paidAtMs,
        },
      );
      result = fin.outcome;
      switch (fin.outcome) {
        case "not_ours":
        case "noop":
        case "won_auto":
          break;
        case "needs_capture": {
          if (!secretKey || !fin.paymentIntentId) {
            result = "capture_skipped_no_key";
            break;
          }
          await capturePaymentIntent(
            { secretKey },
            fin.paymentIntentId,
            `capture:${fin.paymentId}`,
          );
          await ctx.runMutation(
            (internal as any).scheduling.payments._markBookingPaymentStatus,
            { paymentId: fin.paymentId, status: "paid" },
          );
          break;
        }
        case "needs_void": {
          if (secretKey && fin.paymentIntentId) {
            try {
              await cancelPaymentIntent(
                { secretKey },
                fin.paymentIntentId,
                `void:${fin.paymentId}`,
              );
            } catch (err) {
              log.warn("booking.payment.void_failed", {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          await ctx.runMutation(
            (internal as any).scheduling.payments._markBookingPaymentStatus,
            { paymentId: fin.paymentId, status: "voided" },
          );
          await sendLoserEmail(fin.customerEmail, false);
          break;
        }
        case "needs_refund": {
          if (secretKey && fin.paymentIntentId) {
            try {
              await refundPaymentIntent(
                { secretKey },
                fin.paymentIntentId,
                `refund:${fin.paymentId}`,
              );
            } catch (err) {
              log.warn("booking.payment.refund_failed", {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          await ctx.runMutation(
            (internal as any).scheduling.payments._markBookingPaymentStatus,
            { paymentId: fin.paymentId, status: "refunded" },
          );
          await sendLoserEmail(fin.customerEmail, true);
          break;
        }
      }
    } else if (plan.kind === "payment_intent.payment_failed") {
      await ctx.runMutation(
        (internal as any).scheduling.payments._markBookingPaymentFailedByIntent,
        { paymentIntentId: plan.paymentIntentId },
      );
      result = "payment_failed";
    } else {
      result = `ignored:${plan.reason}`;
    }

    return withRequestId(
      new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: JSON_HEADERS,
      }),
      requestId,
    );
  } catch (err) {
    await log.errorDb(ctx, "booking.payment.webhook.error", err, {
      requestId,
      severity: "critical",
    });
    // Re-throw → Convex marks the request failed → Stripe retries (transient).
    throw err;
  }
});
