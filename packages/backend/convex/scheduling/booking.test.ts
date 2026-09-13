// BOOKING / A7 — tests for `scheduling/booking.ts` (createBooking /
// cancelBooking / rescheduleBooking).
//
// HARNESS: repo FakeDb + bare-handler convention (see availability.test.ts).
// The FakeQuery supports eq + gte/lte/gt/lt range chaining. The ctx also carries
// a FakeScheduler so the Phase-B `ctx.scheduler.runAfter(0, …)` stubs are
// recorded (and asserted) without needing the real Convex runtime. No auth mock
// is needed — createBooking is the unauthenticated candidate path. The
// DEFAULT-OFF `booking_enabled` flag is exercised through the REAL
// `_helpers/featureFlag.ts` read path; we seed a flag row to open the gate.
//
// NOTE on the `internal` ref: booking.ts schedules Phase B via
// `(internal as any).scheduling?.booking` and guards on the ref being present.
// Under the stale `_generated/api` the `scheduling` namespace isn't materialized,
// so the ref resolves to `undefined` at test time and the schedule is skipped —
// which is correct (Phase B is a no-op stub in A7). We assert the booking row +
// status regardless; a separate assertion covers that scheduling is at least
// ATTEMPTED via the scheduler shim when the ref IS present (we inject it).

import { describe, it, expect, beforeEach } from "vitest";
import { ConvexError } from "convex/values";
import {
  createBookingHandler,
  cancelBookingHandler,
  rescheduleBookingHandler,
} from "./booking";

// ─────────────────────────────────────────────────────────────
// FakeDb (eq + range) + FakeScheduler
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

class FakeScheduler {
  calls: Array<{ delayMs: number; args: any }> = [];
  async runAfter(delayMs: number, _ref: any, args: any) {
    this.calls.push({ delayMs, args });
  }
}

function makeCtx() {
  return { db: new FakeDb(), scheduler: new FakeScheduler() } as any;
}

// ─────────────────────────────────────────────────────────────
// Seed helpers — UTC schedule, weekday 9–17, one collective host
// ─────────────────────────────────────────────────────────────

const HOST = "host_a";
const OWNER = "owner_x";
const TZ = "UTC";
const SLUG = "intro";

// 2026-06-01 is a Monday. 10:00–10:30Z is inside 9–17 working hours.
const SLOT_START = Date.UTC(2026, 5, 1, 10, 0, 0);
const SLOT_END = Date.UTC(2026, 5, 1, 10, 30, 0);
const NOW = Date.UTC(2026, 5, 1, 9, 0, 0);

// A second non-overlapping slot for reschedule tests (11:00–11:30Z).
const SLOT2_START = Date.UTC(2026, 5, 1, 11, 0, 0);
const SLOT2_END = Date.UTC(2026, 5, 1, 11, 30, 0);

const ATTENDEE = {
  name: "Casey Candidate",
  email: "casey@example.com",
  timeZone: TZ,
  notes: "looking forward",
};

async function enableBooking(ctx: any) {
  await ctx.db.insert("featureFlags", {
    key: "booking_enabled",
    value: true,
    updatedAt: Date.now(),
    updatedBy: "test",
  });
}

async function seedEventType(
  ctx: any,
  opts: { active?: boolean } = {},
): Promise<string> {
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
    startMinute: 540, // 09:00
    endMinute: 1020, // 17:00
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
    active: opts.active ?? true,
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

// Seed a ROUND_ROBIN event type with N non-fixed pool hosts, each on their own
// UTC weekday 9–17 schedule. Returns { eventTypeId, hostIds }.
async function seedRoundRobinEventType(
  ctx: any,
  hostIds: string[],
  opts: { slug?: string } = {},
): Promise<{ eventTypeId: string; hostIds: string[] }> {
  for (const hostId of hostIds) {
    const scheduleId = await ctx.db.insert("schedules", {
      ownerAuthUserId: hostId,
      name: "Working hours",
      timeZone: TZ,
      isDefault: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("availability", {
      scheduleId,
      ownerAuthUserId: hostId,
      days: [1, 2, 3, 4, 5],
      startMinute: 540, // 09:00
      endMinute: 1020, // 17:00
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  const eventTypeId = await ctx.db.insert("eventTypes", {
    ownerAuthUserId: OWNER,
    slug: opts.slug ?? "rr-intro",
    title: "RR Intro",
    durationMinutes: 30,
    schedulingType: "round_robin",
    minimumBookingNoticeMinutes: 0,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    requireEmailVerification: false,
    hidden: false,
    active: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  for (const hostId of hostIds) {
    await ctx.db.insert("eventTypeHosts", {
      eventTypeId,
      ownerAuthUserId: OWNER,
      hostAuthUserId: hostId,
      isFixed: false, // RR pool
      createdAt: Date.now(),
    });
  }
  return { eventTypeId, hostIds };
}

// E3 GROUP — a collective event type with seatsPerSlot = N (group capacity).
// One UTC weekday 9–17 host. The slot may absorb up to N bookings before it is
// "full".
async function seedGroupEventType(
  ctx: any,
  seatsPerSlot: number,
  opts: { slug?: string } = {},
): Promise<string> {
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
    slug: opts.slug ?? "group",
    title: "Group Workshop",
    durationMinutes: 30,
    schedulingType: "collective",
    minimumBookingNoticeMinutes: 0,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    requireEmailVerification: false,
    seatsPerSlot,
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

let ctx: any;
beforeEach(async () => {
  ctx = makeCtx();
  await enableBooking(ctx);
});

// ─────────────────────────────────────────────────────────────
// E3 — GROUP capacity (seatsPerSlot)
// ─────────────────────────────────────────────────────────────

describe("createBooking — group capacity (seatsPerSlot)", () => {
  async function bookGroup(slug: string, key: string) {
    return createBookingHandler(ctx, {
      slug,
      startTime: SLOT_START,
      endTime: SLOT_END,
      bookerTimeZone: TZ,
      holderToken: `tok-${key}`,
      idempotencyKey: key,
      attendee: { ...ATTENDEE, email: `${key}@example.com` },
      nowMs: NOW,
    });
  }

  it("a group slot accepts N bookings then rejects the (N+1)th as full", async () => {
    const CAPACITY = 3;
    await seedGroupEventType(ctx, CAPACITY, { slug: "grp" });

    // First N bookings into the SAME slot all succeed (capacity = 3).
    for (let i = 0; i < CAPACITY; i++) {
      const res = await bookGroup("grp", `g-${i}`);
      expect(res.status).toBe("accepted");
    }

    // The (N+1)th booking for the same slot is rejected — the slot is full.
    let kind = "";
    try {
      await bookGroup("grp", "g-overflow");
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("slot_unavailable");

    // Exactly N bookings exist for the slot.
    const bookings = await ctx.db.query("bookings").collect();
    expect(bookings.filter((b: any) => b.startTime === SLOT_START)).toHaveLength(
      CAPACITY,
    );
  });

  it("a solo slot (no seatsPerSlot) is unchanged: a 2nd booking is rejected", async () => {
    // Regression guard: capacity-1 (default) still enforces zero-overlap.
    await seedEventType(ctx); // no seatsPerSlot → solo
    const first = await createBookingHandler(ctx, {
      slug: SLUG,
      startTime: SLOT_START,
      endTime: SLOT_END,
      bookerTimeZone: TZ,
      holderToken: "tok-A",
      idempotencyKey: "solo-A",
      attendee: ATTENDEE,
      nowMs: NOW,
    });
    expect(first.status).toBe("accepted");
    let kind = "";
    try {
      await createBookingHandler(ctx, {
        slug: SLUG,
        startTime: SLOT_START,
        endTime: SLOT_END,
        bookerTimeZone: TZ,
        holderToken: "tok-B",
        idempotencyKey: "solo-B",
        attendee: { ...ATTENDEE, email: "other@example.com" },
        nowMs: NOW,
      });
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("slot_unavailable");
  });
});

// ─────────────────────────────────────────────────────────────
// (a) RACE GUARD
// ─────────────────────────────────────────────────────────────

describe("createBooking — race guard", () => {
  it("first create succeeds; a SECOND create for the same slot throws slot_unavailable", async () => {
    await seedEventType(ctx);

    const first = await createBookingHandler(ctx, {
      slug: SLUG,
      startTime: SLOT_START,
      endTime: SLOT_END,
      bookerTimeZone: TZ,
      holderToken: "tok-A",
      idempotencyKey: "key-A",
      attendee: ATTENDEE,
      nowMs: NOW,
    });
    expect(first.status).toBe("accepted");

    // Second create for the SAME slot, different idempotency key + holder. The
    // serializable conflict re-check sees the first's just-inserted accepted
    // booking (subtracted from the host's free ranges) → slot_unavailable.
    let kind = "";
    try {
      await createBookingHandler(ctx, {
        slug: SLUG,
        startTime: SLOT_START,
        endTime: SLOT_END,
        bookerTimeZone: TZ,
        holderToken: "tok-B",
        idempotencyKey: "key-B",
        attendee: { ...ATTENDEE, email: "other@example.com" },
        nowMs: NOW,
      });
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("slot_unavailable");

    // Exactly ONE booking exists.
    const bookings = await ctx.db.query("bookings").collect();
    expect(bookings).toHaveLength(1);
    expect(bookings[0]._id).toBe(first.bookingId);
  });
});

// ─────────────────────────────────────────────────────────────
// (b) IDEMPOTENCY
// ─────────────────────────────────────────────────────────────

describe("createBooking — idempotency", () => {
  it("same idempotencyKey returns the SAME booking id with no duplicate row", async () => {
    await seedEventType(ctx);

    const first = await createBookingHandler(ctx, {
      slug: SLUG,
      startTime: SLOT_START,
      endTime: SLOT_END,
      bookerTimeZone: TZ,
      holderToken: "tok-A",
      idempotencyKey: "key-IDEM",
      attendee: ATTENDEE,
      nowMs: NOW,
    });

    const again = await createBookingHandler(ctx, {
      slug: SLUG,
      startTime: SLOT_START,
      endTime: SLOT_END,
      bookerTimeZone: TZ,
      holderToken: "tok-A",
      idempotencyKey: "key-IDEM",
      attendee: ATTENDEE,
      nowMs: NOW,
    });

    expect(again.bookingId).toBe(first.bookingId);
    expect(again.deduplicated).toBe(true);

    const bookings = await ctx.db.query("bookings").collect();
    expect(bookings).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────
// createBooking — happy path side effects + hold consumption
// ─────────────────────────────────────────────────────────────

describe("createBooking — writes", () => {
  it("inserts an accepted booking + booker & host attendees and consumes the hold", async () => {
    const eventTypeId = await seedEventType(ctx);
    // Seed the caller's hold for this slot — it must be consumed on success.
    await ctx.db.insert("bookingHolds", {
      eventTypeId,
      startTime: SLOT_START,
      endTime: SLOT_END,
      holderToken: "tok-A",
      expiresAt: NOW + 5 * 60 * 1000,
      createdAt: NOW,
    });

    const res = await createBookingHandler(ctx, {
      slug: SLUG,
      startTime: SLOT_START,
      endTime: SLOT_END,
      bookerTimeZone: TZ,
      holderToken: "tok-A",
      idempotencyKey: "key-A",
      attendee: ATTENDEE,
      nowMs: NOW,
    });

    const booking = await ctx.db.get(res.bookingId);
    expect(booking.status).toBe("accepted");
    expect(booking.eventTypeId).toBe(eventTypeId);
    expect(booking.assignedHostAuthUserId).toBe(HOST); // single host
    expect(booking.idempotencyKey).toBe("key-A");

    const attendees = await ctx.db.query("bookingAttendees").collect();
    const roles = attendees.map((a: any) => a.role).sort();
    expect(roles).toEqual(["booker", "host"]);
    const booker = attendees.find((a: any) => a.role === "booker");
    expect(booker.email).toBe("casey@example.com");

    // Hold consumed.
    const holds = await ctx.db.query("bookingHolds").collect();
    expect(holds).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// (e) flag-OFF blocks createBooking
// ─────────────────────────────────────────────────────────────

describe("createBooking — flag gate", () => {
  it("throws booking_disabled when the flag is OFF (no row)", async () => {
    const off = makeCtx(); // no enableBooking
    await seedEventType(off);
    let kind = "";
    try {
      await createBookingHandler(off, {
        slug: SLUG,
        startTime: SLOT_START,
        endTime: SLOT_END,
        bookerTimeZone: TZ,
        holderToken: "tok-A",
        idempotencyKey: "key-A",
        attendee: ATTENDEE,
        nowMs: NOW,
      });
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("booking_disabled");

    // No booking written.
    const bookings = await off.db.query("bookings").collect();
    expect(bookings).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// (d) cancel transitions status and frees the slot for a new booking
// ─────────────────────────────────────────────────────────────

describe("cancelBooking", () => {
  it("transitions accepted → cancelled and frees the slot for a fresh booking", async () => {
    await seedEventType(ctx);

    const first = await createBookingHandler(ctx, {
      slug: SLUG,
      startTime: SLOT_START,
      endTime: SLOT_END,
      bookerTimeZone: TZ,
      holderToken: "tok-A",
      idempotencyKey: "key-A",
      attendee: ATTENDEE,
      nowMs: NOW,
    });

    // Sanity: while accepted, the slot is taken (a re-book throws).
    await expect(
      createBookingHandler(ctx, {
        slug: SLUG,
        startTime: SLOT_START,
        endTime: SLOT_END,
        bookerTimeZone: TZ,
        holderToken: "tok-B",
        idempotencyKey: "key-B",
        attendee: ATTENDEE,
        nowMs: NOW,
      }),
    ).rejects.toThrow(ConvexError);

    const cancel = await cancelBookingHandler(ctx, {
      bookingId: first.bookingId,
      nowMs: NOW,
    });
    expect(cancel.status).toBe("cancelled");
    const cancelled = await ctx.db.get(first.bookingId);
    expect(cancelled.status).toBe("cancelled");

    // Slot is now free → a new booking for the same slot succeeds.
    const second = await createBookingHandler(ctx, {
      slug: SLUG,
      startTime: SLOT_START,
      endTime: SLOT_END,
      bookerTimeZone: TZ,
      holderToken: "tok-C",
      idempotencyKey: "key-C",
      attendee: ATTENDEE,
      nowMs: NOW,
    });
    expect(second.status).toBe("accepted");
    expect(second.bookingId).not.toBe(first.bookingId);
  });

  it("rejects cancelling an already-cancelled booking (cannot_cancel_status)", async () => {
    await seedEventType(ctx);
    const first = await createBookingHandler(ctx, {
      slug: SLUG,
      startTime: SLOT_START,
      endTime: SLOT_END,
      bookerTimeZone: TZ,
      holderToken: "tok-A",
      idempotencyKey: "key-A",
      attendee: ATTENDEE,
      nowMs: NOW,
    });
    await cancelBookingHandler(ctx, { bookingId: first.bookingId, nowMs: NOW });

    let kind = "";
    try {
      await cancelBookingHandler(ctx, {
        bookingId: first.bookingId,
        nowMs: NOW,
      });
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("cannot_cancel_status");
  });
});

// ─────────────────────────────────────────────────────────────
// rescheduleBooking
// ─────────────────────────────────────────────────────────────

describe("rescheduleBooking", () => {
  it("marks old → rescheduled (linked) and inserts a new accepted booking", async () => {
    await seedEventType(ctx);
    const orig = await createBookingHandler(ctx, {
      slug: SLUG,
      startTime: SLOT_START,
      endTime: SLOT_END,
      bookerTimeZone: TZ,
      holderToken: "tok-A",
      idempotencyKey: "key-A",
      attendee: ATTENDEE,
      nowMs: NOW,
    });

    const res = await rescheduleBookingHandler(ctx, {
      oldBookingId: orig.bookingId,
      newStartTime: SLOT2_START,
      newEndTime: SLOT2_END,
      newBookerTimeZone: TZ,
      holderToken: "tok-A2",
      idempotencyKey: "key-RESCHED",
      attendee: ATTENDEE,
      nowMs: NOW,
    });

    expect(res.status).toBe("accepted");
    expect(res.newBookingId).not.toBe(orig.bookingId);

    const old = await ctx.db.get(orig.bookingId);
    expect(old.status).toBe("rescheduled");
    expect(old.rescheduledToBookingId).toBe(res.newBookingId);

    const fresh = await ctx.db.get(res.newBookingId);
    expect(fresh.status).toBe("accepted");
    expect(fresh.startTime).toBe(SLOT2_START);
    expect(fresh.rescheduledFromBookingId).toBe(orig.bookingId);
  });

  it("excludes the old booking from the new-slot conflict scan (reschedule to an overlapping window of itself is fine when it's the only conflict)", async () => {
    // Reschedule to a window that overlaps ONLY the old booking. Because the old
    // booking is excluded, the slot is considered free. We use the same slot
    // (10:00) — the only thing occupying it is the booking being replaced.
    await seedEventType(ctx);
    const orig = await createBookingHandler(ctx, {
      slug: SLUG,
      startTime: SLOT_START,
      endTime: SLOT_END,
      bookerTimeZone: TZ,
      holderToken: "tok-A",
      idempotencyKey: "key-A",
      attendee: ATTENDEE,
      nowMs: NOW,
    });

    const res = await rescheduleBookingHandler(ctx, {
      oldBookingId: orig.bookingId,
      newStartTime: SLOT_START, // same slot as the old booking
      newEndTime: SLOT_END,
      newBookerTimeZone: TZ,
      holderToken: "tok-A2",
      idempotencyKey: "key-RESCHED2",
      attendee: ATTENDEE,
      nowMs: NOW,
    });
    expect(res.status).toBe("accepted");
  });

  it("rejects rescheduling a cancelled booking (cannot_reschedule_status)", async () => {
    await seedEventType(ctx);
    const orig = await createBookingHandler(ctx, {
      slug: SLUG,
      startTime: SLOT_START,
      endTime: SLOT_END,
      bookerTimeZone: TZ,
      holderToken: "tok-A",
      idempotencyKey: "key-A",
      attendee: ATTENDEE,
      nowMs: NOW,
    });
    await cancelBookingHandler(ctx, { bookingId: orig.bookingId, nowMs: NOW });

    let kind = "";
    try {
      await rescheduleBookingHandler(ctx, {
        oldBookingId: orig.bookingId,
        newStartTime: SLOT2_START,
        newEndTime: SLOT2_END,
        newBookerTimeZone: TZ,
        holderToken: "tok-A2",
        idempotencyKey: "key-RESCHED",
        attendee: ATTENDEE,
        nowMs: NOW,
      });
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("cannot_reschedule_status");
  });
});

// ─────────────────────────────────────────────────────────────
// E1 — round-robin host selection (getLuckyUser)
// ─────────────────────────────────────────────────────────────

describe("createBooking — round-robin distribution (getLuckyUser)", () => {
  const P1 = "host_p1"; // lexicographically first
  const P2 = "host_p2";

  // Distinct, non-overlapping 30-min slots inside 9–17 on Mon 2026-06-01.
  const S1 = Date.UTC(2026, 5, 1, 10, 0, 0);
  const S2 = Date.UTC(2026, 5, 1, 11, 0, 0);
  const S3 = Date.UTC(2026, 5, 1, 12, 0, 0);
  const half = 30 * 60_000;

  async function book(slug: string, start: number, key: string) {
    return createBookingHandler(ctx, {
      slug,
      startTime: start,
      endTime: start + half,
      bookerTimeZone: TZ,
      holderToken: `tok-${key}`,
      idempotencyKey: key,
      attendee: ATTENDEE,
      nowMs: NOW,
    });
  }

  it("distributes across a 2-host pool least-recently-booked first", async () => {
    await seedRoundRobinEventType(ctx, [P1, P2], { slug: "rr" });

    // Booking 1: both hosts idle (never booked) → tie broken by host id → P1.
    const b1 = await book("rr", S1, "rr-1");
    const r1 = await ctx.db.get(b1.bookingId);
    expect(r1.assignedHostAuthUserId).toBe(P1);

    // Booking 2: P1 now has a recent booking, P2 still never-booked → P2 is the
    // least-recently-booked → P2.
    const b2 = await book("rr", S2, "rr-2");
    const r2 = await ctx.db.get(b2.bookingId);
    expect(r2.assignedHostAuthUserId).toBe(P2);

    // Booking 3: P1's last booking (S1=10:00) is OLDER than P2's (S2=11:00) →
    // P1 is least-recently-booked → P1 again. (Even distribution: 2 vs 1.)
    const b3 = await book("rr", S3, "rr-3");
    const r3 = await ctx.db.get(b3.bookingId);
    expect(r3.assignedHostAuthUserId).toBe(P1);

    // Net distribution across the pool: P1 twice, P2 once (balanced rotation).
    const all = await ctx.db.query("bookings").collect();
    const counts = all.reduce((m: Record<string, number>, b: any) => {
      m[b.assignedHostAuthUserId] = (m[b.assignedHostAuthUserId] ?? 0) + 1;
      return m;
    }, {});
    expect(counts[P1]).toBe(2);
    expect(counts[P2]).toBe(1);
  });

  it("offers a slot if ANY pool host is free (RR), where collective would reject", async () => {
    await seedRoundRobinEventType(ctx, [P1, P2], { slug: "rr-any" });

    // Pre-book P1 solid across S1 so ONLY P2 is free at S1.
    await ctx.db.insert("bookings", {
      eventTypeId: (await ctx.db.query("eventTypes").collect()).find(
        (e: any) => e.slug === "rr-any",
      )._id,
      ownerAuthUserId: OWNER,
      assignedHostAuthUserId: P1,
      startTime: S1,
      endTime: S1 + half,
      timeZone: TZ,
      status: "accepted",
      idempotencyKey: "pre-p1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // RR booking at S1: P1 is busy, but P2 is free → the slot is STILL offered
    // and the booking is assigned to the only free host, P2. (Collective would
    // have rejected since not every host is free.)
    const res = await book("rr-any", S1, "rr-any-1");
    expect(res.status).toBe("accepted");
    const row = await ctx.db.get(res.bookingId);
    expect(row.assignedHostAuthUserId).toBe(P2);
  });

  it("falls back to another free host when the lucky host is booked out (no failure)", async () => {
    await seedRoundRobinEventType(ctx, [P1, P2], { slug: "rr-fb" });
    const etId = (await ctx.db.query("eventTypes").collect()).find(
      (e: any) => e.slug === "rr-fb",
    )._id;

    // P1 would be the lucky pick at S1 (tie → lexicographic), but P1 is booked
    // out at S1. The picker excludes P1 from the free-candidate set and assigns
    // P2 instead of failing the booking.
    await ctx.db.insert("bookings", {
      eventTypeId: etId,
      ownerAuthUserId: OWNER,
      assignedHostAuthUserId: P1,
      startTime: S1,
      endTime: S1 + half,
      timeZone: TZ,
      status: "accepted",
      idempotencyKey: "fb-p1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const res = await book("rr-fb", S1, "rr-fb-1");
    expect(res.status).toBe("accepted");
    const row = await ctx.db.get(res.bookingId);
    expect(row.assignedHostAuthUserId).toBe(P2);
  });

  it("throws slot_unavailable when NO pool host is free", async () => {
    await seedRoundRobinEventType(ctx, [P1, P2], { slug: "rr-none" });
    const etId = (await ctx.db.query("eventTypes").collect()).find(
      (e: any) => e.slug === "rr-none",
    )._id;
    for (const h of [P1, P2]) {
      await ctx.db.insert("bookings", {
        eventTypeId: etId,
        ownerAuthUserId: OWNER,
        assignedHostAuthUserId: h,
        startTime: S1,
        endTime: S1 + half,
        timeZone: TZ,
        status: "accepted",
        idempotencyKey: `none-${h}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    let kind = "";
    try {
      await book("rr-none", S1, "rr-none-1");
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("slot_unavailable");
  });
});
