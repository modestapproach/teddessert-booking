// B2 — unit tests for the Google Calendar OAuth connect helpers
// (`googleOAuth.ts`).
//
// HARNESS NOTE: no Convex runtime, no network. Same "injectable fetch harness"
// convention as googleCalendar.test.ts — plain async fns take an INJECTED
// `fetchImpl` returning hand-crafted `Response` objects. The signing helpers are
// pure given a secret. No `vi.stubGlobal`, no `vi.mock`.
//
// Covers:
//   - signState ↔ verifyState roundtrip PASSES (recovers authUserId)
//   - a tampered state is REJECTED
//   - an expired state is REJECTED
//   - exchangeCodeForTokens parses a mocked token response (+ POSTs body-auth)
//   - buildGoogleConsentUrl includes the two calendar scopes + offline + consent
//   - emailFromIdToken decodes the email claim

import { describe, it, expect } from "vitest";
import {
  buildGoogleConsentUrl,
  exchangeCodeForTokens,
  signState,
  verifyState,
  emailFromIdToken,
  GOOGLE_CALENDAR_SCOPES,
  type GoogleTokenResponse,
} from "./googleOAuth";
import type { FetchImpl } from "./googleCalendar";

const SECRET = "calendar-unit-test-secret-bbb";
const USER = "user_cal_123";

// ─── fake fetch harness (mirrors googleCalendar.test.ts) ─────────────────────

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function recordingFetch(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { fetchImpl: FetchImpl; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Parse an x-www-form-urlencoded body the code sent on a recorded call.
function formBodyOf(call: RecordedCall): URLSearchParams {
  const raw = call.init?.body;
  if (typeof raw !== "string") throw new Error("expected a string body");
  return new URLSearchParams(raw);
}

// ─────────────────────────────────────────────────────────────
// signState / verifyState roundtrip + rejection
// ─────────────────────────────────────────────────────────────

describe("signState / verifyState", () => {
  it("roundtrips a valid state back to the authUserId", async () => {
    const state = await signState({ authUserId: USER }, SECRET);
    const result = await verifyState(state, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.authUserId).toBe(USER);
      expect(result.nonce).toHaveLength(32);
      expect(result.expiry).toBeGreaterThan(Date.now());
    }
  });

  it("REJECTS a tampered state (bad_signature)", async () => {
    const state = await signState({ authUserId: USER }, SECRET);
    const [payload, sig] = state.split(".");
    // Flip the first payload char → signature no longer matches.
    const tampered =
      (payload[0] === "A" ? "B" : "A") + payload.slice(1) + "." + sig;
    const result = await verifyState(tampered, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["bad_signature", "malformed"]).toContain(result.reason);
    }
  });

  it("REJECTS a state signed with a different secret", async () => {
    const state = await signState({ authUserId: USER }, SECRET);
    const result = await verifyState(state, "some-other-secret");
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("REJECTS an expired state", async () => {
    const state = await signState(
      { authUserId: USER, expiry: Date.now() - 1000 },
      SECRET,
    );
    const result = await verifyState(state, SECRET);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("REJECTS a malformed (no-dot) state", async () => {
    const result = await verifyState("not-a-state", SECRET);
    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  it("produces a distinct nonce per call", async () => {
    const a = await signState({ authUserId: USER }, SECRET);
    const b = await signState({ authUserId: USER }, SECRET);
    expect(a).not.toBe(b);
  });
});

// ─────────────────────────────────────────────────────────────
// buildGoogleConsentUrl — scope + offline + consent assertions
// ─────────────────────────────────────────────────────────────

describe("buildGoogleConsentUrl", () => {
  it("includes the two calendar scopes + access_type=offline + prompt=consent", () => {
    const url = buildGoogleConsentUrl({
      state: "signed.state",
      redirectUri: "https://example.convex.site/calendar/oauth/callback",
      clientId: "client-123.apps.googleusercontent.com",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(parsed.searchParams.get("client_id")).toBe(
      "client-123.apps.googleusercontent.com",
    );
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "https://example.convex.site/calendar/oauth/callback",
    );
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("prompt")).toBe("consent");
    expect(parsed.searchParams.get("state")).toBe("signed.state");

    const scope = parsed.searchParams.get("scope") ?? "";
    const scopes = scope.split(" ");
    // The two calendar scopes are present.
    expect(scopes).toContain(
      "https://www.googleapis.com/auth/calendar.freebusy",
    );
    expect(scopes).toContain(
      "https://www.googleapis.com/auth/calendar.events",
    );
    // The full requested set matches GOOGLE_CALENDAR_SCOPES.
    expect(scopes).toEqual([...GOOGLE_CALENDAR_SCOPES]);
  });
});

// ─────────────────────────────────────────────────────────────
// exchangeCodeForTokens — parse a mocked token response
// ─────────────────────────────────────────────────────────────

describe("exchangeCodeForTokens", () => {
  it("POSTs body-auth to the Google token endpoint and parses the response", async () => {
    const NOW = 1_700_000_000_000;
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({
        access_token: "ya29.access",
        refresh_token: "1//refresh",
        expires_in: 3599,
        scope: "openid email https://www.googleapis.com/auth/calendar.events",
        id_token: "header.payload.sig",
      }),
    );

    const tok: GoogleTokenResponse = await exchangeCodeForTokens(
      "auth-code-xyz",
      {
        clientId: "cid",
        clientSecret: "csecret",
        redirectUri: "https://example.convex.site/calendar/oauth/callback",
        now: NOW,
      },
      fetchImpl,
    );

    expect(tok.access_token).toBe("ya29.access");
    expect(tok.refresh_token).toBe("1//refresh");
    // expiry_date = now + expires_in*1000.
    expect(tok.expiry_date).toBe(NOW + 3599 * 1000);
    expect(tok.id_token).toBe("header.payload.sig");

    // It POSTs to the token URL.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(calls[0].init?.method).toBe("POST");
    expect(
      (calls[0].init?.headers as Record<string, string>)["Content-Type"],
    ).toBe("application/x-www-form-urlencoded");

    // Client creds go in the BODY (Google convention), NOT a Basic header.
    expect(
      (calls[0].init?.headers as Record<string, string>).Authorization,
    ).toBeUndefined();
    const body = formBodyOf(calls[0]);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-xyz");
    expect(body.get("client_id")).toBe("cid");
    expect(body.get("client_secret")).toBe("csecret");
    expect(body.get("redirect_uri")).toBe(
      "https://example.convex.site/calendar/oauth/callback",
    );
  });

  it("throws on a non-2xx token exchange", async () => {
    const { fetchImpl } = recordingFetch(() =>
      new Response("invalid_grant", { status: 400 }),
    );
    await expect(
      exchangeCodeForTokens(
        "bad-code",
        { clientId: "c", clientSecret: "s", redirectUri: "r" },
        fetchImpl,
      ),
    ).rejects.toThrow(/exchangeCodeForTokens failed \(400\)/);
  });

  it("throws when the response is missing an access_token", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ scope: "x" }));
    await expect(
      exchangeCodeForTokens(
        "code",
        { clientId: "c", clientSecret: "s", redirectUri: "r" },
        fetchImpl,
      ),
    ).rejects.toThrow(/missing access_token/);
  });
});

// ─────────────────────────────────────────────────────────────
// emailFromIdToken — decode the email claim (no signature verify)
// ─────────────────────────────────────────────────────────────

describe("emailFromIdToken", () => {
  it("decodes the email claim from a JWT payload", () => {
    const payload = { email: "ted@gmail.com", sub: "123" };
    const b64 = btoa(JSON.stringify(payload))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const idToken = `eyJhbGciOiJSUzI1NiJ9.${b64}.signature`;
    expect(emailFromIdToken(idToken)).toBe("ted@gmail.com");
  });

  it("returns undefined for an absent / malformed id_token", () => {
    expect(emailFromIdToken(undefined)).toBeUndefined();
    expect(emailFromIdToken("only-one-part")).toBeUndefined();
    expect(emailFromIdToken("a.!!!notbase64!!!.c")).toBeUndefined();
  });
});
