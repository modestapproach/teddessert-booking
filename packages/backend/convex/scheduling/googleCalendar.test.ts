// B1 — unit tests for the Google Calendar provider (`googleCalendar.ts`).
//
// HARNESS NOTE: no Convex runtime, no network. Following the repo convention
// (`_helpers/googleOidc.test.ts`): the network logic is plain async functions
// that take an INJECTED `fetchImpl`. We pass a fake fetcher returning
// hand-crafted `Response` objects (the global `Response` is available in the
// vitest/Node env) and assert on the parsed result + the requests the code
// made. No `vi.stubGlobal`, no `vi.mock`.
//
// Covers the §criteria:
//   (a) googleGetBusy parses a freeBusy response into correct epoch-ms intervals
//   (b) a calendar that returns errors[] is SKIPPED; the good ones are kept
//   (c) >50 calendar ids are split into multiple fetch calls (call-count assert)
//   (d) googleCreateEvent POSTs the expected body (summary/start/end/attendees)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  googleGetBusy,
  googleGetBusyDetailed,
  googleFreeBusyChunk,
  googleCreateEvent,
  googleUpdateEvent,
  googleDeleteEvent,
  googleListCalendars,
  withGoogleToken,
  chunk,
  chunkWindow,
  type FetchImpl,
} from "./googleCalendar";
import type { CalendarCredential } from "./calendarService";

// ─── fake fetch harness ──────────────────────────────────────────────────────

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

/** Build a fake `fetchImpl` that records every call and returns `responder`. */
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

const TOKEN = "fake-access-token";

// Helper: parse the JSON body the code sent on a recorded call.
function bodyOf(call: RecordedCall): any {
  const raw = call.init?.body;
  if (typeof raw !== "string") throw new Error("expected a string body");
  return JSON.parse(raw);
}

// ─── (a) parsing freeBusy → epoch-ms ─────────────────────────────────────────

describe("googleGetBusy — parsing", () => {
  it("parses busy ISO strings into correct UTC epoch-ms intervals", async () => {
    const start1 = "2026-06-01T09:00:00Z";
    const end1 = "2026-06-01T10:00:00Z";
    const start2 = "2026-06-01T14:30:00Z";
    const end2 = "2026-06-01T15:00:00Z";

    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({
        calendars: {
          primary: { busy: [{ start: start1, end: end1 }] },
          "work@example.com": { busy: [{ start: start2, end: end2 }] },
        },
      }),
    );

    const windowStart = Date.parse("2026-06-01T00:00:00Z");
    const windowEnd = Date.parse("2026-06-02T00:00:00Z");
    const busy = await googleGetBusy(
      TOKEN,
      ["primary", "work@example.com"],
      windowStart,
      windowEnd,
      fetchImpl,
    );

    expect(busy).toEqual([
      { start: Date.parse(start1), end: Date.parse(end1) },
      { start: Date.parse(start2), end: Date.parse(end2) },
    ]);

    // Exactly one freeBusy POST (2 ids ≤ 50, 1-day window ≤ 90d).
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://www.googleapis.com/calendar/v3/freeBusy");
    expect(calls[0].init?.method).toBe("POST");
    const sent = bodyOf(calls[0]);
    expect(sent.timeMin).toBe(new Date(windowStart).toISOString());
    expect(sent.timeMax).toBe(new Date(windowEnd).toISOString());
    expect(sent.items).toEqual([
      { id: "primary" },
      { id: "work@example.com" },
    ]);
    // Bearer auth header present.
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it("skips malformed busy slots (unparseable ISO) without throwing", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({
        calendars: {
          primary: {
            busy: [
              { start: "not-a-date", end: "2026-06-01T10:00:00Z" },
              { start: "2026-06-01T11:00:00Z", end: "2026-06-01T12:00:00Z" },
            ],
          },
        },
      }),
    );
    const busy = await googleFreeBusyChunk(
      TOKEN,
      ["primary"],
      Date.parse("2026-06-01T00:00:00Z"),
      Date.parse("2026-06-02T00:00:00Z"),
      fetchImpl,
    );
    expect(busy.busy).toEqual([
      {
        start: Date.parse("2026-06-01T11:00:00Z"),
        end: Date.parse("2026-06-01T12:00:00Z"),
      },
    ]);
  });
});

// ─── (b) per-calendar errors[] → skip that calendar, keep the rest ───────────

describe("googleGetBusy — per-calendar errors", () => {
  it("skips a calendar that returns errors[] but keeps the good calendars", async () => {
    const goodStart = "2026-06-01T09:00:00Z";
    const goodEnd = "2026-06-01T10:00:00Z";

    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({
        calendars: {
          // inaccessible calendar — returns errors[], NO busy → must be skipped
          "broken@example.com": {
            errors: [{ domain: "global", reason: "notFound" }],
          },
          // good calendar — its busy must survive
          primary: { busy: [{ start: goodStart, end: goodEnd }] },
        },
      }),
    );

    const result = await googleFreeBusyChunk(
      TOKEN,
      ["broken@example.com", "primary"],
      Date.parse("2026-06-01T00:00:00Z"),
      Date.parse("2026-06-02T00:00:00Z"),
      fetchImpl,
    );

    expect(result.busy).toEqual([
      { start: Date.parse(goodStart), end: Date.parse(goodEnd) },
    ]);
    expect(result.erroredCalendarIds).toEqual(["broken@example.com"]);
  });

  it("one bad calendar does not fail the whole getBusy batch", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({
        calendars: {
          bad: { errors: [{ reason: "notFound" }] },
          ok: {
            busy: [
              {
                start: "2026-06-01T09:00:00Z",
                end: "2026-06-01T09:30:00Z",
              },
            ],
          },
        },
      }),
    );
    const busy = await googleGetBusy(
      TOKEN,
      ["bad", "ok"],
      Date.parse("2026-06-01T00:00:00Z"),
      Date.parse("2026-06-02T00:00:00Z"),
      fetchImpl,
    );
    expect(busy).toEqual([
      {
        start: Date.parse("2026-06-01T09:00:00Z"),
        end: Date.parse("2026-06-01T09:30:00Z"),
      },
    ]);
  });
});

// ─── (c) >50 calendar ids → multiple fetch calls ─────────────────────────────

describe("googleGetBusy — batching", () => {
  it("splits >50 calendar ids into multiple freeBusy calls (≤50 each)", async () => {
    // 120 calendar ids → ceil(120/50) = 3 chunks → 3 fetch calls.
    const ids = Array.from({ length: 120 }, (_, i) => `cal-${i}`);

    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({ calendars: {} }),
    );

    await googleGetBusy(
      TOKEN,
      ids,
      Date.parse("2026-06-01T00:00:00Z"),
      Date.parse("2026-06-02T00:00:00Z"), // 1-day window → no window splitting
      fetchImpl,
    );

    expect(calls).toHaveLength(3);
    // Each call carries ≤50 items; total items across calls === 120.
    const itemCounts = calls.map((c) => bodyOf(c).items.length);
    expect(itemCounts.every((n) => n <= 50)).toBe(true);
    expect(itemCounts.reduce((a, b) => a + b, 0)).toBe(120);
    // First two full (50), last is the remainder (20).
    expect(itemCounts).toEqual([50, 50, 20]);
  });

  it("chunks a >90-day window into multiple calls per id-chunk", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({ calendars: {} }),
    );
    const from = Date.parse("2026-01-01T00:00:00Z");
    // 200 days → ceil(200/90) = 3 window chunks; 1 id-chunk → 3 calls.
    const to = from + 200 * 24 * 60 * 60 * 1000;
    await googleGetBusy(TOKEN, ["primary"], from, to, fetchImpl);
    expect(calls).toHaveLength(3);
  });
});

// ─── (d) googleCreateEvent POSTs the expected body ───────────────────────────

describe("googleCreateEvent", () => {
  it("POSTs to the calendar's events endpoint with the mapped event body", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({ id: "created-event-id-123" }),
    );

    const start = Date.parse("2026-06-10T15:00:00Z");
    const end = Date.parse("2026-06-10T16:00:00Z");
    const res = await googleCreateEvent(
      TOKEN,
      "primary",
      {
        title: "Interview: Jane Doe",
        description: "Loop round 2",
        location: "123 Main St",
        start,
        end,
        timeZone: "America/New_York",
        attendees: [
          { email: "jane@example.com", name: "Jane Doe" },
          { email: "host@dibslist.app", responseStatus: "accepted" },
        ],
        idempotencyKey: "dibslistbooking123",
      },
      fetchImpl,
    );

    expect(res).toEqual({ externalEventId: "created-event-id-123" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    );
    expect(calls[0].init?.method).toBe("POST");
    expect(
      (calls[0].init?.headers as Record<string, string>).Authorization,
    ).toBe(`Bearer ${TOKEN}`);

    const sent = bodyOf(calls[0]);
    expect(sent.summary).toBe("Interview: Jane Doe");
    expect(sent.description).toBe("Loop round 2");
    expect(sent.location).toBe("123 Main St");
    expect(sent.start).toEqual({
      dateTime: new Date(start).toISOString(),
      timeZone: "America/New_York",
    });
    expect(sent.end).toEqual({
      dateTime: new Date(end).toISOString(),
      timeZone: "America/New_York",
    });
    expect(sent.attendees).toEqual([
      { email: "jane@example.com", displayName: "Jane Doe" },
      { email: "host@dibslist.app", responseStatus: "accepted" },
    ]);
    // Stable idempotency id passed through as the Google request `id`.
    expect(sent.id).toBe("dibslistbooking123");
  });

  it("encodes a calendar id with special chars in the URL path", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({ id: "evt" }),
    );
    await googleCreateEvent(
      TOKEN,
      "work@example.com",
      {
        title: "x",
        start: Date.parse("2026-06-10T15:00:00Z"),
        end: Date.parse("2026-06-10T16:00:00Z"),
      },
      fetchImpl,
    );
    expect(calls[0].url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/work%40example.com/events",
    );
  });

  it("throws on a non-2xx create response", async () => {
    const { fetchImpl } = recordingFetch(() =>
      new Response("forbidden", { status: 403 }),
    );
    await expect(
      googleCreateEvent(
        TOKEN,
        "primary",
        {
          title: "x",
          start: Date.parse("2026-06-10T15:00:00Z"),
          end: Date.parse("2026-06-10T16:00:00Z"),
        },
        fetchImpl,
      ),
    ).rejects.toThrow(/createEvent failed \(403\)/);
  });
});

// ─── updateEvent / deleteEvent / listCalendars (additional coverage) ─────────

describe("googleUpdateEvent", () => {
  it("PATCHes the event endpoint and drops the immutable request id", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({ id: "evt-1" }),
    );
    const res = await googleUpdateEvent(
      TOKEN,
      "primary",
      "evt-1",
      {
        title: "Updated",
        start: Date.parse("2026-06-10T15:00:00Z"),
        end: Date.parse("2026-06-10T16:00:00Z"),
        idempotencyKey: "shouldNotBeSentOnPatch",
      },
      fetchImpl,
    );
    expect(res).toEqual({ externalEventId: "evt-1" });
    expect(calls[0].init?.method).toBe("PATCH");
    expect(calls[0].url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-1",
    );
    // `id` must NOT be re-sent on PATCH.
    expect(bodyOf(calls[0]).id).toBeUndefined();
    expect(bodyOf(calls[0]).summary).toBe("Updated");
  });
});

describe("googleDeleteEvent", () => {
  it("DELETEs the event endpoint and treats 204 as success", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      new Response(null, { status: 204 }),
    );
    await expect(
      googleDeleteEvent(TOKEN, "primary", "evt-1", fetchImpl),
    ).resolves.toBeUndefined();
    expect(calls[0].init?.method).toBe("DELETE");
    expect(calls[0].url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-1",
    );
  });

  it("treats 410 (already gone) as success", async () => {
    const { fetchImpl } = recordingFetch(() =>
      new Response("gone", { status: 410 }),
    );
    await expect(
      googleDeleteEvent(TOKEN, "primary", "evt-1", fetchImpl),
    ).resolves.toBeUndefined();
  });

  it("throws on a hard delete error (404)", async () => {
    const { fetchImpl } = recordingFetch(() =>
      new Response("nope", { status: 404 }),
    );
    await expect(
      googleDeleteEvent(TOKEN, "primary", "evt-1", fetchImpl),
    ).rejects.toThrow(/deleteEvent failed \(404\)/);
  });
});

describe("googleListCalendars", () => {
  it("maps calendarList items to IntegrationCalendar[] and derives readOnly", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({
        items: [
          {
            id: "primary",
            summary: "Personal",
            primary: true,
            accessRole: "owner",
            timeZone: "America/New_York",
          },
          {
            id: "team@example.com",
            summary: "Team",
            accessRole: "reader",
          },
          {
            id: "writable@example.com",
            summary: "Shared",
            accessRole: "writer",
          },
          // no id → filtered out
          { summary: "ghost" },
        ],
      }),
    );

    const cals = await googleListCalendars(TOKEN, fetchImpl);
    expect(calls[0].url).toBe(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList",
    );
    expect(calls[0].init?.method).toBe("GET");
    expect(cals).toEqual([
      {
        externalId: "primary",
        name: "Personal",
        primary: true,
        readOnly: false,
        timeZone: "America/New_York",
      },
      {
        externalId: "team@example.com",
        name: "Team",
        primary: false,
        readOnly: true,
        timeZone: undefined,
      },
      {
        externalId: "writable@example.com",
        name: "Shared",
        primary: false,
        readOnly: false,
        timeZone: undefined,
      },
    ]);
  });
});

// ─── pure chunk helpers ──────────────────────────────────────────────────────

describe("chunk / chunkWindow helpers", () => {
  it("chunk splits into ≤size groups", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });

  it("chunkWindow splits [from,to) into ≤maxMs sub-windows", () => {
    const out = chunkWindow(0, 250, 100);
    expect(out).toEqual([
      { from: 0, to: 100 },
      { from: 100, to: 200 },
      { from: 200, to: 250 },
    ]);
  });

  it("chunkWindow returns [] for an empty/inverted window", () => {
    expect(chunkWindow(100, 100, 50)).toEqual([]);
    expect(chunkWindow(200, 100, 50)).toEqual([]);
  });
});

// ─── B2: googleGetBusyDetailed surfaces erroredCalendarIds (carry-forward) ────

describe("googleGetBusyDetailed — errored-id carry-forward", () => {
  it("collects deduped errored calendar ids across chunks (no longer dropped)", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({
        calendars: {
          "broken@example.com": {
            errors: [{ domain: "global", reason: "notFound" }],
          },
          primary: {
            busy: [{ start: "2026-06-01T09:00:00Z", end: "2026-06-01T10:00:00Z" }],
          },
        },
      }),
    );
    const res = await googleGetBusyDetailed(
      TOKEN,
      ["broken@example.com", "primary"],
      Date.parse("2026-06-01T00:00:00Z"),
      Date.parse("2026-06-02T00:00:00Z"),
      fetchImpl,
    );
    expect(res.busy).toEqual([
      {
        start: Date.parse("2026-06-01T09:00:00Z"),
        end: Date.parse("2026-06-01T10:00:00Z"),
      },
    ]);
    expect(res.erroredCalendarIds).toEqual(["broken@example.com"]);
  });

  it("googleGetBusy still returns BusyInterval[] (back-compat) and drops nothing silently", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({ calendars: { bad: { errors: [{ reason: "x" }] } } }),
    );
    const busy = await googleGetBusy(
      TOKEN,
      ["bad"],
      Date.parse("2026-06-01T00:00:00Z"),
      Date.parse("2026-06-02T00:00:00Z"),
      fetchImpl,
    );
    expect(busy).toEqual([]); // errored calendar contributes no busy; logged, not thrown
  });
});

// ─── B2: withGoogleToken — refresh-on-401 + mark-invalid on revoked grant ─────

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CRED: CalendarCredential = { provider: "google", secret: "1//refresh" };

/** A fake action ctx that records runMutation calls (mark-invalid lands here). */
function fakeActionCtx() {
  const mutations: Array<{ ref: unknown; args: unknown }> = [];
  return {
    ctx: {
      runMutation: async (ref: unknown, args: unknown) => {
        mutations.push({ ref, args });
        return null;
      },
    } as any,
    mutations,
  };
}

describe("withGoogleToken — refresh-on-401 + mark-invalid", () => {
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  });
  afterEach(() => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });

  it("mints a token, runs the op, and returns its result on the happy path", async () => {
    let minted = 0;
    const fetchImpl: FetchImpl = async (url) => {
      if (url === TOKEN_URL) {
        minted += 1;
        return jsonResponse({ access_token: "access-1" });
      }
      throw new Error("unexpected url");
    };
    const { ctx, mutations } = fakeActionCtx();
    const result = await withGoogleToken(
      ctx,
      "calendarCredentials|1",
      CRED,
      async (token) => `ran with ${token}`,
      fetchImpl,
    );
    expect(result).toBe("ran with access-1");
    expect(minted).toBe(1);
    expect(mutations).toHaveLength(0); // no mark-invalid
  });

  it("retries ONCE with a fresh token on a 401, then succeeds (no mark-invalid)", async () => {
    let minted = 0;
    let opCalls = 0;
    const fetchImpl: FetchImpl = async (url) => {
      if (url === TOKEN_URL) {
        minted += 1;
        return jsonResponse({ access_token: `access-${minted}` });
      }
      throw new Error("unexpected url");
    };
    const { ctx, mutations } = fakeActionCtx();
    const result = await withGoogleToken(
      ctx,
      "calendarCredentials|1",
      CRED,
      async (token) => {
        opCalls += 1;
        if (opCalls === 1) {
          // Simulate a Google API 401 in the SAME message shape the plain fns throw.
          throw new Error("Google Calendar listCalendars failed (401): expired");
        }
        return `ok with ${token}`;
      },
      fetchImpl,
    );
    expect(result).toBe("ok with access-2");
    expect(minted).toBe(2); // initial + one refresh
    expect(opCalls).toBe(2);
    expect(mutations).toHaveLength(0);
  });

  it("flags the credential invalid when the token refresh ITSELF fails (revoked)", async () => {
    const fetchImpl: FetchImpl = async (url) => {
      if (url === TOKEN_URL) {
        // Google returns 400 invalid_grant for a revoked refresh token.
        return new Response("invalid_grant", { status: 400 });
      }
      throw new Error("unexpected url");
    };
    const { ctx, mutations } = fakeActionCtx();
    await expect(
      withGoogleToken(
        ctx,
        "calendarCredentials|42",
        CRED,
        async () => "never",
        fetchImpl,
      ),
    ).rejects.toThrow(/token refresh failed \(400\)/);
    // mark-invalid mutation was invoked with the credential id.
    expect(mutations).toHaveLength(1);
    expect((mutations[0].args as any).credentialId).toBe("calendarCredentials|42");
  });
});
