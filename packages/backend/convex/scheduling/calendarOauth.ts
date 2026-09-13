// B2 / B3 — Google Calendar OAuth connect: Convex-coupled surface.
//
// Splits cleanly from `googleOAuth.ts` (PURE helpers) and `googleCalendar.ts`
// (PURE provider fns). This file holds the `ctx`-bound pieces:
//   - startCalendarConnect (mutation)   — owner-gated; signs state → consent URL.
//   - completeCalendarConnect (internalAction) — called by http.ts /calendar/
//        oauth/callback AFTER it verifies state → authUserId. Exchanges the
//        code, encrypts the refresh token, upserts the `calendarCredentials`
//        row (B2), then enumerates the account's calendars and upserts
//        `selectedCalendars` rows (B3 — primary defaults to checkForConflicts +
//        isDestination true).
//   - _upsertGoogleCalCredential (internalMutation) — the DB write for the
//        credential row (encryptAtRest lives here, inside a mutation).
//   - _upsertSelectedCalendars (internalMutation) — the DB write for the B3
//        enumeration (idempotent per externalCalendarId).
//   - setCalendarConflictFlag (mutation) — owner-scoped toggle of a
//        `selectedCalendars` row's `checkForConflicts`.
//   - markCredentialInvalid (internalMutation) — flips `invalid=true` when a
//        refresh fails (revoked); see googleCalendar.ts refresh-on-401 path.
//
// AUTH + FLAG CONTRACT (identical to schedules.ts / eventTypes.ts):
//   1. `const authUserId = await requireAuthUserId(ctx)` FIRST on web-facing fns.
//   2. WRITE mutations gate on the DEFAULT-OFF `booking_enabled` flag.
//   3. Owner-scoped: a credential/selectedCalendar row's authUserId must equal
//      the caller; otherwise `ConvexError("Not found.")` (leak-prevention).
//
// CODEGEN-PENDING: `calendarCredentials`/`selectedCalendars` exist in schema but
// the committed `_generated` types + `internal` map are stale (codegen is
// operator-gated). String table names + `(internal as any).scheduling.*` refs
// typecheck loose and resolve at runtime once a deploy regenerates types — the
// SAME precedent as googleCalendar.ts / booking.ts.
//
// RUNTIME-UNVERIFIED [R]: no live Google OAuth round-trip exercised.

import { ConvexError, v } from "convex/values";
import {
  mutation,
  query,
  internalMutation,
  internalAction,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { requireAuthUserId } from "../_helpers/auth";
import { requireFlagEnabled } from "../_helpers/featureFlag";
import { log } from "../_helpers/log";
import { encryptAtRest, decryptAtRest } from "../_helpers/cryptoEnvelope";
import {
  buildGoogleConsentUrl,
  exchangeCodeForTokens,
  emailFromIdToken,
} from "./googleOAuth";
import { signState } from "./googleOAuth";
import {
  caldavListCalendars,
  DEFAULT_CALDAV_SERVER_URL,
} from "./caldavCalendar";
import type { IntegrationCalendar } from "./calendarService";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

const BOOKING_FLAG_GATE = {
  kind: "booking_disabled",
  message: "Booking is not available.",
  defaultValue: false as const,
};

async function gateBooking(ctx: Ctx): Promise<void> {
  const gate = await requireFlagEnabled(ctx, "booking_enabled", BOOKING_FLAG_GATE);
  if (!gate.ok) throw new ConvexError({ kind: gate.kind, message: gate.message });
}

/** The registered redirect URI — must EXACTLY match a Google Console entry. */
export function calendarRedirectUri(): string {
  const siteUrl =
    process.env.CONVEX_SITE_URL || process.env.SITE_URL || "";
  return `${siteUrl}/calendar/oauth/callback`;
}

// ─────────────────────────────────────────────────────────────
// startCalendarConnect — owner-gated, stateless (the state IS the proof)
// ─────────────────────────────────────────────────────────────

/**
 * Begin the Google Calendar connect flow. Owner-gated + flag-gated. Returns
 * `{ authorizeUrl }`; the client navigates the browser there, the user
 * consents, and Google redirects to /calendar/oauth/callback with `code` + our
 * signed `state`. No DB write — the signed state carries the authUserId.
 */
export const startCalendarConnect = mutation({
  args: {},
  handler: async (ctx): Promise<{ authorizeUrl: string }> => {
    const authUserId = await requireAuthUserId(ctx);
    await gateBooking(ctx);
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      throw new ConvexError("Google Calendar is not configured.");
    }
    const state = await signState({ authUserId });
    const authorizeUrl = buildGoogleConsentUrl({
      state,
      redirectUri: calendarRedirectUri(),
      clientId,
    });
    return { authorizeUrl };
  },
});

// Owner-scoped variant for the cal.com fork (book.dibslist.app). The fork can't
// carry the dibslist Better-Auth cookie to convex.site on a browser navigation, so
// its tRPC layer calls this server-to-server with the AUTHENTICATED owner's
// authUserId (ctx.user.uuid). No `gateBooking` — connecting your OWN calendar is
// owner setup, independent of the public `booking_enabled` flag. The signed state
// carries the owner id, so the callback needs no session (cross-domain-safe).
//
// PUBLIC `mutation` (NOT internal) — modeled VERBATIM on the calcomAdmin.ts s2s
// trust model. The fork reaches Convex through `getConvex()` (a ConvexHttpClient
// with NO identity token), which can only invoke registered PUBLIC functions; an
// `internalMutation` is unreachable from it and 500s with "Could not find public
// function". Like the other `admin*` s2s fns, this takes an explicit trusted
// `authUserId` and performs no Convex auth check — the fork's resolver is the only
// intended caller, running server-side after `getServerSession` validated the
// dibslist Better-Auth cookie. Worst-case abuse (a caller passing a foreign
// authUserId) merely starts an OAuth flow that, if completed with the caller's OWN
// Google account, would attach that account's busy times to the target's
// availability — an integrity nuisance, not a data leak. Future hardening: add a
// shared-secret arg (tracked alongside the calcomAdmin.ts hardening note).
export const adminStartCalendarConnect = mutation({
  args: { authUserId: v.string() },
  handler: async (_ctx, args): Promise<{ authorizeUrl: string }> => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      throw new ConvexError("Google Calendar is not configured.");
    }
    const state = await signState({ authUserId: args.authUserId });
    const authorizeUrl = buildGoogleConsentUrl({
      state,
      redirectUri: calendarRedirectUri(),
      clientId,
    });
    return { authorizeUrl };
  },
});

// ─────────────────────────────────────────────────────────────
// completeCalendarConnect — internalAction (called by the callback route)
// ─────────────────────────────────────────────────────────────

/**
 * Exchange the OAuth `code`, persist the credential (B2), enumerate calendars
 * and upsert `selectedCalendars` (B3). Called ONLY by http.ts after it has
 * verified the signed state → authUserId. Network I/O lives here (action), DB
 * writes are delegated to the internalMutations below.
 *
 * Throws on any failure so the callback route maps it to an error redirect.
 */
export const completeCalendarConnect = internalAction({
  args: {
    authUserId: v.string(),
    code: v.string(),
  },
  handler: async (ctx, args): Promise<{ credentialId: Id<"calendarCredentials"> }> => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new ConvexError("Google Calendar is not configured.");
    }

    // 1. code → tokens.
    const tok = await exchangeCodeForTokens(args.code, {
      clientId,
      clientSecret,
      redirectUri: calendarRedirectUri(),
    });
    if (!tok.refresh_token) {
      // With access_type=offline + prompt=consent Google always returns one;
      // its absence means we can't mint future access tokens → fail loud.
      throw new ConvexError(
        "Google did not return a refresh_token (re-consent required).",
      );
    }

    const label = emailFromIdToken(tok.id_token) ?? "Google Calendar";

    // 2. Upsert the encrypted credential row (B2).
    const credentialId: Id<"calendarCredentials"> = await ctx.runMutation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (internal as any).scheduling.calendarOauth._upsertGoogleCalCredential,
      {
        authUserId: args.authUserId,
        refreshToken: tok.refresh_token,
        label,
      },
    );

    // 3. Register the PRIMARY calendar (B3). We deliberately request only the
    //    least-privilege calendar.freebusy + calendar.events scopes (see
    //    googleOAuth.ts GOOGLE_CALENDAR_SCOPES) — NEITHER grants access to
    //    calendarList.list, so we cannot enumerate every sub-calendar (it 403s).
    //    The conflict check only needs the owner's PRIMARY calendar, whose id is
    //    the account email from the id_token ("primary" is the documented alias
    //    fallback). freeBusy.query accepts this id under calendar.freebusy, so
    //    seeding it makes the connection immediately usable and surfaces a
    //    connected calendar in the UI. Multi-calendar selection would require
    //    broadening scopes to calendar.readonly — deferred. Seeding failure must
    //    NOT undo the connection (credential already persisted in step 2).
    const primaryCalendarId = emailFromIdToken(tok.id_token) ?? "primary";
    try {
      await ctx.runMutation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (internal as any).scheduling.calendarOauth._upsertSelectedCalendars,
        {
          authUserId: args.authUserId,
          credentialId,
          calendars: [
            {
              externalCalendarId: primaryCalendarId,
              displayName: label,
              primary: true,
            },
          ],
        },
      );
    } catch (err) {
      log.error("calendar.oauth.seed_primary_failed", err, {
        authUserId: args.authUserId,
      });
    }

    // 4. Populate the freebusy cache immediately (B6c) so availability reflects the
    //    new calendar without waiting for the cron. Best-effort — a fetch failure
    //    must NOT undo the connection (the ~10m cron retries).
    try {
      await ctx.runAction(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (internal as any).scheduling.freebusy.refreshFreebusyForUser,
        { authUserId: args.authUserId },
      );
    } catch (err) {
      log.error("calendar.oauth.initial_freebusy_failed", err, {
        authUserId: args.authUserId,
      });
    }

    return { credentialId };
  },
});

// ─────────────────────────────────────────────────────────────
// _upsertGoogleCalCredential — internalMutation (B2 DB write)
// ─────────────────────────────────────────────────────────────

/**
 * Encrypt the refresh token and upsert the (one-per-user) Google
 * `calendarCredentials` row. INTERNAL — only completeCalendarConnect calls it.
 * Re-connecting overwrites the encrypted secret + clears `invalid`.
 */
export const _upsertGoogleCalCredential = internalMutation({
  args: {
    authUserId: v.string(),
    refreshToken: v.string(),
    label: v.string(),
  },
  handler: async (ctx: Ctx, args): Promise<Id<"calendarCredentials">> => {
    const envelope = await encryptAtRest(args.refreshToken);
    const now = Date.now();

    const existing = await ctx.db
      .query("calendarCredentials")
      .withIndex("by_authUserId_provider", (q: Ctx) =>
        q.eq("authUserId", args.authUserId).eq("provider", "google"),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        encSecretCiphertext: envelope.ciphertext,
        encSecretIv: envelope.iv,
        label: args.label || existing.label,
        invalid: false,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("calendarCredentials", {
      authUserId: args.authUserId,
      provider: "google",
      label: args.label,
      encSecretCiphertext: envelope.ciphertext,
      encSecretIv: envelope.iv,
      invalid: false,
      createdAt: now,
      updatedAt: now,
    });
  },
});

// ─────────────────────────────────────────────────────────────
// _upsertSelectedCalendars — internalMutation (B3 enumeration write)
// ─────────────────────────────────────────────────────────────

/**
 * Upsert `selectedCalendars` rows for an enumerated credential. Idempotent per
 * `externalCalendarId` (re-enumeration patches displayName/timeZone but
 * PRESERVES the user's checkForConflicts/isDestination toggles). New rows:
 * primary calendar defaults to `checkForConflicts=true` + `isDestination=true`;
 * non-primary defaults to `checkForConflicts=true` + `isDestination=false`.
 */
export const _upsertSelectedCalendars = internalMutation({
  args: {
    authUserId: v.string(),
    credentialId: v.id("calendarCredentials"),
    calendars: v.array(
      v.object({
        externalCalendarId: v.string(),
        displayName: v.optional(v.string()),
        primary: v.boolean(),
        timeZone: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx: Ctx, args): Promise<{ upserted: number }> => {
    const now = Date.now();
    let upserted = 0;
    for (const cal of args.calendars) {
      const existing = await ctx.db
        .query("selectedCalendars")
        .withIndex("by_credential_external", (q: Ctx) =>
          q
            .eq("credentialId", args.credentialId)
            .eq("externalCalendarId", cal.externalCalendarId),
        )
        .first();

      if (existing) {
        // Refresh metadata only; keep the user's conflict/destination choices.
        await ctx.db.patch(existing._id, {
          displayName: cal.displayName,
          timeZone: cal.timeZone,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert("selectedCalendars", {
          authUserId: args.authUserId,
          credentialId: args.credentialId,
          externalCalendarId: cal.externalCalendarId,
          displayName: cal.displayName,
          // primary → conflict-checked AND the write target by default.
          checkForConflicts: true,
          isDestination: cal.primary,
          timeZone: cal.timeZone,
          createdAt: now,
          updatedAt: now,
        });
      }
      upserted += 1;
    }
    return { upserted };
  },
});

// ─────────────────────────────────────────────────────────────
// setCalendarConflictFlag — owner-scoped toggle (B3)
// ─────────────────────────────────────────────────────────────

/**
 * Toggle whether a connected sub-calendar blocks availability
 * (`checkForConflicts`). Owner-gated + flag-gated. Identified by
 * (credentialId, externalCalendarId). The credential must belong to the caller
 * — otherwise `ConvexError("Not found.")` (leak-prevention). Throws if the
 * `selectedCalendars` row doesn't exist (enumerate via connect first).
 */
export const setCalendarConflictFlag = mutation({
  args: {
    credentialId: v.id("calendarCredentials"),
    externalCalendarId: v.string(),
    checkForConflicts: v.boolean(),
  },
  handler: async (ctx, args): Promise<{ ok: true; changed: boolean }> => {
    const authUserId = await requireAuthUserId(ctx);
    // CV-5 — body factored into setCalendarConflictFlagCore so the s2s admin
    // wrapper can reuse it with an explicit ownerId (identical ownership recheck).
    return setCalendarConflictFlagCore(ctx, authUserId, args);
  },
});

// CV-5 — owner-facing set-destination + disconnect mutations (mirror the
// conflict-toggle pattern: auth-gate then delegate to the post-auth core). The
// `apps/book` UI can call these directly with the Convex string `_id`; the forked
// cal.com app reaches the same cores via the s2s wrappers in calcomAdmin.ts.
export const setDestinationCalendar = mutation({
  args: {
    provider: v.optional(v.union(v.literal("google"), v.literal("caldav"))),
    externalCalendarId: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: true; credentialId: Id<"calendarCredentials"> }> => {
    const authUserId = await requireAuthUserId(ctx);
    return setDestinationCalendarCore(ctx, authUserId, args);
  },
});

export const disconnectCalendar = mutation({
  args: { credentialId: v.id("calendarCredentials") },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: true; deletedSelected: number; deletedFreebusy: number }> => {
    const authUserId = await requireAuthUserId(ctx);
    return disconnectCalendarCore(ctx, authUserId, args);
  },
});

// ─────────────────────────────────────────────────────────────
// setCalendarConflictFlag — post-auth core (CV-5 s2s reuse)
// ─────────────────────────────────────────────────────────────
//
// CV-5 — the conflict-toggle write path. CV-2c shipped the auth-gated
// `setCalendarConflictFlag` mutation above for the `apps/book` UI (which calls it
// directly with the Convex string `_id`). The forked cal.com app cannot — it has
// no Convex identity and rounds back an INTEGER credential id. So we factor the
// body into a post-auth core that the s2s wrapper (calcomAdmin.ts) reuses with an
// explicit, ownership-rechecked `ownerId`. Identical logic; only the identity
// source differs. Returns `{ ok, changed }`.
export async function setCalendarConflictFlagCore(
  ctx: Ctx,
  ownerId: string,
  args: {
    credentialId: Id<"calendarCredentials">;
    externalCalendarId: string;
    checkForConflicts: boolean;
  },
): Promise<{ ok: true; changed: boolean }> {
  await gateBooking(ctx);

  // Ownership: the credential must be the caller's.
  const cred = await ctx.db.get(args.credentialId);
  if (!cred || cred.authUserId !== ownerId) {
    throw new ConvexError("Not found.");
  }

  const row = await ctx.db
    .query("selectedCalendars")
    .withIndex("by_credential_external", (q: Ctx) =>
      q
        .eq("credentialId", args.credentialId)
        .eq("externalCalendarId", args.externalCalendarId),
    )
    .first();
  if (!row || row.authUserId !== ownerId) {
    throw new ConvexError("Not found.");
  }

  if (row.checkForConflicts === args.checkForConflicts) {
    return { ok: true as const, changed: false };
  }
  await ctx.db.patch(row._id, {
    checkForConflicts: args.checkForConflicts,
    updatedAt: Date.now(),
  });
  return { ok: true as const, changed: true };
}

// ─────────────────────────────────────────────────────────────
// setDestinationCalendar — owner-scoped (CV-5). Flip `isDestination`.
// ─────────────────────────────────────────────────────────────
//
// cal models a per-eventType/per-user "write target" calendar; Convex models it
// as the `isDestination` boolean on `selectedCalendars`. This mutation sets ONE
// calendar as the owner's destination, clearing any prior destination across ALL
// of the owner's credentials (single-destination-per-user invariant, analogous to
// schedules.ts `clearOtherDefaults`). Identified by (provider/integration,
// externalCalendarId) — cal's `setDestinationCalendar` is keyed the same way
// (NO credential int), so this needs no credential id-map. The eventTypeId-scoped
// destination cal supports has NO Convex equivalent (user-level only) — documented
// gap; the fork ignores eventTypeId for the destination.
export async function setDestinationCalendarCore(
  ctx: Ctx,
  ownerId: string,
  args: {
    // cal's `integration` string (e.g. "google_calendar" / "caldav_calendar"),
    // mapped to our provider; optional — externalCalendarId alone is unique enough
    // across an owner's small connected-account set, but when present it
    // disambiguates which credential's sub-calendar to target.
    provider?: "google" | "caldav";
    externalCalendarId: string;
  },
): Promise<{ ok: true; credentialId: Id<"calendarCredentials"> }> {
  await gateBooking(ctx);

  // Collect the owner's credentials (optionally narrowed by provider) and find the
  // selectedCalendars row whose externalCalendarId matches the target.
  const creds = await ctx.db
    .query("calendarCredentials")
    .withIndex("by_authUserId", (q: Ctx) => q.eq("authUserId", ownerId))
    .collect();
  const candidateCreds = args.provider
    ? creds.filter((c: Ctx) => c.provider === args.provider)
    : creds;

  let target: Ctx | null = null;
  // All of the owner's selected rows (for clearing the prior destination).
  const allRows: Ctx[] = [];
  for (const cred of creds) {
    const rows = await ctx.db
      .query("selectedCalendars")
      .withIndex("by_credential", (q: Ctx) => q.eq("credentialId", cred._id))
      .collect();
    for (const r of rows) {
      allRows.push(r);
      if (
        !target &&
        r.externalCalendarId === args.externalCalendarId &&
        candidateCreds.some((c: Ctx) => c._id === cred._id)
      ) {
        target = r;
      }
    }
  }

  if (!target) {
    throw new ConvexError(`Could not find calendar ${args.externalCalendarId}`);
  }

  const now = Date.now();
  // Clear any other destination (single-destination-per-owner invariant).
  for (const r of allRows) {
    if (r._id !== target._id && r.isDestination === true) {
      await ctx.db.patch(r._id, { isDestination: false, updatedAt: now });
    }
  }
  if (target.isDestination !== true) {
    await ctx.db.patch(target._id, { isDestination: true, updatedAt: now });
  }
  return { ok: true as const, credentialId: target.credentialId };
}

// ─────────────────────────────────────────────────────────────
// disconnectCalendar — owner-scoped (CV-5). Delete credential + cascade.
// ─────────────────────────────────────────────────────────────
//
// cal's `viewer.credentials.delete` runs a large app-uninstall cascade; in our
// single-user booking model the load-bearing part is: remove the credential row,
// its `selectedCalendars` children (so they stop being conflict-checked / a write
// target), and its `freebusyCache` rows (stale busy intervals for a gone account).
// Owner-gated + flag-gated. The credential's id-map row is left in place — calIds
// are never reused (the counter never decrements), so a stale int simply resolves
// to a now-missing credential and the write 404s. `bookings.externalEvents[]`
// reference the credentialId in historical snapshots; those are NOT rewritten
// (they record what happened at booking time).
export async function disconnectCalendarCore(
  ctx: Ctx,
  ownerId: string,
  args: { credentialId: Id<"calendarCredentials"> },
): Promise<{ ok: true; deletedSelected: number; deletedFreebusy: number }> {
  await gateBooking(ctx);

  const cred = await ctx.db.get(args.credentialId);
  if (!cred || cred.authUserId !== ownerId) {
    throw new ConvexError("Not found.");
  }

  // Cascade selectedCalendars (by_credential).
  const selected = await ctx.db
    .query("selectedCalendars")
    .withIndex("by_credential", (q: Ctx) => q.eq("credentialId", args.credentialId))
    .collect();
  for (const row of selected) await ctx.db.delete(row._id);

  // Cascade freebusyCache (by_credential) — stale busy intervals for the account.
  const fb = await ctx.db
    .query("freebusyCache")
    .withIndex("by_credential", (q: Ctx) => q.eq("credentialId", args.credentialId))
    .collect();
  for (const row of fb) await ctx.db.delete(row._id);

  await ctx.db.delete(args.credentialId);
  return {
    ok: true as const,
    deletedSelected: selected.length,
    deletedFreebusy: fb.length,
  };
}

// ─────────────────────────────────────────────────────────────
// markCredentialInvalid — internalMutation (refresh-failure handling)
// ─────────────────────────────────────────────────────────────

/**
 * Flag a credential `invalid=true` after a hard refresh failure (revoked
 * grant). INTERNAL — called from the googleCalendar.ts action wrappers on a
 * refresh-on-401 that also fails. Idempotent.
 */
export const markCredentialInvalid = internalMutation({
  args: { credentialId: v.id("calendarCredentials") },
  handler: async (ctx: Ctx, args): Promise<null> => {
    const row = await ctx.db.get(args.credentialId);
    if (!row) return null;
    if (row.invalid !== true) {
      await ctx.db.patch(args.credentialId, {
        invalid: true,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

// ─────────────────────────────────────────────────────────────
// connectCalDav — owner-facing mutation (B5 CalDAV/Apple credential intake)
// ─────────────────────────────────────────────────────────────
//
// Unlike Google (3-legged OAuth via a browser redirect), CalDAV/Apple connects
// with a username + a 16-char app-specific password the user pastes in. The
// mutation: auth + flag gate → encrypt the password (NEVER stored/logged in
// plaintext) → upsert a provider:"caldav" credential (one per user) → schedule
// best-effort calendar enumeration in an action (network I/O can't run in a
// mutation). The committed-then-async pattern mirrors completeCalendarConnect:
// the credential is persisted atomically; a failed enumeration does NOT undo it.

/**
 * Connect an Apple/iCloud or Fastmail CalDAV account. Owner-gated + flag-gated.
 * Stores the app-specific password ENCRYPTED at rest. Returns the credentialId;
 * calendar enumeration runs asynchronously (the connected-calendars list
 * populates shortly after).
 */
export const connectCalDav = mutation({
  args: {
    serverUrl: v.optional(v.string()), // defaults to https://caldav.icloud.com
    username: v.string(), // Apple ID / Fastmail address
    appSpecificPassword: v.string(), // 16-char app-specific password
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ credentialId: Id<"calendarCredentials"> }> => {
    const authUserId = await requireAuthUserId(ctx);
    await gateBooking(ctx);

    const username = args.username.trim();
    const password = args.appSpecificPassword.trim();
    if (!username || !password) {
      throw new ConvexError("CalDAV username and password are required.");
    }
    const serverUrl = args.serverUrl?.trim() || DEFAULT_CALDAV_SERVER_URL;

    // Encrypt the app-specific password — the plaintext NEVER lands on the row.
    const envelope = await encryptAtRest(password);
    const now = Date.now();

    const existing = await ctx.db
      .query("calendarCredentials")
      .withIndex("by_authUserId_provider", (q: Ctx) =>
        q.eq("authUserId", authUserId).eq("provider", "caldav"),
      )
      .first();

    let credentialId: Id<"calendarCredentials">;
    if (existing) {
      await ctx.db.patch(existing._id, {
        encSecretCiphertext: envelope.ciphertext,
        encSecretIv: envelope.iv,
        caldavServerUrl: serverUrl,
        caldavUsername: username,
        label: username,
        invalid: false,
        updatedAt: now,
      });
      credentialId = existing._id;
    } else {
      credentialId = await ctx.db.insert("calendarCredentials", {
        authUserId,
        provider: "caldav",
        label: username,
        encSecretCiphertext: envelope.ciphertext,
        encSecretIv: envelope.iv,
        caldavServerUrl: serverUrl,
        caldavUsername: username,
        invalid: false,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Best-effort calendar enumeration (network I/O → an action).
    await ctx.scheduler.runAfter(
      0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (internal as any).scheduling.calendarOauth._enumerateCalDavCalendars,
      { authUserId, credentialId },
    );

    return { credentialId };
  },
});

/**
 * internalQuery — return the raw (encrypted) credential row for an action to
 * decrypt. Keeps the DB read in a query and `decryptAtRest` in the action, per
 * the repo's action/query execution-model split. INTERNAL only.
 */
export const _getCredentialForAction = internalQuery({
  args: { credentialId: v.id("calendarCredentials") },
  handler: async (
    ctx: Ctx,
    args,
  ): Promise<{
    encSecretCiphertext: string;
    encSecretIv: string;
    caldavServerUrl?: string;
    caldavUsername?: string;
  } | null> => {
    const row = await ctx.db.get(args.credentialId);
    if (!row) return null;
    return {
      encSecretCiphertext: row.encSecretCiphertext,
      encSecretIv: row.encSecretIv,
      caldavServerUrl: row.caldavServerUrl,
      caldavUsername: row.caldavUsername,
    };
  },
});

/**
 * internalAction — decrypt the CalDAV password, list the account's calendars,
 * upsert `selectedCalendars`. A failure here MUST NOT undo the credential —
 * log + continue (the user can re-enumerate later). Reuses the same
 * `_upsertSelectedCalendars` write as Google.
 */
export const _enumerateCalDavCalendars = internalAction({
  args: {
    authUserId: v.string(),
    credentialId: v.id("calendarCredentials"),
  },
  handler: async (ctx, args): Promise<void> => {
    const cred = await ctx.runQuery(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (internal as any).scheduling.calendarOauth._getCredentialForAction,
      { credentialId: args.credentialId },
    );
    if (!cred) return;

    try {
      const password = await decryptAtRest({
        ciphertext: cred.encSecretCiphertext,
        iv: cred.encSecretIv,
      });
      const calendars: IntegrationCalendar[] = await caldavListCalendars({
        serverUrl: cred.caldavServerUrl || DEFAULT_CALDAV_SERVER_URL,
        username: cred.caldavUsername ?? "",
        password,
      });
      await ctx.runMutation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (internal as any).scheduling.calendarOauth._upsertSelectedCalendars,
        {
          authUserId: args.authUserId,
          credentialId: args.credentialId,
          calendars: calendars.map((c) => ({
            externalCalendarId: c.externalId,
            displayName: c.name,
            primary: c.primary === true,
            timeZone: c.timeZone,
          })),
        },
      );
    } catch (err) {
      log.error("caldav.enumerate_failed", err, {
        authUserId: args.authUserId,
      });
    }
  },
});

// ─────────────────────────────────────────────────────────────
// listConnectedCalendars — query (owner-scoped, NOT flag-gated)
// ─────────────────────────────────────────────────────────────
//
// C5 (owner admin / "Connected calendars" card). The connect flow + the
// internal enumeration writes (above) existed, but there was no PUBLIC read for
// the settings UI to render "which calendars are connected + per-calendar
// conflict toggle". This adds it.
//
// Owner-scoped like the other reads (identity from auth, NOT flag-gated — the
// owner can always inspect their own config before launch). Returns each
// credential with its `selectedCalendars` children embedded for a single
// round-trip. SECRETS ARE NEVER RETURNED: `encSecretCiphertext`/`encSecretIv`
// (and the CalDAV password fields) stay server-side; only display-safe fields
// are projected.

type ConnectedCalendar = {
  _id: Id<"selectedCalendars">;
  externalCalendarId: string;
  displayName?: string;
  checkForConflicts: boolean;
  isDestination: boolean;
  timeZone?: string;
};

type ConnectedCredential = {
  _id: Id<"calendarCredentials">;
  provider: "google" | "caldav";
  label: string;
  invalid: boolean;
  calendars: ConnectedCalendar[];
};

export async function listConnectedCalendarsHandler(
  ctx: Ctx,
  _args: Record<string, never>,
): Promise<ConnectedCredential[]> {
  const authUserId = await requireAuthUserId(ctx);
  return listConnectedCalendarsCore(ctx, authUserId);
}

// CV-2c — post-auth core. The auth-gated handler resolves the owner via the
// Convex identity; the server-to-server admin wrapper (calcomAdmin.ts) passes an
// explicit trusted `ownerId` (the dibslist authUserId the fork carries on
// session.user.uuid). Both run identical read logic.
export async function listConnectedCalendarsCore(
  ctx: Ctx,
  ownerId: string,
): Promise<ConnectedCredential[]> {
  const creds = await ctx.db
    .query("calendarCredentials")
    .withIndex("by_authUserId", (q: Ctx) => q.eq("authUserId", ownerId))
    .collect();

  const out: ConnectedCredential[] = [];
  for (const cred of creds) {
    const rows = await ctx.db
      .query("selectedCalendars")
      .withIndex("by_credential", (q: Ctx) =>
        q.eq("credentialId", cred._id),
      )
      .collect();
    out.push({
      _id: cred._id,
      provider: cred.provider,
      label: cred.label,
      invalid: cred.invalid === true,
      // Project ONLY display-safe fields — never the encrypted secret envelope.
      calendars: rows.map((r: Ctx) => ({
        _id: r._id,
        externalCalendarId: r.externalCalendarId,
        displayName: r.displayName,
        checkForConflicts: r.checkForConflicts === true,
        isDestination: r.isDestination === true,
        timeZone: r.timeZone,
      })),
    });
  }
  // Insertion order from the index scan (a short connected-accounts list).
  return out;
}

export const listConnectedCalendars = query({
  args: {},
  handler: listConnectedCalendarsHandler,
});
