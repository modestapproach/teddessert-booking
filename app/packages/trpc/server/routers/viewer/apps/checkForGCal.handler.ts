import { prisma } from "@calcom/prisma";

import type { TrpcSessionUser } from "../../../types";

type CheckForGCalOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
};

export const checkForGCalHandler = async ({ ctx }: CheckForGCalOptions) => {
  // no-Postgres fork: `prisma.credential.findFirst` THROWS (no DB), so on the fork
  // (`ctx.user.uuid` = the dibslist authUserId) report no connected Google Calendar.
  if (ctx.user.uuid) {
    return false;
  }

  const gCalPresent = await prisma.credential.findFirst({
    where: {
      type: "google_calendar",
      userId: ctx.user.id,
    },
  });

  return !!gCalPresent;
};
