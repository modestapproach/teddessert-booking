import { TRPCError } from "@trpc/server";

import { OAuthClientRepository } from "@calcom/features/oauth/repositories/OAuthClientRepository";
import type { PrismaClient } from "@calcom/prisma";

import type { TDeleteClientInputSchema } from "./deleteClient.schema";

type DeleteClientOptions = {
  ctx: {
    user: {
      id: number;
      uuid?: string | null;
    };
    prisma: PrismaClient;
  };
  input: TDeleteClientInputSchema;
};

export const deleteClientHandler = async ({ ctx, input }: DeleteClientOptions) => {
  // no-Postgres fork: OAuthClientRepository reads/writes `prisma.oAuthClient` → THROW.
  if (ctx.user.uuid) {
    throw new TRPCError({
      code: "NOT_IMPLEMENTED",
      message: "OAuth app management isn't available on this deployment yet.",
    });
  }

  const { clientId } = input;

  const oAuthClientRepository = new OAuthClientRepository(ctx.prisma);

  const existingClient = await oAuthClientRepository.findByClientId(clientId);
  if (!existingClient) {
    throw new TRPCError({ code: "NOT_FOUND", message: "OAuth Client not found" });
  }

  const isOwner = existingClient.userId != null && existingClient.userId === ctx.user.id;

  if (!isOwner) {
    throw new TRPCError({ code: "NOT_FOUND", message: "OAuth Client not found" });
  }

  await oAuthClientRepository.delete(clientId);

  return { clientId };
};
