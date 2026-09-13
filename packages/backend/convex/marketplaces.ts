// Signed OAuth `state` helpers (HMAC-SHA256, 15-min TTL). Lifted from the
// dibslist marketplaces module; only these pure functions are used here, by
// the Google Calendar connect flow (scheduling/googleOAuth.ts).
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

const IS_TEST =
  process.env.VITEST === "true" || process.env.NODE_ENV === "test";

function stateSecret(): string {
  const explicit = process.env.CALENDAR_OAUTH_STATE_SECRET;
  if (explicit) return explicit;
  if (IS_TEST) return "test-oauth-state-secret";
  throw new Error("CALENDAR_OAUTH_STATE_SECRET is not set.");
}

// Web-Crypto HMAC-SHA256 → hex. async because crypto.subtle is async; the
// isolate exposes the same WebCrypto used by extensionAuth.sha256Hex.
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// Constant-time-ish string compare to avoid leaking signature bytes via early
// exit. Both inputs are hex of fixed length, so the length check is safe.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function b64urlEncode(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

function randomNonce(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  let s = "";
  for (const b of buf) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * Sign an OAuth `state`. Pure given a secret (defaults to stateSecret()), so
 * it's unit-testable. Layout: `${b64url(payload)}.${hmac}` where payload is
 * `${authUserId}:${nonce}:${expiry}`. The HMAC covers the payload string.
 *
 * Exported for unit tests + the start mutation.
 */
export async function signOAuthState(
  authUserId: string,
  opts?: { nonce?: string; expiry?: number; secret?: string; now?: number },
): Promise<string> {
  const now = opts?.now ?? Date.now();
  const nonce = opts?.nonce ?? randomNonce();
  const expiry = opts?.expiry ?? now + OAUTH_STATE_TTL_MS;
  const secret = opts?.secret ?? stateSecret();
  const payload = `${authUserId}:${nonce}:${expiry}`;
  const sig = await hmacHex(secret, payload);
  return `${b64urlEncode(payload)}.${sig}`;
}

export type VerifyStateResult =
  | { ok: true; authUserId: string; nonce: string; expiry: number }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/**
 * Verify a signed OAuth `state`, returning the embedded authUserId (or a
 * reason on failure). Pure given a secret. Rejects tampered signatures and
 * expired states. Exported for unit tests + the callback HTTP action.
 */
export async function verifyOAuthState(
  state: string,
  opts?: { secret?: string; now?: number },
): Promise<VerifyStateResult> {
  const now = opts?.now ?? Date.now();
  const secret = opts?.secret ?? stateSecret();
  const dot = state.indexOf(".");
  if (dot <= 0 || dot === state.length - 1) {
    return { ok: false, reason: "malformed" };
  }
  const encodedPayload = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  let payload: string;
  try {
    payload = b64urlDecode(encodedPayload);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const expectedSig = await hmacHex(secret, payload);
  if (!timingSafeEqual(sig, expectedSig)) {
    return { ok: false, reason: "bad_signature" };
  }
  // payload = authUserId:nonce:expiry. authUserId may itself be opaque but
  // never contains ':' in BetterAuth ids; split from the right two fields.
  const parts = payload.split(":");
  if (parts.length < 3) return { ok: false, reason: "malformed" };
  const expiryStr = parts[parts.length - 1];
  const nonce = parts[parts.length - 2];
  const authUserId = parts.slice(0, parts.length - 2).join(":");
  const expiry = Number(expiryStr);
  if (!authUserId || !nonce || !Number.isFinite(expiry)) {
    return { ok: false, reason: "malformed" };
  }
  if (expiry < now) return { ok: false, reason: "expired" };
  return { ok: true, authUserId, nonce, expiry };
}
