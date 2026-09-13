import { TRPCError } from "@trpc/server";

import type { TrpcSessionUser } from "../../../types";
import type { TGetBookingDetailsInputSchema } from "./getBookingDetails.schema";

type GetBookingDetailsOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TGetBookingDetailsInputSchema;
};

export const getBookingDetailsHandler = async ({
  ctx: _ctx,
  input: _input,
}: GetBookingDetailsOptions) => {
  // CV-9 — CLEANLY DISABLED (missed by CV-8). The body did
  // `new BookingDetailsService(prisma).getBookingDetails(...)` →
  // `BookingRepository`/`BookingAccessService` prisma reads, which THROW on the
  // no-Postgres fork (the bookings-dashboard detail panel 500'd on its own,
  // independent of the isAuthed gate). Our Convex booking model has no equivalent
  // rich detail-with-access-resolution read wired for this surface; the dashboard
  // list itself is Convex-rewired (CV-4, `bookings.get`). We throw a friendly
  // NOT_IMPLEMENTED BEFORE any prisma — never let the raw client throw.
  throw new TRPCError({
    code: "NOT_IMPLEMENTED",
    message: "Booking details are not available in this deployment.",
  });
};
