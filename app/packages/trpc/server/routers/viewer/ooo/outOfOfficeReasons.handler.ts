import prisma from "@calcom/prisma";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";

type Options = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
};

export const outOfOfficeReasonList = async ({ ctx }: Options) => {
  // no-Postgres fork: `prisma.outOfOfficeReason.findMany` THROWS (no DB), so on the fork
  // (`ctx.user.uuid` = the dibslist authUserId) return the empty reasons list.
  if (ctx.user.uuid) {
    return [];
  }

  const outOfOfficeReasons = await prisma.outOfOfficeReason.findMany({
    where: {
      enabled: true,
    },
  });

  return outOfOfficeReasons;
};
