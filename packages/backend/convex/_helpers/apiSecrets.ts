// Developer API platform — secret generation + hashing helpers.
// docs/developer-api-prd.md §2.2/§4. Secrets are generated server-side,
// returned to the caller EXACTLY ONCE, and only their SHA-256 hash is
// persisted (never the plaintext). Uses the Web Crypto API, which is
// available in the Convex function runtime (crypto.getRandomValues is
// seeded deterministically by Convex; crypto.subtle.digest is pure).

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomString(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** SHA-256 hex digest of an input string. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** dbl_live_… / dbl_test_… personal API key. Returns plaintext + last4. */
export function generateApiKeySecret(mode: "live" | "test"): {
  secret: string;
  last4: string;
} {
  const body = randomString(40);
  return { secret: `dbl_${mode}_${body}`, last4: body.slice(-4) };
}

export function generateClientId(): string {
  return `dbl_client_${randomString(16)}`;
}

export function generateClientSecret(): string {
  return `dbl_secret_${randomString(48)}`;
}

export function generateWebhookSecret(): string {
  return `whsec_${randomString(48)}`;
}
