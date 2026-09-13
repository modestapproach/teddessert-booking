// CV-4 — REWIRED onto the dibslist Convex backend.
//
// cal's host `requestReschedule` (a) sets the existing booking CANCELLED with
// `rescheduled: true`, (b) deletes the calendar/video meeting for the old slot, (c)
// emails the attendee a RESCHEDULE LINK so they re-pick a new slot themselves, and
// (d) fires a BOOKING_CANCELLED webhook with `requestReschedule: true`.
//
// Our Convex backend models only the STATUS change cleanly (`adminCancelBooking` →
// status `cancelled`, which fires our own `booking.cancelled` webhook + drops pending
// reminders inside the same ACID mutation). It has NO attendee-repick reschedule-link
// EMAIL/token flow and no per-booking calendar-event delete on cancel-for-reschedule.
// So this handler routes ONLY the status change to Convex; the attendee
// reschedule-link email + the old-slot calendar/video teardown have NO Convex
// equivalent and are DEFERRED (documented in CONVEX-REWIRE-NOTES.md CV-4). cal's
// React components + the tRPC client are UNTOUCHED — this is a resolver-body swap.
//
// The owner is `ctx.user.uuid` (the trusted dibslist authUserId the fork carries on
// the session); ownership is re-checked inside `adminCancelBooking`. `bookingUid` is
// the Convex booking `_id` string (CV-3 sets the booking uid = String(bookingId)).
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import { TRPCError } from "@trpc/server";
import type { TrpcSessionUser } from "../../../types";
import type { TRequestRescheduleInputSchema } from "./requestReschedule.schema";

type ActionSource = string;

type RequestRescheduleOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TRequestRescheduleInputSchema;
  source: ActionSource;
};
const log = logger.getSubLogger({ prefix: ["requestRescheduleHandler"] });
export const requestRescheduleHandler = async ({ ctx, input }: RequestRescheduleOptions) => {
  const { user } = ctx;
  const { bookingUid, rescheduleReason } = input;
  log.debug("Started (Convex)", safeStringify({ bookingUid }));

  const { requestRescheduleViaConvex } = await import(
    "@calcom/lib/server/convexBookingsListAdapter"
  );

  try {
    await requestRescheduleViaConvex({
      ownerAuthUserId: user.uuid,
      bookingUid,
      reason: rescheduleReason,
    });
  } catch (err) {
    log.error("requestRescheduleViaConvex failed", safeStringify({ bookingUid, err }));
    // Map the Convex ownership / status guards to a tRPC error the UI renders.
    const kind =
      err && typeof err === "object" && "data" in err
        ? (err as { data?: { kind?: string } }).data?.kind
        : undefined;
    if (kind === "booking_not_found") {
      throw new TRPCError({ code: "FORBIDDEN", message: "User isn't owner of the current booking" });
    }
    if (kind === "cannot_cancel_status") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Cannot request reschedule for cancelled or rejected booking",
      });
    }
    if (kind === "booking_disabled") {
      throw new TRPCError({ code: "NOT_FOUND", message: "Booking is not available." });
    }
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to request reschedule." });
  }
};
