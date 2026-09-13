import type { PrismaClient } from "@calcom/prisma";

import type { TFindInputSchema } from "./find.schema";

type GetOptions = {
  ctx: {
    prisma: PrismaClient;
  };
  input: TFindInputSchema;
};

export const getHandler = async ({ ctx: _ctx, input: _input }: GetOptions) => {
  // CV-9 — PUBLIC/anonymous path. CLEANLY DISABLED. The original
  // `prisma.booking.findUnique({ where: { uid } })` THROWS on the no-Postgres fork
  // for ANY unauthenticated caller. `viewer.bookings.find` is a minor public lookup
  // (id/uid/times/status/paid by uid); there is no Convex public booking-by-uid read
  // wired for the fork, and the booking detail surfaces the Booker actually needs go
  // through the (Convex-rewired) public `event`/`getSchedule` + the booking write
  // path. We return the `{ booking: null }` shape the original could already return
  // (findUnique → null), so the consumer degrades to "not found" rather than 500ing.
  // NO `ctx.prisma`.
  return {
    booking: null,
  };
};
