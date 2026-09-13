import { prisma } from "@calcom/prisma";
import type {
  Booking,
  EventType,
  BookingReference,
  Attendee,
  Credential,
  DestinationCalendar,
  User,
} from "@calcom/prisma/client";
import { MembershipRole, SchedulingType } from "@calcom/prisma/enums";

import { TRPCError } from "@trpc/server";

import authedProcedure from "../../../procedures/authedProcedure";
import { commonBookingSchema } from "./types";

export const bookingsProcedure = authedProcedure
  .input(commonBookingSchema)
  .use(async ({ next: _next }) => {
    // CV-9 — THE THIRD CHOKEPOINT. This `.use()` middleware ran an UNCONDITIONAL
    // `prisma.booking.findFirst` (admin check) THEN a second `prisma.booking.findFirst`
    // (organizer/collective check) to resolve + authorise `ctx.booking` BEFORE the
    // handler — exactly the createEventPbacProcedure pattern, one layer up. On the
    // no-Postgres fork those THROW, 500ing before the handler runs.
    //
    // Its SOLE consumer is `viewer.bookings.editLocation`, which CV-8 already
    // CLEANLY DISABLED (post-create location-edit + calendar re-sync has no Convex
    // model). Because the body throws as its first statement, its `ctx.booking` is
    // never read. So rather than half-rewire a booking-access resolver onto Convex
    // for a disabled surface, we surface the SAME friendly NOT_IMPLEMENTED here,
    // BEFORE any `prisma` access — never letting the raw no-Postgres client throw.
    // (`bookingsProcedure` has no other consumer — verified — so this neutralises
    // the chokepoint without affecting any live surface. The zod input schema +
    // the editLocation handler are untouched; the handler body is now unreachable.)
    throw new TRPCError({
      code: "NOT_IMPLEMENTED",
      message: "Editing a booking's location is not available in this deployment.",
    });
  });

export type BookingsProcedureContext = {
  booking: Booking & {
    eventType:
      | (EventType & {
          team?: { id: number; name: string; parentId?: number | null } | null;
        })
      | null;
    destinationCalendar: DestinationCalendar | null;
    user:
      | (User & {
          destinationCalendar: DestinationCalendar | null;
          credentials: Credential[];
          profiles: { organizationId: number }[];
        })
      | null;
    references: BookingReference[];
    attendees: Attendee[];
  };
};
