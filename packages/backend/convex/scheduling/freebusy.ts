// Booking-calendar-integration-prd B6a/B6c — populate `freebusyCache` from a host's
// connected calendars so `getUserAvailabilityRanges` (B6b) can subtract external
// busy times (no double-booking).
//
// An action orchestrates the Convex way: load the owner's credentials + their
// conflict-checked calendars (query) → fetch merged busy via the provider's
// `getBusyForCredential` (action) → upsert ONE merged `freebusyCache` row per
// credential (mutation). Triggered on connect (`completeCalendarConnect`) and by a
// cron (`refreshAllFreebusy`). Errors are logged + leave the prior cache row in
// place (conservative — never silently drop a host's busy intervals).

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { log } from "../_helpers/log";
import type { Id } from "../_generated/dataModel";

const DEFAULT_WINDOW_MS = 28 * 24 * 60 * 60 * 1000; // 28 days forward (booking window)
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min; the cron refreshes on this cadence
const MERGED_CALENDAR_SENTINEL = "__merged__"; // one merged row per credential

type RefreshTarget = {
  credentialId: Id<"calendarCredentials">;
  provider: "google" | "caldav";
  calendarIds: string[];
};

/** Load a user's VALID credentials + their conflict-checked external calendar ids. */
export const getRefreshTargets = internalQuery({
  args: { authUserId: v.string() },
  handler: async (ctx, args): Promise<RefreshTarget[]> => {
    const creds = await ctx.db
      .query("calendarCredentials")
      .withIndex("by_authUserId", (q) => q.eq("authUserId", args.authUserId))
      .collect();
    const targets: RefreshTarget[] = [];
    for (const cred of creds) {
      if (cred.invalid) continue;
      const cals = await ctx.db
        .query("selectedCalendars")
        .withIndex("by_credential", (q) => q.eq("credentialId", cred._id))
        .collect();
      const calendarIds = cals.filter((c) => c.checkForConflicts).map((c) => c.externalCalendarId);
      if (calendarIds.length === 0) continue;
      targets.push({ credentialId: cred._id, provider: cred.provider, calendarIds });
    }
    return targets;
  },
});

/** Upsert ONE merged freebusy row per credential covering [windowStart, windowEnd). */
export const writeFreebusyCache = internalMutation({
  args: {
    authUserId: v.string(),
    credentialId: v.id("calendarCredentials"),
    windowStart: v.number(),
    windowEnd: v.number(),
    busy: v.array(v.object({ start: v.number(), end: v.number() })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    // Replace any prior rows for this credential (we keep a single merged row).
    const existing = await ctx.db
      .query("freebusyCache")
      .withIndex("by_credential", (q) => q.eq("credentialId", args.credentialId))
      .collect();
    for (const row of existing) await ctx.db.delete(row._id);
    await ctx.db.insert("freebusyCache", {
      authUserId: args.authUserId,
      credentialId: args.credentialId,
      externalCalendarId: MERGED_CALENDAR_SENTINEL,
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
      busy: args.busy,
      fetchedAt: now,
      expiresAt: now + CACHE_TTL_MS,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Refresh ONE owner's freebusy cache from all their connected, conflict-checked calendars. */
export const refreshFreebusyForUser = internalAction({
  args: {
    authUserId: v.string(),
    windowStart: v.optional(v.number()),
    windowEnd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const windowStart = args.windowStart ?? Date.now();
    const windowEnd = args.windowEnd ?? windowStart + DEFAULT_WINDOW_MS;
    const targets = await ctx.runQuery(internal.scheduling.freebusy.getRefreshTargets, {
      authUserId: args.authUserId,
    });
    for (const t of targets) {
      let busy: Array<{ start: number; end: number }> = [];
      try {
        busy =
          t.provider === "google"
            ? await ctx.runAction(internal.scheduling.googleCalendar.getBusyForCredential, {
                credentialId: t.credentialId,
                calendarIds: t.calendarIds,
                windowStart,
                windowEnd,
              })
            : await ctx.runAction(internal.scheduling.caldavCalendar.getBusyForCredential, {
                credentialId: t.credentialId,
                calendarIds: t.calendarIds,
                windowStart,
                windowEnd,
              });
      } catch (e) {
        log.warn("refreshFreebusy.fetchFailed", {
          credentialId: t.credentialId,
          provider: t.provider,
          error: e instanceof Error ? e.message : String(e),
        });
        continue; // leave the prior cache row in place (conservative)
      }
      await ctx.runMutation(internal.scheduling.freebusy.writeFreebusyCache, {
        authUserId: args.authUserId,
        credentialId: t.credentialId,
        windowStart,
        windowEnd,
        busy,
      });
    }
  },
});

/** Distinct owners with ≥1 valid calendar credential (for the cron fan-out). */
export const listCredentialOwners = internalQuery({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    const creds = await ctx.db.query("calendarCredentials").collect();
    return [...new Set(creds.filter((c) => !c.invalid).map((c) => c.authUserId))];
  },
});

/** Cron entry: refresh freebusy for every owner with a connected calendar. */
export const refreshAllFreebusy = internalAction({
  args: {},
  handler: async (ctx) => {
    const owners = await ctx.runQuery(internal.scheduling.freebusy.listCredentialOwners, {});
    for (const authUserId of owners) {
      await ctx.runAction(internal.scheduling.freebusy.refreshFreebusyForUser, { authUserId });
    }
    log.info("refreshAllFreebusy.done", { owners: owners.length });
  },
});
