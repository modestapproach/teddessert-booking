// Outbound booking webhooks are not wired in the standalone deployment. The
// booking write path schedules `internal.webhooks._emitEvent` after each
// booking event; this no-op keeps that contract without any endpoint table.
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

export const _emitEvent = internalMutation({
  args: {
    authUserId: v.string(),
    event: v.string(),
    data: v.any(),
    eventTypeCalId: v.optional(v.number()),
  },
  handler: async (_ctx, args) => {
    console.log(`[INFO] webhook.event ${args.event}`);
    return null;
  },
});
