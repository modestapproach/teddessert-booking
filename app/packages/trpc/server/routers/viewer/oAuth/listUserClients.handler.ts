import { OAuthClientRepository } from "@calcom/features/oauth/repositories/OAuthClientRepository";
import type { PrismaClient } from "@calcom/prisma";

type ListUserClientsOptions = {
  ctx: {
    user: {
      id: number;
      uuid?: string | null;
    };
    prisma: PrismaClient;
  };
};

export const listUserClientsHandler = async ({ ctx }: ListUserClientsOptions) => {
  // no-Postgres fork: OAuthClientRepository reads `prisma.oAuthClient` → THROWS. On the fork
  // (`ctx.user.uuid` = the dibslist authUserId) there are no OAuth clients — return empty.
  if (ctx.user.uuid) {
    return [];
  }

  const userId = ctx.user.id;

  const oAuthClientRepository = new OAuthClientRepository(ctx.prisma);

  return oAuthClientRepository.findByUserId(userId);
};
