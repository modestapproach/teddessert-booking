// Owner in-app notification feed (booking_received, calendar_sync_failed, …).
import { v } from "convex/values";
import { internalMutation, query, mutation } from "./_generated/server";
import { requireAuthUserId } from "./_helpers/auth";

export const _create = internalMutation({
  args: {
    authUserId: v.string(),
    kind: v.string(),
    title: v.string(),
    body: v.optional(v.string()),
    href: v.optional(v.string()),
    routingId: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("notifications", {
      authUserId: args.authUserId,
      kind: args.kind,
      title: args.title,
      body: args.body,
      href: args.href,
      createdAt: Date.now(),
    });
  },
});

export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const authUserId = await requireAuthUserId(ctx);
    return await ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("authUserId", authUserId))
      .order("desc")
      .take(limit ?? 50);
  },
});

export const markRead = mutation({
  args: { id: v.id("notifications") },
  handler: async (ctx, { id }) => {
    await ctx.db.patch(id, { readAt: Date.now() });
  },
});
