// CV-1 — Cal.com auth-shim identity map.
//
// The forked Cal.com app (book.dibslist.app) no longer has a Postgres `User`
// table. It authenticates via the dibslist Better-Auth session cookie. But the
// cal `Session.user.id` MUST be an integer (Prisma Int) and cal needs a stable
// numeric id to thread through its wire protocol. These functions mint + persist
// that integer per dibslist user (keyed by the Better-Auth `authUserId` string)
// and return a cal-shaped user snapshot.
//
// resolveOrCreateCalcomUser is the upsert the cal server's getServerSession
// calls (server-to-server via ConvexHttpClient) after it has validated the
// Better-Auth cookie. getCalcomUserByAuthUserId / getCalcomUserByCalId are
// read-only lookups used by other booking-surface callsites + the reverse shim
// path (numeric userId from the wire → dibslist identity).
//
// STABLE ID STRATEGY: a monotonic counter row in `calcomSeq`. Convex serialises
// mutations per document key, so the read-bump-write of `calcomSeq.nextId` inside
// a single mutation is atomic — no SEQUENCE primitive needed. The counter never
// decrements, so a calId is never reused even after the dibslist user is deleted
// (calcomUserMap cascades on deletion; calcomSeq does NOT — see userDeletion.ts).
//
// PII: calcomUserMap carries email + name. It cascades on account purge
// (userDeletion.ts) and is in TABLES_TO_WIPE (_clear.ts).
//
// TESTABILITY: each function's logic is exported as a bare async handler
// (`*Impl`) so calcomUsers.test.ts can exercise it against an in-memory fake
// ctx (repo convention — see holds.test.ts / schedules.test.ts). The registered
// mutation/query wrappers also expose `._handler`.
//
// NO AUTH GATE: this map is identity infrastructure, not a user-facing booking
// surface — it is only ever called server-to-server by the cal shim after it has
// already validated the Better-Auth cookie. It deliberately does NOT call
// requireAuthUserId (the ConvexHttpClient call is unauthenticated to Convex) and
// does NOT gate on `booking_enabled` (the map must resolve even while the public
// booking surface is dark).

import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

// Shared return validator for a cal-shaped user row.
const calcomUserRow = v.object({
  _id: v.id("calcomUserMap"),
  // Convex documents ALWAYS carry `_creationTime`. `v.object()` is strict, so
  // omitting it made every full-document return fail with ReturnsValidationError —
  // which the cal shim's getServerSession / getOwnerSessionPrefs swallow in a
  // try/catch and default `completedOnboarding` to false, stranding an onboarded
  // owner in /getting-started. Including it is REQUIRED for any document return.
  _creationTime: v.number(),
  authUserId: v.string(),
  calId: v.number(),
  email: v.string(),
  name: v.string(),
  username: v.string(),
  timeZone: v.optional(v.string()),
  locale: v.optional(v.string()),
  bio: v.optional(v.string()),
  avatarUrl: v.optional(v.string()),
  weekStart: v.optional(v.string()),
  // CV-8 — booking prefs written by the cal me.updateProfile save subset.
  timeFormat: v.optional(v.number()),
  defaultScheduleId: v.optional(v.id("schedules")),
  completedBookingOnboarding: v.optional(v.boolean()),
  theme: v.optional(v.union(v.string(), v.null())),
  appTheme: v.optional(v.union(v.string(), v.null())),
  createdAt: v.number(),
  updatedAt: v.number(),
});

// Derive a username slug when the caller didn't supply one: the lowercased
// email local-part, stripped to a safe slug. Falls back to `user{calId}` only
// if the local part is empty after stripping (handled by the caller, which has
// the calId). Here we just normalise the local part.
export function deriveUsername(email: string): string {
  const local = (email.split("@")[0] ?? "").toLowerCase();
  const slug = local.replace(/[^a-z0-9._-]/g, "");
  return slug;
}

export interface ResolveArgs {
  authUserId: string;
  email: string;
  name: string;
  username?: string;
  timeZone?: string;
  locale?: string;
  avatarUrl?: string;
  weekStart?: string;
  bio?: string;
}

export interface ResolveResult {
  calId: number;
  _id: Id<"calcomUserMap">;
  created: boolean;
}

// ─────────────────────────────────────────────────────────────
// resolveOrCreateCalcomUser — upsert + stable-id allocation.
// ─────────────────────────────────────────────────────────────

export async function resolveOrCreateCalcomUserImpl(
  ctx: Ctx,
  args: ResolveArgs,
): Promise<ResolveResult> {
  const existing = await ctx.db
    .query("calcomUserMap")
    .withIndex("by_authUserId", (q: Ctx) => q.eq("authUserId", args.authUserId))
    .unique();

  const now = Date.now();
  // Prefer an explicit username; otherwise derive from the email local-part.
  const derived = deriveUsername(args.email);
  const username = args.username && args.username.length > 0 ? args.username : derived;

  if (existing) {
    // Lazily re-sync profile fields on every call so the snapshot stays fresh
    // without the cal shim having to re-query Better Auth.
    await ctx.db.patch(existing._id, {
      email: args.email,
      name: args.name,
      // Keep a stable username once assigned, but refresh if we now have a
      // non-empty value and the stored one was empty (e.g. first call had a
      // weird email). Never overwrite a good username with an empty one.
      username: username.length > 0 ? username : existing.username,
      ...(args.timeZone !== undefined ? { timeZone: args.timeZone } : {}),
      ...(args.locale !== undefined ? { locale: args.locale } : {}),
      ...(args.avatarUrl !== undefined ? { avatarUrl: args.avatarUrl } : {}),
      ...(args.weekStart !== undefined ? { weekStart: args.weekStart } : {}),
      ...(args.bio !== undefined ? { bio: args.bio } : {}),
      updatedAt: now,
    });
    return { calId: existing.calId, _id: existing._id, created: false };
  }

  // Allocate the next integer id from the global counter. calcomSeq has at most
  // one row; create it on first call if absent. Pre-increment so the next caller
  // reads the already-bumped value.
  const seqRow = await ctx.db.query("calcomSeq").first();
  let nextId: number;
  if (seqRow) {
    nextId = seqRow.nextId;
    await ctx.db.patch(seqRow._id, { nextId: nextId + 1 });
  } else {
    nextId = 1;
    await ctx.db.insert("calcomSeq", { nextId: 2 });
  }

  // If the derived username is empty (e.g. email had no usable local-part), fall
  // back to a calId-based slug so `username` is never an empty string.
  const finalUsername = username.length > 0 ? username : `user${nextId}`;

  const _id = await ctx.db.insert("calcomUserMap", {
    authUserId: args.authUserId,
    calId: nextId,
    email: args.email,
    name: args.name,
    username: finalUsername,
    ...(args.timeZone !== undefined ? { timeZone: args.timeZone } : {}),
    ...(args.locale !== undefined ? { locale: args.locale } : {}),
    ...(args.avatarUrl !== undefined ? { avatarUrl: args.avatarUrl } : {}),
    ...(args.weekStart !== undefined ? { weekStart: args.weekStart } : {}),
    ...(args.bio !== undefined ? { bio: args.bio } : {}),
    createdAt: now,
    updatedAt: now,
  });

  return { calId: nextId, _id: _id as Id<"calcomUserMap">, created: true };
}

export const resolveOrCreateCalcomUser = mutation({
  args: {
    authUserId: v.string(),
    email: v.string(),
    name: v.string(),
    username: v.optional(v.string()),
    timeZone: v.optional(v.string()),
    locale: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    weekStart: v.optional(v.string()),
    bio: v.optional(v.string()),
  },
  returns: v.object({
    calId: v.number(),
    _id: v.id("calcomUserMap"),
    created: v.boolean(),
  }),
  handler: (ctx, args) => resolveOrCreateCalcomUserImpl(ctx, args),
});

// ─────────────────────────────────────────────────────────────
// Lookups (read-only).
// ─────────────────────────────────────────────────────────────

export async function getCalcomUserByAuthUserIdImpl(ctx: Ctx, authUserId: string) {
  return await ctx.db
    .query("calcomUserMap")
    .withIndex("by_authUserId", (q: Ctx) => q.eq("authUserId", authUserId))
    .unique();
}

export const getCalcomUserByAuthUserId = query({
  args: { authUserId: v.string() },
  returns: v.union(calcomUserRow, v.null()),
  handler: (ctx, { authUserId }) => getCalcomUserByAuthUserIdImpl(ctx, authUserId),
});

export async function getCalcomUserByCalIdImpl(ctx: Ctx, calId: number) {
  return await ctx.db
    .query("calcomUserMap")
    .withIndex("by_calId", (q: Ctx) => q.eq("calId", calId))
    .unique();
}

export const getCalcomUserByCalId = query({
  args: { calId: v.number() },
  returns: v.union(calcomUserRow, v.null()),
  handler: (ctx, { calId }) => getCalcomUserByCalIdImpl(ctx, calId),
});

// Convenience lookup by email — the cal shim sometimes only has the verified
// Better-Auth email handy (e.g. a legacy callsite). Returns the first match
// (email is effectively unique per dibslist account but is NOT indexed, so this
// is a bounded table scan; prefer the authUserId/calId paths on hot surfaces).
export async function getCalcomUserByEmailImpl(ctx: Ctx, email: string) {
  const all = await ctx.db.query("calcomUserMap").collect();
  const lower = email.toLowerCase();
  return all.find((r: Ctx) => r.email.toLowerCase() === lower) ?? null;
}

export const getCalcomUserByEmail = query({
  args: { email: v.string() },
  returns: v.union(calcomUserRow, v.null()),
  handler: (ctx, { email }) => getCalcomUserByEmailImpl(ctx, email),
});

// ─────────────────────────────────────────────────────────────
// CV-8 — updateCalcomUserPrefs (the cal `me.updateProfile` SAVE subset)
// ─────────────────────────────────────────────────────────────
//
// cal's settings save (`viewer.me.updateProfile`) bundles IDENTITY fields
// (name/email/username/bio/avatarUrl) WITH booking PREFS (timeZone / weekStart /
// timeFormat / locale / defaultScheduleId). On the dibslist booking fork the
// IDENTITY fields are owned by Better Auth (the dibslist account is the source of
// truth) — the fork handler cleanly NO-OPs those. The PREFS subset is persisted
// here onto the existing `calcomUserMap` row (the same row resolveOrCreateCalcomUser
// upserts), so they survive across sessions even though getServerSession re-seeds
// the snapshot on each call.
//
// PATCH semantics: only the provided fields are written (undefined = leave as-is),
// mirroring the partial-save the settings form sends. No identity field is ever
// touched here. If the owner has no map row yet (shouldn't happen — they must have
// signed in to reach the settings page), this is a no-op returning { updated:false }
// rather than minting one (minting is resolveOrCreateCalcomUser's job, which needs
// email+name). Setting timeZone optionally propagates it to the owner's DEFAULT
// schedule's timeZone (cal's tz-change side effect) when one exists.
//
// NO AUTH GATE / NO booking_enabled GATE — same trust model as the rest of
// calcomUsers/* (identity/prefs infra reached only s2s by the fork after it has
// validated the Better-Auth cookie; the prefs must persist while the public
// booking surface is dark). The caller passes the trusted authUserId.

export interface UpdateCalcomUserPrefsArgs {
  authUserId: string;
  timeZone?: string;
  weekStart?: string;
  timeFormat?: number;
  locale?: string;
  defaultScheduleId?: Id<"schedules">;
  // When true + a timeZone is provided, also propagate the tz onto the owner's
  // default schedule (cal's me.updateProfile tz-change side effect).
  propagateTimeZoneToDefaultSchedule?: boolean;
  // Onboarding-writable IDENTITY/profile fields. Unlike the prefs subset these
  // are only sent by the getting-started flow (Step 1 username, Step 5 bio +
  // Finish), so a normal settings save never touches them.
  bookingUsername?: string;
  bio?: string;
  completedBookingOnboarding?: boolean;
  // Appearance settings (me.updateProfile): booking-page theme + dashboard appTheme.
  // null = "system" (the cal form sends null); string = "light"/"dark".
  theme?: string | null;
  appTheme?: string | null;
}

export async function updateCalcomUserPrefsImpl(
  ctx: Ctx,
  args: UpdateCalcomUserPrefsArgs,
): Promise<{ updated: boolean }> {
  const existing = await ctx.db
    .query("calcomUserMap")
    .withIndex("by_authUserId", (q: Ctx) => q.eq("authUserId", args.authUserId))
    .unique();
  if (!existing) {
    // No map row → nothing to patch (don't mint here; that needs email+name).
    return { updated: false };
  }

  const patch: Record<string, unknown> = { updatedAt: Date.now() };
  if (args.timeZone !== undefined) patch.timeZone = args.timeZone;
  if (args.weekStart !== undefined) patch.weekStart = args.weekStart;
  if (args.timeFormat !== undefined) patch.timeFormat = args.timeFormat;
  if (args.locale !== undefined) patch.locale = args.locale;
  // Onboarding-writable fields. Only patch a non-empty username so a stray empty
  // submit can't blank the public booking handle.
  if (args.bookingUsername !== undefined && args.bookingUsername.length > 0) {
    patch.username = args.bookingUsername;
  }
  if (args.bio !== undefined) patch.bio = args.bio;
  if (args.completedBookingOnboarding !== undefined) {
    patch.completedBookingOnboarding = args.completedBookingOnboarding;
  }
  if (args.theme !== undefined) patch.theme = args.theme;
  if (args.appTheme !== undefined) patch.appTheme = args.appTheme;
  if (args.defaultScheduleId !== undefined) {
    // The default schedule must belong to this owner (defensive — the prefs save
    // doesn't normally carry this, but guard against a forged id).
    const sched = await ctx.db.get(args.defaultScheduleId);
    if (sched && sched.ownerAuthUserId === args.authUserId) {
      patch.defaultScheduleId = args.defaultScheduleId;
    }
  }

  await ctx.db.patch(existing._id, patch);

  // Optional tz propagation to the owner's default schedule (cal side effect).
  if (args.propagateTimeZoneToDefaultSchedule && args.timeZone !== undefined) {
    const def = await ctx.db
      .query("schedules")
      .withIndex("by_owner_default", (q: Ctx) =>
        q.eq("ownerAuthUserId", args.authUserId).eq("isDefault", true),
      )
      .first();
    if (def) {
      await ctx.db.patch(def._id, { timeZone: args.timeZone, updatedAt: Date.now() });
    }
  }

  return { updated: true };
}

export const updateCalcomUserPrefs = mutation({
  args: {
    authUserId: v.string(),
    timeZone: v.optional(v.string()),
    weekStart: v.optional(v.string()),
    timeFormat: v.optional(v.number()),
    locale: v.optional(v.string()),
    defaultScheduleId: v.optional(v.id("schedules")),
    propagateTimeZoneToDefaultSchedule: v.optional(v.boolean()),
    bookingUsername: v.optional(v.string()),
    bio: v.optional(v.string()),
    completedBookingOnboarding: v.optional(v.boolean()),
    theme: v.optional(v.union(v.string(), v.null())),
    appTheme: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({ updated: v.boolean() }),
  handler: (ctx, args) => updateCalcomUserPrefsImpl(ctx, args),
});
