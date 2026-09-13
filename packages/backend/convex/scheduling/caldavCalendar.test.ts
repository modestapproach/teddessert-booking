// B5 — unit tests for the CalDAV/Apple provider (`caldavCalendar.ts`) +
// the `connectCalDav` credential intake (`calendarOauth.ts`).
//
// HARNESS: no Convex runtime, no network. The wire fns are plain async fns
// taking an INJECTED `fetchImpl`; we pass a fake fetcher returning hand-crafted
// CalDAV XML / iCal `Response` objects and assert on the parsed result + the
// requests the code made. The intake mutation uses the FakeDb harness from
// `calendarOauth.test.ts` and asserts the password is stored ENCRYPTED.
//
// Covers the §criteria:
//   (a) getBusy parses a VFREEBUSY into correct epoch-ms intervals
//   (b) falls back to calendar-query + VEVENT merge when freebusy is empty
//   (c) expands a weekly RRULE within the window (honors EXDATE)
//   (d) an errored calendar is SURFACED (NOT treated as free)
//   (e) connectCalDav stores the password ENCRYPTED (no plaintext on the row)

import { describe, it, expect, vi } from "vitest";
import { ConvexError } from "convex/values";
import {
  caldavGetBusy,
  caldavGetBusyDetailed,
  caldavFreeBusyQuery,
  caldavCalendarQuery,
  caldavCreateEvent,
  caldavUpdateEvent,
  caldavDeleteEvent,
  caldavListCalendars,
  parseICal,
  parseRRule,
  expandRecurringEvent,
  veventsToBusy,
  mergeBusyIntervals,
  icalDateToEpochMs,
  parseICalDuration,
  buildEventICal,
  eventObjectUrl,
  type FetchImpl,
  type CalDavAuth,
} from "./caldavCalendar";

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

function xmlResponse(body: string, status = 207): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}

const AUTH: CalDavAuth = {
  serverUrl: "https://caldav.icloud.com",
  username: "ted@icloud.com",
  password: "abcd-efgh-ijkl-mnop",
};

const CAL_URL = "https://caldav.icloud.com/123/calendars/home/";

// Window: 2026-06-01 .. 2026-06-30 UTC.
const WIN_START = Date.parse("2026-06-01T00:00:00Z");
const WIN_END = Date.parse("2026-07-01T00:00:00Z");

// ─── (a) VFREEBUSY parse → epoch-ms intervals ────────────────────────────────

describe("caldavGetBusy — free-busy-query (VFREEBUSY) parse", () => {
  it("parses VFREEBUSY periods into correct UTC epoch-ms busy intervals", async () => {
    const vfreebusy = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VFREEBUSY",
      "DTSTART:20260601T000000Z",
      "DTEND:20260701T000000Z",
      "FREEBUSY;FBTYPE=BUSY:20260602T090000Z/20260602T100000Z",
      "FREEBUSY;FBTYPE=BUSY:20260603T140000Z/20260603T143000Z",
      // a FREE period must be ignored (not busy)
      "FREEBUSY;FBTYPE=FREE:20260604T000000Z/20260604T120000Z",
      "END:VFREEBUSY",
      "END:VCALENDAR",
    ].join("\r\n");

    const { fetchImpl, calls } = recordingFetch(() => xmlResponse(vfreebusy, 200));

    const busy = await caldavGetBusy(AUTH, [CAL_URL], WIN_START, WIN_END, fetchImpl);

    expect(busy).toEqual([
      {
        start: Date.parse("2026-06-02T09:00:00Z"),
        end: Date.parse("2026-06-02T10:00:00Z"),
      },
      {
        start: Date.parse("2026-06-03T14:00:00Z"),
        end: Date.parse("2026-06-03T14:30:00Z"),
      },
    ]);

    // A free-busy-query REPORT with the time-range + Basic auth header.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(CAL_URL);
    expect(calls[0].init?.method).toBe("REPORT");
    const auth = (calls[0].init?.headers as Record<string, string>).Authorization;
    expect(auth).toBe(`Basic ${btoa(`${AUTH.username}:${AUTH.password}`)}`);
    expect(String(calls[0].init?.body)).toMatch(/free-busy-query/);
    expect(String(calls[0].init?.body)).toMatch(/20260601T000000Z/);
  });

  it("parses a FREEBUSY period expressed as start/DURATION", async () => {
    const parsed = parseICal(
      [
        "BEGIN:VFREEBUSY",
        "FREEBUSY:20260602T090000Z/PT1H30M",
        "END:VFREEBUSY",
      ].join("\r\n"),
    );
    expect(parsed.freebusyPeriods).toEqual([
      {
        start: Date.parse("2026-06-02T09:00:00Z"),
        end: Date.parse("2026-06-02T10:30:00Z"),
      },
    ]);
  });
});

// ─── (b) fall back to calendar-query + VEVENT merge ──────────────────────────

describe("caldavGetBusy — calendar-query VEVENT fallback", () => {
  function multistatusWithEvents(...icals: string[]): string {
    const responses = icals
      .map(
        (ical) =>
          `<response><href>${CAL_URL}evt.ics</href><propstat><prop>` +
          `<calendar-data>${ical
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")}</calendar-data>` +
          `</prop><status>HTTP/1.1 200 OK</status></propstat></response>`,
      )
      .join("");
    return `<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${responses}</multistatus>`;
  }

  it("falls back to calendar-query when free-busy-query returns no VFREEBUSY", async () => {
    const event = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:evt-1@icloud.com",
      "DTSTART:20260610T130000Z",
      "DTEND:20260610T140000Z",
      "SUMMARY:Standup",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    let reportCount = 0;
    const { fetchImpl, calls } = recordingFetch((_url, init) => {
      const body = String(init?.body ?? "");
      reportCount++;
      if (/free-busy-query/.test(body)) {
        // iCloud-style: 200 but NO VFREEBUSY → triggers fallback.
        return xmlResponse(
          `<multistatus xmlns="DAV:"></multistatus>`,
          200,
        );
      }
      // calendar-query → return the VEVENT
      return xmlResponse(multistatusWithEvents(event), 207);
    });

    const busy = await caldavGetBusy(AUTH, [CAL_URL], WIN_START, WIN_END, fetchImpl);
    expect(busy).toEqual([
      {
        start: Date.parse("2026-06-10T13:00:00Z"),
        end: Date.parse("2026-06-10T14:00:00Z"),
      },
    ]);
    // Two REPORTs: free-busy-query (empty) then calendar-query (the fallback).
    expect(reportCount).toBe(2);
    expect(String(calls[1].init?.body)).toMatch(/calendar-query/);
  });

  it("skips a TRANSPARENT (show-as-free) event in the calendar-query merge", async () => {
    const opaque = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:busy@x",
      "DTSTART:20260610T130000Z",
      "DTEND:20260610T140000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const transparent = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:free@x",
      "TRANSP:TRANSPARENT",
      "DTSTART:20260611T130000Z",
      "DTEND:20260611T140000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const { fetchImpl } = recordingFetch(() =>
      xmlResponse(multistatusWithEvents(opaque, transparent), 207),
    );
    const busy = await caldavCalendarQuery(
      AUTH,
      CAL_URL,
      WIN_START,
      WIN_END,
      fetchImpl,
    );
    expect(busy).toEqual([
      {
        start: Date.parse("2026-06-10T13:00:00Z"),
        end: Date.parse("2026-06-10T14:00:00Z"),
      },
    ]);
  });

  it("merges two overlapping VEVENTs into a single busy interval", async () => {
    const a = [
      "BEGIN:VEVENT",
      "UID:a",
      "DTSTART:20260610T130000Z",
      "DTEND:20260610T143000Z",
      "END:VEVENT",
    ].join("\r\n");
    const b = [
      "BEGIN:VEVENT",
      "UID:b",
      "DTSTART:20260610T140000Z",
      "DTEND:20260610T150000Z",
      "END:VEVENT",
    ].join("\r\n");
    const events = parseICal(
      `BEGIN:VCALENDAR\r\n${a}\r\n${b}\r\nEND:VCALENDAR`,
    ).events;
    const busy = mergeBusyIntervals(veventsToBusy(events, WIN_START, WIN_END));
    expect(busy).toEqual([
      {
        start: Date.parse("2026-06-10T13:00:00Z"),
        end: Date.parse("2026-06-10T15:00:00Z"),
      },
    ]);
  });
});

// ─── (c) weekly RRULE expansion within the window (honors EXDATE) ────────────

describe("RRULE expansion", () => {
  it("expands a weekly RRULE within the window and DROPS an EXDATE occurrence", async () => {
    // Mon 2026-06-01 10:00–11:00 UTC, weekly, with 2026-06-15 cancelled.
    const ical = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:weekly@x",
      "DTSTART:20260601T100000Z",
      "DTEND:20260601T110000Z",
      "RRULE:FREQ=WEEKLY;INTERVAL=1",
      "EXDATE:20260615T100000Z",
      "SUMMARY:Weekly 1:1",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const events = parseICal(ical).events;
    // Window 2026-06-01 .. 2026-06-30: occurrences on 06-01, 06-08, (06-15 EXDATE'd),
    // 06-22, 06-29 → 4 busy intervals.
    const busy = veventsToBusy(events, WIN_START, WIN_END);
    expect(busy).toEqual([
      { start: Date.parse("2026-06-01T10:00:00Z"), end: Date.parse("2026-06-01T11:00:00Z") },
      { start: Date.parse("2026-06-08T10:00:00Z"), end: Date.parse("2026-06-08T11:00:00Z") },
      { start: Date.parse("2026-06-22T10:00:00Z"), end: Date.parse("2026-06-22T11:00:00Z") },
      { start: Date.parse("2026-06-29T10:00:00Z"), end: Date.parse("2026-06-29T11:00:00Z") },
    ]);
    // The EXDATE'd 06-15 occurrence is absent.
    expect(
      busy.some((b) => b.start === Date.parse("2026-06-15T10:00:00Z")),
    ).toBe(false);
  });

  it("honors a RECURRENCE-ID override (moved occurrence) in the expansion", async () => {
    const ical = [
      "BEGIN:VCALENDAR",
      // master weekly
      "BEGIN:VEVENT",
      "UID:weekly@x",
      "DTSTART:20260601T100000Z",
      "DTEND:20260601T110000Z",
      "RRULE:FREQ=WEEKLY",
      "END:VEVENT",
      // override: 06-08 moved to 15:00–16:00
      "BEGIN:VEVENT",
      "UID:weekly@x",
      "RECURRENCE-ID:20260608T100000Z",
      "DTSTART:20260608T150000Z",
      "DTEND:20260608T160000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const events = parseICal(ical).events;
    const busy = veventsToBusy(events, WIN_START, WIN_END);
    // 06-08 reflects the OVERRIDE (15:00), not the original 10:00.
    const jun8 = busy.find(
      (b) => b.start === Date.parse("2026-06-08T15:00:00Z"),
    );
    expect(jun8).toEqual({
      start: Date.parse("2026-06-08T15:00:00Z"),
      end: Date.parse("2026-06-08T16:00:00Z"),
    });
    // The original 06-08 10:00 occurrence must NOT also appear.
    expect(
      busy.some((b) => b.start === Date.parse("2026-06-08T10:00:00Z")),
    ).toBe(false);
  });

  it("respects COUNT in a daily RRULE", () => {
    const rule = parseRRule("FREQ=DAILY;COUNT=3")!;
    const out = expandRecurringEvent(
      Date.parse("2026-06-01T10:00:00Z"),
      3600_000,
      rule,
      WIN_START,
      WIN_END,
      new Set(),
      new Map(),
    );
    expect(out).toHaveLength(3);
    expect(out[0].start).toBe(Date.parse("2026-06-01T10:00:00Z"));
    expect(out[2].start).toBe(Date.parse("2026-06-03T10:00:00Z"));
  });

  it("SKIPS sub-daily (HOURLY) frequencies entirely", () => {
    const rule = parseRRule("FREQ=HOURLY")!;
    const out = expandRecurringEvent(
      WIN_START,
      3600_000,
      rule,
      WIN_START,
      WIN_END,
      new Set(),
      new Map(),
    );
    expect(out).toEqual([]);
  });
});

// ─── (d) an errored calendar is surfaced (NOT treated as free) ───────────────

describe("caldavGetBusyDetailed — errored calendar is surfaced", () => {
  it("records a calendar whose REPORT hard-fails (does NOT read as free)", async () => {
    const goodEvent = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:g",
      "DTSTART:20260610T130000Z",
      "DTEND:20260610T140000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const goodMultistatus =
      `<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">` +
      `<response><href>${CAL_URL}g.ics</href><propstat><prop><calendar-data>` +
      goodEvent.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") +
      `</calendar-data></prop></propstat></response></multistatus>`;

    const goodUrl = CAL_URL;
    const brokenUrl = "https://caldav.icloud.com/123/calendars/broken/";

    const { fetchImpl } = recordingFetch((url, init) => {
      const body = String(init?.body ?? "");
      if (url === brokenUrl) {
        // Both free-busy-query (→ null on non-2xx) AND calendar-query 500 here.
        // calendar-query throws → calendar surfaced as errored.
        return xmlResponse("server exploded", 500);
      }
      // good calendar: empty free-busy → fallback returns the VEVENT
      if (/free-busy-query/.test(body)) {
        return xmlResponse(`<multistatus xmlns="DAV:"></multistatus>`, 200);
      }
      return xmlResponse(goodMultistatus, 207);
    });

    const res = await caldavGetBusyDetailed(
      AUTH,
      [brokenUrl, goodUrl],
      WIN_START,
      WIN_END,
      fetchImpl,
    );

    // The good calendar's busy survived…
    expect(res.busy).toEqual([
      {
        start: Date.parse("2026-06-10T13:00:00Z"),
        end: Date.parse("2026-06-10T14:00:00Z"),
      },
    ]);
    // …and the broken calendar is SURFACED as errored, NOT silently dropped to
    // "free". The "false-free" trap: an errored calendar must never read empty.
    expect(res.erroredCalendarUrls).toEqual([brokenUrl]);
  });
});

// ─── write surface (create/update/delete) ────────────────────────────────────

describe("caldavCreateEvent / Update / Delete", () => {
  const EVENT = {
    title: "Interview: Jane Doe",
    description: "Loop round 2",
    location: "123 Main St",
    start: Date.parse("2026-06-10T15:00:00Z"),
    end: Date.parse("2026-06-10T16:00:00Z"),
    attendees: [{ email: "jane@example.com", name: "Jane Doe" }],
    idempotencyKey: "dibslist-booking-123",
  };

  it("PUTs a new object to {calendar}/{uid}.ics and returns the object URL", async () => {
    const { fetchImpl, calls } = recordingFetch(() => new Response(null, { status: 201 }));
    const res = await caldavCreateEvent(AUTH, CAL_URL, EVENT, fetchImpl);
    const expectedUrl = eventObjectUrl(CAL_URL, "dibslist-booking-123");
    expect(res).toEqual({ externalEventId: expectedUrl });
    expect(calls[0].url).toBe(expectedUrl);
    expect(calls[0].init?.method).toBe("PUT");
    expect((calls[0].init?.headers as Record<string, string>)["If-None-Match"]).toBe("*");
    const sent = String(calls[0].init?.body);
    expect(sent).toMatch(/UID:dibslist-booking-123/);
    expect(sent).toMatch(/SUMMARY:Interview: Jane Doe/);
    expect(sent).toMatch(/DTSTART:20260610T150000Z/);
    expect(sent).toMatch(/ATTENDEE;CN=Jane Doe:mailto:jane@example.com/);
  });

  it("uses the idempotencyKey as the iCal UID for provider-side dedupe", () => {
    const ical = buildEventICal("dibslist-booking-123", EVENT);
    expect(ical).toMatch(/UID:dibslist-booking-123/);
  });

  it("updateEvent does a full PUT to the existing object URL", async () => {
    const { fetchImpl, calls } = recordingFetch(() => new Response(null, { status: 204 }));
    const objectUrl = eventObjectUrl(CAL_URL, "dibslist-booking-123");
    const res = await caldavUpdateEvent(AUTH, objectUrl, EVENT, CAL_URL, fetchImpl);
    expect(res).toEqual({ externalEventId: objectUrl });
    expect(calls[0].init?.method).toBe("PUT");
    expect(calls[0].url).toBe(objectUrl);
  });

  it("deleteEvent treats a 404 (already gone) as success", async () => {
    const { fetchImpl } = recordingFetch(() => new Response("gone", { status: 404 }));
    await expect(
      caldavDeleteEvent(AUTH, eventObjectUrl(CAL_URL, "x"), CAL_URL, fetchImpl),
    ).resolves.toBeUndefined();
  });

  it("deleteEvent throws on a hard error (500)", async () => {
    const { fetchImpl } = recordingFetch(() => new Response("boom", { status: 500 }));
    await expect(
      caldavDeleteEvent(AUTH, eventObjectUrl(CAL_URL, "x"), CAL_URL, fetchImpl),
    ).rejects.toThrow(/deleteEvent failed \(500\)/);
  });
});

// ─── listCalendars (PROPFIND multistatus → IntegrationCalendar[]) ────────────

describe("caldavListCalendars", () => {
  it("maps calendar collections to IntegrationCalendar[] and derives readOnly", async () => {
    const body =
      `<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">` +
      // a calendar collection (writable)
      `<response><href>/123/calendars/home/</href><propstat><prop>` +
      `<resourcetype><collection/><C:calendar/></resourcetype>` +
      `<displayname>Home</displayname>` +
      `<current-user-privilege-set><privilege><write/></privilege></current-user-privilege-set>` +
      `</prop></propstat></response>` +
      // a read-only calendar (no write privilege)
      `<response><href>/123/calendars/holidays/</href><propstat><prop>` +
      `<resourcetype><collection/><C:calendar/></resourcetype>` +
      `<displayname>Holidays</displayname>` +
      `<current-user-privilege-set><privilege><read/></privilege></current-user-privilege-set>` +
      `</prop></propstat></response>` +
      // a NON-calendar collection (the home itself) → filtered out
      `<response><href>/123/calendars/</href><propstat><prop>` +
      `<resourcetype><collection/></resourcetype><displayname>Calendars</displayname>` +
      `</prop></propstat></response>` +
      `</multistatus>`;

    const { fetchImpl, calls } = recordingFetch(() => xmlResponse(body, 207));
    const cals = await caldavListCalendars(AUTH, fetchImpl);

    expect(calls[0].init?.method).toBe("PROPFIND");
    expect((calls[0].init?.headers as Record<string, string>).Depth).toBe("1");
    expect(cals).toEqual([
      {
        externalId: "https://caldav.icloud.com/123/calendars/home/",
        name: "Home",
        readOnly: false,
        primary: false,
      },
      {
        externalId: "https://caldav.icloud.com/123/calendars/holidays/",
        name: "Holidays",
        readOnly: true,
        primary: false,
      },
    ]);
  });
});

// ─── pure date/duration helpers ──────────────────────────────────────────────

describe("icalDateToEpochMs / parseICalDuration", () => {
  it("parses UTC, floating, and date-only iCal values", () => {
    expect(icalDateToEpochMs("20260601T090000Z")).toBe(
      Date.parse("2026-06-01T09:00:00Z"),
    );
    expect(icalDateToEpochMs("20260601")).toBe(Date.UTC(2026, 5, 1, 0, 0, 0));
    expect(icalDateToEpochMs("garbage")).toBeNull();
  });
  it("parses RFC 5545 durations", () => {
    expect(parseICalDuration("PT1H30M")).toBe(90 * 60_000);
    expect(parseICalDuration("P1D")).toBe(86400_000);
    expect(parseICalDuration("PT0S")).toBe(0);
    expect(parseICalDuration("nope")).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (e) connectCalDav — credential intake stores the password ENCRYPTED
// ════════════════════════════════════════════════════════════════════════════

vi.mock("../_helpers/auth", () => ({
  requireAuthUserId: async (ctx: any) => {
    if (!ctx.__identity)
      throw new ConvexError("Not authenticated. Please sign in.");
    return ctx.__identity as string;
  },
}));

// eslint-disable-next-line import/first
import * as calendarOauth from "./calendarOauth";
// eslint-disable-next-line import/first
import { decryptAtRest } from "../_helpers/cryptoEnvelope";

// In-memory FakeDb + scheduler (mirrors calendarOauth.test.ts).
type Doc = Record<string, any> & { _id: string; _creationTime: number };

class FakeQuery {
  private rows: Doc[];
  constructor(rows: Doc[]) {
    this.rows = rows;
  }
  withIndex(_name: string, fn?: (q: any) => any) {
    if (!fn) return this;
    const eqs: Array<[string, any]> = [];
    const q = {
      eq(field: string, value: any) {
        eqs.push([field, value]);
        return q;
      },
    };
    fn(q);
    this.rows = this.rows.filter((r) => eqs.every(([f, val]) => r[f] === val));
    return this;
  }
  async collect(): Promise<Doc[]> {
    return [...this.rows];
  }
  async unique(): Promise<Doc | null> {
    if (this.rows.length > 1) throw new Error("unique(): more than one row");
    return this.rows[0] ?? null;
  }
  async first(): Promise<Doc | null> {
    return this.rows[0] ?? null;
  }
}

class FakeDb {
  tables: Record<string, Map<string, Doc>> = {};
  private seq = 0;
  private table(name: string): Map<string, Doc> {
    if (!this.tables[name]) this.tables[name] = new Map();
    return this.tables[name];
  }
  private tableOfId(id: string): string {
    return id.split("|")[0];
  }
  async insert(table: string, doc: Record<string, any>): Promise<string> {
    this.seq += 1;
    const _id = `${table}|${this.seq}`;
    const row: Doc = { ...doc, _id, _creationTime: Date.now() + this.seq };
    this.table(table).set(_id, row);
    return _id;
  }
  async get(id: string): Promise<Doc | null> {
    return this.table(this.tableOfId(id)).get(id) ?? null;
  }
  async patch(id: string, patch: Record<string, any>): Promise<void> {
    const row = this.table(this.tableOfId(id)).get(id);
    if (!row) throw new Error(`patch: missing ${id}`);
    for (const [k, val] of Object.entries(patch)) {
      if (val === undefined) delete row[k];
      else row[k] = val;
    }
  }
  query(table: string) {
    return new FakeQuery([...this.table(table).values()]);
  }
}

function makeCtx(identity: string | null) {
  const scheduled: Array<{ delayMs: number; ref: unknown; args: unknown }> = [];
  return {
    ctx: {
      db: new FakeDb(),
      __identity: identity,
      scheduler: {
        runAfter: async (delayMs: number, ref: unknown, args: unknown) => {
          scheduled.push({ delayMs, ref, args });
        },
      },
    } as any,
    scheduled,
  };
}

async function enableBooking(ctx: any) {
  await ctx.db.insert("featureFlags", {
    key: "booking_enabled",
    value: true,
    updatedAt: Date.now(),
    updatedBy: "test",
  });
}

const callConnect = (ctx: any, a: any) =>
  (calendarOauth.connectCalDav as any)._handler(ctx, a);

describe("connectCalDav — encrypted credential intake", () => {
  it("stores the app-specific password ENCRYPTED (no plaintext on the row)", async () => {
    const { ctx, scheduled } = makeCtx("user_me");
    await enableBooking(ctx);

    const PLAINTEXT_PW = "abcd-efgh-ijkl-mnop";
    const { credentialId } = await callConnect(ctx, {
      serverUrl: "https://caldav.icloud.com",
      username: "ted@icloud.com",
      appSpecificPassword: PLAINTEXT_PW,
    });

    const row = await ctx.db.get(credentialId);
    expect(row.provider).toBe("caldav");
    expect(row.caldavServerUrl).toBe("https://caldav.icloud.com");
    expect(row.caldavUsername).toBe("ted@icloud.com");
    expect(row.label).toBe("ted@icloud.com");
    expect(row.invalid).toBe(false);

    // The plaintext password must NOT appear anywhere on the stored row.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(PLAINTEXT_PW);
    // No `appSpecificPassword`/`password`/`secret` plaintext field on the row.
    expect(row).not.toHaveProperty("appSpecificPassword");
    expect(row).not.toHaveProperty("password");

    // The encrypted envelope round-trips back to the original password.
    expect(
      await decryptAtRest({
        ciphertext: row.encSecretCiphertext,
        iv: row.encSecretIv,
      }),
    ).toBe(PLAINTEXT_PW);

    // Enumeration was scheduled (best-effort, committed-then-async).
    expect(scheduled).toHaveLength(1);
    expect((scheduled[0].args as any).credentialId).toBe(credentialId);
  });

  it("defaults serverUrl to https://caldav.icloud.com and re-connect clears invalid", async () => {
    const { ctx } = makeCtx("user_me");
    await enableBooking(ctx);

    const first = await callConnect(ctx, {
      username: "ted@icloud.com",
      appSpecificPassword: "first-pass-word-xx",
    });
    const row1 = await ctx.db.get(first.credentialId);
    expect(row1.caldavServerUrl).toBe("https://caldav.icloud.com");

    await ctx.db.patch(first.credentialId, { invalid: true });
    const second = await callConnect(ctx, {
      username: "ted@icloud.com",
      appSpecificPassword: "second-pass-word-x",
    });
    expect(second.credentialId).toBe(first.credentialId); // upsert, same row
    const row2 = await ctx.db.get(first.credentialId);
    expect(row2.invalid).toBe(false); // cleared on reconnect
    expect(
      await decryptAtRest({
        ciphertext: row2.encSecretCiphertext,
        iv: row2.encSecretIv,
      }),
    ).toBe("second-pass-word-x");
  });

  it("requires authentication", async () => {
    const { ctx } = makeCtx(null);
    await enableBooking(ctx);
    await expect(
      callConnect(ctx, {
        username: "ted@icloud.com",
        appSpecificPassword: "x",
      }),
    ).rejects.toThrow(/Not authenticated/);
  });

  it("is gated behind the DEFAULT-OFF booking flag", async () => {
    const { ctx } = makeCtx("user_me"); // no enableBooking
    await expect(
      callConnect(ctx, {
        username: "ted@icloud.com",
        appSpecificPassword: "x",
      }),
    ).rejects.toThrow();
  });

  it("rejects an empty username or password", async () => {
    const { ctx } = makeCtx("user_me");
    await enableBooking(ctx);
    await expect(
      callConnect(ctx, { username: "  ", appSpecificPassword: "x" }),
    ).rejects.toThrow(/required/);
  });
});
