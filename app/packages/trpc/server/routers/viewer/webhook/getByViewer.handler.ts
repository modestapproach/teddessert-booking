import { getWebhookFeature } from "@calcom/features/di/webhooks/containers/webhook";
import type { WebhookGroup } from "@calcom/features/webhooks/lib/dto/types";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";

type GetByViewerOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
};

export type WebhooksByViewer = {
  webhookGroups: WebhookGroup[];
  profiles: {
    readOnly?: boolean | undefined;
    slug: string | null;
    name: string | null;
    image?: string | undefined;
    teamId: number | null | undefined;
  }[];
};

export const getByViewerHandler = async ({ ctx }: GetByViewerOptions): Promise<WebhooksByViewer> => {
  // no-Postgres fork: the webhook repository's prisma reads THROW (no DB) and webhooks have
  // no Convex backing, so on the fork (`ctx.user.uuid` = the dibslist authUserId) report none.
  // no-Postgres fork (`ctx.user.uuid` = the dibslist authUserId): build the single
  // owner group from the Convex (webhookEndpoints) rows via the owner adapter.
  if (ctx.user.uuid) {
    const { listOwnerWebhooks } = await import("@calcom/lib/server/calcomWebhookAdapters");
    const webhooks = await listOwnerWebhooks({ ownerAuthUserId: ctx.user.uuid });
    if (webhooks.length === 0) {
      return { webhookGroups: [], profiles: [] };
    }
    const profile = {
      slug: ctx.user.username ?? null,
      name: ctx.user.name ?? null,
      image: undefined,
    };
    return {
      webhookGroups: [
        {
          teamId: null,
          profile,
          metadata: { canModify: true, canDelete: true },
          webhooks: webhooks as unknown as WebhookGroup["webhooks"],
        },
      ],
      profiles: [
        {
          readOnly: false,
          slug: ctx.user.username ?? null,
          name: ctx.user.name ?? null,
          teamId: null,
        },
      ],
    };
  }

  // Use the singleton instance to avoid creating new instances repeatedly
  const { repository: webhookRepository } = getWebhookFeature();
  return await webhookRepository.getFilteredWebhooksForUser({
    userId: ctx.user.id,
    userRole: ctx.user.role,
  });
};
