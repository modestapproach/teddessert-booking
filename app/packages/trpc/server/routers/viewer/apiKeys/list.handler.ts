import { PrismaApiKeyRepository } from "@calcom/features/api-keys-legacy/api-keys/repositories/PrismaApiKeyRepository";
import type { PrismaClient } from "@calcom/prisma";

import type { TrpcSessionUser } from "../../../types";

type ListOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
    prisma: PrismaClient;
  };
};

export const listHandler = async ({ ctx: { user, prisma } }: ListOptions) => {
  // no-Postgres fork: `prisma.apiKey` reads THROW. On the fork (`user.uuid` = the dibslist
  // authUserId) API keys aren't modeled here — return the empty list.
  if (user.uuid) {
    return [];
  }
  return new PrismaApiKeyRepository(prisma).findApiKeysFromUserId({ userId: user.id });
};
