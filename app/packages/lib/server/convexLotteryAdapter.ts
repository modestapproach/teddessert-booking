/**
 * BOOKING-LOTTERY — lottery-entry adapter (cal Booker → dibslist Convex).
 *
 * For `interactionMode: "lottery"` event types the Booker's submit is routed to
 * `/api/lottery/enter` (instead of `/api/book/event`), which calls the PUBLIC
 * Convex mutation `scheduling/lottery:enterSlotLotteryPublic` server-to-server
 * via `getConvex().mutation(...)` — the SAME trusted-fork pattern as
 * `createBookingViaConvex` (convexBookingAdapter.ts). No booking is created
 * here: the entry joins the slot's drawing; the draw at `closesAt` creates the
 * winner's real booking on the Convex side.
 *
 * IN adapter: cal's dynamic `BookingCreateBody` → the Convex enter body
 * { slug, start, end, name, email, notes, timeZone, intakeResponses } where
 * `intakeResponses` carries every NON-system answer from `responses` (custom
 * booking questions — "what kind of session do you want to shoot?").
 */
import { ErrorCode } from "@calcom/lib/errorCodes";
import { HttpError } from "@calcom/lib/http-error";
import { getConvex } from "@calcom/lib/server/convex";
import { makeFunctionReference } from "convex/server";

const enterSlotLotteryPublicRef = makeFunctionReference<"mutation">(
  "scheduling/lottery:enterSlotLotteryPublic"
);

/** What the Convex `enterSlotLotteryPublic` returns. */
export interface ConvexLotteryEntryResult {
  lotteryId: string;
  closesAt: number;
  entrantCount: number;
  alreadyEntered: boolean;
}

/** The wire shape `/api/lottery/enter` returns to the Booker client. */
export interface LotteryEnterResponse extends ConvexLotteryEntryResult {
  lotteryEntry: true; // discriminator for the client-side redirect
}

// cal system booking-field names — everything else in `responses` is a custom
// question whose answer we forward as an intake response.
const SYSTEM_RESPONSE_KEYS = new Set([
  "name",
  "email",
  "notes",
  "guests",
  "location",
  "title",
  "phone",
  "attendeePhoneNumber",
  "smsReminderNumber",
  "rescheduleReason",
]);

function flattenName(name: unknown): string {
  if (typeof name === "string") return name;
  if (name && typeof name === "object") {
    const n = name as { firstName?: string; lastName?: string };
    return [n.firstName, n.lastName].filter(Boolean).join(" ").trim();
  }
  return "";
}

function stringifyAnswer(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(stringifyAnswer).join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return "";
}

export function mapCalBodyToLotteryEnter(body: Record<string, any>): {
  slug: string;
  start: number;
  end: number;
  name: string;
  email: string;
  notes?: string;
  timeZone: string;
  intakeResponses?: Array<{ name: string; label: string; value: string }>;
} {
  const responses = (body?.responses ?? {}) as Record<string, any>;

  const slug: string | undefined = body?.eventTypeSlug;
  const startIso: string | undefined = body?.start;
  const endIso: string | undefined = body?.end;
  const timeZone: string = body?.timeZone ?? "UTC";

  const name = flattenName(responses.name) || flattenName(body?.name);
  const email: string = responses.email ?? body?.email ?? "";
  const notes: string | undefined = responses.notes || body?.notes || undefined;

  const bad = (m: string): never => {
    throw new HttpError({ statusCode: 400, message: m });
  };
  if (!slug) bad("eventTypeSlug is required.");
  if (!startIso) bad("start is required.");
  if (!endIso) bad("end is required.");
  if (!name) bad("Entrant name is required.");
  if (!email) bad("Entrant email is required.");

  const startMs = new Date(startIso as string).getTime();
  const endMs = new Date(endIso as string).getTime();
  if (Number.isNaN(startMs)) bad("start is not a valid date.");
  if (Number.isNaN(endMs)) bad("end is not a valid date.");

  // Every non-system answer is a custom intake question. Label falls back to
  // the field name (the fork's bookingFields don't round-trip labels yet).
  const intakeResponses = Object.entries(responses)
    .filter(([key, v]) => !SYSTEM_RESPONSE_KEYS.has(key) && v != null && v !== "")
    .map(([key, v]) => ({ name: key, label: key, value: stringifyAnswer(v) }))
    .filter((r) => r.value !== "");

  return {
    slug: slug as string,
    start: startMs,
    end: endMs,
    name,
    email,
    notes,
    timeZone,
    ...(intakeResponses.length > 0 ? { intakeResponses } : {}),
  };
}

/** Map Convex lottery error kinds → the cal `HttpError` the Booker renders. */
export function mapConvexLotteryError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const data = (err as { data?: any })?.data;
  const kind: string | undefined =
    typeof data === "object" && data ? data.kind : undefined;
  const message: string | undefined =
    (typeof data === "object" && data ? data.message : undefined) ??
    (err instanceof Error ? err.message : undefined);

  switch (kind) {
    case "lottery_closed":
      return new HttpError({
        statusCode: 410,
        message: "Entries for this time have closed.",
      });
    case "not_a_lottery_event":
      return new HttpError({
        statusCode: 400,
        message: "This event does not use a drawing.",
      });
    case "slot_unavailable":
      return new HttpError({ statusCode: 409, message: ErrorCode.NoAvailableUsersFound });
    case "booking_too_soon":
    case "outside_booking_window":
    case "invalid_duration":
      return new HttpError({ statusCode: 400, message: ErrorCode.BookingTimeOutOfBounds });
    case "event_type_not_found":
      return new HttpError({ statusCode: 404, message: ErrorCode.EventTypeNotFound });
    case "booking_disabled":
    case "lottery_disabled":
      // Dark launch → clean 404 (don't reveal the surface).
      return new HttpError({ statusCode: 404, message: ErrorCode.NotFound });
    case "invalid_request":
      return new HttpError({ statusCode: 400, message: message ?? ErrorCode.RequestBodyInvalid });
    default:
      return new HttpError({
        statusCode: 500,
        message: message ?? ErrorCode.InternalServerError,
      });
  }
}

/** IN adapter → Convex `enterSlotLotteryPublic` → wire response. */
export async function enterLotteryViaConvex(
  body: Record<string, any>
): Promise<LotteryEnterResponse> {
  const enterBody = mapCalBodyToLotteryEnter(body);
  try {
    const result = (await getConvex().mutation(
      enterSlotLotteryPublicRef,
      enterBody
    )) as ConvexLotteryEntryResult;
    return { ...result, lotteryEntry: true };
  } catch (err) {
    throw mapConvexLotteryError(err);
  }
}
