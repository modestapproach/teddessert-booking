/**
 * CV-4 — booking DASHBOARD rewire adapter (cal `/bookings` list + host actions →
 * dibslist Convex).
 *
 * Companion to `convexBookingAdapter.ts` (the CV-3 booking-CREATE rewire). This
 * module sources the OWNER's bookings list + routes the two host actions that have a
 * Convex equivalent (cancel + requestReschedule's status-change) onto the dibslist
 * Convex backend via the server-to-server `scheduling/bookingAdmin:*` fns, which take
 * an explicit `ownerAuthUserId` (the trusted dibslist authUserId the fork carries on
 * `session.user.uuid`). See the Convex `bookingAdmin.ts` header for the trust model.
 *
 * What it owns:
 *   - `listBookingsViaConvex(...)` — IN (cal `get` filters → Convex listBookings) +
 *     OUT (Convex `{page,isDone,continueCursor}` rows → cal's
 *     `{bookings, recurringInfo, totalCount, nextCursor}` shape) for the
 *     `viewer.bookings.get` resolver. cal's offset/cursor pagination is mapped onto
 *     Convex cursor pagination (the cursor IS the offset-as-string in our shim).
 *   - `cancelBookingViaConvex(...)` — cal's `/api/cancel` (host/owner cancel) →
 *     `adminCancelBooking`.
 *   - `requestRescheduleViaConvex(...)` — the STATUS-change half of cal's
 *     `requestReschedule` (set the old booking terminal) → `adminCancelBooking`. The
 *     attendee-repick reschedule-link EMAIL/token flow has NO Convex equivalent and
 *     stays on the cal path (documented in CONVEX-REWIRE-NOTES.md CV-4).
 *
 * cal's `id` is a Prisma INTEGER; our bookings are keyed by an opaque Convex STRING
 * `_id`. CV-3 already exposes that string as the booking `uid`, so this list maps
 * `uid = String(booking._id)` and synthesizes a stable display-only `id` (FNV-1a int
 * of the `_id`) — the `/bookings` list + detail sheet key off `uid`, never the int.
 */
import { BookingStatus, SchedulingType } from "@calcom/prisma/enums";
import { getConvex } from "@calcom/lib/server/convex";
import { makeFunctionReference } from "convex/server";

// ─── server-to-server fn refs (addressed by path; fork has no _generated) ─────

const listBookingsRef = makeFunctionReference<"query">(
  "scheduling/bookingAdmin:listBookings"
);
const adminCancelBookingRef = makeFunctionReference<"mutation">(
  "scheduling/bookingAdmin:adminCancelBooking"
);
// NOTE: adminRescheduleBooking exists on the backend (owner direct reslot) but cal's
// host `requestReschedule` is NOT a direct reslot — it sets the old booking terminal
// and asks the attendee to re-pick. So this module routes requestReschedule to the
// CANCEL wrapper (the status change), not the reschedule wrapper. The reschedule
// wrapper is reached by the public Booker reschedule flow (separate path).

// ─── Convex wire shapes (mirror scheduling/bookingAdmin.ts) ───────────────────

type CalListStatus = "upcoming" | "past" | "cancelled" | "unconfirmed" | "recurring";

interface ConvexBookingRow {
  status: "accepted" | "pending" | "cancelled" | "rescheduled";
  startTime: number;
  endTime: number;
  timeZone: string;
  locationText?: string | null;
  bookerNotes?: string | null;
  idempotencyKey: string;
  rescheduledToBookingId?: string;
  rescheduledFromBookingId?: string;
  createdAt: number;
  updatedAt: number;
  _id: string;
  _creationTime: number;
}

interface ConvexAttendeeRow {
  _id: string;
  name: string;
  email: string;
  timeZone: string;
  role: "booker" | "host" | "guest";
  createdAt: number;
}

interface ConvexEventTypeSnapshot {
  _id: string;
  slug: string;
  title: string;
  durationMinutes: number;
  locationText: string | null;
  schedulingType: string | null;
}

interface ConvexListRow {
  booking: ConvexBookingRow;
  attendees: ConvexAttendeeRow[];
  eventType: ConvexEventTypeSnapshot | null;
}

interface ConvexListResponse {
  page: ConvexListRow[];
  isDone: boolean;
  continueCursor: string;
}

// FNV-1a → positive 31-bit int. DISPLAY-only id for the cal booking row (the list +
// detail sheet key off `uid`, never this int). Same precedent as
// `convexIdToCalInt` in calcomAdminAdapters.ts.
function convexIdToCalInt(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) & 0x7fffffff;
}

// Our 4-state status → cal's uppercase BookingStatus. `rescheduled` (our terminal
// rescheduled-away marker) maps to CANCELLED, matching cal's `cancelled` tab
// semantics (cal flags such bookings CANCELLED + rescheduled:true).
function toCalStatus(status: ConvexBookingRow["status"]): BookingStatus {
  switch (status) {
    case "accepted":
      return BookingStatus.ACCEPTED;
    case "pending":
      return BookingStatus.PENDING;
    case "cancelled":
      return BookingStatus.CANCELLED;
    case "rescheduled":
      return BookingStatus.CANCELLED;
    default:
      return BookingStatus.PENDING;
  }
}

function toCalSchedulingType(t: string | null): SchedulingType | null {
  switch (t) {
    case "round_robin":
      return SchedulingType.ROUND_ROBIN;
    case "collective":
      return SchedulingType.COLLECTIVE;
    case "managed":
      return SchedulingType.MANAGED;
    default:
      return null;
  }
}

// Map one Convex list row → the cal booking-row shape the list/detail sheet read.
// Cast `as any` at the call site: the Prisma-derived row type is far wider than the
// consumed fields, and the detail sheet re-fetches via getBookingDetails for the few
// extras (previousBooking/tracking) our backend doesn't model. We populate EVERY
// field the list row (BookingItemProps) + the detail sheet consume that maps onto our
// data, with safe defaults for the Prisma-only surface (see CONVEX-REWIRE-NOTES.md).
function mapConvexRowToCalBooking(row: ConvexListRow) {
  const b = row.booking;
  const uid = String(b._id);
  const isRescheduledAway = b.status === "rescheduled";
  const fromReschedule = b.rescheduledFromBookingId
    ? String(b.rescheduledFromBookingId)
    : null;

  const attendees = row.attendees
    .filter((a) => a.role === "booker" || a.role === "guest")
    .map((a) => ({
      id: convexIdToCalInt(a._id),
      name: a.name,
      email: a.email,
      timeZone: a.timeZone,
      phoneNumber: null,
      noShow: false,
      locale: null,
      // Enriched-from-users left-join is a cal-Postgres concept; our attendees are
      // raw candidates with no users row → user stays null (the list row tolerates).
      user: null as null,
    }));

  const et = row.eventType;
  const eventType = et
    ? {
        id: convexIdToCalInt(et._id),
        slug: et.slug,
        title: et.title,
        eventName: null as string | null,
        price: 0,
        currency: "usd",
        recurringEvent: null,
        metadata: {},
        disableGuests: false,
        bookingFields: null,
        seatsPerTimeSlot: null,
        seatsShowAttendees: null,
        seatsShowAvailabilityCount: null,
        eventTypeColor: null,
        customReplyToEmail: null,
        allowReschedulingPastBookings: false,
        hideOrganizerEmail: false,
        disableCancelling: false,
        disableRescheduling: false,
        minimumRescheduleNotice: null,
        teamId: null,
        parentId: null,
        schedulingType: toCalSchedulingType(et.schedulingType),
        length: et.durationMinutes,
        team: null,
        hosts: [],
        hostGroups: [],
      }
    : null;

  return {
    id: convexIdToCalInt(b._id),
    uid,
    title: et?.title ?? "Booking",
    description: b.bookerNotes ?? null,
    customInputs: null,
    // cal serializes startTime/endTime as ISO strings (handler does toISOString()).
    startTime: new Date(b.startTime).toISOString(),
    endTime: new Date(b.endTime).toISOString(),
    createdAt: new Date(b.createdAt),
    updatedAt: new Date(b.updatedAt),
    metadata: null,
    responses: {
      name: attendees[0]?.name ?? null,
      email: attendees[0]?.email ?? null,
      ...(b.bookerNotes ? { notes: b.bookerNotes } : {}),
    },
    recurringEventId: null,
    location: b.locationText ?? null,
    status: toCalStatus(b.status),
    paid: false,
    fromReschedule,
    // `rescheduled` = this booking was itself rescheduled away (terminal).
    rescheduled: isRescheduledAway || null,
    rescheduledBy: null,
    rescheduler: null,
    cancelledBy: null,
    isRecorded: false,
    cancellationReason: null,
    rejectionReason: null,
    userPrimaryEmail: null,
    user: null,
    attendees,
    eventType,
    references: [],
    payment: [],
    seatsReferences: [],
    assignmentReasonSortedByCreatedAt: [],
    report: null,
  };
}

// cal's get input filters (subset we honor). `statuses[0]` / `status` pick the tab;
// `afterStartDate`/`beforeEndDate` bound the window. Unhandled cal filters (teamIds,
// userIds, eventTypeIds, attendee name/email, bookingUid, updated/created windows)
// are NO-OPs in this rewire — our backend is single-owner/no-teams (see notes).
export interface CalGetFilters {
  status?: CalListStatus;
  statuses?: CalListStatus[];
  afterStartDate?: string;
  beforeEndDate?: string;
}

export interface ListBookingsArgs {
  ownerAuthUserId: string;
  filters: CalGetFilters;
  take: number;
  // cal's offset (list) or cursor (calendar). Both are an offset int in this shim.
  skip: number;
}

export interface CalGetResult {
  bookings: ReturnType<typeof mapConvexRowToCalBooking>[];
  recurringInfo: never[];
  totalCount: number;
  nextCursor: string | undefined;
}

// Resolve which cal tab to filter on (default upcoming, matching cal's getHandler).
function pickStatus(filters: CalGetFilters): CalListStatus {
  if (filters.statuses?.length) return filters.statuses[0];
  return filters.status ?? "upcoming";
}

/**
 * IN→OUT for `viewer.bookings.get`. Calls Convex `listBookings` owner-scoped, maps the
 * rows → cal booking rows, and rebuilds cal's offset/cursor pagination envelope.
 *
 * PAGINATION SHIM: our backend paginates by a Convex cursor; the cal list/calendar
 * pages by offset/cursor-as-offset. We translate cal's `skip` (offset) ↔ the Convex
 * cursor (which our shim defines AS the offset-as-string), request `take` items, and
 * compute `nextCursor = String(skip + page.length)` when `!isDone`. `totalCount` is
 * best-effort: when the page is the last one we return `skip + page.length` (exact);
 * otherwise we return a "+1" sentinel (`skip + page.length + 1`) so the infinite-query
 * UI keeps paging. This is honest about not doing a full COUNT (documented).
 */
export async function listBookingsViaConvex(
  args: ListBookingsArgs
): Promise<CalGetResult> {
  const status = pickStatus(args.filters);
  const after = args.filters.afterStartDate
    ? Date.parse(args.filters.afterStartDate)
    : undefined;
  const before = args.filters.beforeEndDate
    ? Date.parse(args.filters.beforeEndDate)
    : undefined;

  // recurring tab → always empty (no recurring model). Short-circuit (the backend
  // also returns empty, but skip the round-trip).
  if (status === "recurring") {
    return { bookings: [], recurringInfo: [], totalCount: args.skip, nextCursor: undefined };
  }

  const res = (await getConvex().query(listBookingsRef, {
    ownerAuthUserId: args.ownerAuthUserId,
    status,
    after,
    before,
    paginationOpts: { numItems: args.take, cursor: args.skip > 0 ? String(args.skip) : null },
  })) as ConvexListResponse;

  const bookings = res.page.map(mapConvexRowToCalBooking);
  const nextOffset = args.skip + bookings.length;
  const nextCursor = res.isDone ? undefined : String(nextOffset);
  // Exact when this is the last page; a "+1" sentinel keeps the infinite query going.
  const totalCount = res.isDone ? nextOffset : nextOffset + 1;

  return { bookings, recurringInfo: [], totalCount, nextCursor };
}

/**
 * Owner/host cancel → Convex `adminCancelBooking`. `bookingUid` is the Convex booking
 * `_id` string (CV-3 sets uid = String(bookingId)). Returns the cancelled booking id.
 */
export async function cancelBookingViaConvex(args: {
  ownerAuthUserId: string;
  bookingUid: string;
  reason?: string;
}): Promise<{ bookingId: string; status: string }> {
  return (await getConvex().mutation(adminCancelBookingRef, {
    ownerAuthUserId: args.ownerAuthUserId,
    bookingId: args.bookingUid,
    reason: args.reason,
  })) as { bookingId: string; status: string };
}

/**
 * requestReschedule STATUS-change → Convex `adminCancelBooking`. cal's host
 * requestReschedule cancels the old booking (rescheduled:true) and emails the attendee
 * a reschedule link. Our backend has no attendee-repick token/email flow, so this
 * routes ONLY the status change (cancel the old booking) to Convex; the email/webhook
 * side stays on the cal path. Documented gap in CONVEX-REWIRE-NOTES.md CV-4.
 */
export async function requestRescheduleViaConvex(args: {
  ownerAuthUserId: string;
  bookingUid: string;
  reason?: string;
}): Promise<{ bookingId: string; status: string }> {
  return cancelBookingViaConvex(args);
}
