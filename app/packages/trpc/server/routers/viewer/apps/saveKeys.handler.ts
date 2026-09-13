import { appKeysSchemas } from "@calcom/app-store/apps.keys-schemas.generated";
import { getLocalAppMetadata } from "@calcom/app-store/utils";
import type { PrismaClient } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import type { AppCategories } from "@calcom/prisma/enums";

// import prisma from "@calcom/prisma";
import { TRPCError } from "@trpc/server";

import type { TrpcSessionUser } from "../../../types";
import type { TSaveKeysInputSchema } from "./saveKeys.schema";

type SaveKeysOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
    prisma: PrismaClient;
  };
  input: TSaveKeysInputSchema;
};

export const saveKeysHandler = async ({ ctx, input }: SaveKeysOptions) => {
  // no-Postgres fork: `ctx.prisma.app.upsert` THROWS (no DB) and app-key admin has no Convex
  // backing, so on the fork (`ctx.user.uuid` = the dibslist authUserId) this write is N/A.
  if (ctx.user.uuid) {
    throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "Not available on this deployment" });
  }

  const keysSchema = appKeysSchemas[input.dirName as keyof typeof appKeysSchemas];
  const keys = keysSchema.parse(input.keys);

  // Get app name from metadata
  const localApps = getLocalAppMetadata();
  const appMetadata = localApps.find((localApp) => localApp.slug === input.slug);

  if (!appMetadata?.dirName && appMetadata?.categories)
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "App metadata could not be found" });

  await ctx.prisma.app.upsert({
    where: {
      slug: input.slug,
    },
    update: { keys, ...(input.fromEnabled && { enabled: true }) },
    create: {
      slug: input.slug,
      dirName: appMetadata?.dirName || appMetadata?.slug || "",
      categories:
        (appMetadata?.categories as AppCategories[]) ||
        ([appMetadata?.category] as AppCategories[]) ||
        undefined,
      keys: (input.keys as Prisma.InputJsonObject) || undefined,
      ...(input.fromEnabled && { enabled: true }),
    },
  });
};
