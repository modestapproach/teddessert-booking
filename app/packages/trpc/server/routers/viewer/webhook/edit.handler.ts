import {
  updateTriggerForExistingBookings,
  deleteWebhookScheduledTriggers,
  cancelNoShowTasksForBooking,
} from "@calcom/features/webhooks/lib/scheduleTrigger";
import { validateUrlForSSRFSync } from "@calcom/lib/ssrfProtection";
import { prisma } from "@calcom/prisma";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";

import { TRPCError } from "@trpc/server";

import type { TEditInputSchema } from "./edit.schema";

type EditOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TEditInputSchema;
};

export const editHandler = async ({ input, ctx }: EditOptions) => {
  // no-Postgres fork (`ctx.user.uuid` = the dibslist authUserId): update the Convex
  // (webhookEndpoints) row via the owner adapter instead of prisma.
  if (ctx.user.uuid) {
    if (input.subscriberUrl) {
      const forkValidation = validateUrlForSSRFSync(input.subscriberUrl);
      if (!forkValidation.isValid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Webhook URL is not allowed: ${forkValidation.error}`,
        });
      }
    }
    const { updateOwnerWebhook } = await import("@calcom/lib/server/calcomWebhookAdapters");
    return await updateOwnerWebhook({
      ownerAuthUserId: ctx.user.uuid,
      id: input.id,
      ...(input.subscriberUrl !== undefined ? { subscriberUrl: input.subscriberUrl } : {}),
      ...(input.eventTriggers !== undefined ? { eventTriggers: input.eventTriggers } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      payloadTemplate: input.payloadTemplate,
      ...(input.secret !== undefined ? { secret: input.secret } : {}),
    });
  }

  const { id, webhookId: _webhookId, ...data } = input;

  const webhook = await prisma.webhook.findUnique({
    where: {
      id,
    },
  });

  if (!webhook) {
    return null;
  }

  // SSRF validation: only validate if URL is being changed
  if (data.subscriberUrl && data.subscriberUrl !== webhook.subscriberUrl) {
    const validation = validateUrlForSSRFSync(data.subscriberUrl);
    if (!validation.isValid) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Webhook URL is not allowed: ${validation.error}`,
      });
    }
  }

  if (webhook.platform) {
    const { user } = ctx;
    if (user?.role !== "ADMIN") {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }
  }

  const updatedWebhook= await prisma.webhook.update({
    where: {
      id,
    },
    data: {
      ...data,
      time: data.time ?? null,
      timeUnit: data.timeUnit ?? null,
    },
  });

  if (data.active) {
    const activeTriggersBefore = webhook.active ? webhook.eventTriggers : [];
    await updateTriggerForExistingBookings(webhook, activeTriggersBefore, updatedWebhook.eventTriggers);
  } else if (!data.active && webhook.active) {
    await cancelNoShowTasksForBooking({
      webhook: {
        id: webhook.id,
        userId: webhook.userId,
        teamId: webhook.teamId,
        eventTypeId: webhook.eventTypeId,
      },
    });
    await deleteWebhookScheduledTriggers({ webhookId: webhook.id });
  }

  return updatedWebhook;
};
