import logger from "@calcom/lib/logger";
import { createHmac, timingSafeEqual } from "node:crypto";

const log = logger.getSubLogger({ prefix: ["ownerSession"] });

/**
 * STANDALONE OWNER AUTH.
 *
 * This booking app has exactly one account: the site owner. There is no user
 * database. Signing in means proving your identity through Cloudflare Access
 * (Google login, owner emails only) at `/owner-login` — see
 * `app/owner-login/route.ts` and `cloudflareAccess.ts`. That route then sets
 * an httpOnly cookie whose value is HMAC(NEXTAUTH_SECRET, <fixed label>).
 * Every request that carries that cookie resolves to the same owner user.
 * The public booking pages need no session at all.
 *
 * The module keeps the `validateDibslistSession` / `DibslistAuthSession`
 * names because `getServerSession.ts` (and its tests) consume them; the
 * shape is what matters, not the name.
 *
 * Env:
 *   NEXTAUTH_SECRET  HMAC key for the cookie (already required by next.config)
 *   OWNER_EMAIL      owner identity (default owner@localhost)
 *   OWNER_NAME       display name
 *   OWNER_USERNAME   Cal.com username behind the public pages, e.g. `ted`;
 *                    proxy.ts maps the clean / and /<slug> URLs onto /ted/<slug>
 */

export const OWNER_COOKIE = "owner_session";
export const OWNER_AUTH_USER_ID = "owner";

export function ownerSessionToken(): string | null {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update("owner-session-cloudflare-access").digest("hex");
}

/** The Convex HTTP-actions origin (`.convex.site`), derived from the cloud URL. */
export function getDibslistAuthBaseUrl(): string {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) throw new Error("NEXT_PUBLIC_CONVEX_URL is not set.");
  return convexUrl.replace(/\/$/, "").replace(/\.convex\.cloud$/, ".convex.site");
}

/** Where an unauthenticated visitor is sent to sign in as the owner. */
export function getDibslistLoginUrl(nextUrl?: string): string {
  const base = "/owner-login";
  if (!nextUrl) return base;
  return `${base}?next=${encodeURIComponent(nextUrl)}`;
}

export interface DibslistAuthUser {
  id: string;
  email: string;
  name?: string | null;
  emailVerified?: boolean | null;
  image?: string | null;
  username?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface DibslistAuthSession {
  session: { id: string; userId: string; expiresAt?: string | null; token?: string };
  user: DibslistAuthUser;
}

function ownerUser(): DibslistAuthUser {
  const email = process.env.OWNER_EMAIL || "owner@localhost";
  return {
    id: OWNER_AUTH_USER_ID,
    email,
    name: process.env.OWNER_NAME || email.split("@")[0],
    emailVerified: true,
    image: null,
    username: process.env.OWNER_USERNAME || "owner",
  };
}

function cookieValue(cookieHeader: string, name: string): string | undefined {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1];
}

/**
 * Resolve the owner session from the raw Cookie header. Returns the owner
 * when the `owner_session` cookie carries the expected HMAC, else null.
 */
export async function validateDibslistSession(
  cookieHeader: string | undefined | null
): Promise<DibslistAuthSession | null> {
  if (!cookieHeader) return null;
  const presented = cookieValue(cookieHeader, OWNER_COOKIE);
  if (!presented) return null;
  const expected = ownerSessionToken();
  if (!expected) {
    log.warn("NEXTAUTH_SECRET not set — nobody can sign in");
    return null;
  }
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return {
    session: {
      id: "owner-session",
      userId: OWNER_AUTH_USER_ID,
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    },
    user: ownerUser(),
  };
}
