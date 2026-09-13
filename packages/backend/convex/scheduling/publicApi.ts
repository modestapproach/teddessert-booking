// BOOKING / F1 (M-DA3) — the PUBLIC, key-less booking httpActions.
//
// Five candidate-facing routes under `/book/api/*`, modeled verbatim on the
// dev-API public precedent `v1StorefrontHandler` (apiV1.ts ~line 683):
//
//   GET  /book/api/event-type/{slug}  — public-safe event-type DTO
//   GET  /book/api/slots/{slug}?from&to&tz — available slots (IP rate-limited)
//   POST /book/api/booking            — create a booking (IP rate-limited)
//   POST /book/api/reschedule         — token-guarded self-service reschedule
//   POST /book/api/cancel             — token-guarded self-service cancel
//   POST /book/api/request-code       — E4: send a 6-digit email verification
//                                       code (IP rate-limited; enumeration-safe)
//
// E4 ANTI-ABUSE: the booking POST enforces three optional, per-event-type
// defenses (see scheduling/antiAbuse.ts): a 6-digit email-verification code
// (requireEmailVerification), single-use/personalized links (isSingleUse), and
// optional Cloudflare Turnstile (requireCaptcha, gated on TURNSTILE_SECRET_KEY).
//
// CONTRACT (docs/booking-deploy-auth-prd.md §1.2–§1.5):
//   - The WHOLE surface is gated behind the DEFAULT-OFF `booking_enabled`
//     feature flag. While the flag is off EVERY route returns 404 — we don't
//     even reveal the booking API exists (same as apiV1's `api_enabled` gate).
//   - Errors are RFC 9457 `application/problem+json` via the local `problem()`
//     helper (a copy of apiV1's helper — the booking surface is a sibling, not a
//     subtree, of /v1, so it carries its own error vocabulary).
//   - Every route ships an OPTIONS handler + CORS, keyed off the BetterAuth
//     `trustedOrigins` allow-list (which already includes the public web origin
//     `https://dibslist.app`) — reusing `extensionAuth.corsHeaders`.
//   - `GET /book/api/slots` + `POST /book/api/booking` are IP rate-limited via
//     the shared `checkAndLogRateLimitByIp` helper (httpActions can't touch
//     ctx.db, so we delegate through the `_checkIpRateLimit` internalMutation).
//
// TESTABILITY: the repo convention for httpAction logic is to factor the body
// into a plain async function that takes a thin `ctx` (db / storage / scheduler)
// + a parsed-args object, then test THAT against an in-memory FakeDb (see
// scheduling/booking.test.ts). The `*Impl` functions below are those testable
// cores; the `http*Handler` httpActions are thin glue (URL/body parse → Impl →
// JSON/problem Response). The Impl functions never construct a Response, so the
// tests assert on plain data + thrown ConvexErrors.
//
// PUBLIC-SAFE PROJECTION: the event-type DTO strips every owner internal
// (ownerAuthUserId, schedulingType, scheduleId, buffers, limits, active, …) and
// exposes only title/description/durationMinutes/locationText/requireLogin +
// resolved host display-names+avatars. The slots DTO exposes only opaque
// {start,end} instants — never titles, attendees, or host identities.
//
// TOKEN NOTE: the `bookings` schema has no dedicated signed cancel/reschedule
// token columns yet (real signed-token verification lands with the deploy-auth
// PRD — booking.ts already threads `cancelToken`/`rescheduleToken` args
// unverified). For F1 the capability token IS the opaque `bookingId`: a caller
// who holds it can self-serve cancel/reschedule. The mutations still enforce the
// status-transition guard, so this is a bounded capability, not an open door.
// Swapping in HMAC-signed single-use tokens later is additive (the body already
// carries `cancelToken`/`rescheduleToken` fields that we currently ignore).

import { ConvexError, v } from "convex/values";
import {
  httpAction,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { internal, api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { isFlagEnabled } from "../_helpers/featureFlag";
import {
  checkAndLogRateLimitByIp,
  extractClientIp,
} from "../_helpers/rateLimit";
import { corsHeaders, sha256Hex } from "../extensionAuth";
// Owner-side MCP auth: reuse the developer-API key store. `hashApiKey` MUST match
// the hash apiKeys.create wrote (so a Bearer key resolves), so import the same
// _helpers/apiSecrets impl rather than extensionAuth's sha256Hex.
import {
  generateApiKeySecret,
  sha256Hex as hashApiKey,
} from "../_helpers/apiSecrets";
import { getOrMintRequestId, withRequestId } from "../_helpers/requestId";
import { log } from "../_helpers/log";
import {
  getAvailableSlotsHandler,
  type AvailableSlotsResult,
} from "./availableSlots";
import {
  createBookingHandler,
  cancelBookingHandler,
  rescheduleBookingHandler,
} from "./booking";
import {
  requestVerificationCodeImpl,
  verifyTurnstileToken,
  singleUseLinkIsGone,
} from "./antiAbuse";
import { sendBrevoEmail } from "./notify";
import { getCalcomUserByAuthUserIdImpl } from "./calcomUsers";
import {
  getPublicPollImpl,
  votePollHandler,
  type PublicPollDto,
} from "./polls";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

// ─── RFC 9457 response helpers (mirrors apiV1.ts lines 36–68) ────────────────

const ERROR_TITLES: Record<string, string> = {
  not_found: "Not found",
  rate_limited: "Rate limit exceeded",
  invalid_request: "Invalid request",
  slot_unavailable: "Slot no longer available",
  internal_error: "Internal error",
  // E4 anti-abuse:
  verify_code_invalid: "Verification code invalid or expired",
  captcha_failed: "Captcha verification failed",
  single_use_required: "This booking link requires a valid token",
  link_gone: "This booking link has already been used",
  // E3 meeting polls:
  poll_closed: "This poll is no longer accepting votes",
  // BOOKING-LOTTERY:
  lottery_closed: "Entries for this time have closed",
  lottery_only: "This event uses a drawing — enter the lottery instead",
};

function problem(
  status: number,
  code: string,
  detail: string,
  cors: Record<string, string>,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      type: `https://docs.dibslist.app/errors/${code}`,
      title: ERROR_TITLES[code] ?? code,
      status,
      code,
      detail,
      ...extra,
    }),
    {
      status,
      headers: { "content-type": "application/problem+json", ...cors },
    },
  );
}

function json(
  body: unknown,
  cors: Record<string, string>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}

// Map a ConvexError thrown by the booking mutations to an RFC-9457 problem. The
// mutations throw `ConvexError({ kind, message, ... })`; we translate the kind
// to an HTTP status. Anything unrecognized → 400 invalid_request (never 500,
// which would leak that the codepath ran).
function bookingErrorToProblem(
  err: unknown,
  cors: Record<string, string>,
): Response {
  if (err instanceof ConvexError) {
    const data = err.data as { kind?: string; message?: string; status?: string };
    const kind = data?.kind ?? "";
    const message = data?.message ?? "Request could not be completed.";
    switch (kind) {
      case "booking_disabled":
        // Flag off mid-flight → behave like the surface doesn't exist.
        return problem(404, "not_found", "Not found.", cors);
      case "event_type_not_found":
      case "event_type_inactive":
      case "booking_not_found":
      case "poll_not_found":
        return problem(404, "not_found", "Not found.", cors);
      // E3 meeting polls: a closed/expired poll rejecting a vote → 409.
      case "poll_closed":
        return problem(409, "poll_closed", message, cors);
      case "slot_unavailable":
        return problem(409, "slot_unavailable", message, cors);
      case "invalid_duration":
      case "booking_too_soon":
      case "outside_booking_window":
        return problem(400, "invalid_request", message, cors);
      case "cannot_cancel_status":
      case "cannot_reschedule_status":
        return problem(409, "invalid_request", message, cors, {
          status: data?.status,
        });
      // E4 anti-abuse. `verify_code_invalid` deliberately maps EVERY
      // email-verification failure (wrong / expired / locked-out / none) to one
      // 403 so the surface isn't an oracle.
      case "email_verification_required":
        return problem(403, "verify_code_invalid", message, cors);
      case "captcha_failed":
        return problem(403, "captcha_failed", message, cors);
      case "single_use_required":
        return problem(403, "single_use_required", message, cors);
      case "single_use_consumed":
        // The link was valid but is now spent → 410 Gone.
        return problem(410, "link_gone", message, cors);
      // BOOKING-PAYMENTS — paid-checkout error kinds.
      case "payments_disabled":
        // Paid booking dark → behave like the surface doesn't exist.
        return problem(404, "not_found", "Not found.", cors);
      // BOOKING-LOTTERY — slot-lottery error kinds.
      case "lottery_disabled":
      case "interactions_disabled":
        // Mode dark → behave like the surface doesn't exist.
        return problem(404, "not_found", "Not found.", cors);
      // WAVE-2 PAIR
      case "pair_not_found":
        return problem(404, "not_found", "Not found.", cors);
      case "pair_gone":
        return problem(410, "lottery_closed", message, cors);
      case "pair_already_joined":
        return problem(409, "invalid_request", message, cors);
      case "not_a_lottery_event":
        return problem(400, "invalid_request", message, cors);
      case "lottery_closed":
        // Valid drawing, but entries are over → 410 Gone (like spent links).
        return problem(410, "lottery_closed", message, cors);
      case "lottery_only":
        // Direct booking attempt on a lottery event → 409 with a hint.
        return problem(409, "lottery_only", message, cors);
      case "not_a_paid_event":
      case "invalid_price":
        return problem(400, "invalid_request", message, cors);
      case "already_in_progress":
        return problem(409, "slot_unavailable", message, cors);
      case "payments_unconfigured":
      case "stripe_error":
        // Misconfiguration / upstream Stripe failure → 503 (no charge happened).
        return problem(503, "internal_error", "Payment processing is temporarily unavailable.", cors);
    }
  }
  return problem(400, "invalid_request", "Request could not be completed.", cors);
}

// ─── Internal helpers (httpActions delegate to these for ctx.db access) ──────

// Flag probe. Mirrors apiV1._apiEnabled.
export const _bookingEnabled = internalQuery({
  args: {},
  handler: async (ctx) => isFlagEnabled(ctx, "booking_enabled", false),
});

// IP rate-limit check+log. httpActions can't touch ctx.db, so they delegate
// here. Mirrors extensionBids.checkAndLogRateLimitInternal but for the per-IP
// variant.
export const _checkIpRateLimit = internalMutation({
  args: {
    ipHash: v.string(),
    kind: v.string(),
    windowMs: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => checkAndLogRateLimitByIp(ctx, args),
});

// Operator toggle for the booking_enabled launch gate (DEFAULT-OFF). Run from
// the CLI: `npx convex run scheduling/publicApi:_setBookingEnabled '{"value":true}'`.
// Mirrors apiV1._setApiEnabled.
export const _setBookingEnabled = internalMutation({
  args: { value: v.boolean() },
  handler: async (ctx, { value }) => {
    const existing = await ctx.db
      .query("featureFlags")
      .withIndex("by_key", (q: Ctx) => q.eq("key", "booking_enabled"))
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        value,
        updatedAt: now,
        updatedBy: "cli",
        reason: "booking launch toggle",
      });
    } else {
      await ctx.db.insert("featureFlags", {
        key: "booking_enabled",
        value,
        updatedAt: now,
        updatedBy: "cli",
        reason: "booking launch toggle",
      });
    }
    return { key: "booking_enabled", value };
  },
});

// ─── Public-safe DTO builders (testable cores) ───────────────────────────────

export interface PublicHost {
  displayName: string;
  avatarUrl: string | null;
}

export interface PublicEventTypeDto {
  slug: string;
  title: string;
  description: string | null;
  durationMinutes: number;
  /** Free-text meeting location / instructions; null when unset. */
  location: string | null;
  /** Reserved per-event-type "must be logged in" gate (RECON D); false today. */
  requireLogin: boolean;
  /**
   * BOOKING-LOTTERY §6 — public-safe "???" mode so the Booker can switch
   * flows: "lottery" ⇒ slot pick leads to a drawing entry, not a booking;
   * "first_come" ⇒ claim-framed instant booking (first to claim a slot gets
   * it; the future pay-to-claim requirement attaches here). Null = standard.
   */
  interactionMode:
    | "lottery"
    | "first_come"
    | "application"
    | "threshold"
    | "pair"
    | null;
  /** Threshold only: minimum attendees for the session to confirm. */
  thresholdMinAttendees: number | null;
  /** Lottery only: entries close this many minutes before the slot. */
  lotteryCloseLeadMinutes: number | null;
  hosts: PublicHost[];
}

// Resolve one host's public display-name + avatar. Display name precedence:
// sellerProfiles.displayName → userPreferences.displayName → "Host". Avatar from
// the seller profile's storage id (resolved to a URL). NEVER returns the raw
// authUserId.
async function resolvePublicHost(
  ctx: Ctx,
  hostAuthUserId: string,
): Promise<PublicHost> {
  const profile = await ctx.db
    .query("sellerProfiles")
    .withIndex("by_user", (q: Ctx) => q.eq("authUserId", hostAuthUserId))
    .unique();
  let displayName: string | undefined = profile?.displayName ?? undefined;
  if (!displayName) {
    const prefs = await ctx.db
      .query("userPreferences")
      .withIndex("by_user", (q: Ctx) => q.eq("authUserId", hostAuthUserId))
      .unique();
    displayName = prefs?.displayName ?? undefined;
  }
  let avatarUrl: string | null = null;
  if (profile?.avatarStorageId && ctx.storage?.getUrl) {
    avatarUrl = await ctx.storage.getUrl(profile.avatarStorageId);
  }
  return { displayName: displayName ?? "Host", avatarUrl };
}

// Build the public-safe event-type DTO for a slug. Throws
// ConvexError({kind:"event_type_not_found"}) when the slug is missing or the
// event type isn't published (`active === false`) — callers map that to 404 so
// "not found" and "unpublished" are indistinguishable (no enumeration leak).
export async function getPublicEventTypeImpl(
  ctx: Ctx,
  slug: string,
): Promise<PublicEventTypeDto> {
  const eventType = await ctx.db
    .query("eventTypes")
    .withIndex("by_slug", (q: Ctx) => q.eq("slug", slug))
    .unique();
  // `active === true` is our "published" state in the current schema (the PRD's
  // draft/published/paused `status` column isn't added yet). An inactive or
  // missing event type is a 404 — never reveal which.
  if (!eventType || eventType.active === false) {
    throw new ConvexError({ kind: "event_type_not_found", message: "Not found." });
  }

  const hostRows: Array<Record<string, any>> = await ctx.db
    .query("eventTypeHosts")
    .withIndex("by_eventType", (q: Ctx) => q.eq("eventTypeId", eventType._id))
    .collect();
  const hosts: PublicHost[] = [];
  for (const h of hostRows) {
    hosts.push(await resolvePublicHost(ctx, h.hostAuthUserId as string));
  }

  return {
    slug: eventType.slug,
    title: eventType.title,
    description: eventType.description ?? null,
    durationMinutes: eventType.durationMinutes,
    location: eventType.locationText ?? null,
    // `requireLogin` is a reserved per-event-type flag (RECON D / PRD §1.5). The
    // column doesn't exist yet; default false (anonymous booking allowed).
    requireLogin: eventType.requireLogin === true,
    interactionMode:
      eventType.interactionMode === "lottery" ||
      eventType.interactionMode === "first_come" ||
      eventType.interactionMode === "application" ||
      eventType.interactionMode === "threshold" ||
      eventType.interactionMode === "pair"
        ? eventType.interactionMode
        : null,
    lotteryCloseLeadMinutes:
      eventType.interactionMode === "lottery" ||
      eventType.interactionMode === "application" ||
      eventType.interactionMode === "threshold"
        ? (eventType.lotteryCloseLeadMinutes ?? 1440)
        : null,
    thresholdMinAttendees:
      eventType.interactionMode === "threshold"
        ? (eventType.thresholdMinAttendees ?? null)
        : null,
    hosts,
  };
}

// ─── .ics generation (pure, no network, no dep) ──────────────────────────────

// Escape per RFC 5545: backslash, comma, semicolon, newline.
function icsEscape(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// Format a UTC epoch-ms as an ICS UTC timestamp (YYYYMMDDTHHMMSSZ).
function icsUtc(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

// Build a minimal, valid single-event VCALENDAR. Returned synchronously in the
// booking confirmation so the candidate gets an "Add to calendar" download
// (PRD §6). Pure string building — fits the Convex action runtime with no SDK.
export function buildIcs(args: {
  uid: string;
  title: string;
  startMs: number;
  endMs: number;
  location?: string | null;
  description?: string | null;
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//DibsList//Booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${icsEscape(args.uid)}`,
    `DTSTAMP:${icsUtc(Date.now())}`,
    `DTSTART:${icsUtc(args.startMs)}`,
    `DTEND:${icsUtc(args.endMs)}`,
    `SUMMARY:${icsEscape(args.title)}`,
  ];
  if (args.location) lines.push(`LOCATION:${icsEscape(args.location)}`);
  if (args.description) lines.push(`DESCRIPTION:${icsEscape(args.description)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n");
}

// ─── Booking create (testable core) ──────────────────────────────────────────

export interface CreateBookingBody {
  slug: string;
  start: number;
  end: number;
  name: string;
  email: string;
  notes?: string;
  holderToken?: string;
  idempotencyKey: string;
  timeZone?: string;
  // E4 anti-abuse (optional; enforced server-side only when the event type opts
  // in). assertCreateBody does NOT require these — the per-event-type gates in
  // createBookingHandler give the right 4xx kind when they're missing.
  verificationCode?: string; // 6-digit email OTP (requireEmailVerification)
  singleUseToken?: string; // host-minted single-use link token (isSingleUse)
  turnstileToken?: string; // Cloudflare Turnstile token (requireCaptcha)
  // BOOKING-PAYMENTS §6 — answers to the event type's custom booking questions.
  // Optional; persisted onto the booking. The cal fork's IN adapter (M5) maps
  // its `responses` object to this shape.
  intakeResponses?: Array<{ name: string; label: string; value: string }>;
}

export interface CreateBookingConfirmation {
  bookingId: Id<"bookings">;
  status: string;
  deduplicated?: boolean;
  ics: string;
  // For F1 the capability token IS the bookingId (see file header). Real signed
  // single-use tokens land with the deploy-auth PRD.
  rescheduleToken: string;
  cancelToken: string;
  // CV-3: echo the public-safe event meta + slot back so the cal fork's OUT
  // adapter can assemble a complete cal `BookingResponse` from a SINGLE
  // round-trip (no second event-type fetch). All public-safe: title + location
  // are the same fields `getPublicEventTypeBySlug` already exposes; start/end
  // are the booker's own request echoed back. NEVER includes ownerAuthUserId,
  // host emails, or any internal flag.
  eventTitle: string;
  eventLocation: string | null;
  start: number;
  end: number;
  bookerName: string;
  bookerEmail: string;
  bookerTimeZone: string;
  notes: string | null;
}

// Validate the parsed body shape (the httpAction parses JSON; this asserts the
// required fields are present + well-typed before touching the booking mutation,
// so a malformed body is a clean 400 invalid_request rather than a mutation
// throw). Throws ConvexError({kind:"invalid_request"}) on any miss.
function assertCreateBody(body: any): asserts body is CreateBookingBody {
  const bad = (m: string) => {
    throw new ConvexError({ kind: "invalid_request", message: m });
  };
  if (!body || typeof body !== "object") bad("Body must be a JSON object.");
  if (typeof body.slug !== "string" || !body.slug) bad("slug is required.");
  if (typeof body.start !== "number") bad("start (epoch-ms) is required.");
  if (typeof body.end !== "number") bad("end (epoch-ms) is required.");
  if (typeof body.name !== "string" || !body.name) bad("name is required.");
  if (typeof body.email !== "string" || !body.email) bad("email is required.");
  if (typeof body.idempotencyKey !== "string" || !body.idempotencyKey)
    bad("idempotencyKey is required.");
}

export async function createBookingImpl(
  ctx: Ctx,
  body: CreateBookingBody,
  nowMs?: number,
): Promise<CreateBookingConfirmation> {
  assertCreateBody(body);
  const bookerTimeZone = body.timeZone ?? "UTC";

  const res = await createBookingHandler(ctx, {
    slug: body.slug,
    startTime: body.start,
    endTime: body.end,
    bookerTimeZone,
    // The hold token is optional from the public client; createBooking tolerates
    // a missing/expired hold (the conflict re-check is authoritative).
    holderToken: body.holderToken ?? "",
    idempotencyKey: body.idempotencyKey,
    attendee: {
      name: body.name,
      email: body.email,
      timeZone: bookerTimeZone,
      notes: body.notes,
    },
    // E4 anti-abuse: pass through; createBookingHandler enforces per-event-type.
    verificationCode: body.verificationCode,
    singleUseToken: body.singleUseToken,
    // BOOKING-PAYMENTS §6 — intake answers (free path; paid path passes these
    // via the webhook finalize from the stored bookingIntent).
    intakeResponses: body.intakeResponses,
    nowMs,
  });

  // Resolve a public title for the .ics from the event type (already validated
  // present by createBooking). Falls back to a generic label.
  const eventType = await ctx.db
    .query("eventTypes")
    .withIndex("by_slug", (q: Ctx) => q.eq("slug", body.slug))
    .unique();

  const ics = buildIcs({
    uid: `${res.bookingId}@dibslist.app`,
    title: eventType?.title ?? "Booking",
    startMs: body.start,
    endMs: body.end,
    location: eventType?.locationText ?? null,
    description: body.notes ?? null,
  });

  return {
    bookingId: res.bookingId,
    status: res.status,
    deduplicated: res.deduplicated,
    ics,
    rescheduleToken: String(res.bookingId),
    cancelToken: String(res.bookingId),
    // CV-3 echo (public-safe): the cal OUT adapter builds its BookingResponse
    // from these without a second fetch.
    eventTitle: eventType?.title ?? "Booking",
    eventLocation: eventType?.locationText ?? null,
    start: body.start,
    end: body.end,
    bookerName: body.name,
    bookerEmail: body.email,
    bookerTimeZone,
    notes: body.notes ?? null,
  };
}

// ─── Cancel / reschedule (testable cores) ────────────────────────────────────

export interface CancelBody {
  bookingId: Id<"bookings">;
  cancelToken: string;
  reason?: string;
}

function assertCancelBody(body: any): asserts body is CancelBody {
  if (!body || typeof body !== "object")
    throw new ConvexError({ kind: "invalid_request", message: "Body must be a JSON object." });
  if (typeof body.bookingId !== "string" || !body.bookingId)
    throw new ConvexError({ kind: "invalid_request", message: "bookingId is required." });
  if (typeof body.cancelToken !== "string" || !body.cancelToken)
    throw new ConvexError({ kind: "invalid_request", message: "cancelToken is required." });
}

export async function cancelBookingImpl(
  ctx: Ctx,
  body: CancelBody,
  nowMs?: number,
): Promise<{ bookingId: Id<"bookings">; status: string }> {
  assertCancelBody(body);
  // Capability check: the cancelToken must match the bookingId (F1 token model).
  if (String(body.cancelToken) !== String(body.bookingId)) {
    throw new ConvexError({ kind: "booking_not_found", message: "Not found." });
  }
  return cancelBookingHandler(ctx, {
    bookingId: body.bookingId,
    cancelToken: body.cancelToken,
    reason: body.reason,
    nowMs,
  });
}

export interface RescheduleBody {
  bookingId: Id<"bookings">;
  rescheduleToken: string;
  start: number;
  end: number;
  name: string;
  email: string;
  notes?: string;
  holderToken?: string;
  idempotencyKey: string;
  timeZone?: string;
}

function assertRescheduleBody(body: any): asserts body is RescheduleBody {
  const bad = (m: string) => {
    throw new ConvexError({ kind: "invalid_request", message: m });
  };
  if (!body || typeof body !== "object") bad("Body must be a JSON object.");
  if (typeof body.bookingId !== "string" || !body.bookingId) bad("bookingId is required.");
  if (typeof body.rescheduleToken !== "string" || !body.rescheduleToken)
    bad("rescheduleToken is required.");
  if (typeof body.start !== "number") bad("start (epoch-ms) is required.");
  if (typeof body.end !== "number") bad("end (epoch-ms) is required.");
  if (typeof body.name !== "string" || !body.name) bad("name is required.");
  if (typeof body.email !== "string" || !body.email) bad("email is required.");
  if (typeof body.idempotencyKey !== "string" || !body.idempotencyKey)
    bad("idempotencyKey is required.");
}

export async function rescheduleBookingImpl(
  ctx: Ctx,
  body: RescheduleBody,
  nowMs?: number,
): Promise<{
  oldBookingId: Id<"bookings">;
  newBookingId: Id<"bookings">;
  status: string;
  deduplicated?: boolean;
  rescheduleToken: string;
  cancelToken: string;
}> {
  assertRescheduleBody(body);
  if (String(body.rescheduleToken) !== String(body.bookingId)) {
    throw new ConvexError({ kind: "booking_not_found", message: "Not found." });
  }
  const newTz = body.timeZone ?? "UTC";
  const res = await rescheduleBookingHandler(ctx, {
    oldBookingId: body.bookingId,
    newStartTime: body.start,
    newEndTime: body.end,
    newBookerTimeZone: newTz,
    holderToken: body.holderToken ?? "",
    idempotencyKey: body.idempotencyKey,
    rescheduleToken: body.rescheduleToken,
    attendee: {
      name: body.name,
      email: body.email,
      timeZone: newTz,
      notes: body.notes,
    },
    nowMs,
  });
  return {
    oldBookingId: res.oldBookingId,
    newBookingId: res.newBookingId,
    status: res.status,
    deduplicated: res.deduplicated,
    // The new booking's id is the new capability token.
    rescheduleToken: String(res.newBookingId),
    cancelToken: String(res.newBookingId),
  };
}

// ─── Slot-window parsing (testable core) ─────────────────────────────────────

export interface ParsedSlotQuery {
  windowStart: number;
  windowEnd: number;
  viewerTimeZone: string;
}

// Parse + validate ?from=&to=&tz=. `from`/`to` accept epoch-ms OR ISO strings.
// Defaults: from=now, to=now+14d, tz=UTC. Throws ConvexError(invalid_request)
// on an unparseable / inverted window.
export function parseSlotQuery(
  params: URLSearchParams,
  nowMs: number,
): ParsedSlotQuery {
  const parseInstant = (raw: string | null): number | null => {
    if (raw === null || raw === "") return null;
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && raw.trim() !== "") return asNum;
    const asDate = Date.parse(raw);
    return Number.isNaN(asDate) ? NaN : asDate;
  };
  const DEFAULT_WINDOW_MS = 14 * 86_400_000;
  const fromRaw = parseInstant(params.get("from"));
  const toRaw = parseInstant(params.get("to"));
  if (fromRaw !== null && Number.isNaN(fromRaw))
    throw new ConvexError({ kind: "invalid_request", message: "Invalid `from`." });
  if (toRaw !== null && Number.isNaN(toRaw))
    throw new ConvexError({ kind: "invalid_request", message: "Invalid `to`." });
  const windowStart = fromRaw ?? nowMs;
  const windowEnd = toRaw ?? windowStart + DEFAULT_WINDOW_MS;
  if (windowEnd <= windowStart)
    throw new ConvexError({ kind: "invalid_request", message: "`to` must be after `from`." });
  const viewerTimeZone = params.get("tz") || "UTC";
  return { windowStart, windowEnd, viewerTimeZone };
}

// Compute the public slots DTO. Returns ONLY opaque {start,end} instants grouped
// by date + the slot duration — never host identities or event titles. Throws
// ConvexError(event_type_not_found) for a missing/inactive slug (→ 404).
export async function getPublicSlotsImpl(
  ctx: Ctx,
  args: { slug: string } & ParsedSlotQuery,
  nowMs?: number,
): Promise<{
  durationMinutes: number;
  slotsByDate: Record<string, Array<{ start: number; end: number }>>;
}> {
  let raw: AvailableSlotsResult;
  try {
    raw = await getAvailableSlotsHandler(ctx, {
      slug: args.slug,
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
      viewerTimeZone: args.viewerTimeZone,
      nowMs,
    });
  } catch (e) {
    // getAvailableSlotsHandler throws ConvexError("Not found.") (a string
    // payload) for missing/inactive event types — normalize to our kind.
    throw new ConvexError({ kind: "event_type_not_found", message: "Not found." });
  }
  // Strip eligibleHostIdxs + host roster — expose only opaque instants.
  const slotsByDate: Record<string, Array<{ start: number; end: number }>> = {};
  for (const [date, slots] of Object.entries(raw.slotsByDate)) {
    slotsByDate[date] = slots.map((s) => ({ start: s.startMs, end: s.endMs }));
  }
  return {
    durationMinutes: raw.eventTypeDurationMinutes,
    slotsByDate,
  };
}

// ─── URL parsing helper ──────────────────────────────────────────────────────

// Extract the trailing slug segment after a `/book/api/<resource>/` prefix.
// Returns "" when absent (caller → 404).
function extractSlug(url: URL, prefix: string): string {
  const tail = url.pathname.slice(prefix.length).split("/").filter(Boolean);
  return tail[0] ? decodeURIComponent(tail[0]) : "";
}

// E3 poll routing: both `/book/api/poll/{id}` (GET view) and
// `/book/api/poll/{id}/vote` (POST vote) share the `/book/api/poll/` prefix, so
// extractSlug's first-segment grab already isolates `{id}` (the trailing
// `/vote` is the SECOND segment). We also expose whether the path ends in
// `/vote` so the shared handler can distinguish the two routes.
function pollPathIsVote(url: URL): boolean {
  const tail = url.pathname
    .slice("/book/api/poll/".length)
    .split("/")
    .filter(Boolean);
  return tail[1] === "vote";
}

async function safeJsonBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

// ─── httpAction wrappers (thin glue) ─────────────────────────────────────────

// The committed `_generated/api` is stale: codegen for this brand-new
// scheduling.publicApi module is operator-gated, so the `scheduling` namespace
// isn't materialized on the typed `internal` yet. The runtime refs
// (refs._bookingEnabled / _checkIpRateLimit /
// _publicEventType / …) are correct and a deploy regenerates the types; until
// then we go through this `(internal as any)` hop — the SAME precedent as
// scheduling/booking.ts (`(internal as any).scheduling?.booking`) and the
// crons.ts `(internal as any).gmailPush` references. (EXPECTED tsc-only churn.)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const refs = (internal as any).scheduling.publicApi;
// Sibling module refs (calendar sync action for the C7 resync endpoint). Same
// codegen-pending `(internal as any)` hop as `refs` above.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const syncRefs = (internal as any).scheduling.sync;
// BOOKING-PAYMENTS — the paid-checkout action + payments flag probe. Same
// codegen-pending `(internal as any)` hop as `refs`/`syncRefs` above.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const paymentRefs = (internal as any).scheduling.payments;
// BOOKING-LOTTERY — the slot-lottery enter/status fns + flag probe.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lotteryRefs = (internal as any).scheduling.lottery;

// Shared flag gate: returns a 404 Response (with CORS + request-id) when the
// booking surface is dark, else null.
async function bookingGate(
  ctx: Ctx,
  cors: Record<string, string>,
): Promise<Response | null> {
  const enabled = await ctx.runQuery(refs._bookingEnabled, {});
  return enabled ? null : problem(404, "not_found", "Not found.", cors);
}

// Shared IP rate gate: returns a 429 Response when over the limit, else null.
async function ipRateGate(
  ctx: Ctx,
  req: Request,
  kind: string,
  limit: number,
  windowMs: number,
  requestId: string,
  cors: Record<string, string>,
): Promise<Response | null> {
  const ip = extractClientIp(req);
  const ipHash = await sha256Hex(ip);
  const gate = await ctx.runMutation(refs._checkIpRateLimit, {
    ipHash,
    kind,
    windowMs,
    limit,
  });
  if (!gate.ok) {
    log.warn("booking.rate_limited", {
      kind,
      ipHash: ipHash.slice(0, 8),
      resetInMs: gate.resetInMs,
      requestId,
    });
    return problem(429, "rate_limited", "Too many requests — slow down.", cors, {
      retryAfterMs: gate.resetInMs,
    });
  }
  return null;
}

// GET /book/api/event-type/{slug} — public-safe event-type DTO. No rate limit
// (cheap read). 404 when flag-off / missing / unpublished.
export const bookEventTypeHandler = httpAction(async (ctx, req) => {
  const requestId = getOrMintRequestId(req);
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS")
    return withRequestId(new Response(null, { status: 204, headers: cors }), requestId);

  const dark = await bookingGate(ctx, cors);
  if (dark) return withRequestId(dark, requestId);

  const slug = extractSlug(new URL(req.url), "/book/api/event-type/");
  if (!slug) return withRequestId(problem(404, "not_found", "Not found.", cors), requestId);
  try {
    const dto = await ctx.runQuery(refs._publicEventType, { slug });
    if (!dto) return withRequestId(problem(404, "not_found", "Not found.", cors), requestId);
    return withRequestId(json(dto, cors), requestId);
  } catch (e) {
    return withRequestId(bookingErrorToProblem(e, cors), requestId);
  }
});

// GET /book/api/slots/{slug}?from&to&tz — available slots. IP rate-limited.
export const bookSlotsHandler = httpAction(async (ctx, req) => {
  const requestId = getOrMintRequestId(req);
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS")
    return withRequestId(new Response(null, { status: 204, headers: cors }), requestId);

  const dark = await bookingGate(ctx, cors);
  if (dark) return withRequestId(dark, requestId);

  const limited = await ipRateGate(ctx, req, "booking.slots", 60, 60_000, requestId, cors);
  if (limited) return withRequestId(limited, requestId);

  const url = new URL(req.url);
  const slug = extractSlug(url, "/book/api/slots/");
  if (!slug) return withRequestId(problem(404, "not_found", "Not found.", cors), requestId);
  try {
    const dto = await ctx.runQuery(refs._publicSlots, {
      slug,
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
      tz: url.searchParams.get("tz") ?? undefined,
      token: url.searchParams.get("token") ?? undefined,
    });
    return withRequestId(json(dto, cors), requestId);
  } catch (e) {
    return withRequestId(bookingErrorToProblem(e, cors), requestId);
  }
});

// POST /book/api/booking — create. IP rate-limited (tight window).
export const bookCreateHandler = httpAction(async (ctx, req) => {
  const requestId = getOrMintRequestId(req);
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS")
    return withRequestId(new Response(null, { status: 204, headers: cors }), requestId);

  const dark = await bookingGate(ctx, cors);
  if (dark) return withRequestId(dark, requestId);

  const limited = await ipRateGate(ctx, req, "booking.create", 10, 60_000, requestId, cors);
  if (limited) return withRequestId(limited, requestId);

  const body = await safeJsonBody(req);

  // ── E4 optional Turnstile captcha ──────────────────────────────────────────
  // Only incurs the siteverify round-trip when (a) TURNSTILE_SECRET_KEY is set
  // AND (b) the event type has requireCaptcha === true. The cheap indexed lookup
  // runs first; _verifyTurnstile no-ops to `true` when the secret is unset.
  if (body?.slug) {
    const captchaRequired = await ctx.runQuery(refs._getCaptchaRequired, {
      slug: body.slug,
    });
    if (captchaRequired) {
      const token: string =
        typeof body.turnstileToken === "string" ? body.turnstileToken : "";
      if (!token) {
        return withRequestId(
          problem(400, "invalid_request", "Captcha token required.", cors),
          requestId,
        );
      }
      const remoteIp = extractClientIp(req);
      const ok = await ctx.runAction(refs._verifyTurnstile, {
        token,
        remoteIp,
      });
      if (!ok) {
        return withRequestId(
          problem(403, "captcha_failed", "Captcha verification failed.", cors),
          requestId,
        );
      }
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  try {
    const confirmation = await ctx.runMutation(refs._createBooking, {
      body,
    });
    return withRequestId(json(confirmation, cors, 201), requestId);
  } catch (e) {
    return withRequestId(bookingErrorToProblem(e, cors), requestId);
  }
});

// POST /book/api/checkout — start a Stripe Checkout for a PAID event type.
// Flag-gated (booking_enabled AND booking_payments_enabled → 404 while dark),
// IP rate-limited like create. Reached server-to-server from the cal fork's
// booking route; returns { checkoutUrl } to redirect the booker to Stripe's
// hosted page. The booking is NOT created here — the webhook finalizes it after
// payment (so payment can never bypass the slot conflict re-check).
export const bookCheckoutHandler = httpAction(async (ctx, req) => {
  const requestId = getOrMintRequestId(req);
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS")
    return withRequestId(new Response(null, { status: 204, headers: cors }), requestId);

  const dark = await bookingGate(ctx, cors);
  if (dark) return withRequestId(dark, requestId);

  // Payments sub-gate: 404 while paid booking is dark (even if booking_enabled).
  const payEnabled = await ctx.runQuery(paymentRefs._bookingPaymentsEnabled, {});
  if (!payEnabled)
    return withRequestId(problem(404, "not_found", "Not found.", cors), requestId);

  const limited = await ipRateGate(ctx, req, "booking.checkout", 10, 60_000, requestId, cors);
  if (limited) return withRequestId(limited, requestId);

  const body = await safeJsonBody(req);
  if (!body || typeof body !== "object")
    return withRequestId(
      problem(400, "invalid_request", "Body must be a JSON object.", cors),
      requestId,
    );
  for (const k of ["slug", "start", "end", "name", "email", "successUrl", "cancelUrl"]) {
    if (body[k] === undefined || body[k] === null || body[k] === "")
      return withRequestId(
        problem(400, "invalid_request", `${k} is required.`, cors),
        requestId,
      );
  }
  try {
    const res = await ctx.runAction(paymentRefs.createBookingCheckout, {
      slug: String(body.slug),
      start: Number(body.start),
      end: Number(body.end),
      name: String(body.name),
      email: String(body.email),
      notes: body.notes != null ? String(body.notes) : undefined,
      timeZone: body.timeZone != null ? String(body.timeZone) : undefined,
      holderToken: body.holderToken != null ? String(body.holderToken) : undefined,
      intakeResponses: Array.isArray(body.intakeResponses)
        ? body.intakeResponses
        : undefined,
      successUrl: String(body.successUrl),
      cancelUrl: String(body.cancelUrl),
    });
    return withRequestId(json(res, cors, 201), requestId);
  } catch (e) {
    return withRequestId(bookingErrorToProblem(e, cors), requestId);
  }
});

// BOOKING-LOTTERY / WAVE-2 — shared sub-gate: the round routes are open when
// EITHER the lottery or the interactions flag is on (the impls then gate
// precisely per the event's mode). 404 while both are dark.
async function lotteryGate(
  ctx: Ctx,
  cors: Record<string, string>,
): Promise<Response | null> {
  const lotteryOn = await ctx.runQuery(lotteryRefs._bookingLotteryEnabled, {});
  const interactionsOn = await ctx.runQuery(
    lotteryRefs._bookingInteractionsEnabled,
    {},
  );
  return lotteryOn || interactionsOn
    ? null
    : problem(404, "not_found", "Not found.", cors);
}

// WAVE-2-only sub-gate (pair + pick routes).
async function interactionsGate(
  ctx: Ctx,
  cors: Record<string, string>,
): Promise<Response | null> {
  const enabled = await ctx.runQuery(
    lotteryRefs._bookingInteractionsEnabled,
    {},
  );
  return enabled ? null : problem(404, "not_found", "Not found.", cors);
}

// POST /book/api/lottery/enter — enter the drawing for a specific slot of a
// lottery-mode event type. Flag-gated (booking_enabled AND
// booking_lottery_enabled → 404 while dark), IP-rate-limited like create.
// Returns { lotteryId, closesAt, entrantCount, alreadyEntered } — idempotent
// per (slot, email).
export const bookLotteryEnterHandler = httpAction(async (ctx, req) => {
  const requestId = getOrMintRequestId(req);
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS")
    return withRequestId(new Response(null, { status: 204, headers: cors }), requestId);

  const dark = await bookingGate(ctx, cors);
  if (dark) return withRequestId(dark, requestId);
  const lotteryDark = await lotteryGate(ctx, cors);
  if (lotteryDark) return withRequestId(lotteryDark, requestId);

  const limited = await ipRateGate(ctx, req, "booking.lottery.enter", 10, 60_000, requestId, cors);
  if (limited) return withRequestId(limited, requestId);

  const body = await safeJsonBody(req);
  if (!body || typeof body !== "object")
    return withRequestId(
      problem(400, "invalid_request", "Body must be a JSON object.", cors),
      requestId,
    );
  for (const k of ["slug", "start", "end", "name", "email"]) {
    if (body[k] === undefined || body[k] === null || body[k] === "")
      return withRequestId(
        problem(400, "invalid_request", `${k} is required.`, cors),
        requestId,
      );
  }
  try {
    const res = await ctx.runMutation(lotteryRefs._enterSlotLottery, {
      slug: String(body.slug),
      start: Number(body.start),
      end: Number(body.end),
      name: String(body.name),
      email: String(body.email),
      timeZone: body.timeZone != null ? String(body.timeZone) : undefined,
      notes: body.notes != null ? String(body.notes) : undefined,
      intakeResponses: Array.isArray(body.intakeResponses)
        ? body.intakeResponses
        : undefined,
    });
    return withRequestId(json(res, cors, 201), requestId);
  } catch (e) {
    return withRequestId(bookingErrorToProblem(e, cors), requestId);
  }
});

// GET /book/api/lottery/{id} — the public countdown DTO (poll-friendly; no
// auth; never exposes entrant identities). 404 while dark / missing / garbage.
export const bookLotteryStatusHandler = httpAction(async (ctx, req) => {
  const requestId = getOrMintRequestId(req);
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS")
    return withRequestId(new Response(null, { status: 204, headers: cors }), requestId);

  const dark = await bookingGate(ctx, cors);
  if (dark) return withRequestId(dark, requestId);
  const lotteryDark = await lotteryGate(ctx, cors);
  if (lotteryDark) return withRequestId(lotteryDark, requestId);

  const limited = await ipRateGate(ctx, req, "booking.lottery.view", 120, 60_000, requestId, cors);
  if (limited) return withRequestId(limited, requestId);

  const lotteryId = extractSlug(new URL(req.url), "/book/api/lottery/");
  if (!lotteryId || lotteryId === "enter")
    return withRequestId(problem(404, "not_found", "Not found.", cors), requestId);
  try {
    const dto = await ctx.runQuery(lotteryRefs._publicSlotLottery, { lotteryId });
    if (!dto) return withRequestId(problem(404, "not_found", "Not found.", cors), requestId);
    return withRequestId(json(dto, cors), requestId);
  } catch (e) {
    return withRequestId(bookingErrorToProblem(e, cors), requestId);
  }
});

// GET /book/api/application/pick?round&entry&token — the owner's signed
// one-click pick link from the applications-closed email. GET-with-side-effect
// is deliberate (email links can't POST); the signed single-use token is the
// capability, and a replay is an idempotent "not_awaiting" no-op. Returns tiny
// human-readable HTML (the owner clicks this from their mail client).
export const bookApplicationPickHandler = httpAction(async (ctx, req) => {
  const requestId = getOrMintRequestId(req);
  const cors = corsHeaders(req);
  const dark = await bookingGate(ctx, cors);
  if (dark) return withRequestId(dark, requestId);
  const interactionsDark = await interactionsGate(ctx, cors);
  if (interactionsDark) return withRequestId(interactionsDark, requestId);

  const url = new URL(req.url);
  const round = url.searchParams.get("round") ?? "";
  const entry = url.searchParams.get("entry") ?? "";
  const token = url.searchParams.get("token") ?? "";
  const html = (status: number, body: string) =>
    withRequestId(
      new Response(
        `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:30rem;margin:4rem auto;text-align:center">${body}</body>`,
        { status, headers: { "content-type": "text/html; charset=utf-8" } },
      ),
      requestId,
    );
  if (!round || !entry || !token) return html(400, "<h2>Malformed pick link.</h2>");
  try {
    const res = await ctx.runMutation(lotteryRefs._pickApplicationWinner, {
      lotteryId: round,
      entryId: entry,
      token,
    });
    switch (res.outcome) {
      case "picked":
        return html(
          200,
          `<h2>✅ Picked!</h2><p><strong>${res.winnerName ?? "The applicant"}</strong> is booked. Everyone else has been notified.</p>`,
        );
      case "not_awaiting":
        return html(
          409,
          "<h2>Already resolved.</h2><p>This round was already picked, cancelled, or expired.</p>",
        );
      case "cancelled":
        return html(
          409,
          "<h2>Could not book the winner.</h2><p>The time is no longer available — the round was cancelled and every applicant notified.</p>",
        );
      default:
        return html(404, "<h2>Pick link not valid.</h2>");
    }
  } catch (e) {
    return withRequestId(bookingErrorToProblem(e, cors), requestId);
  }
});

// GET /book/api/pair/{token} — public partner-join context (PII-light).
export const bookPairStatusHandler = httpAction(async (ctx, req) => {
  const requestId = getOrMintRequestId(req);
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS")
    return withRequestId(new Response(null, { status: 204, headers: cors }), requestId);
  const dark = await bookingGate(ctx, cors);
  if (dark) return withRequestId(dark, requestId);
  const interactionsDark = await interactionsGate(ctx, cors);
  if (interactionsDark) return withRequestId(interactionsDark, requestId);
  const limited = await ipRateGate(ctx, req, "booking.pair.view", 120, 60_000, requestId, cors);
  if (limited) return withRequestId(limited, requestId);

  const token = extractSlug(new URL(req.url), "/book/api/pair/");
  if (!token || token === "join")
    return withRequestId(problem(404, "not_found", "Not found.", cors), requestId);
  try {
    const dto = await ctx.runQuery(lotteryRefs._publicPair, { token });
    if (!dto) return withRequestId(problem(404, "not_found", "Not found.", cors), requestId);
    return withRequestId(json(dto, cors), requestId);
  } catch (e) {
    return withRequestId(bookingErrorToProblem(e, cors), requestId);
  }
});

// POST /book/api/pair/join — the partner commits (name+email), flipping the
// pending hold to a confirmed two-person booking.
export const bookPairJoinHandler = httpAction(async (ctx, req) => {
  const requestId = getOrMintRequestId(req);
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS")
    return withRequestId(new Response(null, { status: 204, headers: cors }), requestId);
  const dark = await bookingGate(ctx, cors);
  if (dark) return withRequestId(dark, requestId);
  const interactionsDark = await interactionsGate(ctx, cors);
  if (interactionsDark) return withRequestId(interactionsDark, requestId);
  const limited = await ipRateGate(ctx, req, "booking.pair.join", 10, 60_000, requestId, cors);
  if (limited) return withRequestId(limited, requestId);

  const body = await safeJsonBody(req);
  for (const k of ["token", "name", "email"]) {
    if (!body?.[k])
      return withRequestId(
        problem(400, "invalid_request", `${k} is required.`, cors),
        requestId,
      );
  }
  try {
    const res = await ctx.runMutation(lotteryRefs._joinPair, {
      token: String(body.token),
      name: String(body.name),
      email: String(body.email),
      timeZone: body.timeZone != null ? String(body.timeZone) : undefined,
    });
    return withRequestId(json(res, cors, 200), requestId);
  } catch (e) {
    return withRequestId(bookingErrorToProblem(e, cors), requestId);
  }
});

// POST /book/api/request-code — E4 email verification. Mints a 6-digit code,
// stores its hash, and dispatches it by email. IP rate-limited TIGHT (5/min);
// ENUMERATION-SAFE: always returns 200 { sent: true } regardless of whether the
// slug/email/event-type exist or require verification.
export const bookRequestCodeHandler = httpAction(async (ctx, req) => {
  const requestId = getOrMintRequestId(req);
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS")
    return withRequestId(new Response(null, { status: 204, headers: cors }), requestId);

  const dark = await bookingGate(ctx, cors);
  if (dark) return withRequestId(dark, requestId);

  const limited = await ipRateGate(ctx, req, "booking.verify", 5, 60_000, requestId, cors);
  if (limited) return withRequestId(limited, requestId);

  const body = await safeJsonBody(req);
  const slug = typeof body?.slug === "string" ? body.slug : "";
  const email = typeof body?.email === "string" ? body.email : "";
  // Malformed body is the only non-200 here — a clean 400 for an empty
  // slug/email is NOT an oracle (it doesn't reveal anything about existence).
  if (!slug || !email) {
    return withRequestId(
      problem(400, "invalid_request", "slug and email are required.", cors),
      requestId,
    );
  }
  // Best-effort: never throw into the client (no oracle). The mutation mints +
  // stores the code AND schedules the email send atomically.
  try {
    await ctx.runMutation(refs._requestVerificationCode, { slug, email });
  } catch (e) {
    log.warn("booking.request_code.error", {
      requestId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return withRequestId(json({ sent: true }, cors), requestId);
});

// POST /book/api/reschedule — token-guarded. No extra IP limit (token = capability).
export const bookRescheduleHandler = httpAction(async (ctx, req) => {
  const requestId = getOrMintRequestId(req);
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS")
    return withRequestId(new Response(null, { status: 204, headers: cors }), requestId);

  const dark = await bookingGate(ctx, cors);
  if (dark) return withRequestId(dark, requestId);

  const body = await safeJsonBody(req);
  try {
    const res = await ctx.runMutation(refs._rescheduleBooking, { body });
    return withRequestId(json(res, cors), requestId);
  } catch (e) {
    return withRequestId(bookingErrorToProblem(e, cors), requestId);
  }
});

// POST /book/api/cancel — token-guarded. No extra IP limit.
export const bookCancelHandler = httpAction(async (ctx, req) => {
  const requestId = getOrMintRequestId(req);
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS")
    return withRequestId(new Response(null, { status: 204, headers: cors }), requestId);

  const dark = await bookingGate(ctx, cors);
  if (dark) return withRequestId(dark, requestId);

  const body = await safeJsonBody(req);
  try {
    const res = await ctx.runMutation(refs._cancelBooking, { body });
    return withRequestId(json(res, cors), requestId);
  } catch (e) {
    return withRequestId(bookingErrorToProblem(e, cors), requestId);
  }
});

// POST /book/api/resync — token-guarded organizer re-trigger of calendar sync
// (C7). Re-attempts only `failed`/never-attempted `externalEvents` entries; the
// underlying `resyncBooking` action is idempotent (synced entries untouched).
// Capability model mirrors cancel: the caller proves ownership of the booking by
// supplying `resyncToken === bookingId` (the F1 token == id model). Flag-gated
// (404 while dark) like every other booking route.
export const bookResyncHandler = httpAction(async (ctx, req) => {
  const requestId = getOrMintRequestId(req);
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS")
    return withRequestId(new Response(null, { status: 204, headers: cors }), requestId);

  const dark = await bookingGate(ctx, cors);
  if (dark) return withRequestId(dark, requestId);

  const body = await safeJsonBody(req);
  const bookingId = body?.bookingId;
  const resyncToken = body?.resyncToken;
  // Token guard: same pure string-compare capability check as cancelBookingImpl.
  if (
    typeof bookingId !== "string" ||
    String(resyncToken) !== String(bookingId)
  ) {
    return withRequestId(problem(404, "not_found", "Not found.", cors), requestId);
  }
  try {
    const res = await ctx.runAction(syncRefs.resyncBooking, {
      bookingId: bookingId as Id<"bookings">,
    });
    return withRequestId(json(res, cors), requestId);
  } catch (e) {
    return withRequestId(bookingErrorToProblem(e, cors), requestId);
  }
});

// ─── E3 meeting polls (public httpActions) ───────────────────────────────────

// GET  /book/api/poll/{id}        — public-safe poll view (IP rate-limited, read)
// POST /book/api/poll/{id}/vote   — cast/update a vote (IP rate-limited, tight)
//
// Both share the `/book/api/poll/` prefix; the handler inspects the trailing
// segment (`pollPathIsVote`) + the HTTP method to distinguish them, mirroring
// the other booking routes (flag-404 + CORS + IP rate-limit + RFC-9457).

// GET /book/api/poll/{id} — public poll view. IP rate-limited (generous read).
export const bookPollHandler = httpAction(async (ctx, req) => {
  const requestId = getOrMintRequestId(req);
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS")
    return withRequestId(new Response(null, { status: 204, headers: cors }), requestId);

  const dark = await bookingGate(ctx, cors);
  if (dark) return withRequestId(dark, requestId);

  const limited = await ipRateGate(ctx, req, "booking.poll.view", 120, 60_000, requestId, cors);
  if (limited) return withRequestId(limited, requestId);

  const pollId = extractSlug(new URL(req.url), "/book/api/poll/");
  if (!pollId) return withRequestId(problem(404, "not_found", "Not found.", cors), requestId);
  try {
    const dto = await ctx.runQuery(refs._publicPoll, { pollId });
    if (!dto) return withRequestId(problem(404, "not_found", "Not found.", cors), requestId);
    return withRequestId(json(dto, cors), requestId);
  } catch (e) {
    return withRequestId(bookingErrorToProblem(e, cors), requestId);
  }
});

// POST /book/api/poll/{id}/vote — cast a vote. IP rate-limited (tight, like create).
export const bookPollVoteHandler = httpAction(async (ctx, req) => {
  const requestId = getOrMintRequestId(req);
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS")
    return withRequestId(new Response(null, { status: 204, headers: cors }), requestId);

  const dark = await bookingGate(ctx, cors);
  if (dark) return withRequestId(dark, requestId);

  const url = new URL(req.url);
  // Only the `/vote` sub-path is a valid POST target.
  if (!pollPathIsVote(url))
    return withRequestId(problem(404, "not_found", "Not found.", cors), requestId);

  const limited = await ipRateGate(ctx, req, "booking.poll.vote", 10, 60_000, requestId, cors);
  if (limited) return withRequestId(limited, requestId);

  const pollId = extractSlug(url, "/book/api/poll/");
  if (!pollId) return withRequestId(problem(404, "not_found", "Not found.", cors), requestId);
  const body = await safeJsonBody(req);
  try {
    const res = await ctx.runMutation(refs._castPollVote, { body: { ...body, pollId } });
    return withRequestId(json(res, cors, 201), requestId);
  } catch (e) {
    return withRequestId(bookingErrorToProblem(e, cors), requestId);
  }
});

// ─── Booking MCP (Model Context Protocol over a Convex httpAction) ────────────
//
// A STATELESS Streamable-HTTP MCP server exposing the booker-side scheduling verbs
// to AI agents (Claude Code / openclaw / hermes / Cursor). It is SELF-CONTAINED:
// every tool routes to the SAME internal functions the `/book/api/*` httpActions
// use (`refs._public*` / `refs._createBooking` / ...), so there is no external base
// URL and the whole booking feature stays portable — deploy this Convex project and
// the MCP ships with it at `<deployment>.convex.site/book/mcp`.
//
// Transport: the modern Streamable-HTTP simplest mode — the client POSTs JSON-RPC
// 2.0 and we answer with a single JSON response (no SSE, no sessions, no
// server-initiated messages). That is fully supported by the spec for a stateless
// server and is all the booking tools need (request → response). Flag-gated behind
// `booking_enabled` like the rest of `/book/api` (404 while dark). Public/key-less
// (booker side); per-booking capability tokens guard cancel/reschedule, and
// `book_meeting` keeps the same per-IP create rate-limit as the HTTP surface.

const MCP_PROTOCOL_VERSION = "2025-06-18";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type McpToolCtx = any;
interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  // Owner-side tools set a required API-key scope (e.g. "booking:read"); public
  // booker tools leave it undefined. When set, the handler resolves a Bearer key
  // to an authUserId BEFORE calling and passes it as the 3rd arg.
  scope?: string;
  // Returns a JSON-serializable result (rendered as the tool's text content).
  // `authUserId` is present only for scope-gated owner tools.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call: (ctx: McpToolCtx, args: any, authUserId?: string) => Promise<unknown>;
}

// Unique idempotency key when the agent doesn't supply one. crypto.randomUUID is
// available in the Convex action runtime; fall back defensively.
function mcpIdempotencyKey(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `mcp-${crypto.randomUUID()}`;
    }
  } catch {
    /* fall through */
  }
  return `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const BOOKING_MCP_TOOLS: McpTool[] = [
  {
    name: "get_event_type",
    description:
      "Look up a booking event type by its slug — returns title, duration, location and scheduling type. Call this first to confirm an event exists before listing slots.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: 'Event-type slug, e.g. "30min".' },
      },
      required: ["slug"],
    },
    call: async (ctx, args) => {
      const dto = await ctx.runQuery(refs._publicEventType, { slug: String(args.slug) });
      if (!dto) throw new ConvexError({ kind: "not_found", message: "Event type not found." });
      return dto;
    },
  },
  {
    name: "list_slots",
    description:
      "List open meeting slots for an event type, grouped by date. start/end are millisecond-epoch timestamps. Optional ISO `from`/`to` bound the window (default = next ~14 days).",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Event-type slug." },
        from: { type: "string", description: "ISO datetime lower bound (optional)." },
        to: { type: "string", description: "ISO datetime upper bound (optional)." },
        tz: { type: "string", description: "IANA timezone for date bucketing (optional)." },
      },
      required: ["slug"],
    },
    call: async (ctx, args) =>
      ctx.runQuery(refs._publicSlots, {
        slug: String(args.slug),
        from: args.from != null ? String(args.from) : undefined,
        to: args.to != null ? String(args.to) : undefined,
        tz: args.tz != null ? String(args.tz) : undefined,
      }),
  },
  {
    name: "book_meeting",
    description:
      "Book a meeting slot. start/end are millisecond-epoch timestamps taken from list_slots. Returns the bookingId plus cancelToken/rescheduleToken used to manage it later. Pass your own idempotencyKey to make retries safe (one is auto-generated if omitted).",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        start: { type: "number", description: "Slot start (ms epoch)." },
        end: { type: "number", description: "Slot end (ms epoch)." },
        name: { type: "string", description: "Attendee full name." },
        email: { type: "string", description: "Attendee email address." },
        timeZone: { type: "string", description: "Attendee IANA timezone (optional, defaults UTC)." },
        notes: { type: "string", description: "Optional agenda/notes." },
        idempotencyKey: { type: "string", description: "Optional; auto-generated if omitted." },
      },
      required: ["slug", "start", "end", "name", "email"],
    },
    call: async (ctx, args) =>
      ctx.runMutation(refs._createBooking, {
        body: {
          slug: String(args.slug),
          start: Number(args.start),
          end: Number(args.end),
          name: String(args.name),
          email: String(args.email),
          timeZone: args.timeZone != null ? String(args.timeZone) : undefined,
          notes: args.notes != null ? String(args.notes) : undefined,
          idempotencyKey:
            args.idempotencyKey != null ? String(args.idempotencyKey) : mcpIdempotencyKey(),
        },
      }),
  },
  {
    name: "cancel_booking",
    description:
      "Cancel a booking. Requires the bookingId and its cancelToken (both returned by book_meeting — the token equals the bookingId).",
    inputSchema: {
      type: "object",
      properties: {
        bookingId: { type: "string" },
        cancelToken: { type: "string" },
        reason: { type: "string", description: "Optional cancellation reason." },
      },
      required: ["bookingId", "cancelToken"],
    },
    call: async (ctx, args) =>
      ctx.runMutation(refs._cancelBooking, {
        body: {
          bookingId: String(args.bookingId),
          cancelToken: String(args.cancelToken),
          reason: args.reason != null ? String(args.reason) : undefined,
        },
      }),
  },
  {
    name: "reschedule_booking",
    description:
      "Move a booking to a new slot. Requires bookingId + rescheduleToken (from book_meeting) and the new start/end (ms epoch).",
    inputSchema: {
      type: "object",
      properties: {
        bookingId: { type: "string" },
        rescheduleToken: { type: "string" },
        start: { type: "number", description: "New slot start (ms epoch)." },
        end: { type: "number", description: "New slot end (ms epoch)." },
        name: { type: "string" },
        email: { type: "string" },
        timeZone: { type: "string" },
        notes: { type: "string" },
        idempotencyKey: { type: "string", description: "Optional; auto-generated if omitted." },
      },
      required: ["bookingId", "rescheduleToken", "start", "end", "name", "email"],
    },
    call: async (ctx, args) =>
      ctx.runMutation(refs._rescheduleBooking, {
        body: {
          bookingId: String(args.bookingId),
          rescheduleToken: String(args.rescheduleToken),
          start: Number(args.start),
          end: Number(args.end),
          name: String(args.name),
          email: String(args.email),
          timeZone: args.timeZone != null ? String(args.timeZone) : undefined,
          notes: args.notes != null ? String(args.notes) : undefined,
          idempotencyKey:
            args.idempotencyKey != null ? String(args.idempotencyKey) : mcpIdempotencyKey(),
        },
      }),
  },
  // ── Owner-side tools (require a Bearer API key with the booking:read scope) ──
  {
    name: "list_my_bookings",
    description:
      "List YOUR bookings as the host/owner (requires an API key with the booking:read scope passed as 'Authorization: Bearer <key>'). Filter by status; returns a page of bookings with attendee + time details.",
    scope: "booking:read",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["upcoming", "past", "cancelled", "unconfirmed"],
          description: "Which bookings to return (default: upcoming).",
        },
        limit: { type: "number", description: "Max bookings to return (default 25, max 100)." },
      },
    },
    call: async (ctx, args, authUserId) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx.runQuery((api as any).scheduling.bookingAdmin.listBookings, {
        ownerAuthUserId: authUserId as string,
        status: (args.status as string) ?? "upcoming",
        paginationOpts: {
          numItems: Math.min(Math.max(Number(args.limit) || 25, 1), 100),
          cursor: null,
        },
      }),
  },
  {
    name: "list_my_event_types",
    description:
      "List YOUR bookable event types (slug, title, duration, scheduling type) — what people can book with you (requires an API key with the booking:read scope). Use the slug with list_slots/book_meeting.",
    scope: "booking:read",
    inputSchema: {
      type: "object",
      properties: {
        activeOnly: { type: "boolean", description: "Only active/non-hidden event types (default false)." },
      },
    },
    call: async (ctx, args, authUserId) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx.runQuery((api as any).scheduling.calcomAdmin.adminListEventTypes, {
        ownerAuthUserId: authUserId as string,
        activeOnly: args.activeOnly === true ? true : undefined,
      }),
  },
  // ── Owner webhook management (thin wrappers over convex/webhooks.ts owner fns) ──
  {
    name: "list_my_webhooks",
    description:
      "List YOUR booking webhooks (requires an API key with the booking:read scope). Optionally scope to ONE event type via eventTypeCalId. Returns each endpoint incl. its decrypted signing secret (it's your own).",
    scope: "booking:read",
    inputSchema: {
      type: "object",
      properties: {
        eventTypeCalId: {
          type: "number",
          description: "Only webhooks scoped to this event type's cal int id (omit = all your webhooks).",
        },
      },
    },
    call: async (ctx, args, authUserId) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx.runQuery((api as any).webhooks.ownerListWebhooks, {
        ownerAuthUserId: authUserId as string,
        eventTypeCalId: args.eventTypeCalId != null ? Number(args.eventTypeCalId) : undefined,
      }),
  },
  {
    name: "create_webhook",
    description:
      "Create a booking webhook (requires an API key with the booking:write scope). It POSTs a signed payload to subscriberUrl when matching booking events fire. Today ONLY these eventTriggers actually fire: BOOKING_CREATED, BOOKING_CANCELLED, BOOKING_RESCHEDULED. Omit eventTypeCalId to fire for ALL your bookings, or set it to scope to one event type. subscriberUrl must be http(s); the server validates + SSRF-checks it.",
    scope: "booking:write",
    inputSchema: {
      type: "object",
      properties: {
        subscriberUrl: { type: "string", description: "https:// (or http://) endpoint to POST to." },
        eventTriggers: {
          type: "array",
          items: {
            type: "string",
            enum: ["BOOKING_CREATED", "BOOKING_CANCELLED", "BOOKING_RESCHEDULED"],
          },
          description: "Which booking events fire this webhook. Only these three fire today.",
        },
        active: { type: "boolean", description: "Enabled on creation (default true)." },
        eventTypeCalId: {
          type: "number",
          description: "Scope to one event type's cal int id; omit = all your bookings.",
        },
        payloadTemplate: {
          type: "string",
          description: "Optional custom body template; omit for the default {type,created,data} payload.",
        },
        secret: {
          type: "string",
          description: "Optional signing secret (whsec_...); omit to auto-generate one.",
        },
      },
      required: ["subscriberUrl", "eventTriggers"],
    },
    call: async (ctx, args, authUserId) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx.runMutation((api as any).webhooks.ownerCreateWebhook, {
        ownerAuthUserId: authUserId as string,
        subscriberUrl: String(args.subscriberUrl),
        eventTriggers: Array.isArray(args.eventTriggers) ? args.eventTriggers.map(String) : [],
        active: args.active !== false,
        payloadTemplate: args.payloadTemplate != null ? String(args.payloadTemplate) : undefined,
        secret: args.secret != null ? String(args.secret) : undefined,
        eventTypeCalId: args.eventTypeCalId != null ? Number(args.eventTypeCalId) : undefined,
      }),
  },
  {
    name: "delete_webhook",
    description:
      "Delete one of YOUR booking webhooks by id (requires an API key with the booking:write scope). Get the id from list_my_webhooks.",
    scope: "booking:write",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The webhook id (from list_my_webhooks)." } },
      required: ["id"],
    },
    call: async (ctx, args, authUserId) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx.runMutation((api as any).webhooks.ownerDeleteWebhook, {
        ownerAuthUserId: authUserId as string,
        id: String(args.id),
      }),
  },
  {
    name: "test_webhook",
    description:
      "Fire a real signed TEST delivery to one of YOUR webhooks (requires an API key with the booking:write scope — it POSTs). Use to confirm the endpoint receives + verifies the signature.",
    scope: "booking:write",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The webhook id (from list_my_webhooks)." } },
      required: ["id"],
    },
    call: async (ctx, args, authUserId) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx.runMutation((api as any).webhooks.ownerTestWebhook, {
        ownerAuthUserId: authUserId as string,
        id: String(args.id),
      }),
  },
];

// Resolve a Bearer API key from the request to an owner authUserId, enforcing a
// required scope. Reuses the developer-API `apiKeys` store but is gated by the
// MCP's own `booking_enabled` flag (NOT the dark `api_enabled`). Returns
// {ok:true, authUserId} or {ok:false, reason} for MCP-shaped error rendering.
async function resolveBookingAuth(
  ctx: McpToolCtx,
  req: Request,
  requiredScope: string,
): Promise<
  { ok: true; authUserId: string } | { ok: false; reason: "missing" | "invalid" | "scope" }
> {
  const authz = req.headers.get("authorization") ?? req.headers.get("Authorization") ?? "";
  const m = authz.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, reason: "missing" };
  const tokenHash = await hashApiKey(m[1].trim());
  const res = await ctx.runQuery(refs._authBookingKey, { tokenHash, requiredScope });
  if (res.ok) return { ok: true, authUserId: res.authUserId as string };
  return { ok: false, reason: res.reason };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonRpcEnvelope(id: any, payload: Record<string, unknown>, cors: Record<string, string>): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...payload }), {
    status: 200,
    headers: { ...cors, "content-type": "application/json" },
  });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonRpcResult = (id: any, result: unknown, cors: Record<string, string>) =>
  jsonRpcEnvelope(id, { result }, cors);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonRpcError = (id: any, code: number, message: string, cors: Record<string, string>) =>
  jsonRpcEnvelope(id, { error: { code, message } }, cors);

// POST/GET/OPTIONS /book/mcp — the MCP endpoint.
export const bookMcpHandler = httpAction(async (ctx, req) => {
  const requestId = getOrMintRequestId(req);
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS")
    return withRequestId(new Response(null, { status: 204, headers: cors }), requestId);

  const dark = await bookingGate(ctx, cors);
  if (dark) return withRequestId(dark, requestId);

  // Stateless server: no SSE stream to open, so a GET (the optional SSE channel)
  // isn't supported — clients fall back to POST-only request/response.
  if (req.method !== "POST") {
    return withRequestId(
      new Response("Method Not Allowed", { status: 405, headers: cors }),
      requestId,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let msg: any;
  try {
    msg = await req.json();
  } catch {
    return withRequestId(jsonRpcError(null, -32700, "Parse error", cors), requestId);
  }
  if (Array.isArray(msg)) {
    // JSON-RPC batching was removed in the 2025 MCP spec; reject explicitly.
    return withRequestId(jsonRpcError(null, -32600, "Batch requests are not supported", cors), requestId);
  }

  const id = msg?.id ?? null;
  const method = msg?.method;

  // A notification (no `id`) — e.g. notifications/initialized — gets a bare 202.
  if (msg?.id === undefined && typeof method === "string") {
    return withRequestId(new Response(null, { status: 202, headers: cors }), requestId);
  }

  try {
    if (method === "initialize") {
      const clientProto = msg?.params?.protocolVersion;
      return withRequestId(
        jsonRpcResult(
          id,
          {
            protocolVersion: typeof clientProto === "string" ? clientProto : MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "dibslist-booking", version: "1.0.0" },
            instructions:
              "Scheduling/booking tools for the dibslist booking system. Typical flow: get_event_type -> list_slots -> book_meeting. book_meeting returns a bookingId plus cancelToken/rescheduleToken you use with cancel_booking / reschedule_booking. Times are millisecond-epoch timestamps.",
          },
          cors,
        ),
        requestId,
      );
    }

    if (method === "ping") {
      return withRequestId(jsonRpcResult(id, {}, cors), requestId);
    }

    if (method === "tools/list") {
      return withRequestId(
        jsonRpcResult(
          id,
          {
            tools: BOOKING_MCP_TOOLS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
          cors,
        ),
        requestId,
      );
    }

    if (method === "tools/call") {
      const name = msg?.params?.name;
      const args = msg?.params?.arguments ?? {};
      const tool = BOOKING_MCP_TOOLS.find((t) => t.name === name);
      if (!tool) {
        return withRequestId(jsonRpcError(id, -32602, `Unknown tool: ${name}`, cors), requestId);
      }
      // Keep the same per-IP create guard the HTTP surface has.
      if (name === "book_meeting") {
        const limited = await ipRateGate(ctx, req, "booking.create", 10, 60_000, requestId, cors);
        if (limited) {
          return withRequestId(
            jsonRpcResult(
              id,
              {
                content: [
                  { type: "text", text: "Rate limit exceeded for book_meeting (10/min). Retry shortly." },
                ],
                isError: true,
              },
              cors,
            ),
            requestId,
          );
        }
      }
      // Owner-side tools require a Bearer API key carrying the tool's scope.
      let ownerAuthUserId: string | undefined;
      if (tool.scope) {
        const auth = await resolveBookingAuth(ctx, req, tool.scope);
        if (!auth.ok) {
          const text =
            auth.reason === "scope"
              ? `This API key is missing the required scope "${tool.scope}".`
              : `Authentication required: pass an API key as "Authorization: Bearer <key>" with the "${tool.scope}" scope.`;
          return withRequestId(
            jsonRpcResult(id, { content: [{ type: "text", text }], isError: true }, cors),
            requestId,
          );
        }
        ownerAuthUserId = auth.authUserId;
      }
      try {
        const result = await tool.call(ctx, args, ownerAuthUserId);
        return withRequestId(
          jsonRpcResult(
            id,
            { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
            cors,
          ),
          requestId,
        );
      } catch (e) {
        // MCP convention: a tool failure is a result with isError:true (so the model
        // reads + reacts), not a JSON-RPC protocol error.
        const message =
          e instanceof ConvexError
            ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ((e.data as any)?.message ?? "Request could not be completed.")
            : e instanceof Error
              ? e.message
              : "Request could not be completed.";
        return withRequestId(
          jsonRpcResult(id, { content: [{ type: "text", text: `Error: ${message}` }], isError: true }, cors),
          requestId,
        );
      }
    }

    return withRequestId(jsonRpcError(id, -32601, `Method not found: ${method}`, cors), requestId);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Internal error";
    return withRequestId(jsonRpcError(id, -32603, message, cors), requestId);
  }
});

// Owner-side MCP auth resolver: look up a hashed Bearer key in the developer-API
// `apiKeys` store + enforce a scope. Deliberately NOT gated on `api_enabled` (the
// /v1 REST flag) — the MCP is its own booking surface gated by `booking_enabled`,
// so an agent key works for booking tools even while the /v1 REST API is dark.
export const _authBookingKey = internalQuery({
  args: { tokenHash: v.string(), requiredScope: v.string() },
  handler: async (
    ctx,
    { tokenHash, requiredScope },
  ): Promise<
    { ok: true; authUserId: string } | { ok: false; reason: "invalid" | "scope" }
  > => {
    const row = await ctx.db
      .query("apiKeys")
      .withIndex("by_hashedKey", (q) => q.eq("hashedKey", tokenHash))
      .unique();
    if (!row || row.revokedAt) return { ok: false, reason: "invalid" };
    if (!row.scopes.includes(requiredScope)) return { ok: false, reason: "scope" };
    return { ok: true, authUserId: row.authUserId as string };
  },
});

// Provision an agent API key for the owner's MCP/REST access. INTERNAL (operator-
// only via `convex run`) — not a public client door; mints a key the same way the
// dashboard's apiKeys.create does and returns the secret ONCE. Use until the
// dashboard scope picker offers booking:* scopes.
export const _mintAgentKey = internalMutation({
  args: {
    authUserId: v.string(),
    name: v.string(),
    scopes: v.array(v.string()),
  },
  handler: async (ctx, { authUserId, name, scopes }) => {
    const { secret, last4 } = generateApiKeySecret("live");
    const hashedKey = await hashApiKey(secret);
    await ctx.db.insert("apiKeys", {
      authUserId,
      name: name.slice(0, 80),
      mode: "live",
      scopes,
      hashedKey,
      last4,
      createdAt: Date.now(),
    });
    // The secret is returned ONCE here and never stored in plaintext.
    return { secret, last4, scopes };
  },
});

// Revoke agent API key(s) for an owner by last4 (the mint response echoes last4).
// INTERNAL (operator-only) — symmetric with _mintAgentKey for provisioning cleanup.
export const _revokeAgentKey = internalMutation({
  args: { authUserId: v.string(), last4: v.string() },
  handler: async (ctx, { authUserId, last4 }) => {
    const rows = await ctx.db
      .query("apiKeys")
      .withIndex("by_user", (q) => q.eq("authUserId", authUserId))
      .collect();
    let revoked = 0;
    for (const r of rows) {
      if (r.last4 === last4 && !r.revokedAt) {
        await ctx.db.patch(r._id, { revokedAt: Date.now() });
        revoked++;
      }
    }
    return { revoked };
  },
});

// ─── Internal query/mutation glue (httpActions can't read/write ctx.db) ──────
//
// The httpActions above delegate the DB-touching work to these so the
// public-safe projection + booking mutation run inside a real query/mutation
// context (httpActions have no ctx.db). Each just calls the testable Impl.

export const _publicEventType = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => getPublicEventTypeImpl(ctx, slug),
});

// ─── CV-2b: PUBLIC (registered, no-auth) event-type meta for the cal Booker SSR ─
//
// The httpAction above reaches `_publicEventType` via `ctx.runQuery` because it
// lives inside Convex. But the cal fork's SSR loader (EventRepository.getPublicEvent
// → calcomAdapters.mapConvexEventToPublicEvent) calls `getConvex().query(...)` —
// a server-to-server call against the Convex CLIENT API, which can ONLY reach
// PUBLIC (`query`/`mutation`) functions, never `internalQuery`. Before CV-2b the
// fork fell back to the OWNER-SCOPED `scheduling/eventTypes:getEventTypeBySlug`,
// which runs `requireAuthUserId` and therefore ALWAYS returned null for an
// anonymous visitor — so anonymous Booker pages showed only placeholder
// title/host meta (the slug as the title, a placeholder avatar).
//
// This `query` closes that gap: it is the SAME public-safe projection as
// `_publicEventType` (identical body via `getPublicEventTypeImpl`), but registered
// as a PUBLIC function so the fork's anonymous client can call it. It performs NO
// auth check and is intentionally readable by anyone — it returns ONLY the
// public-safe fields in `PublicEventTypeDto` (title, description, durationMinutes,
// location, requireLogin, and each host's displayName + avatarUrl). It NEVER
// returns ownerAuthUserId, scheduleId, buffers/limits, schedulingType, or any
// internal flag (active/hidden/requireCaptcha/isSingleUse/seatsPerSlot/…).
//
// Returns `null` (not a thrown error) for a missing OR inactive event type so the
// caller renders a 404 without being able to distinguish the two cases (no
// enumeration oracle): `getPublicEventTypeImpl` throws
// ConvexError({kind:"event_type_not_found"}) for both, which we collapse to null.
//
// NOTE: unlike the `/book/api/event-type/{slug}` httpAction, this query is NOT
// gated behind the `booking_enabled` flag. The flag gate exists to keep the
// PUBLIC HTTP booking SURFACE dark before launch; this query is reached only
// server-to-server by the trusted cal fork SSR loader (never exposed as a raw
// public URL), and the fork's own page wiring is what's dark before launch. The
// projection is public-safe regardless, so leaving it always-on lets the fork's
// owner-preview + SSR path render even while the HTTP surface is gated.
export const getPublicEventTypeBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }): Promise<PublicEventTypeDto | null> => {
    try {
      return await getPublicEventTypeImpl(ctx, slug);
    } catch {
      // getPublicEventTypeImpl throws ConvexError({kind:"event_type_not_found"})
      // for a missing or inactive event type; collapse to null for callers that
      // prefer a null sentinel over a thrown error (the cal SSR loader renders
      // 404 on null). Any other unexpected error also collapses to null rather
      // than leaking a 500 to the anonymous Booker.
      return null;
    }
  },
});

// CV-B5: PUBLIC booking-by-uid read for the cal confirmation page (`/booking/[uid]`).
// The booking lives in CONVEX (created via createBookingPublic) but the cal page's
// getUserBooking() reads `prisma.booking` → finds nothing on the no-Postgres fork → 404.
// This returns the raw pieces (booking + event type + organizer profile + attendees) that
// the fork shim maps into cal's confirmation shape. Anon-safe: null for missing/malformed uid.
export const getBookingByUid = query({
  args: { uid: v.string() },
  handler: async (ctx: Ctx, { uid }: { uid: string }) => {
    let booking;
    try {
      booking = await ctx.db.get(uid as Id<"bookings">);
    } catch {
      return null; // malformed Convex id
    }
    if (!booking) return null;

    const eventType = await ctx.db.get(booking.eventTypeId);
    const organizer = await getCalcomUserByAuthUserIdImpl(ctx, booking.ownerAuthUserId);
    const attendeeRows = await ctx.db
      .query("bookingAttendees")
      .withIndex("by_booking", (q: Ctx) => q.eq("bookingId", booking._id))
      .collect();

    return {
      uid: booking._id as string,
      startTime: booking.startTime as number,
      endTime: booking.endTime as number,
      status: booking.status as string,
      timeZone: booking.timeZone as string,
      location: (booking.locationText ?? null) as string | null,
      notes: (booking.bookerNotes ?? null) as string | null,
      eventType: eventType
        ? {
            title: eventType.title as string,
            slug: eventType.slug as string,
            schedulingType: eventType.schedulingType as string,
            durationMinutes: eventType.durationMinutes as number,
          }
        : null,
      organizer: organizer
        ? {
            name: organizer.name as string,
            email: organizer.email as string,
            username: organizer.username as string,
            timeZone: (organizer.timeZone ?? "UTC") as string,
            avatarUrl: (organizer.avatarUrl ?? null) as string | null,
          }
        : null,
      attendees: attendeeRows.map((a: { name: string; email: string; timeZone: string }) => ({
        name: a.name,
        email: a.email,
        timeZone: a.timeZone,
      })),
    };
  },
});

// ─── CV-3: PUBLIC (registered, no-auth) booking CREATE for the cal Booker flow ─
//
// WHY a public mutation in addition to the `POST /book/api/booking` httpAction:
// the cal fork's `/api/book/event` route runs server-side (Next API route, NOT a
// browser) and assembles a typed cal `BookingResponse` from the result. The
// established fork integration calls Convex via `getConvex().mutation(...)` (see
// `getPublicEventTypeBySlug` / the admin adapters), and `getConvex()` (the Convex
// CLIENT API) can reach ONLY public `query`/`mutation` — never `internalMutation`.
// `createBooking` (scheduling/booking.ts) and `_createBooking` (above) are both
// `internalMutation` by design, so this is the public client door.
//
// SECURITY — what this DOES and DOES NOT keep vs the httpAction:
//   - KEPT (live inside createBookingImpl → createBookingHandler): the DEFAULT-OFF
//     `booking_enabled` flag gate (throws `booking_disabled` when off, so this is
//     dark before launch exactly like the HTTP surface), idempotency dedupe, the
//     authoritative write-time slot-conflict re-check (→ `slot_unavailable`), and
//     the E4 per-event-type email-verification + single-use-link gates.
//   - NOT kept here: IP rate-limiting (`booking.create`, 10/min) and Turnstile
//     captcha. Those live ONLY in `bookCreateHandler` and are deliberately NOT in
//     the mutation. This mutation is therefore reached ONLY server-to-server by
//     the TRUSTED cal fork API route (same trust model as `getPublicEventTypeBySlug`),
//     never wired to a raw browser-facing URL. The cal route does its own bot
//     detection + core rate-limit before calling this (see CONVEX-REWIRE-NOTES.md).
//     A public browser booking path must still go through the httpAction.
//
// Returns the SAME enriched `CreateBookingConfirmation` the httpAction returns,
// so the fork's OUT adapter can build a complete cal BookingResponse from one call.
export const createBookingPublic = mutation({
  args: { body: v.any() },
  handler: async (ctx, { body }): Promise<CreateBookingConfirmation> =>
    createBookingImpl(ctx, body),
});

export const _publicSlots = internalQuery({
  args: {
    slug: v.string(),
    from: v.optional(v.string()),
    to: v.optional(v.string()),
    tz: v.optional(v.string()),
    // E4: when the event type is single-use, a burned/expired/unknown token
    // makes the page read as 410 gone before slots are computed.
    token: v.optional(v.string()),
  },
  handler: async (ctx, { slug, from, to, tz, token }) => {
    // E4 single-use gate (read path). For a single-use event type whose link is
    // already spent (or no token supplied) throw single_use_consumed → 410 so
    // the booking page stops showing slots after the one booking.
    const et = await ctx.db
      .query("eventTypes")
      .withIndex("by_slug", (q: Ctx) => q.eq("slug", slug))
      .unique();
    if (et && et.active !== false && et.isSingleUse === true) {
      const gone = await singleUseLinkIsGone(ctx, { eventType: et, token });
      if (gone) {
        throw new ConvexError({
          kind: "single_use_consumed",
          message: "This booking link has already been used.",
        });
      }
    }
    const params = new URLSearchParams();
    if (from !== undefined) params.set("from", from);
    if (to !== undefined) params.set("to", to);
    if (tz !== undefined) params.set("tz", tz);
    const parsed = parseSlotQuery(params, Date.now());
    return getPublicSlotsImpl(ctx, { slug, ...parsed });
  },
});

export const _createBooking = internalMutation({
  args: { body: v.any() },
  handler: async (ctx, { body }) => createBookingImpl(ctx, body),
});

export const _rescheduleBooking = internalMutation({
  args: { body: v.any() },
  handler: async (ctx, { body }) => rescheduleBookingImpl(ctx, body),
});

export const _cancelBooking = internalMutation({
  args: { body: v.any() },
  handler: async (ctx, { body }) => cancelBookingImpl(ctx, body),
});

// ─── E3 meeting-poll internal glue ────────────────────────────────────────────

// Public-safe poll DTO by id (organizer id + voter emails stripped; only the
// per-option aggregate tally + a voteCount leave the server). Returns null for
// a missing poll so the httpAction maps it to 404.
export const _publicPoll = internalQuery({
  args: { pollId: v.string() },
  handler: async (ctx, { pollId }): Promise<PublicPollDto | null> =>
    getPublicPollImpl(ctx, pollId),
});

// Record a vote (upsert per voter). The httpAction passes the parsed body with
// the `pollId` merged in from the URL. We validate the body shape here so a
// malformed payload is a clean 400 invalid_request rather than a raw throw.
export const _castPollVote = internalMutation({
  args: { body: v.any() },
  handler: async (ctx, { body }) => {
    if (!body || typeof body !== "object")
      throw new ConvexError({ kind: "invalid_request", message: "Body must be a JSON object." });
    if (typeof body.pollId !== "string" || !body.pollId)
      throw new ConvexError({ kind: "invalid_request", message: "pollId is required." });
    if (typeof body.voterEmail !== "string" || !body.voterEmail)
      throw new ConvexError({ kind: "invalid_request", message: "voterEmail is required." });
    if (!Array.isArray(body.selectedOptionIdxs))
      throw new ConvexError({ kind: "invalid_request", message: "selectedOptionIdxs must be an array." });
    const voteId = await votePollHandler(ctx, {
      pollId: body.pollId as Id<"bookingPolls">,
      voterEmail: body.voterEmail,
      voterName: typeof body.voterName === "string" ? body.voterName : undefined,
      selectedOptionIdxs: body.selectedOptionIdxs,
      ifNeededOptionIdxs: Array.isArray(body.ifNeededOptionIdxs)
        ? body.ifNeededOptionIdxs
        : undefined,
    });
    return { voteId, recorded: true };
  },
});

// ─── E4 anti-abuse internal glue ──────────────────────────────────────────────

// Mint a verification code (hash-stored) + schedule its email dispatch ATOMICALLY
// inside the mutation (the scheduler.runAfter commits with the row, same pattern
// as scheduleBookingSideEffects). Enumeration-safe: a missing/inactive/
// non-verification event type writes no row + schedules no email, and the caller
// returns sent:true regardless.
export const _requestVerificationCode = internalMutation({
  args: { slug: v.string(), email: v.string() },
  handler: async (ctx, { slug, email }) => {
    const minted = await requestVerificationCodeImpl(ctx, { slug, email });
    if (minted) {
      // Schedule the email send (actions can't run in a mutation). The code
      // never leaves the server except in this email.
      await ctx.scheduler.runAfter(0, refs._sendVerificationEmail, {
        email: minted.email,
        code: minted.code,
      });
    }
    return { sent: true };
  },
});

// Dispatch the OTP email via the shared Brevo channel (gated on EMAIL_API_KEY;
// no-op + warn when unset). The code is in the body; no .ics attachment.
export const _sendVerificationEmail = internalAction({
  args: { email: v.string(), code: v.string() },
  handler: async (_ctx, { email, code }): Promise<{ skipped: boolean }> => {
    return sendBrevoEmail({
      toEmail: email,
      toName: email,
      subject: "Your DibsList booking verification code",
      htmlContent:
        `<p>Your verification code is <strong>${code}</strong>.</p>` +
        `<p>It expires in 10 minutes. Enter it to confirm your booking.</p>`,
    });
  },
});

// Thin captcha-required probe for the booking POST httpAction (it must know
// whether to demand a turnstileToken before reaching the mutation).
export const _getCaptchaRequired = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, { slug }): Promise<boolean> => {
    const et = await ctx.db
      .query("eventTypes")
      .withIndex("by_slug", (q: Ctx) => q.eq("slug", slug))
      .unique();
    return et?.requireCaptcha === true && et.active !== false;
  },
});

// Re-export the Turnstile siteverify action so the booking httpAction can reach
// it as refs._verifyTurnstile (httpActions can't fetch in a mutation). The body
// lives in antiAbuse.ts (injectable-fetch + no-op when the secret is unset).
export const _verifyTurnstile = internalAction({
  args: { token: v.string(), remoteIp: v.optional(v.string()) },
  handler: async (_ctx, { token, remoteIp }): Promise<boolean> =>
    verifyTurnstileToken(token, remoteIp),
});
