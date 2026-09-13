// CV-8 — confirm CLEANLY DISABLED (no requiresConfirmation / payment-refund /
// recurring / confirmation-email engine in our Convex backend).
//
// cal's `bookings.confirm` host action loads the booking (prisma.booking.
// findUniqueOrThrow), gates on payment/paid, runs the recurring-booking cascade,
// and drives the full handleConfirmation / processPaymentRefund engine + the
// BOOKING_CONFIRMED/REJECTED webhooks. dibslist's Convex booking backend has NO
// pending→accept confirmation gate (bookings auto-confirm), no payments/refunds,
// and no recurring model — so there is nothing to confirm. The original 450-line
// Prisma body THREW on the no-Postgres fork.
//
// Per the CV-8 "never leave a raw prisma throw reachable" rule, this returns
// EARLY with a friendly TRPCError BEFORE any ctx.prisma access. The whole
// confirm/reject action (incl. the magic-link confirm routes that re-import
// `confirmHandler`) is intentionally unavailable on this deployment (documented
// in CONVEX-REWIRE-NOTES §CV-8). The `confirmHandler` export name + signature +
// `{ message, status }` return shape are PRESERVED so the platform libraries
// re-export and the route consumers stay type-clean. The zod schema + the React
// bookings UI are UNTOUCHED.

import { BookingStatus } from "@calcom/prisma/enums";
import type { TraceContext } from "@calcom/lib/tracing";
import { TRPCError } from "@trpc/server";
import type { TrpcSessionUser } from "../../../types";
import type { TConfirmInputSchema } from "./confirm.schema";

type ConfirmOptions = {
  ctx: {
    user: Pick<
      NonNullable<TrpcSessionUser>,
      "id" | "uuid" | "email" | "username" | "role" | "destinationCalendar"
    >;
    traceContext?: TraceContext;
  };
  input: TConfirmInputSchema;
};

export const confirmHandler = async (
  _opts: ConfirmOptions
): Promise<{ message: string; status: BookingStatus }> => {
  throw new TRPCError({
    code: "NOT_IMPLEMENTED",
    message: "Confirming bookings is not available in this deployment.",
  });
};
