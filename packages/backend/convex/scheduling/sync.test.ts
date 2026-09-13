// B4 — tests for `scheduling/sync.ts` (the REAL booking → calendar sync with
// the per-host partial-failure model).
//
// HARNESS: the repo action-test convention — a FAKE `ctx` whose `runQuery` /
// `runMutation` / `runAction` / `scheduler.runAfter` are `vi.fn()` stubs (see
// ingestCron.test.ts). We dispatch on the Convex `getFunctionName(ref)` (the
// `_generated/api` Proxy resolves every internal ref to a real
// FunctionReference even pre-codegen), and we route the seed/patch/read refs
// through the REAL `sync.ts` handlers against a small FakeDb so the join +
// patch logic is exercised end-to-end. Google create/delete is the mocked
// external boundary (`createEventForCredential` / `deleteEventForCredential`).
//
// The load-bearing assertion (test b): when ONE host's create throws, that
// host's externalEvents entry is `failed` (+tries incremented, a backoff retry
// scheduled), the OTHER host is `synced`, and the bookings ROW is never rolled
// back — it stays `status:"accepted"` (source of truth).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getFunctionName } from "convex/server";
import {
  syncToCalendarsHandler,
  resyncBookingHandler,
  getBookingSyncContextHandler,
  seedExternalEventsHandler,
  patchExternalEventHandler,
  MAX_SYNC_TRIES,
} from "./sync";

// ─────────────────────────────────────────────────────────────
// FakeDb (eq + filter(eq) chaining; index-name-agnostic)
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
    };
    fn(q);
    this.rows = this.rows.filter((r) => preds.every((p) => p(r)));
    return this;
  }
  filter(fn: (q: any) => any) {
    const q = {
      eq: (a: any, b: any) => () => a === b,
      field: (name: string) => (r: Doc) => r[name],
    };
    // Build a predicate: filter((q) => q.eq(q.field("isDestination"), true))
    const built = fn({
      eq: (left: (r: Doc) => any, right: any) => (r: Doc) => left(r) === right,
      field: (name: string) => (r: Doc) => r[name],
    });
    void q;
    this.rows = this.rows.filter((r) => built(r));
    return this;
  }
  async collect(): Promise<Doc[]> {
    return [...this.rows];
  }
  async first(): Promise<Doc | null> {
    return this.rows[0] ?? null;
  }
  async unique(): Promise<Doc | null> {
    if (this.rows.length > 1) throw new Error("unique(): more than one row");
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

// ─────────────────────────────────────────────────────────────
// Fake action ctx — dispatch internal refs on getFunctionName(ref)
// ─────────────────────────────────────────────────────────────

interface MakeCtxOpts {
  // Per-credentialId behavior for the mocked Google createEvent.
  createImpl?: (args: {
    credentialId: string;
    externalCalendarId?: string;
    event: any;
  }) => { externalEventId: string };
}

function makeCtx(db: FakeDb, opts: MakeCtxOpts = {}) {
  const scheduled: Array<{ delayMs: number; name: string; args: any }> = [];
  const deletedUids: string[] = [];
  const createdFor: string[] = [];
  let createSeq = 0;

  const runQuery = vi.fn(async (ref: any, args: any) => {
    const name = getFunctionName(ref);
    if (name === "scheduling/sync:getBookingSyncContext") {
      return getBookingSyncContextHandler({ db } as any, args);
    }
    throw new Error(`unexpected runQuery: ${name}`);
  });

  const runMutation = vi.fn(async (ref: any, args: any) => {
    const name = getFunctionName(ref);
    if (name === "scheduling/sync:seedExternalEvents") {
      return seedExternalEventsHandler({ db } as any, args);
    }
    if (name === "scheduling/sync:patchExternalEvent") {
      return patchExternalEventHandler({ db } as any, args);
    }
    if (name === "notifications:_create") {
      await db.insert("notifications", {
        authUserId: args.authUserId,
        kind: args.kind,
        title: args.title,
        body: args.body,
        href: args.href,
        createdAt: Date.now(),
      });
      return null;
    }
    throw new Error(`unexpected runMutation: ${name}`);
  });

  const runAction = vi.fn(async (ref: any, args: any) => {
    const name = getFunctionName(ref);
    if (name === "scheduling/googleCalendar:createEventForCredential") {
      createdFor.push(args.credentialId);
      if (opts.createImpl) return opts.createImpl(args);
      createSeq += 1;
      return { externalEventId: `gcal-evt-${createSeq}` };
    }
    if (name === "scheduling/googleCalendar:deleteEventForCredential") {
      deletedUids.push(args.uid);
      return null;
    }
    throw new Error(`unexpected runAction: ${name}`);
  });

  const scheduler = {
    runAfter: vi.fn(async (delayMs: number, ref: any, args: any) => {
      scheduled.push({ delayMs, name: getFunctionName(ref), args });
    }),
  };

  const ctx = { db, runQuery, runMutation, runAction, scheduler } as any;
  return { ctx, scheduled, deletedUids, createdFor, runMutation, runAction };
}

// ─────────────────────────────────────────────────────────────
// Seed: a booking + two fixed hosts, each with a Google credential +
// destination calendar.
// ─────────────────────────────────────────────────────────────

const OWNER = "owner_x";
const HOST_A = "host_a";
const HOST_B = "host_b";

// Returns the booking id as `any` so it slots into the handlers' `Id<"bookings">`
// args under the FakeDb's string ids (the repo `ctx: any` test convention).
async function seedTwoHostBooking(
  db: FakeDb,
  opts: { hostBInvalid?: boolean } = {},
): Promise<any> {
  const eventTypeId = await db.insert("eventTypes", {
    ownerAuthUserId: OWNER,
    slug: "intro",
    title: "Intro Call",
    durationMinutes: 30,
  });

  // Credentials + destination calendars for each host.
  const credA = await db.insert("calendarCredentials", {
    authUserId: HOST_A,
    provider: "google",
    invalid: false,
  });
  await db.insert("selectedCalendars", {
    authUserId: HOST_A,
    credentialId: credA,
    externalCalendarId: "host_a_dest@group.calendar.google.com",
    isDestination: true,
  });

  const credB = await db.insert("calendarCredentials", {
    authUserId: HOST_B,
    provider: "google",
    invalid: opts.hostBInvalid === true,
  });
  await db.insert("selectedCalendars", {
    authUserId: HOST_B,
    credentialId: credB,
    externalCalendarId: "primary",
    isDestination: true,
  });

  const bookingId = await db.insert("bookings", {
    eventTypeId,
    ownerAuthUserId: OWNER,
    startTime: Date.UTC(2026, 5, 1, 10, 0, 0),
    endTime: Date.UTC(2026, 5, 1, 10, 30, 0),
    timeZone: "UTC",
    status: "accepted",
    idempotencyKey: "key-A",
    locationText: "Zoom",
    bookerNotes: "looking forward",
  });

  // Attendees: one booker (real email) + two hosts (email:"" per A7 stub; the
  // hostAuthUserId is carried in `name`).
  await db.insert("bookingAttendees", {
    bookingId,
    ownerAuthUserId: OWNER,
    name: "Casey Candidate",
    email: "casey@example.com",
    role: "booker",
    timeZone: "UTC",
  });
  await db.insert("bookingAttendees", {
    bookingId,
    ownerAuthUserId: OWNER,
    name: HOST_A,
    email: "",
    role: "host",
    timeZone: "UTC",
  });
  await db.insert("bookingAttendees", {
    bookingId,
    ownerAuthUserId: OWNER,
    name: HOST_B,
    email: "",
    role: "host",
    timeZone: "UTC",
  });

  return bookingId;
}

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb();
});

// ─────────────────────────────────────────────────────────────
// (a) all hosts succeed → every entry synced with an eventId
// ─────────────────────────────────────────────────────────────

describe("syncToCalendars — BOOKING_CREATED, all hosts succeed", () => {
  it("writes one synced externalEvents entry (with eventId) per host", async () => {
    const bookingId = await seedTwoHostBooking(db);
    const { ctx, createdFor } = makeCtx(db);

    await syncToCalendarsHandler(ctx, { bookingId, event: "BOOKING_CREATED" });

    const booking = await db.get(bookingId);
    expect(booking!.status).toBe("accepted");
    const entries = booking!.externalEvents as any[];
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e.syncStatus).toBe("synced");
      expect(typeof e.externalEventId).toBe("string");
      expect(e.externalEventId.length).toBeGreaterThan(0);
    }
    // Both hosts' calendars were written.
    expect(createdFor).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────
// (b) ONE host's create throws → that entry failed (+tries, retry scheduled),
//     the OTHER synced, booking NOT rolled back.
// ─────────────────────────────────────────────────────────────

describe("syncToCalendars — one host fails (partial-failure isolation)", () => {
  it("failed host → failed+tries+retry; other host → synced; booking stays accepted (NOT rolled back)", async () => {
    const bookingId = await seedTwoHostBooking(db);
    // Identify host B's credentialId so the mock can fail exactly that host.
    const sctx = await getBookingSyncContextHandler({ db } as any, { bookingId });
    const hostBCred = sctx!.hostTargets.find((t) => t.hostAuthUserId === HOST_B)!
      .credentialId as string;

    const { ctx, scheduled, createdFor } = makeCtx(db, {
      createImpl: ({ credentialId }) => {
        if (credentialId === hostBCred) {
          throw new Error("Google Calendar createEvent failed (500): quota");
        }
        return { externalEventId: "gcal-evt-ok" };
      },
    });

    await syncToCalendarsHandler(ctx, { bookingId, event: "BOOKING_CREATED" });

    const booking = await db.get(bookingId);
    // SOURCE OF TRUTH: the booking row is NOT rolled back.
    expect(booking!.status).toBe("accepted");

    const entries = booking!.externalEvents as any[];
    const a = entries.find((e) => e.hostAuthUserId === HOST_A)!;
    const b = entries.find((e) => e.hostAuthUserId === HOST_B)!;

    // Host A still synced — one host's failure did NOT unwind the other's success.
    expect(a.syncStatus).toBe("synced");
    expect(a.externalEventId).toBe("gcal-evt-ok");

    // Host B failed, tries incremented, and a backoff retry was scheduled.
    expect(b.syncStatus).toBe("failed");
    expect(b.tries).toBe(1);
    expect(typeof b.lastTriedAt).toBe("number");
    const retry = scheduled.find(
      (s) => s.name === "scheduling/sync:syncToCalendars",
    );
    expect(retry).toBeDefined();
    expect(retry!.args).toMatchObject({ bookingId, event: "BOOKING_CREATED" });
    expect(retry!.delayMs).toBeGreaterThan(0);

    // Both hosts were ATTEMPTED (proves independence).
    expect(createdFor).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────
// (c) after MAX_SYNC_TRIES → organizer notification inserted (no further retry)
// ─────────────────────────────────────────────────────────────

describe("syncToCalendars — retry cap", () => {
  it("on the final allowed try a failure inserts a calendar_sync_failed notice to the organizer and schedules NO further retry", async () => {
    const bookingId = await seedTwoHostBooking(db);
    const sctx = await getBookingSyncContextHandler({ db } as any, { bookingId });
    const hostBCred = sctx!.hostTargets.find((t) => t.hostAuthUserId === HOST_B)!
      .credentialId as string;

    // Pre-seed host B's entry at tries = MAX-1 and failed, so this attempt is the
    // capped one (tries becomes MAX_SYNC_TRIES → no reschedule, organizer notice).
    const hostACred = sctx!.hostTargets.find((t) => t.hostAuthUserId === HOST_A)!
      .credentialId as string;
    await db.patch(bookingId, {
      externalEvents: [
        {
          hostAuthUserId: HOST_A,
          credentialId: hostACred,
          externalCalendarId: "host_a_dest@group.calendar.google.com",
          syncStatus: "synced",
          externalEventId: "already-ok",
        },
        {
          hostAuthUserId: HOST_B,
          credentialId: hostBCred,
          externalCalendarId: "primary",
          syncStatus: "failed",
          tries: MAX_SYNC_TRIES - 1,
        },
      ],
    });

    const { ctx, scheduled } = makeCtx(db, {
      createImpl: ({ credentialId }) => {
        if (credentialId === hostBCred) {
          throw new Error("Google Calendar createEvent failed (500): still down");
        }
        return { externalEventId: "gcal-evt-ok" };
      },
    });

    await syncToCalendarsHandler(ctx, { bookingId, event: "BOOKING_CREATED" });

    const booking = await db.get(bookingId);
    const b = (booking!.externalEvents as any[]).find(
      (e) => e.hostAuthUserId === HOST_B,
    )!;
    expect(b.syncStatus).toBe("failed");
    expect(b.tries).toBe(MAX_SYNC_TRIES);

    // No further retry scheduled at the cap.
    expect(
      scheduled.filter((s) => s.name === "scheduling/sync:syncToCalendars"),
    ).toHaveLength(0);

    // Organizer got the reconnect/re-sync notice.
    const notes = await db.query("notifications").collect();
    const note = notes.find((n) => n.kind === "calendar_sync_failed");
    expect(note).toBeDefined();
    expect(note!.authUserId).toBe(OWNER);
    expect(note!.href).toBe("/settings/integrations");
  });
});

// ─────────────────────────────────────────────────────────────
// dead-credential host short-circuits to failed + organizer notice
// ─────────────────────────────────────────────────────────────

describe("syncToCalendars — dead credential", () => {
  it("an invalid host credential short-circuits to failed + organizer notice (no Google call), the valid host still syncs", async () => {
    const bookingId = await seedTwoHostBooking(db, { hostBInvalid: true });
    const { ctx, createdFor } = makeCtx(db);

    await syncToCalendarsHandler(ctx, { bookingId, event: "BOOKING_CREATED" });

    const booking = await db.get(bookingId);
    expect(booking!.status).toBe("accepted");
    const entries = booking!.externalEvents as any[];
    const a = entries.find((e) => e.hostAuthUserId === HOST_A)!;
    const b = entries.find((e) => e.hostAuthUserId === HOST_B)!;
    expect(a.syncStatus).toBe("synced");
    expect(b.syncStatus).toBe("failed");

    // Only the valid host's calendar was called (the dead one was short-circuited).
    expect(createdFor).toEqual([a.credentialId]);

    const notes = await db.query("notifications").collect();
    expect(notes.some((n) => n.kind === "calendar_sync_failed")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// (d) cancel deletes the synced events
// ─────────────────────────────────────────────────────────────

describe("syncToCalendars — BOOKING_CANCELLED", () => {
  it("deletes every synced host event and skips entries that never wrote", async () => {
    const bookingId = await seedTwoHostBooking(db);
    const sctx = await getBookingSyncContextHandler({ db } as any, { bookingId });
    const hostACred = sctx!.hostTargets.find((t) => t.hostAuthUserId === HOST_A)!
      .credentialId as string;
    const hostBCred = sctx!.hostTargets.find((t) => t.hostAuthUserId === HOST_B)!
      .credentialId as string;

    // One synced (with an event id), one failed (never wrote → should be skipped).
    await db.patch(bookingId, {
      status: "cancelled",
      externalEvents: [
        {
          hostAuthUserId: HOST_A,
          credentialId: hostACred,
          externalCalendarId: "host_a_dest@group.calendar.google.com",
          syncStatus: "synced",
          externalEventId: "evt-to-delete",
        },
        {
          hostAuthUserId: HOST_B,
          credentialId: hostBCred,
          externalCalendarId: "primary",
          syncStatus: "failed",
          tries: 2,
        },
      ],
    });

    const { ctx, deletedUids } = makeCtx(db);
    await syncToCalendarsHandler(ctx, { bookingId, event: "BOOKING_CANCELLED" });

    // Only the synced host's event was deleted.
    expect(deletedUids).toEqual(["evt-to-delete"]);
  });
});

// ─────────────────────────────────────────────────────────────
// resyncBooking — idempotent retry of failed entries
// ─────────────────────────────────────────────────────────────

describe("resyncBooking", () => {
  it("retries only failed/pending entries (skips synced) and re-syncs them, resetting tries", async () => {
    const bookingId = await seedTwoHostBooking(db);
    const sctx = await getBookingSyncContextHandler({ db } as any, { bookingId });
    const hostACred = sctx!.hostTargets.find((t) => t.hostAuthUserId === HOST_A)!
      .credentialId as string;
    const hostBCred = sctx!.hostTargets.find((t) => t.hostAuthUserId === HOST_B)!
      .credentialId as string;

    await db.patch(bookingId, {
      externalEvents: [
        {
          hostAuthUserId: HOST_A,
          credentialId: hostACred,
          externalCalendarId: "host_a_dest@group.calendar.google.com",
          syncStatus: "synced",
          externalEventId: "already-ok",
        },
        {
          hostAuthUserId: HOST_B,
          credentialId: hostBCred,
          externalCalendarId: "primary",
          syncStatus: "failed",
          tries: 3,
        },
      ],
    });

    const { ctx, createdFor } = makeCtx(db); // create succeeds this time
    const res = await resyncBookingHandler(ctx, { bookingId });

    expect(res.retried).toBe(1); // only host B

    const booking = await db.get(bookingId);
    const entries = booking!.externalEvents as any[];
    const a = entries.find((e) => e.hostAuthUserId === HOST_A)!;
    const b = entries.find((e) => e.hostAuthUserId === HOST_B)!;

    // Host A untouched (still its original synced event id).
    expect(a.syncStatus).toBe("synced");
    expect(a.externalEventId).toBe("already-ok");
    // Host B re-synced.
    expect(b.syncStatus).toBe("synced");
    expect(typeof b.externalEventId).toBe("string");

    // Only host B's calendar was (re)written.
    expect(createdFor).toEqual([hostBCred]);
  });
});
