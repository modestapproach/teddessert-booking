// B2 — Google Calendar OAuth connect (auth-code flow): plain, injectable-fetch,
// testable helpers.
//
// TESTABILITY CONTRACT (identical to googleCalendar.ts): every function here is
// a PLAIN module-level async function. The HTTP one takes an INJECTABLE
// `fetchImpl` (defaulting to the global `fetch`); the signing helpers are pure
// given a secret. No Convex `ctx`, no DB, no token minting via the SDK — so unit
// tests pass a fake fetcher + fixed secret and exercise the real request-build /
// response-parse / HMAC logic with NO network.
//
// The signed-`state` HMAC is REUSED verbatim from the eBay flow
// (`marketplaces.ts` signOAuthState/verifyOAuthState) — same stateless wire
// format `${b64url(authUserId:nonce:expiry)}.${hmac}`. We additionally expose
// thin `signState`/`verifyState` wrappers under the calendar-conventional names
// so the http.ts callback + the start route can import from one place, and so a
// dedicated `CALENDAR_OAUTH_STATE_SECRET` can be threaded if the operator wants
// to rotate calendar state independently of eBay.
//
// RUNTIME-UNVERIFIED [R]: no live Google OAuth round-trip has been exercised
// (no consent-screen, no real `code`). The pure helpers ARE unit-tested
// (signState↔verifyState roundtrip, tamper/expiry rejection, the token-exchange
// fetch shape against a mocked fetcher, and the consent-URL scope assertions).

import {
  signOAuthState,
  verifyOAuthState,
  type VerifyStateResult,
} from "../marketplaces";
import type { FetchImpl } from "./googleCalendar";

const defaultFetch: FetchImpl = (url, init) => fetch(url, init);

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const FETCH_TIMEOUT_MS = 10_000;

/**
 * The scopes the consent screen requests. `openid email` lets the callback
 * recover the connected account's email (for the credential `label`);
 * `calendar.freebusy` powers availability conflict checks; `calendar.events`
 * powers writing the booking event onto the destination calendar. We do NOT
 * request the broad read/write `calendar` scope — least-privilege.
 */
export const GOOGLE_CALENDAR_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.events",
] as const;

// ─────────────────────────────────────────────────────────────
// Consent URL
// ─────────────────────────────────────────────────────────────

export interface BuildConsentUrlParams {
  /** Signed OAuth `state` (carries authUserId + nonce + expiry; see signState). */
  state: string;
  /** Registered redirect URI — must EXACTLY match a Google Cloud Console entry. */
  redirectUri: string;
  /** Google OAuth client id (from GOOGLE_CLIENT_ID). */
  clientId: string;
  /**
   * Scopes to request. Defaults to GOOGLE_CALENDAR_SCOPES so existing calendar
   * callers are unchanged; the Connect-Gmail flow passes GOOGLE_GMAIL_SCOPES
   * (scheduling/gmailOauth.ts). COMPLIANT-SYNC (docs/compliant-sync-*.md).
   */
  scope?: readonly string[];
}

/**
 * Build the Google consent URL. `access_type=offline` + `prompt=consent` force
 * Google to issue a refresh_token on EVERY connect (without `prompt=consent`,
 * Google omits the refresh_token on a re-consent for an already-authorized
 * client, which would leave us unable to mint access tokens later).
 *
 * Pure — no env, no network. Returns the full authorize URL string.
 */
export function buildGoogleConsentUrl(params: BuildConsentUrlParams): string {
  const search = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: (params.scope ?? GOOGLE_CALENDAR_SCOPES).join(" "),
    access_type: "offline",
    prompt: "consent",
    // include_granted_scopes lets incremental authorizations stack rather than
    // replace previously-granted scopes for the same client.
    include_granted_scopes: "true",
    state: params.state,
  });
  return `${GOOGLE_AUTHORIZE_URL}?${search.toString()}`;
}

// ─────────────────────────────────────────────────────────────
// Auth-code → tokens exchange
// ─────────────────────────────────────────────────────────────

export interface GoogleTokenResponse {
  access_token: string;
  /**
   * Present only when Google issues a refresh token. With `access_type=offline`
   * + `prompt=consent` it is always returned on a fresh connect; we treat its
   * absence as a hard error in the callback.
   */
  refresh_token?: string;
  /** Absolute UTC epoch-ms at which the access token expires. */
  expiry_date: number;
  /** Space-delimited granted scopes, if Google echoes them. */
  scope?: string;
  /** The raw id_token (JWT) — used by the callback to recover the email. */
  id_token?: string;
}

export interface ExchangeCodeOpts {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** For deterministic `expiry_date` in tests; defaults to Date.now(). */
  now?: number;
}

async function fetchWithTimeout(
  fetchImpl: FetchImpl,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exchange an authorization `code` for tokens. POSTs to Google's token endpoint
 * with the client_id/client_secret in the BODY (Google's convention — NOT a
 * Basic auth header like eBay). Injectable `fetchImpl` for tests.
 *
 * Throws on a non-2xx (mirrors googleCalendar.ts `throwForStatus` shape:
 * `exchangeCodeForTokens failed (<status>): <body slice>`), so the callback can
 * map the failure to an error redirect without leaking the body.
 */
export async function exchangeCodeForTokens(
  code: string,
  opts: ExchangeCodeOpts,
  fetchImpl: FetchImpl = defaultFetch,
): Promise<GoogleTokenResponse> {
  const now = opts.now ?? Date.now();
  const resp = await fetchWithTimeout(fetchImpl, GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!resp.ok) {
    let body = "";
    try {
      body = await resp.text();
    } catch {
      // best-effort context only
    }
    throw new Error(
      `exchangeCodeForTokens failed (${resp.status}): ${body.slice(0, 500)}`,
    );
  }
  const data = (await resp.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    id_token?: string;
  };
  if (!data.access_token) {
    throw new Error("Google token response missing access_token.");
  }
  const expiresInMs = (data.expires_in ?? 0) * 1000;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expiry_date: now + expiresInMs,
    scope: data.scope,
    id_token: data.id_token,
  };
}

// ─────────────────────────────────────────────────────────────
// id_token email recovery (pure JWT payload parse — NO signature verify)
// ─────────────────────────────────────────────────────────────

/**
 * Decode the `email` claim from a Google id_token WITHOUT verifying the
 * signature. This is SAFE here because the id_token arrived over a TLS
 * server-to-server token exchange we initiated (not from the browser), so it is
 * already trusted as Google's response — we only need the email for a display
 * label, never for authz. Returns undefined if absent/unparseable.
 */
export function emailFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  const parts = idToken.split(".");
  if (parts.length < 2) return undefined;
  try {
    // base64url → base64 → JSON
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    const claims = JSON.parse(json) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email : undefined;
  } catch {
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────
// Signed state — calendar-conventional wrappers over the shared eBay signer
// ─────────────────────────────────────────────────────────────

// The calendar flow can sign state under a dedicated secret; falls back to the
// shared signer's default (EBAY_OAUTH_STATE_SECRET → BETTER_AUTH_SECRET → test
// placeholder) when CALENDAR_OAUTH_STATE_SECRET is unset.
function calendarStateSecret(): string | undefined {
  return process.env.CALENDAR_OAUTH_STATE_SECRET || undefined;
}

export interface SignStatePayload {
  authUserId: string;
  /** Optional override for the random nonce (tests). */
  nonce?: string;
  /** Optional absolute expiry epoch-ms (tests); else 15-min TTL. */
  expiry?: number;
  /** Optional Date.now() override (tests). */
  now?: number;
}

/**
 * Sign a calendar OAuth `state` carrying `authUserId` + a random nonce + a short
 * (15-min) TTL. Thin wrapper over the shared `signOAuthState` so the wire format
 * is byte-identical to eBay's — only the (optional) secret differs. `secret`
 * defaults to CALENDAR_OAUTH_STATE_SECRET, else the shared signer's fallback.
 */
export async function signState(
  payload: SignStatePayload,
  secret?: string,
): Promise<string> {
  return signOAuthState(payload.authUserId, {
    nonce: payload.nonce,
    expiry: payload.expiry,
    now: payload.now,
    secret: secret ?? calendarStateSecret(),
  });
}

/**
 * Verify a calendar OAuth `state`. Returns the embedded authUserId or a failure
 * reason (malformed | bad_signature | expired). Thin wrapper over the shared
 * `verifyOAuthState`.
 */
export async function verifyState(
  token: string,
  secret?: string,
  now?: number,
): Promise<VerifyStateResult> {
  return verifyOAuthState(token, {
    secret: secret ?? calendarStateSecret(),
    now,
  });
}
