import { getWebhookFeature } from "@calcom/features/di/webhooks/containers/webhook";
import type { Webhook } from "@calcom/features/webhooks/lib/dto/types";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { TListInputSchema } from "./list.schema";

type ListOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TListInputSchema;
};

export const listHandler = async ({ ctx, input }: ListOptions): Promise<Webhook[]> => {
  // no-Postgres fork (`ctx.user.uuid` = the dibslist authUserId): read from Convex
  // (webhookEndpoints) via the owner adapter, scoped to the event type when filtered.
  if (ctx.user.uuid) {
    const { listOwnerWebhooks } = await import("@calcom/lib/server/calcomWebhookAdapters");
    const rows = await listOwnerWebhooks({
      ownerAuthUserId: ctx.user.uuid,
      ...(input?.eventTypeId !== undefined ? { eventTypeCalId: input.eventTypeId } : {}),
    });
    return rows as unknown as Webhook[];
  }

  const { repository } = getWebhookFeature();

  return repository.listWebhooks({
    userId: ctx.user.id,
    appId: input?.appId,
    eventTypeId: input?.eventTypeId,
    eventTriggers: input?.eventTriggers,
  });
};
