// CV-4 — SERVER-TO-SERVER owner bookings DASHBOARD surface for the forked cal.com
// app (the `/bookings` list + detail sheet).
//
// WHY THIS EXISTS
// ───────────────
// The forked cal.com app reaches Convex through `getConvex()` — a `ConvexHttpClient`
// with NO Convex-verifiable identity token (it validates the dibslist Better-Auth
// COOKIE itself in `getServerSession`, then carries the trusted authUserId string on
// `session.user.uuid`). So it CANNOT call any `requireAuthUserId`-gated fn as the
// user. This module is the bridge — modeled VERBATIM on the established
// `scheduling/calcomAdmin.ts` precedent: registered `query`/`mutation` fns that take
// an EXPLICIT `ownerAuthUserId` arg (the trusted authUserId) and either read
// owner-scoped rows or delegate to the post-auth booking handlers.
//
// TRUST MODEL (identical to calcomAdmin.ts):
//   - NO Convex auth check. The ONLY caller is the fork's tRPC resolver / API-route
//     layer, which runs server-side AFTER `getServerSession` validated the cookie
//     (fail-closed) and resolved the authUserId, then passes it as `ownerAuthUserId`.
//   - Every read is owner-scoped by the explicit arg → leaks nothing cross-owner.
//   - Every WRITE additionally re-checks `booking.ownerAuthUserId === ownerAuthUserId`
//     (so even a forged owner arg can only touch rows it already owns — no
//     escalation, just delegation) AND inherits the DEFAULT-OFF `booking_enabled`
//     flag gate from `cancelBookingHandler`/`rescheduleBookingHandler`'s `gateBooking`.
//
// HOST-ACTION COVERAGE (see CONVEX-REWIRE-NOTES.md CV-4): only `cancel` and
// `rescheduleBooking` map cleanly to a Convex op. `requestReschedule` (host asks the
// attendee to re-pick a slot, with a reschedule-link email) is routed to
// `adminCancelBooking` for the STATUS change only — the attendee-repick email /
// token flow has NO Convex equivalent and stays on the cal path. `confirm`,
// `editLocation`, `markNoShow`, `addGuests` have no Convex equivalent → DEFERRED.

import { v, ConvexError } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { paginationOptsValidator } from "convex/server";
import { cancelBookingHandler, rescheduleBookingHandler } from "./booking";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

// cal's list tab enum. We DON'T model `recurring` (no recurring-series support) —
// the fork maps that tab to an empty page. The four we support map onto our 4-state
// status model + an endTime-vs-now window. See `bookingMatchesStatus` below.
const calListStatus = v.union(
  v.literal("upcoming"),
  v.literal("past"),
  v.literal("cancelled"),
  v.literal("unconfirmed"),
  v.literal("recurring"),
);

export type CalListStatus =
  | "upcoming"
  | "past"
  | "cancelled"
  | "unconfirmed"
  | "recurring";

// Map a raw booking row → does it belong on the requested cal list tab?
// Mirrors cal's `addStatusesQueryFilters` SQL semantics, projected onto our
// statuses (`accepted | pending | cancelled | rescheduled`):
//   - upcoming    : endTime >= now AND status ∈ {accepted, pending}
//   - past        : endTime <= now AND status ∈ {accepted, pending}
//   - cancelled   : status ∈ {cancelled, rescheduled}   (cal lumps rescheduled-away
//                   bookings into its CANCELLED tab via the `rescheduled` flag)
//   - unconfirmed : endTime >= now AND status == pending
//   - recurring   : never (no recurring model) → always false
export function bookingMatchesStatus(
  booking: { status: string; endTime: number },
  status: CalListStatus | undefined,
  nowMs: number,
): boolean {
  if (!status) return true; // undefined = all
  const live = booking.status === "accepted" || booking.status === "pending";
  switch (status) {
    case "upcoming":
      return live && booking.endTime >= nowMs;
    case "past":
      return live && booking.endTime <= nowMs;
    case "cancelled":
      return booking.status === "cancelled" || booking.status === "rescheduled";
    case "unconfirmed":
      return booking.status === "pending" && booking.endTime >= nowMs;
    case "recurring":
      return false;
    default:
      return false;
  }
}

// A list row: the full booking + its attendees + a minimal event-type snapshot the
// cal list/detail-sheet read (title / slug / length / location / schedulingType).
export interface BookingListRow {
  booking: Record<string, unknown>;
  attendees: Array<Record<string, unknown>>;
  eventType: {
    _id: Id<"eventTypes">;
    slug: string;
    title: string;
    durationMinutes: number;
    locationText: string | null;
    schedulingType: string | null;
  } | null;
}

// Core: owner-scoped, status + time-window filtered, paginated list of bookings.
// Exported as a bare fn for the FakeDb-harness tests; the registered `query` wraps it.
//
// QUERY PLAN: scan the `by_owner_startTime` index bounded by [after, before] on
// startTime (single index range, no full-table scan), then post-filter by the cal
// status tab in JS (no composite owner+status index exists). Convex `.paginate()`
// advances its cursor over the SCANNED rows, so when a status filter drops rows the
// returned page may be SMALLER than `numItems` requested — an accepted caveat at
// pilot scale (documented in CONVEX-REWIRE-NOTES.md). The fork's offset→cursor shim
// tolerates short pages (it relies on `nextCursor`/`isDone`, not exact page size).
export async function listBookingsCore(
  ctx: Ctx,
  args: {
    ownerAuthUserId: string;
    status?: CalListStatus;
    after?: number;
    before?: number;
    nowMs?: number;
    paginationOpts: { numItems: number; cursor: string | null };
  },
): Promise<{
  page: BookingListRow[];
  isDone: boolean;
  continueCursor: string;
}> {
  const now = args.nowMs ?? Date.now();
  const lower = args.after ?? 0;
  const upper = args.before ?? Number.MAX_SAFE_INTEGER;

  const page = await ctx.db
    .query("bookings")
    .withIndex("by_owner_startTime", (q: Ctx) =>
      q
        .eq("ownerAuthUserId", args.ownerAuthUserId)
        .gte("startTime", lower)
        .lte("startTime", upper),
    )
    .paginate(args.paginationOpts);

  const filtered: Array<Record<string, unknown>> = page.page.filter(
    (b: { status: string; endTime: number }) =>
      bookingMatchesStatus(b, args.status, now),
  );

  // Join attendees + a minimal event-type snapshot for each surviving row.
  const rows: BookingListRow[] = await Promise.all(
    filtered.map(async (booking) => {
      const bId = (booking as { _id: Id<"bookings"> })._id;
      const attendees = await ctx.db
        .query("bookingAttendees")
        .withIndex("by_booking", (q: Ctx) => q.eq("bookingId", bId))
        .collect();
      const etId = (booking as { eventTypeId: Id<"eventTypes"> }).eventTypeId;
      const et = await ctx.db.get(etId);
      return {
        booking,
        attendees,
        eventType: et
          ? {
              _id: et._id as Id<"eventTypes">,
              slug: et.slug as string,
              title: et.title as string,
              durationMinutes: et.durationMinutes as number,
              locationText: (et.locationText as string | undefined) ?? null,
              schedulingType: (et.schedulingType as string | undefined) ?? null,
            }
          : null,
      };
    }),
  );

  return {
    page: rows,
    isDone: page.isDone,
    continueCursor: page.continueCursor,
  };
}

// CV-4 — owner bookings list (s2s, explicit owner, no Convex identity). Read-only,
// owner-scoped by the explicit arg → leaks nothing cross-owner. NOT flag-gated (a
// read is harmless dark; the fork only shows it to a signed-in owner). Returns the
// rows + attendees + event-type snapshot the cal list/detail sheet consume, plus the
// Convex pagination envelope (the fork maps {isDone, continueCursor} ↔ cal's
// {nextCursor, totalCount} offset/cursor shim).
export const listBookings = query({
  args: {
    ownerAuthUserId: v.string(),
    status: v.optional(calListStatus),
    after: v.optional(v.number()),
    before: v.optional(v.number()),
    nowMs: v.optional(v.number()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { paginationOpts, ...rest }) =>
    listBookingsCore(ctx, { ...rest, paginationOpts }),
});

// ─────────────────────────────────────────────────────────────
// OWNER cancel / reschedule (s2s wrappers — mirror createBookingPublic)
// ─────────────────────────────────────────────────────────────
//
// `cancelBooking` / `rescheduleBooking` (scheduling/booking.ts) are `internalMutation`
// by design (the public entry is the F1 httpAction's IP-rate-limit + token gate). The
// fork's owner dashboard has no httpAction in the loop — it calls these as the
// already-authenticated owner. So these wrappers expose a PUBLIC `mutation` door that
// (1) re-checks ownership against the trusted `ownerAuthUserId`, then (2) delegates to
// the SAME post-gate handler the internalMutation registers. The flag gate
// (`gateBooking`) + status-transition guards live INSIDE those handlers and still hold.

// Owner-scoped cancel. Mirrors cal's `cancel` (/api/cancel → handleCancelBooking) +
// the STATUS-change half of `requestReschedule`. Ownership-guarded, then delegates to
// cancelBookingHandler (flag gate + "cannot cancel a <status> booking" guard inside).
export const adminCancelBooking = mutation({
  args: {
    ownerAuthUserId: v.string(),
    bookingId: v.id("bookings"),
    reason: v.optional(v.string()),
    nowMs: v.optional(v.number()),
  },
  handler: async (ctx, { ownerAuthUserId, bookingId, reason, nowMs }) => {
    const booking = await ctx.db.get(bookingId);
    if (!booking || booking.ownerAuthUserId !== ownerAuthUserId) {
      throw new ConvexError({ kind: "booking_not_found", message: "Not found." });
    }
    return cancelBookingHandler(ctx, { bookingId, reason, nowMs });
  },
});

// Owner-scoped direct reschedule (host picks the new slot). Mirrors cal's direct
// host reslot. Ownership-guarded, then delegates to rescheduleBookingHandler (flag
// gate + status guard + authoritative conflict re-check inside). `holderToken` is
// optional from the owner (they hold no bookingHolds row for the new slot) — the
// handler tolerates an empty/missing hold; the conflict re-check is authoritative.
export const adminRescheduleBooking = mutation({
  args: {
    ownerAuthUserId: v.string(),
    oldBookingId: v.id("bookings"),
    newStartTime: v.number(),
    newEndTime: v.number(),
    newBookerTimeZone: v.string(),
    idempotencyKey: v.string(),
    holderToken: v.optional(v.string()),
    attendee: v.object({
      name: v.string(),
      email: v.string(),
      timeZone: v.string(),
      notes: v.optional(v.string()),
    }),
    nowMs: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { ownerAuthUserId, oldBookingId, holderToken, ...rest },
  ) => {
    const booking = await ctx.db.get(oldBookingId);
    if (!booking || booking.ownerAuthUserId !== ownerAuthUserId) {
      throw new ConvexError({ kind: "booking_not_found", message: "Not found." });
    }
    return rescheduleBookingHandler(ctx, {
      oldBookingId,
      holderToken: holderToken ?? "",
      ...rest,
    });
  },
});
