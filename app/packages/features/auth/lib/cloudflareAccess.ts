import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * Cloudflare Access verification for the owner sign-in path.
 *
 * `/owner-login` sits behind a Cloudflare Access application scoped to that
 * one path (Google IdP only, restricted to the owner's emails). Access
 * attaches the signed identity to every request in `cf-access-jwt-assertion`;
 * verifying it here (signature via Access's published JWKS, issuer, audience,
 * expiry) proves the request really came through Access and lets the owner
 * sign in with Google instead of a password.
 */

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function teamDomain(): string | null {
  const raw = process.env.ACCESS_TEAM_DOMAIN;
  return raw ? raw.replace(/\/$/, "") : null;
}

/** The verified Access email (lowercase), or null when the assertion is missing/invalid. */
export async function verifyAccessAssertion(token: string | null | undefined): Promise<string | null> {
  const domain = teamDomain();
  const audience = process.env.ACCESS_AUD;
  if (!domain || !audience || !token) return null;
  // createRemoteJWKSet caches keys and refetches on an unrecognized kid, so
  // Access's periodic signing-key rotation doesn't need handling here.
  if (!jwks) jwks = createRemoteJWKSet(new URL(`${domain}/cdn-cgi/access/certs`));
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: domain, audience });
    return typeof payload.email === "string" ? payload.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Access emails allowed to sign in as the owner, lowercase. */
export function allowedAccessEmails(): string[] {
  return (process.env.ACCESS_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}
