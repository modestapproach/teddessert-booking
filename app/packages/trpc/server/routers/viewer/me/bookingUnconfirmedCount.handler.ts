import { prisma } from "@calcom/prisma";
import { BookingStatus } from "@calcom/prisma/enums";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";

type BookingUnconfirmedCountOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
};

export const bookingUnconfirmedCountHandler = async ({ ctx }: BookingUnconfirmedCountOptions) => {
  const { user } = ctx;

  // CV — no-Postgres fork: `prisma.booking.count`/`groupBy` THROW (no DB), 500ing this
  // nav-badge query which polls on every authed page (and surfaces as repeated React #419
  // noise). dibslist booking confirmations are not modeled as cal "PENDING" bookings, so
  // on the fork (`uuid` = the dibslist authUserId, the no-Postgres signal) report 0
  // unconfirmed. The Postgres path is LEFT INTACT for the uuid-absent case.
  if (user.uuid) {
    return 0;
  }

  const count = await prisma.booking.count({
    where: {
      status: BookingStatus.PENDING,
      userId: user.id,
      endTime: { gt: new Date() },
    },
  });
  const recurringGrouping = await prisma.booking.groupBy({
    by: ["recurringEventId"],
    _count: {
      recurringEventId: true,
    },
    where: {
      recurringEventId: { not: { equals: null } },
      status: { equals: "PENDING" },
      userId: user.id,
      endTime: { gt: new Date() },
    },
  });
  return recurringGrouping.reduce((prev, current) => {
    // recurringEventId is the total number of recurring instances for a booking
    // we need to subtract all but one, to represent a single recurring booking
    return prev - (current._count?.recurringEventId - 1);
  }, count);
};
