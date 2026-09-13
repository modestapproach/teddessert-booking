/**
 * CV-3 — booking-create rewire adapter (cal Booker → dibslist Convex).
 *
 * The cal Booker POSTs to `/api/book/event` (apps/web/pages/api/book/event.ts).
 * Instead of cal's `RegularBookingService.createBooking` (Postgres/Prisma), that
 * route now routes the create to the dibslist Convex backend's PUBLIC booking
 * mutation `scheduling/publicApi:createBookingPublic`, reached server-to-server
 * via `getConvex().mutation(...)` (the same trusted-fork pattern as
 * `getPublicEventTypeBySlug`). cal's `handleNewBooking` / `RegularBookingService`
 * is SKIPPED entirely on this path.
 *
 * This module owns the two boundary translations:
 *   - IN  adapter (`mapCalBookingBodyToConvexCreate`): cal's dynamic `BookingCreateBody`
 *     (responses.name/email/notes, eventTypeSlug, start/end ISO, timeZone, …) →
 *     the Convex `createBookingPublic` body { slug, start, end, name, email, notes,
 *     idempotencyKey, holderToken, timeZone, verificationCode }.
 *   - OUT adapter (`mapConvexConfirmationToBookingResponse`): the Convex
 *     `CreateBookingConfirmation` → a cal `BookingResponse` carrying EVERY field
 *     the Booker success flow (useBookings.onSuccess + bookingSuccessRedirect)
 *     destructures, with safe defaults for the Prisma-only fields that flow no
 *     further than the `/booking/{uid}` redirect (which re-fetches from the DB).
 *
 * Convex error kinds are mapped to the cal `HttpError` the Booker already renders:
 * `slot_unavailable` → `ErrorCode.NoAvailableUsersFound` (the canonical
 * "slot no longer available" error the Booker shows on conflict).
 */
import { ErrorCode } from "@calcom/lib/errorCodes";
import { HttpError } from "@calcom/lib/http-error";
import { getConvex } from "@calcom/lib/server/convex";
import type { BookingResponse } from "@calcom/features/bookings/types";
import { makeFunctionReference } from "convex/server";

// PUBLIC, no-auth, booking_enabled-gated booking CREATE. Reached only
// server-to-server by this trusted route (never a raw browser URL). The Convex
// mutation keeps the flag gate + idempotency + slot-conflict re-check + E4 gates;
// IP-rate-limit + Turnstile live in the parallel httpAction, not here (this route
// does its own bot-detection + core rate-limit upstream).
const createBookingPublicRef = makeFunctionReference<"mutation">(
  "scheduling/publicApi:createBookingPublic"
);

/** The enriched confirmation the Convex `createBookingPublic` returns (CV-3). */
export interface ConvexCreateBookingConfirmation {
  bookingId: string;
  status: string;
  deduplicated?: boolean;
  ics: string;
  rescheduleToken: string;
  cancelToken: string;
  // CV-3 echo (public-safe) — lets the OUT adapter build BookingResponse in one call.
  eventTitle: string;
  eventLocation: string | null;
  start: number;
  end: number;
  bookerName: string;
  bookerEmail: string;
  bookerTimeZone: string;
  notes: string | null;
}

/** Body shape the Convex `createBookingPublic` mutation expects. */
export interface ConvexCreateBookingBody {
  slug: string;
  start: number;
  end: number;
  name: string;
  email: string;
  notes?: string;
  idempotencyKey: string;
  holderToken: string;
  timeZone: string;
  verificationCode?: string;
}

/**
 * Flatten cal's `responses.name` (string OR { firstName, lastName }) to a single
 * display name, mirroring how cal derives the attendee name in getBookingData.
 */
function flattenName(name: unknown): string {
  if (typeof name === "string") return name;
  if (name && typeof name === "object") {
    const n = name as { firstName?: string; lastName?: string };
    return [n.firstName, n.lastName].filter(Boolean).join(" ").trim();
  }
  return "";
}

/** Deterministic-ish idempotency key for a create (slug + start + email). The
 * Convex side dedupes by this key, so a retried POST with identical inputs maps
 * to the same booking instead of double-booking. */
function deriveIdempotencyKey(slug: string, startMs: number, email: string): string {
  return `cal:${slug}:${startMs}:${email.toLowerCase()}`;
}

/**
 * IN adapter — cal `/api/book/event` body → Convex `createBookingPublic` body.
 *
 * @throws HttpError(400) when required fields (slug, start, attendee name/email)
 *         are missing — surfaced to the Booker as a clean 400.
 */
export function mapCalBookingBodyToConvexCreate(
  body: Record<string, any>
): ConvexCreateBookingBody {
  const responses = (body?.responses ?? {}) as Record<string, any>;

  const slug: string | undefined = body?.eventTypeSlug;
  const startIso: string | undefined = body?.start;
  const endIso: string | undefined = body?.end;
  const timeZone: string = body?.timeZone ?? "UTC";

  const name = flattenName(responses.name) || flattenName(body?.name);
  const email: string = responses.email ?? body?.email ?? "";
  const notes: string | undefined = responses.notes || body?.notes || undefined;
  const verificationCode: string | undefined = body?.verificationCode;

  const bad = (m: string): never => {
    throw new HttpError({ statusCode: 400, message: m });
  };

  if (!slug) bad("eventTypeSlug is required.");
  if (!startIso) bad("start is required.");
  if (!name) bad("Attendee name is required.");
  if (!email) bad("Attendee email is required.");

  const startMs = new Date(startIso as string).getTime();
  if (Number.isNaN(startMs)) bad("start is not a valid date.");

  // cal always sends `end`, but tolerate a missing one (defaults handled upstream
  // by the mapper). If absent we cannot infer duration here, so require it.
  if (!endIso) bad("end is required.");
  const endMs = new Date(endIso as string).getTime();
  if (Number.isNaN(endMs)) bad("end is not a valid date.");

  return {
    slug: slug as string,
    start: startMs,
    end: endMs,
    name,
    email,
    notes,
    idempotencyKey: deriveIdempotencyKey(slug as string, startMs, email),
    // cal's hold model differs from dibslist's; createBooking tolerates an empty
    // holder token (the write-time conflict re-check is the authoritative guard).
    holderToken: "",
    timeZone,
    verificationCode,
  };
}

/**
 * OUT adapter — Convex `CreateBookingConfirmation` → cal `BookingResponse`.
 *
 * Produces every field the Booker success flow reads:
 *   useBookings.onSuccess: uid, id, title, startTime, endTime, eventTypeId,
 *     status, videoCallUrl, paymentRequired, isRecurring, paymentUid,
 *     seatReferenceUid, userPrimaryEmail, user{email,timeZone}, attendees[0],
 *     isDryRun, isShortCircuitedBooking, location.
 *   bookingSuccessRedirect: uid, title, description, startTime, endTime,
 *     location, attendees, user{name,timeZone}, responses{name,phone}.
 *
 * Prisma-only columns that flow nowhere past the `/booking/{uid}` redirect (which
 * server-re-fetches fresh DB data) get safe defaults. `startTime`/`endTime` are
 * real Date objects (cal's `create-booking.ts` declares them as strings over the
 * wire — `defaultResponder`'s JSON serialization renders Dates to ISO strings, so
 * the on-the-wire contract matches; the in-process type is `BookingResponse`).
 */
export function mapConvexConfirmationToBookingResponse(
  confirmation: ConvexCreateBookingConfirmation,
  ctx: { eventTypeId: number | null }
): BookingResponse {
  const startTime = new Date(confirmation.start);
  const endTime = new Date(confirmation.end);
  const uid = String(confirmation.bookingId);

  // cal status enum is uppercase ("ACCEPTED" | "PENDING" | …); Convex returns
  // lowercase ("accepted"). Map to cal's BookingStatus string.
  const status = confirmation.status === "accepted" ? "ACCEPTED" : "PENDING";

  const attendees = [
    {
      id: 0,
      email: confirmation.bookerEmail,
      name: confirmation.bookerName,
      timeZone: confirmation.bookerTimeZone,
      locale: null,
      phoneNumber: null,
      bookingId: null,
      noShow: false,
    },
  ];

  const out = {
    // ── Identifiers + core slot ──────────────────────────────────────────────
    id: 0, // Prisma int id; the success page keys off `uid`, not `id`.
    uid,
    title: confirmation.eventTitle,
    startTime,
    endTime,
    status,
    location: confirmation.eventLocation,
    description: confirmation.notes,
    // The Booker re-renders responses on the success page; mirror what we sent so
    // bookingSuccessRedirect can extract name/phone if it forwards params.
    responses: {
      name: confirmation.bookerName,
      email: confirmation.bookerEmail,
      ...(confirmation.notes ? { notes: confirmation.notes } : {}),
    },
    metadata: null,

    // ── Attendees + organizer (email nulled, mirroring RegularBookingService) ──
    attendees,
    user: {
      id: 0,
      name: confirmation.eventTitle, // host display name is re-fetched on the success page
      email: null,
      timeZone: confirmation.bookerTimeZone,
      username: null,
    },
    userId: null,
    userUuid: null,
    userPrimaryEmail: null,
    eventTypeId: ctx.eventTypeId,

    // ── Payment / flags the success flow gates on ─────────────────────────────
    paid: false,
    paymentRequired: false,
    cancellationReason: null,
    rescheduled: false,
    fromReschedule: null,
    recurringEventId: null,
    isRecurring: false,
    iCalUID: `${uid}@teddessert.com`,
    iCalSequence: 0,
    oneTimePassword: null,
    smsReminderNumber: null,
    scheduledJobs: [] as string[],
    references: [] as unknown[],
    payment: [] as unknown[],

    // ── Always-present augmented fields ───────────────────────────────────────
    isDryRun: false,
    seatReferenceUid: undefined,
    videoCallUrl: undefined,
    previousBooking: null,
  };

  // BookingResponse is a Prisma-derived structural type far wider than the fields
  // the Booker reads; this boundary cast is the established pattern for adapting
  // an external data source into it (the success page re-fetches from the DB, so
  // only the destructured fields above actually matter on the wire).
  return out as unknown as BookingResponse;
}

/**
 * Map a Convex booking error (ConvexError data.kind, or a thrown HttpError from
 * the IN adapter) to the cal `HttpError` the Booker renders.
 */
export function mapConvexBookingError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;

  // ConvexError surfaces its payload on `.data` (server-to-server) — the kind
  // field is our RFC-9457-style discriminator.
  const data = (err as { data?: any })?.data;
  const kind: string | undefined =
    typeof data === "object" && data ? data.kind : undefined;
  const message: string | undefined =
    (typeof data === "object" && data ? data.message : undefined) ??
    (err instanceof Error ? err.message : undefined);

  switch (kind) {
    case "slot_unavailable":
      // The canonical "slot no longer available / no host free" error the Booker
      // already shows on conflict.
      return new HttpError({ statusCode: 409, message: ErrorCode.NoAvailableUsersFound });
    case "booking_too_soon":
    case "outside_booking_window":
    case "invalid_duration":
      return new HttpError({ statusCode: 400, message: ErrorCode.BookingTimeOutOfBounds });
    case "event_type_not_found":
    case "event_type_inactive":
      return new HttpError({ statusCode: 404, message: ErrorCode.EventTypeNotFound });
    case "booking_disabled":
      // Surface dark-launch as a clean 404 (the whole booking surface is off).
      return new HttpError({ statusCode: 404, message: ErrorCode.NotFound });
    case "email_verification_required":
      return new HttpError({ statusCode: 400, message: ErrorCode.InvalidVerificationCode });
    case "invalid_request":
      return new HttpError({ statusCode: 400, message: message ?? ErrorCode.RequestBodyInvalid });
    default:
      return new HttpError({
        statusCode: 500,
        message: message ?? ErrorCode.InternalServerError,
      });
  }
}

/**
 * Top-level CV-3 booking-create: IN adapter → Convex `createBookingPublic` →
 * OUT adapter. Throws a cal `HttpError` (mapped) on any failure so the
 * `defaultResponder` wrapper renders the right status + message to the Booker.
 */
export async function createBookingViaConvex(
  body: Record<string, any>
): Promise<BookingResponse> {
  const convexBody = mapCalBookingBodyToConvexCreate(body);
  const eventTypeId =
    typeof body?.eventTypeId === "number" ? body.eventTypeId : null;

  try {
    const confirmation = (await getConvex().mutation(createBookingPublicRef, {
      body: convexBody,
    })) as ConvexCreateBookingConfirmation;

    return mapConvexConfirmationToBookingResponse(confirmation, { eventTypeId });
  } catch (err) {
    throw mapConvexBookingError(err);
  }
}

/**
 * CV-3b — booking RESCHEDULE rewire (the Booker submitting with `rescheduleUid`).
 *
 * There is no PUBLIC Convex client mutation for reschedule (`_rescheduleBooking`
 * is internal by design), so this goes through the existing public httpAction
 * `POST {convex .site}/book/api/reschedule` server-to-server — the same
 * token-guarded door external callers use (F1: rescheduleToken === bookingId).
 * That endpoint owns the flag gate, status guards ("cannot reschedule a
 * cancelled booking"), the authoritative slot re-check, and the full side-effect
 * cascade (old Google event deleted + new one created, notifications, webhooks).
 *
 * The response is the slim `{ oldBookingId, newBookingId, status, … }` (not the
 * enriched create confirmation), so the OUT mapping echoes the request fields —
 * safe because the success page re-fetches everything from `getBookingByUid`.
 */
export async function rescheduleBookingViaConvex(
  body: Record<string, any>
): Promise<BookingResponse> {
  // Reuse the create IN-mapper for field extraction + 400-validation (slug,
  // start/end, name/email); reschedule needs the same fields plus the uid.
  const convexBody = mapCalBookingBodyToConvexCreate(body);
  const rescheduleUid = String(body.rescheduleUid ?? "");
  if (!rescheduleUid) {
    throw new HttpError({ statusCode: 400, message: "rescheduleUid is required." });
  }
  const eventTypeId = typeof body?.eventTypeId === "number" ? body.eventTypeId : null;

  // httpActions live on the deployment's .site host (the .cloud host serves the
  // client API). Same env var the rest of the fork keys off.
  const siteUrl = (process.env.NEXT_PUBLIC_CONVEX_URL ?? "").replace(
    ".convex.cloud",
    ".convex.site"
  );

  const res = await fetch(`${siteUrl}/book/api/reschedule`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bookingId: rescheduleUid,
      rescheduleToken: rescheduleUid,
      start: convexBody.start,
      end: convexBody.end,
      name: convexBody.name,
      email: convexBody.email,
      timeZone: convexBody.timeZone,
      notes: convexBody.notes,
      // Distinct namespace from creates so a reschedule retry dedupes to the
      // same reschedule rather than colliding with a create of the same slot.
      idempotencyKey: `cal-resch:${rescheduleUid}:${convexBody.start}:${convexBody.email.toLowerCase()}`,
    }),
  });

  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    // The httpAction answers RFC-9457 (`{ code, detail }`); its `code` carries the
    // same kind strings ConvexError uses — synthesize the shape mapConvexBookingError
    // already switches on instead of duplicating the mapping.
    throw mapConvexBookingError({ data: { kind: json?.code, message: json?.detail } });
  }

  const confirmation: ConvexCreateBookingConfirmation = {
    bookingId: String(json.newBookingId),
    status: String(json.status ?? "accepted"),
    deduplicated: json.deduplicated,
    ics: "",
    rescheduleToken: String(json.rescheduleToken ?? json.newBookingId),
    cancelToken: String(json.cancelToken ?? json.newBookingId),
    eventTitle: String(body?.eventTypeSlug ?? "Booking"),
    eventLocation: null,
    start: convexBody.start,
    end: convexBody.end,
    bookerName: convexBody.name,
    bookerEmail: convexBody.email,
    bookerTimeZone: convexBody.timeZone,
    notes: convexBody.notes ?? null,
  };
  const out = mapConvexConfirmationToBookingResponse(confirmation, { eventTypeId });
  // Mark the response as a reschedule so the success flow renders the right copy.
  (out as { rescheduled?: boolean }).rescheduled = true;
  (out as { fromReschedule?: string | null }).fromReschedule = rescheduleUid;
  return out;
}
