import { OAuthClientRepository } from "@calcom/features/oauth/repositories/OAuthClientRepository";
import type { PrismaClient } from "@calcom/prisma";
import { generateSecret } from "@calcom/features/oauth/utils/generateSecret";
import { TRPCError } from "@trpc/server";
import type { TCreateClientInputSchema } from "./createClient.schema";

type AddClientOptions = {
  ctx: {
    user?: { uuid?: string | null };
    prisma: PrismaClient;
  };
  input: TCreateClientInputSchema;
};

export const createClientHandler = async ({ ctx, input }: AddClientOptions) => {
  // no-Postgres fork: OAuthClientRepository writes `prisma.oAuthClient` → THROW. OAuth app
  // management isn't modeled on the fork (`ctx.user.uuid` = the dibslist authUserId).
  if (ctx.user?.uuid) {
    throw new TRPCError({
      code: "NOT_IMPLEMENTED",
      message: "OAuth app management isn't available on this deployment yet.",
    });
  }

  const { name, purpose, redirectUri, logo, websiteUrl, enablePkce } = input;

  const oAuthClientRepository = new OAuthClientRepository(ctx.prisma);

  let plainSecret: string | undefined;
  let hashedSecret: string | undefined;
  if (!enablePkce) {
    const [hashed, plain] = generateSecret();
    hashedSecret = hashed;
    plainSecret = plain;
  }

  const client = await oAuthClientRepository.create({
    name,
    purpose,
    redirectUri,
    clientSecret: hashedSecret,
    logo,
    websiteUrl,
    enablePkce,
    status: "APPROVED",
  });

  return {
    clientId: client.clientId,
    name: client.name,
    purpose: client.purpose,
    redirectUri: client.redirectUri,
    logo: client.logo,
    clientType: client.clientType,
    clientSecret: plainSecret,
    isPkceEnabled: enablePkce,
    status: client.status,
  };
};
