import prisma from "@calcom/prisma";

import { TRPCError } from "@trpc/server";

import type { TrpcSessionUser } from "../../../types";
import type { TDeleteInputSchema } from "./delete.schema";

type DeleteOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TDeleteInputSchema;
};

export const deleteHandler = async ({ ctx, input }: DeleteOptions) => {
  // no-Postgres fork: `prisma.apiKey`/user writes THROW (no DB) and cal API keys have no
  // Convex backing, so on the fork (`ctx.user.uuid` = the dibslist authUserId) this is N/A.
  if (ctx.user.uuid) {
    throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "Not available on this deployment" });
  }

  const { id } = input;

  const apiKeyToDelete = await prisma.apiKey.findUnique({
    where: {
      id,
    },
  });

  await prisma.user.update({
    where: {
      id: ctx.user.id,
    },
    data: {
      apiKeys: {
        delete: {
          id,
        },
      },
    },
  });

  //remove all existing zapier webhooks, as we always have only one zapier API key and the running zaps won't work any more if this key is deleted
  if (apiKeyToDelete && apiKeyToDelete.appId === "zapier") {
    await prisma.webhook.deleteMany({
      where: {
        userId: ctx.user.id,
        appId: "zapier",
      },
    });
  }

  return {
    id,
  };
};
