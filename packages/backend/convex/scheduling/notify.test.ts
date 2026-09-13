// SCHEDULING D1 / D3 / D4 — tests for the channel-pluggable booking
// notification action (`scheduling/notify.ts`), the reminder sweep
// (`scheduling/reminders.ts`), and the webhook `_emitEvent` fan-out wired into
// `scheduling/booking.ts`.
//
// HARNESS: the repo action-test convention — a FakeDb + a fake action ctx whose
// `runQuery` / `runMutation` / `scheduler.runAfter` are dispatched on
// `getFunctionName(ref)` (the `_generated/api` Proxy resolves internal refs to
// real FunctionReferences even pre-codegen). The Brevo/Twilio HTTP boundary is
// the mocked `fetchImpl` injected into the channel fns; `_emitEvent` is the
// mocked webhook boundary (asserted via the FakeScheduler call log).
//
// LOAD-BEARING ASSERTIONS:
//   (a) email channel POSTs Brevo with the right body + base64 .ics attachment
//       when EMAIL_API_KEY is set; NO fetch at all when unset (skipped no-op).
//   (b) sms channel POSTs Twilio when TWILIO_* set; no fetch when unset.
//   (c) in_app channel ALWAYS inserts a notifications row (booking_received).
//   (d) reminder sweep dispatches due unsent rows + marks sentAt; skips
//       future-dated + already-sent rows.
//   (e) createBooking schedules internal.webhooks._emitEvent with the
//       `booking.created` PII-minimal payload.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getFunctionName } from "convex/server";
import {
  sendNotificationHandler,
  sendBrevoEmail,
  sendTwilioSms,
} from "./notify";
import { getBookingSyncContextHandler } from "./sync";
import { sweepDueRemindersHandler } from "./reminders";
import { createBookingHandler } from "./booking";

// ─────────────────────────────────────────────────────────────
// FakeDb (eq + range + take)
// ─────────────────────────────────────────────────────────────

type Doc = Record<string, any> & { _id: string; _creationTime: number };

class FakeQuery {
  private rows: Doc[];
  constructor(rows: Doc[]) {
    this.rows = rows;
  }
  withIndex(_name: string, fn?: (q: any) => any) {
    if (!fn) return this;
    const preds: Array<(r: Doc) => boolean> = [];
    const q = {
      eq(field: string, value: any) {
        preds.push((r) => r[field] === value);
        return q;
      },
      gte(field: string, value: any) {
        preds.push((r) => r[field] >= value);
        return q;
      },
      lte(field: string, value: any) {
        preds.push((r) => r[field] <= value);
        return q;
      },
      gt(field: string, value: any) {
        preds.push((r) => r[field] > value);
        return q;
      },
      lt(field: string, value: any) {
        preds.push((r) => r[field] < value);
        return q;
      },
    };
    fn(q);
    this.rows = this.rows.filter((r) => preds.every((p) => p(r)));
    return this;
  }
  filter(fn: (q: any) => any) {
    const built = fn({
      eq: (left: (r: Doc) => any, right: any) => (r: Doc) => left(r) === right,
      field: (name: string) => (r: Doc) => r[name],
    });
    this.rows = this.rows.filter((r) => built(r));
    return this;
  }
  async collect(): Promise<Doc[]> {
    return [...this.rows];
  }
  async take(n: number): Promise<Doc[]> {
    return this.rows.slice(0, n);
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
  async delete(id: string): Promise<void> {
    this.table(this.tableOfId(id)).delete(id);
  }
  query(table: string) {
    return new FakeQuery([...this.table(table).values()]);
  }
}

// A fake Response with a settable `ok`/`status`, matching the bits the channel
// fns read.
function fakeResponse(ok: boolean, status = ok ? 200 : 500): any {
  return { ok, status, async json() { return {}; }, async text() { return ""; } };
}

// ─────────────────────────────────────────────────────────────
// Seed: an accepted booking + booker/host attendees + event type.
// ─────────────────────────────────────────────────────────────

const OWNER = "owner_x";
const HOST = "host_a";

async function seedBooking(
  db: FakeDb,
  opts: { bookerPhone?: string } = {},
): Promise<string> {
  const eventTypeId = await db.insert("eventTypes", {
    ownerAuthUserId: OWNER,
    slug: "intro",
    title: "Intro Call",
    durationMinutes: 30,
    timeZone: "UTC",
  });
  const bookingId = await db.insert("bookings", {
    eventTypeId,
    ownerAuthUserId: OWNER,
    startTime: Date.UTC(2026, 5, 2, 10, 0, 0),
    endTime: Date.UTC(2026, 5, 2, 10, 30, 0),
    timeZone: "UTC",
    status: "accepted",
    locationText: "Zoom",
    bookerNotes: "see you there",
    idempotencyKey: "key-A",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await db.insert("bookingAttendees", {
    bookingId,
    ownerAuthUserId: OWNER,
    name: "Casey Candidate",
    email: "casey@example.com",
    timeZone: "UTC",
    role: "booker",
    createdAt: Date.now(),
    ...(opts.bookerPhone ? { phone: opts.bookerPhone } : {}),
  });
  await db.insert("bookingAttendees", {
    bookingId,
    ownerAuthUserId: OWNER,
    name: HOST,
    email: "",
    timeZone: "UTC",
    role: "host",
    createdAt: Date.now(),
  });
  return bookingId;
}

// Fake action ctx: routes runQuery→getBookingSyncContext through the REAL
// sync.ts handler against the FakeDb; runMutation→notifications._create inserts
// a notifications row; scheduler records calls.
function makeActionCtx(db: FakeDb) {
  const notifInserts: any[] = [];
  const runQuery = vi.fn(async (ref: any, args: any) => {
    // The `_generated/api` Proxy resolves the getBookingSyncContext ref even
    // pre-codegen, so the notify handler reaches it via ctx.runQuery; route it
    // through the REAL sync.ts handler against the FakeDb (same as sync.test).
    const name = getFunctionName(ref);
    if (name === "scheduling/sync:getBookingSyncContext") {
      return getBookingSyncContextHandler({ db } as any, args);
    }
    throw new Error(`unexpected runQuery: ${name}`);
  });
  const runMutation = vi.fn(async (ref: any, args: any) => {
    const name = getFunctionName(ref);
    if (name === "notifications:_create") {
      notifInserts.push(args);
      await db.insert("notifications", {
        authUserId: args.authUserId,
        kind: args.kind,
        title: args.title,
        body: args.body,
        href: args.href,
        createdAt: Date.now(),
      });
      return "notifications|x";
    }
    throw new Error(`unexpected runMutation: ${name}`);
  });
  const scheduler = { runAfter: vi.fn(async () => {}) };
  const ctx = { db, runQuery, runMutation, scheduler } as any;
  return { ctx, notifInserts, runMutation };
}

// ─────────────────────────────────────────────────────────────
// Env var save/restore so per-test gates don't leak.
// ─────────────────────────────────────────────────────────────

const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────
// (a) Brevo email channel
// ─────────────────────────────────────────────────────────────

describe("sendBrevoEmail", () => {
  it("POSTs Brevo with the right body + base64 .ics attachment when EMAIL_API_KEY is set", async () => {
    process.env.EMAIL_API_KEY = "brevo-test-key";
    process.env.EMAIL_FROM = "bookings@dibslist.app";
    const fetchImpl = vi.fn(async () => fakeResponse(true));

    const res = await sendBrevoEmail(
      {
        toEmail: "casey@example.com",
        toName: "Casey",
        subject: "Booking confirmation: Intro Call",
        htmlContent: "<p>Your booking for <strong>Intro Call</strong> is confirmed.</p>",
        icsString: "BEGIN:VCALENDAR\r\nEND:VCALENDAR",
      },
      fetchImpl as any,
    );

    expect(res.skipped).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(init.method).toBe("POST");
    expect(init.headers["api-key"]).toBe("brevo-test-key");
    expect(init.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(init.body);
    expect(body.sender).toEqual({ name: "DibsList Booking", email: "bookings@dibslist.app" });
    expect(body.to).toEqual([{ email: "casey@example.com", name: "Casey" }]);
    expect(body.subject).toBe("Booking confirmation: Intro Call");
    // .ics base64-attached under attachment[0].content
    expect(Array.isArray(body.attachment)).toBe(true);
    expect(body.attachment[0].name).toBe("invite.ics");
    const decoded = Buffer.from(body.attachment[0].content, "base64").toString("utf-8");
    expect(decoded).toContain("BEGIN:VCALENDAR");
  });

  it("is a NO-OP (no fetch) when EMAIL_API_KEY is unset", async () => {
    delete process.env.EMAIL_API_KEY;
    const fetchImpl = vi.fn(async () => fakeResponse(true));
    const res = await sendBrevoEmail(
      {
        toEmail: "casey@example.com",
        toName: "Casey",
        subject: "Booking confirmation: Intro Call",
        htmlContent: "<p>confirmed</p>",
      },
      fetchImpl as any,
    );
    expect(res.skipped).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// (b) Twilio SMS channel
// ─────────────────────────────────────────────────────────────

describe("sendTwilioSms", () => {
  it("POSTs Twilio Messages.json with basic auth when TWILIO_* set", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACxxx";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.TWILIO_FROM = "+15550001111";
    const fetchImpl = vi.fn(async () => fakeResponse(true));

    const res = await sendTwilioSms(
      { to: "+15557654321", body: "Your booking for Intro Call is confirmed." },
      fetchImpl as any,
    );

    expect(res.skipped).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/ACxxx/Messages.json");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from("ACxxx:tok").toString("base64")}`);
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(init.body).toContain("From=%2B15550001111");
    expect(init.body).toContain("To=%2B15557654321");
    expect(init.body).toContain("Body=");
  });

  it("is a NO-OP (no fetch) when any TWILIO_* var is unset", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACxxx";
    delete process.env.TWILIO_AUTH_TOKEN; // missing → gate
    process.env.TWILIO_FROM = "+15550001111";
    const fetchImpl = vi.fn(async () => fakeResponse(true));
    const res = await sendTwilioSms(
      { to: "+15557654321", body: "hi" },
      fetchImpl as any,
    );
    expect(res.skipped).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// (c) sendNotification action — in_app ALWAYS fires; email gated
// ─────────────────────────────────────────────────────────────

describe("sendNotificationHandler — channel dispatch", () => {
  it("ALWAYS inserts an in-app notifications row for the organizer on BOOKING_CREATED", async () => {
    delete process.env.EMAIL_API_KEY; // email gated off → in_app still fires
    const db = new FakeDb();
    const bookingId = await seedBooking(db);
    const { ctx, notifInserts } = makeActionCtx(db);
    const fetchImpl = vi.fn(async () => fakeResponse(true));

    const res = await sendNotificationHandler(ctx, {
      bookingId: bookingId as any,
      event: "BOOKING_CREATED",
      fetchImpl: fetchImpl as any,
    });

    // Email skipped (no key) → not in `delivered`; in_app present.
    expect(res.delivered).toContain("in_app");
    expect(res.delivered).not.toContain("email");
    expect(fetchImpl).not.toHaveBeenCalled(); // no email POST without a key

    // The organizer gets exactly one booking_received notification.
    expect(notifInserts).toHaveLength(1);
    expect(notifInserts[0].authUserId).toBe(OWNER);
    expect(notifInserts[0].kind).toBe("booking_received");
    expect(notifInserts[0].href).toBe(`/book/settings?booking=${bookingId}`);
    const notifs = await db.query("notifications").collect();
    expect(notifs).toHaveLength(1);
  });

  it("sends the Brevo email to the booker AND inserts in-app when EMAIL_API_KEY is set", async () => {
    process.env.EMAIL_API_KEY = "brevo-test-key";
    const db = new FakeDb();
    const bookingId = await seedBooking(db);
    const { ctx } = makeActionCtx(db);
    const fetchImpl = vi.fn(async () => fakeResponse(true));

    const res = await sendNotificationHandler(ctx, {
      bookingId: bookingId as any,
      event: "BOOKING_CREATED",
      fetchImpl: fetchImpl as any,
    });

    expect(res.delivered).toContain("email");
    expect(res.delivered).toContain("in_app");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    const body = JSON.parse(init.body);
    // .ics attachment present for a live (created) booking, addressed to booker.
    expect(body.to[0].email).toBe("casey@example.com");
    expect(body.attachment[0].name).toBe("invite.ics");
  });

  it("pins a single channel (sms) when given an explicit channel + a booker phone", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACxxx";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.TWILIO_FROM = "+15550001111";
    const db = new FakeDb();
    const bookingId = await seedBooking(db, { bookerPhone: "+15557654321" });
    const { ctx, notifInserts } = makeActionCtx(db);
    const fetchImpl = vi.fn(async () => fakeResponse(true));

    const res = await sendNotificationHandler(ctx, {
      bookingId: bookingId as any,
      event: "reminder_24h",
      channel: "sms",
      fetchImpl: fetchImpl as any,
    });

    expect(res.delivered).toEqual(["sms"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] as any;
    expect(url).toContain("Messages.json");
    // sms-pinned → no in-app organizer notification.
    expect(notifInserts).toHaveLength(0);
  });

  // N6 — bounded email retry on a transient Brevo failure.
  it("schedules a bounded email retry when the Brevo send throws (non-2xx)", async () => {
    process.env.EMAIL_API_KEY = "brevo-test-key";
    const db = new FakeDb();
    const bookingId = await seedBooking(db);
    const { ctx } = makeActionCtx(db);
    const fetchImpl = vi.fn(async () => fakeResponse(false)); // 500 → throws

    const res = await sendNotificationHandler(ctx, {
      bookingId: bookingId as any,
      event: "BOOKING_CREATED",
      fetchImpl: fetchImpl as any,
    });

    // Email failed → not delivered; in_app still fires (independent channel).
    expect(res.delivered).not.toContain("email");
    expect(res.delivered).toContain("in_app");
    // Exactly one re-dispatch, pinned to email, tries incremented to 1.
    expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
    const [, , retryArgs] = ctx.scheduler.runAfter.mock.calls[0] as any;
    expect(retryArgs.channel).toBe("email");
    expect(retryArgs.tries).toBe(1);
    expect(retryArgs.bookingId).toBe(bookingId);
  });

  it("gives up (no reschedule) once the email retry cap is reached", async () => {
    process.env.EMAIL_API_KEY = "brevo-test-key";
    const db = new FakeDb();
    const bookingId = await seedBooking(db);
    const { ctx } = makeActionCtx(db);
    const fetchImpl = vi.fn(async () => fakeResponse(false));

    // tries:2 → this attempt is the 3rd (== MAX_EMAIL_TRIES) → no further retry.
    const res = await sendNotificationHandler(ctx, {
      bookingId: bookingId as any,
      event: "BOOKING_CREATED",
      channel: "email",
      tries: 2,
      fetchImpl: fetchImpl as any,
    });

    expect(res.delivered).not.toContain("email");
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// (d) reminder sweep
// ─────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 5, 1, 10, 0, 0);

describe("sweepDueReminders", () => {
  function makeSweepCtx(db: FakeDb) {
    const scheduler = { runAfter: vi.fn(async () => {}) };
    return { db, scheduler } as any;
  }

  it("dispatches a due unsent reminder and marks sentAt", async () => {
    const db = new FakeDb();
    const ctx = makeSweepCtx(db);
    const remId = await db.insert("reminders", {
      bookingId: "bookings|1",
      kind: "confirmation",
      channel: "email",
      recipient: "booker",
      sendAt: NOW - 1000, // past due
      // sentAt intentionally absent
    });

    const res = await sweepDueRemindersHandler(ctx, { nowMs: NOW });
    expect(res.dispatched).toBe(1);
    expect(res.scanned).toBe(1);

    const updated = await db.get(remId);
    expect(updated?.sentAt).toBe(NOW);
  });

  it("skips a due reminder that is already marked sentAt", async () => {
    const db = new FakeDb();
    const ctx = makeSweepCtx(db);
    await db.insert("reminders", {
      bookingId: "bookings|1",
      kind: "reminder_24h",
      channel: "email",
      recipient: "booker",
      sendAt: NOW - 1000,
      sentAt: NOW - 500, // already dispatched
    });

    const res = await sweepDueRemindersHandler(ctx, { nowMs: NOW });
    expect(res.dispatched).toBe(0);
  });

  it("leaves a future-sendAt reminder untouched", async () => {
    const db = new FakeDb();
    const ctx = makeSweepCtx(db);
    const remId = await db.insert("reminders", {
      bookingId: "bookings|1",
      kind: "reminder_24h",
      channel: "email",
      recipient: "booker",
      sendAt: NOW + 60_000, // not yet due
    });

    const res = await sweepDueRemindersHandler(ctx, { nowMs: NOW });
    expect(res.dispatched).toBe(0);
    expect((await db.get(remId))?.sentAt).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// (e) webhook _emitEvent on createBooking — booking.created payload
// ─────────────────────────────────────────────────────────────

const SLUG = "intro";
const TZ = "UTC";
const SLOT_START = Date.UTC(2026, 5, 1, 10, 0, 0); // 2026-06-01 Mon 10:00Z
const SLOT_END = Date.UTC(2026, 5, 1, 10, 30, 0);
const CREATE_NOW = Date.UTC(2026, 5, 1, 9, 0, 0);
const ATTENDEE = {
  name: "Casey Candidate",
  email: "casey@example.com",
  timeZone: TZ,
  notes: "looking forward",
};

class FakeScheduler {
  calls: Array<{ delayMs: number; name: string; args: any }> = [];
  async runAfter(delayMs: number, ref: any, args: any) {
    let name = "";
    try {
      name = getFunctionName(ref);
    } catch {
      name = "<unresolved>";
    }
    this.calls.push({ delayMs, name, args });
  }
}

function makeMutationCtx() {
  return { db: new FakeDb(), scheduler: new FakeScheduler() } as any;
}

async function enableBooking(ctx: any) {
  await ctx.db.insert("featureFlags", {
    key: "booking_enabled",
    value: true,
    updatedAt: Date.now(),
    updatedBy: "test",
  });
}

async function seedEventType(ctx: any): Promise<string> {
  const scheduleId = await ctx.db.insert("schedules", {
    ownerAuthUserId: HOST,
    name: "Working hours",
    timeZone: TZ,
    isDefault: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await ctx.db.insert("availability", {
    scheduleId,
    days: [1, 2, 3, 4, 5],
    startMinute: 540,
    endMinute: 1020,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const eventTypeId = await ctx.db.insert("eventTypes", {
    ownerAuthUserId: OWNER,
    slug: SLUG,
    title: "Intro",
    durationMinutes: 30,
    schedulingType: "collective",
    minimumBookingNoticeMinutes: 0,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    requireEmailVerification: false,
    hidden: false,
    active: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await ctx.db.insert("eventTypeHosts", {
    eventTypeId,
    ownerAuthUserId: OWNER,
    hostAuthUserId: HOST,
    isFixed: true,
    createdAt: Date.now(),
  });
  return eventTypeId;
}

describe("createBooking — webhook + reminders side effects", () => {
  let ctx: any;
  beforeEach(async () => {
    ctx = makeMutationCtx();
    await enableBooking(ctx);
  });

  it("schedules internal.webhooks._emitEvent with the booking.created PII-minimal payload", async () => {
    await seedEventType(ctx);
    const res = await createBookingHandler(ctx, {
      slug: SLUG,
      startTime: SLOT_START,
      endTime: SLOT_END,
      bookerTimeZone: TZ,
      holderToken: "tok-A",
      idempotencyKey: "key-A",
      attendee: ATTENDEE,
      nowMs: CREATE_NOW,
    });

    const emit = ctx.scheduler.calls.find(
      (c: any) => c.name === "webhooks:_emitEvent",
    );
    expect(emit).toBeDefined();
    expect(emit.args.event).toBe("booking.created");
    expect(emit.args.authUserId).toBe(OWNER);
    expect(emit.args.data.bookingId).toBe(res.bookingId);
    expect(emit.args.data.eventTypeSlug).toBe(SLUG);
    expect(emit.args.data.start).toBe(SLOT_START);
    expect(emit.args.data.end).toBe(SLOT_END);
    expect(emit.args.data.attendees).toEqual([
      { email: "casey@example.com", name: "Casey Candidate" },
    ]);
  });

  it("inserts confirmation + reminder_24h reminder rows on create", async () => {
    await seedEventType(ctx);
    await createBookingHandler(ctx, {
      slug: SLUG,
      startTime: SLOT_START,
      endTime: SLOT_END,
      bookerTimeZone: TZ,
      holderToken: "tok-A",
      idempotencyKey: "key-A",
      attendee: ATTENDEE,
      nowMs: CREATE_NOW,
    });

    const reminders = await ctx.db.query("reminders").collect();
    const kinds = reminders.map((r: any) => r.kind).sort();
    expect(kinds).toEqual(["confirmation", "reminder_24h"]);
    const r24 = reminders.find((r: any) => r.kind === "reminder_24h");
    expect(r24.sendAt).toBe(SLOT_START - 24 * 60 * 60 * 1000);
    expect(r24.sentAt).toBeUndefined();
    const conf = reminders.find((r: any) => r.kind === "confirmation");
    expect(conf.sendAt).toBe(CREATE_NOW);
  });
});
