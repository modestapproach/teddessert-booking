// CV-1 — dibslist-backed getServerSession.
//
// ORIGINAL: this read the next-auth JWT cookie (`getToken`), looked the user up
// in the cal.com Postgres `User` table via Prisma, and enriched it with the
// org/profile. The dibslist rewire removes Postgres entirely.
//
// NOW: the forked app trusts the dibslist Better-Auth session cookie (issued by
// the main app on `Domain=.dibslist.app`). This function:
//   1. Reads the incoming request's raw Cookie header.
//   2. Validates it via the Better Auth get-session proxy
//      (`validateDibslistSession` → GET {auth}/api/auth/get-session). Fail-closed.
//   3. Resolves a STABLE INTEGER cal user id for the dibslist user via the Convex
//      `scheduling/calcomUsers:resolveOrCreateCalcomUser` mutation (server-to-server
//      through `getConvex()`). cal's `Session.user.id` MUST be a number.
//   4. Returns the cal `Session` shape (same fields cal's call sites consume) —
//      a plain personal user (no org, no impersonation).
//
// `getUserSession` / `isAuthed` / `ensureSession` are unchanged: they consume the
// `Session` this returns, and the shape is identical to what cal expects.
//
// See CONVEX-REWIRE-NOTES.md for the full auth flow + required env.

import { getUserAvatarUrl } from "@calcom/lib/getAvatarUrl";
import { getConvex } from "@calcom/lib/server/convex";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import { LRUCache } from "lru-cache";
import type { GetServerSidePropsContext, NextApiRequest } from "next";
import type { AuthOptions, Session } from "next-auth";
import { makeFunctionReference } from "convex/server";

import { validateDibslistSession } from "./dibslistSession";

const log = logger.getSubLogger({ prefix: ["getServerSession"] });

// Reference to the Convex mutation by its string path. The fork has no Convex
// `_generated/api` (that lives in the dibslist backend repo), so we address the
// function by path. The mutation is idempotent — it upserts + re-syncs the
// profile snapshot, returning the stable integer `calId`.
const resolveOrCreateCalcomUser = makeFunctionReference<"mutation">(
  "scheduling/calcomUsers:resolveOrCreateCalcomUser"
);

// Read the stored calcom user row to reflect the real booking-onboarding state
// + the (possibly onboarding-edited) public booking handle in the session.
const getCalcomUserByAuthUserId = makeFunctionReference<"query">(
  "scheduling/calcomUsers:getCalcomUserByAuthUserId"
);

/**
 * Cache the constructed cal Session keyed by the Better-Auth session token so we
 * don't re-proxy + re-mint on every server call within a request burst. Short
 * TTL so a sign-out / profile change propagates quickly.
 */
const CACHE = new LRUCache<string, Session>({ max: 1000, ttl: 60 * 1000 });

/**
 * Drop any cached Session(s) for a dibslist authUserId. Called after a profile
 * mutation that changes a session-reflected field (e.g. `completedOnboarding`
 * flips, or the booking handle changes) so the 60s TTL can't keep serving a stale
 * flag — which would, for `completedOnboarding`, bounce a just-finished owner back
 * into onboarding for up to a minute. Keyed by session token internally, so we
 * scan the (≤1000-entry) cache and drop entries whose user matches.
 */
export function clearSessionCacheForUser(authUserId: string): void {
  const stale: string[] = [];
  for (const [token, session] of CACHE.entries()) {
    if (session?.user?.uuid === authUserId) stale.push(token);
  }
  for (const token of stale) CACHE.delete(token);
}

/** Extract the raw Cookie header from either request flavour cal passes. */
function getCookieHeader(
  req: NextApiRequest | GetServerSidePropsContext["req"]
): string | undefined {
  // `cookie` is typed `string | undefined` on NextApiRequest, but be defensive
  // about an array-of-strings shape (some adapters), without tripping the
  // never-narrowing on the string-only type.
  const raw: unknown = req?.headers?.cookie;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.join("; ");
  return undefined;
}

/**
 * Pull the Better-Auth session token out of the Cookie header for cache-keying.
 * Falls back to the whole header if the named cookie isn't found (still a stable
 * key per request burst).
 */
function sessionTokenFromCookies(cookieHeader: string): string {
  const match = cookieHeader.match(/(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=([^;]+)/);
  return match?.[1] ?? cookieHeader;
}

/**
 * Slimmed-down `getServerSession` — now backed by dibslist Better-Auth + Convex
 * instead of next-auth JWT + Prisma. The signature is unchanged so all existing
 * call sites (getUserSession, isAuthed, ensureSession, trpc createContext) keep
 * working.
 */
export async function getServerSession(options: {
  req: NextApiRequest | GetServerSidePropsContext["req"];
  authOptions?: AuthOptions;
}): Promise<Session | null> {
  const { req } = options;

  const cookieHeader = getCookieHeader(req);
  if (!cookieHeader) {
    log.debug("No cookie header on request");
    return null;
  }

  const cacheKey = sessionTokenFromCookies(cookieHeader);
  const cached = CACHE.get(cacheKey);
  if (cached) {
    log.debug("Returning cached session");
    return cached;
  }

  // 1+2. Validate the dibslist Better-Auth cookie (fail-closed).
  const authResult = await validateDibslistSession(cookieHeader);
  if (!authResult) {
    log.debug("dibslist session validation returned null");
    return null;
  }

  const { user: dibsUser } = authResult;

  // 3. Resolve a stable INTEGER cal user id + a fresh profile snapshot.
  let calId: number;
  let username: string;
  try {
    const convex = getConvex();
    const resolved = (await convex.mutation(resolveOrCreateCalcomUser, {
      authUserId: dibsUser.id,
      email: dibsUser.email,
      name: dibsUser.name ?? dibsUser.email.split("@")[0] ?? dibsUser.email,
      ...(dibsUser.username ? { username: dibsUser.username } : {}),
      ...(dibsUser.image ? { avatarUrl: dibsUser.image } : {}),
    })) as { calId: number; _id: string; created: boolean };
    calId = resolved.calId;
    // Re-derive the username the same way the mutation does so the session
    // matches the stored row without an extra round-trip.
    username =
      dibsUser.username ??
      (dibsUser.email.split("@")[0] ?? "").toLowerCase().replace(/[^a-z0-9._-]/g, "") ??
      `user${calId}`;
    if (!username) username = `user${calId}`;
  } catch (err) {
    // If we can't mint the cal id, we cannot produce a valid cal session
    // (cal requires an integer user.id). Fail closed.
    log.error("resolveOrCreateCalcomUser failed", err);
    return null;
  }

  // Reflect the stored booking-onboarding state + the (possibly edited) public
  // booking handle. Cached with the whole session, so this is one read per cache
  // window, not per request. Fail open to "not onboarded" so a transient Convex
  // error sends the owner through onboarding rather than skipping it.
  let completedOnboarding = false;
  try {
    const row = (await getConvex().query(getCalcomUserByAuthUserId, {
      authUserId: dibsUser.id,
    })) as { username?: string; completedBookingOnboarding?: boolean } | null;
    if (row?.username) username = row.username;
    completedOnboarding = row?.completedBookingOnboarding ?? false;
  } catch (err) {
    log.warn("getCalcomUserByAuthUserId (onboarding state) failed; defaulting to not-onboarded", err);
  }

  const emailVerified = dibsUser.emailVerified ? new Date() : null;
  const upId = `usr-${calId}`;

  // 4. Build the cal Session shape (plain personal user; no org, no impersonation).
  const session: Session = {
    hasValidLicense: false,
    expires: authResult.session.expiresAt
      ? new Date(authResult.session.expiresAt).toISOString()
      : new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    profileId: null,
    upId,
    user: {
      id: calId, // MUST be an integer — cal's Session.user.id is a Prisma Int
      uuid: dibsUser.id, // carry the dibslist authUserId string as the uuid
      name: dibsUser.name ?? null,
      username,
      orgAwareUsername: username,
      email: dibsUser.email,
      emailVerified,
      email_verified: !!dibsUser.emailVerified,
      completedOnboarding,
      role: "USER",
      image: getUserAvatarUrl({ avatarUrl: dibsUser.image ?? null }),
      belongsToActiveTeam: false,
      org: undefined,
      locale: "en",
      profile: {
        id: null, // UserAsPersonalProfile — no org
        upId,
        username,
        organizationId: null,
        organization: null,
      },
    },
  };

  CACHE.set(cacheKey, session);
  log.debug("Returned dibslist-backed session", safeStringify({ calId, upId }));
  return session;
}
