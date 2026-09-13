import { prisma } from "@calcom/prisma";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";

import { TRPCError } from "@trpc/server";

import type { TGetBookingAttendeesInputSchema } from "./getBookingAttendees.schema";

type GetBookingAttendeesOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TGetBookingAttendeesInputSchema;
};

export const getBookingAttendeesHandler = async ({ ctx, input }: GetBookingAttendeesOptions) => {
  // no-Postgres fork: `prisma.bookingSeat.findUniqueOrThrow` THROWS (no DB); seated bookings
  // are not modeled on the dibslist backend, so on the fork (`ctx.user.uuid` = the dibslist
  // authUserId) this is N/A.
  if (ctx.user.uuid) {
    throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "Not available on this deployment" });
  }

  const bookingSeat = await prisma.bookingSeat.findUniqueOrThrow({
    where: {
      referenceUid: input.seatReferenceUid,
    },
    select: {
      booking: {
        select: {
          _count: {
            select: {
              seatsReferences: true,
            },
          },
        },
      },
    },
  });

  if (!bookingSeat) {
    throw new Error("Booking not found");
  }

  return bookingSeat.booking._count.seatsReferences;
};
