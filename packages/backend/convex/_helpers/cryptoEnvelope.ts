// SECURITY-AUDIT-iter101 P0 — at-rest envelope encryption for long-lived
// secrets we have to keep in plaintext-equivalent form (the OAuth refresh
// tokens stored in `gmailAccounts.refreshToken`). Cannot hash because we
// have to present the token back to Google's token endpoint to mint a
// fresh access token.
//
// Algorithm: AES-256-GCM via WebCrypto (`crypto.subtle`). Convex's V8
// isolate exposes `globalThis.crypto.subtle` (we already use it for SHA-2
// digests in `inventoryAi.ts` / `extensionAuth.ts`), and Node's `globalThis.crypto`
// is symmetric — same `encryptAtRest({ciphertext, iv})` shape works in
// both the runtime and the vitest harness without an extra adapter.
//
// Storage shape: `{ ciphertext: hex, iv: hex }`. Tag is appended to
// ciphertext per the WebCrypto convention (last 16 bytes of the
// `encrypt()` output). Keeps the table schema two strings — no extra
// auth-tag column to migrate later if we rotate algorithms.
//
// Key source: `process.env.REFRESH_TOKEN_ENCRYPTION_KEY`. Operator must
// set this to a hex-encoded 32-byte value (`openssl rand -hex 32`) in
// every deployed env. In dev — when missing — we fall back to a
// DETERMINISTIC dev-only key and emit a single `log.warn` at module load
// so the developer sees it once. A deterministic fallback means an
// existing self-hosted dev row keeps decrypting across restarts; a
// random fallback would silently brick every row on every reload.
//
// Migration contract: callers that READ an existing plaintext row
// (`isEnvelope(value) === false`) should treat it as a legacy plaintext
// value, then transparently re-encrypt-and-write on the same mutation.
// This file ships the pure helpers; the migration glue lives in
// `gmailAccounts.ts` next to the read path.

import { log } from "./log";

// Public shape persisted on the row. Two `v.string()` fields in schema.
export interface EncryptedEnvelope {
  ciphertext: string; // hex
  iv: string; // hex
}

// ─────────────────────────────────────────────────────────────
// Key resolution
// ─────────────────────────────────────────────────────────────

const KEY_ENV = "REFRESH_TOKEN_ENCRYPTION_KEY";
// Deterministic dev key — sha256("dibslist-dev-refresh-token-key-v1") truncated
// to 32 bytes. Repeatable across module reloads so existing dev rows keep
// decrypting. NEVER used when the env var is set; only the dev fallback path.
const DEV_KEY_HEX =
  "7da0c5b7c5d9c5f6f5e4d3c2b1a09988776655443322110099887766554433aa";

let warnedAboutDevKey = false;

function resolveRawKeyHex(): { hex: string; isDev: boolean } {
  const fromEnv = (
    typeof process !== "undefined" ? process.env?.[KEY_ENV] : undefined
  )?.trim();
  if (fromEnv && fromEnv.length > 0) {
    if (fromEnv.length !== 64 || !/^[0-9a-fA-F]+$/.test(fromEnv)) {
      // Mis-set key: 32 bytes hex = 64 chars. Fall back to dev so we
      // still boot (the warn surfaces in logs) but flag it loudly.
      log.error("cryptoEnvelope.invalidKey", {
        env: KEY_ENV,
        reason: "must be 64 hex chars (32 bytes); falling back to dev key",
      });
      if (!warnedAboutDevKey) {
        warnedAboutDevKey = true;
        log.warn("cryptoEnvelope.devKeyFallback", {
          env: KEY_ENV,
          reason: "invalid value — using deterministic dev key",
        });
      }
      return { hex: DEV_KEY_HEX, isDev: true };
    }
    return { hex: fromEnv, isDev: false };
  }
  if (!warnedAboutDevKey) {
    warnedAboutDevKey = true;
    log.warn("cryptoEnvelope.devKeyFallback", {
      env: KEY_ENV,
      reason: "env var not set — using deterministic dev key",
    });
  }
  return { hex: DEV_KEY_HEX, isDev: true };
}

// ─────────────────────────────────────────────────────────────
// Hex helpers (avoid pulling in `node:buffer` so this stays Convex-safe)
// ─────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

// ─────────────────────────────────────────────────────────────
// Key cache. importKey is async + non-trivial; cache the resolved
// CryptoKey so high-volume callers (e.g. ingest scanning all of a
// user's gmailAccounts) don't pay it per call. Key handle is opaque
// and safe to memoize at module scope.
// ─────────────────────────────────────────────────────────────

let cachedKey: { hex: string; key: CryptoKey } | null = null;

async function getKey(): Promise<CryptoKey> {
  const { hex } = resolveRawKeyHex();
  if (cachedKey && cachedKey.hex === hex) return cachedKey.key;
  // Convex TS lib's BufferSource typing requires an ArrayBuffer-backed
  // view (not SharedArrayBuffer). Allocate a fresh ArrayBuffer and copy
  // the hex-decoded bytes into it so importKey is happy.
  const raw = hexToBytes(hex);
  const rawBuf = new ArrayBuffer(raw.length);
  new Uint8Array(rawBuf).set(raw);
  const key = await crypto.subtle.importKey(
    "raw",
    rawBuf,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  cachedKey = { hex, key };
  return key;
}

// ─────────────────────────────────────────────────────────────
// Public surface
// ─────────────────────────────────────────────────────────────

/**
 * Encrypt a UTF-8 plaintext into an envelope safe to persist as two
 * `v.string()` fields. Fresh random IV per call (do NOT reuse — AES-GCM
 * leaks the key under IV reuse).
 */
export async function encryptAtRest(plaintext: string): Promise<EncryptedEnvelope> {
  if (typeof plaintext !== "string") {
    throw new Error("encryptAtRest: plaintext must be a string");
  }
  const key = await getKey();
  // Allocate IV + data on fresh ArrayBuffers (Convex TS lib rejects
  // SharedArrayBuffer-backed views — same reason as `getKey`).
  const ivBuf = new ArrayBuffer(12);
  const ivView = new Uint8Array(ivBuf);
  crypto.getRandomValues(ivView);
  const encoded = new TextEncoder().encode(plaintext);
  const dataBuf = new ArrayBuffer(encoded.length);
  new Uint8Array(dataBuf).set(encoded);
  const cipherBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: ivBuf },
    key,
    dataBuf,
  );
  return {
    ciphertext: bytesToHex(new Uint8Array(cipherBuf)),
    iv: bytesToHex(ivView),
  };
}

/**
 * Decrypt an envelope produced by `encryptAtRest`. Throws on tampered
 * ciphertext (GCM auth tag mismatch) or malformed hex.
 */
export async function decryptAtRest(env: EncryptedEnvelope): Promise<string> {
  if (
    !env ||
    typeof env.ciphertext !== "string" ||
    typeof env.iv !== "string"
  ) {
    throw new Error("decryptAtRest: envelope must have ciphertext + iv strings");
  }
  const key = await getKey();
  const ivBytes = hexToBytes(env.iv);
  const cipherBytes = hexToBytes(env.ciphertext);
  const ivBuf = new ArrayBuffer(ivBytes.length);
  new Uint8Array(ivBuf).set(ivBytes);
  const cipherBuf = new ArrayBuffer(cipherBytes.length);
  new Uint8Array(cipherBuf).set(cipherBytes);
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBuf },
    key,
    cipherBuf,
  );
  return new TextDecoder().decode(plainBuf);
}

/**
 * Pure predicate. Distinguishes a row that already holds an
 * `EncryptedEnvelope` from one that still holds legacy plaintext (or
 * `undefined`). Read paths use this to decide whether to decrypt or to
 * trigger the encrypt-on-read migration. Kept loose (`unknown`) so
 * callers don't have to narrow at the call site.
 */
export function isEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.ciphertext === "string" &&
    typeof v.iv === "string" &&
    v.ciphertext.length > 0 &&
    v.iv.length > 0 &&
    /^[0-9a-fA-F]+$/.test(v.ciphertext) &&
    /^[0-9a-fA-F]+$/.test(v.iv)
  );
}

// Test-only: clear the module-scope warn flag and key cache so unit
// tests can exercise multiple key-resolution paths in one run. Not
// exported from the package; only consumed by `cryptoEnvelope.test.ts`.
export function _resetForTesting(): void {
  warnedAboutDevKey = false;
  cachedKey = null;
}
