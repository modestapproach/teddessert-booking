import { getWebhookFeature } from "@calcom/features/di/webhooks/containers/webhook";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { TGetInputSchema } from "./get.schema";

type GetOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TGetInputSchema;
};

export const getHandler = async ({ ctx, input }: GetOptions) => {
  // no-Postgres fork (`ctx.user.uuid` = the dibslist authUserId): read the Convex
  // (webhookEndpoints) row via the owner adapter instead of the Prisma repository.
  if (ctx.user.uuid) {
    const { getOwnerWebhook } = await import("@calcom/lib/server/calcomWebhookAdapters");
    return await getOwnerWebhook({
      ownerAuthUserId: ctx.user.uuid,
      id: input.id || input.webhookId,
    });
  }
  const { repository: webhookRepository } = getWebhookFeature();
  return await webhookRepository.findByWebhookId(input.id || input.webhookId);
};
