import prisma from "@calcom/prisma";

import { TRPCError } from "@trpc/server";

import type { TrpcSessionUser } from "../../../types";
import type { TEditInputSchema } from "./edit.schema";

type EditOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TEditInputSchema;
};

export const editHandler = async ({ ctx, input }: EditOptions) => {
  // no-Postgres fork: `prisma.user.update` (apiKeys) THROWS (no DB) and cal API keys have no
  // Convex backing, so on the fork (`ctx.user.uuid` = the dibslist authUserId) this is N/A.
  if (ctx.user.uuid) {
    throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "Not available on this deployment" });
  }

  const { id, ...data } = input;

  const {
    apiKeys: [updatedApiKey],
  } = await prisma.user.update({
    where: {
      id: ctx.user.id,
    },
    data: {
      apiKeys: {
        update: {
          where: {
            id,
          },
          data,
        },
      },
    },
    select: {
      apiKeys: {
        where: {
          id,
        },
      },
    },
  });

  return updatedApiKey;
};
