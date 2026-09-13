// CV-4 — tests for the owner bookings DASHBOARD surface (bookingAdmin.ts).
//
// Proves the s2s layer the forked cal.com app's `/bookings` list + host actions
// call via getConvex():
//   - `listBookingsCore` is owner-scoped by the EXPLICIT `ownerAuthUserId` arg (NO
//     Convex identity), filters onto cal's status tabs (upcoming/past/cancelled/
//     unconfirmed/recurring) projected on our 4-state model, bounds the time window
//     via the by_owner_startTime index, paginates (cursor + isDone), and joins
//     attendees + the event-type snapshot the cal list/detail sheet read;
//   - `adminCancelBooking` / `adminRescheduleBooking` re-check ownership against the
//     trusted arg, inherit the DEFAULT-OFF booking_enabled flag gate (via the real
//     cancelBookingHandler / rescheduleBookingHandler), and delegate the write.
//
// Harness: a FakeDb that adds `.paginate()` (Convex's contract) to the eq/gte/lte
// chaining the sibling scheduling tests use, so we exercise the REAL handlers.

import { describe, it, expect, beforeEach } from "vitest";
import { ConvexError } from "convex/values";
import {
  listBookingsCore,
  bookingMatchesStatus,
  adminCancelBooking,
  adminRescheduleBooking,
} from "./bookingAdmin";

type Doc = Record<string, any> & { _id: string; _creationTime: number };

class FakeQuery {
  private rows: Doc[];
  private orderDir: "asc" | "desc" = "asc";
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
  order(dir: "asc" | "desc") {
    this.orderDir = dir;
    return this;
  }
  private sorted(): Doc[] {
    const rows = [...this.rows];
    rows.sort((a, b) =>
      this.orderDir === "desc"
        ? b._creationTime - a._creationTime
        : a._creationTime - b._creationTime,
    );
    return rows;
  }
  async collect(): Promise<Doc[]> {
    return this.sorted();
  }
  async take(n: number): Promise<Doc[]> {
    return this.sorted().slice(0, n);
  }
  async unique(): Promise<Doc | null> {
    if (this.rows.length > 1) throw new Error("unique(): more than one row");
    return this.rows[0] ?? null;
  }
  async first(): Promise<Doc | null> {
    return this.sorted()[0] ?? null;
  }
  // Convex pagination contract: cursor is the numeric offset (as a string) into the
  // index-ordered rows; returns { page, isDone, continueCursor }.
  async paginate(opts: { numItems: number; cursor: string | null }) {
    const rows = this.sorted();
    const offset = opts.cursor ? parseInt(opts.cursor, 10) : 0;
    const slice = rows.slice(offset, offset + opts.numItems);
    const nextOffset = offset + slice.length;
    const isDone = nextOffset >= rows.length;
    return {
      page: slice,
      isDone,
      continueCursor: String(nextOffset),
    };
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

async function enableBooking(ctx: any) {
  await ctx.db.insert("featureFlags", {
    key: "booking_enabled",
    value: true,
    updatedAt: Date.now(),
    updatedBy: "test",
  });
}

const OWNER = "owner_x";
const OTHER = "owner_other";
const HOST = "host_a";
const TZ = "UTC";
const SLUG = "intro";

// 2026-06-01 is a Monday. Window 9–17Z. NOW = 12:00Z splits past/future.
const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

// Seed a full event type + schedule + host so the REAL reschedule handler can
// resolve hosts + availability for a reslot.
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
    startMinute: 540, // 09:00
    endMinute: 1020, // 17:00
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const eventTypeId = await ctx.db.insert("eventTypes", {
    ownerAuthUserId: OWNER,
    slug: SLUG,
    title: "Intro Call",
    description: "A quick chat.",
    durationMinutes: 30,
    schedulingType: "collective",
    scheduleId,
    minimumBookingNoticeMinutes: 0,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    requireEmailVerification: false,
    hidden: false,
    locationText: "Coffee shop on Main St",
    active: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await ctx.db.insert("eventTypeHosts", {
    eventTypeId,
    ownerAuthUserId: OWNER,
    hostAuthUserId: HOST,
    isFixed: true,
    scheduleId,
    createdAt: Date.now(),
  });
  return eventTypeId;
}

// Insert a booking row + a booker attendee, owner = OWNER unless overridden.
async function seedBooking(
  ctx: any,
  eventTypeId: string,
  opts: {
    owner?: string;
    status?: "accepted" | "pending" | "cancelled" | "rescheduled";
    startTime: number;
    endTime: number;
    attendee?: { name: string; email: string };
  },
): Promise<string> {
  const owner = opts.owner ?? OWNER;
  const bookingId = await ctx.db.insert("bookings", {
    eventTypeId,
    ownerAuthUserId: owner,
    assignedHostAuthUserId: HOST,
    startTime: opts.startTime,
    endTime: opts.endTime,
    timeZone: TZ,
    status: opts.status ?? "accepted",
    idempotencyKey: `seed:${opts.startTime}:${owner}`,
    locationText: "Coffee shop on Main St",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const a = opts.attendee ?? { name: "Casey Candidate", email: "casey@example.com" };
  await ctx.db.insert("bookingAttendees", {
    bookingId,
    ownerAuthUserId: owner,
    name: a.name,
    email: a.email,
    timeZone: TZ,
    role: "booker",
    createdAt: Date.now(),
  });
  return bookingId;
}

const PAGE_ALL = { numItems: 100, cursor: null };

let ctx: any;
let eventTypeId: string;
beforeEach(async () => {
  ctx = makeCtx();
  await enableBooking(ctx);
  eventTypeId = await seedEventType(ctx);
});

// ─────────────────────────────────────────────────────────────
// bookingMatchesStatus — the cal-tab projection (pure)
// ─────────────────────────────────────────────────────────────

describe("bookingMatchesStatus — cal status-tab projection", () => {
  const future = NOW + 3_600_000;
  const past = NOW - 3_600_000;
  it("upcoming = live (accepted/pending) AND endTime >= now", () => {
    expect(bookingMatchesStatus({ status: "accepted", endTime: future }, "upcoming", NOW)).toBe(true);
    expect(bookingMatchesStatus({ status: "pending", endTime: future }, "upcoming", NOW)).toBe(true);
    expect(bookingMatchesStatus({ status: "accepted", endTime: past }, "upcoming", NOW)).toBe(false);
    expect(bookingMatchesStatus({ status: "cancelled", endTime: future }, "upcoming", NOW)).toBe(false);
  });
  it("past = live AND endTime <= now", () => {
    expect(bookingMatchesStatus({ status: "accepted", endTime: past }, "past", NOW)).toBe(true);
    expect(bookingMatchesStatus({ status: "accepted", endTime: future }, "past", NOW)).toBe(false);
    expect(bookingMatchesStatus({ status: "cancelled", endTime: past }, "past", NOW)).toBe(false);
  });
  it("cancelled = status cancelled OR rescheduled (cal lumps rescheduled-away in)", () => {
    expect(bookingMatchesStatus({ status: "cancelled", endTime: future }, "cancelled", NOW)).toBe(true);
    expect(bookingMatchesStatus({ status: "rescheduled", endTime: past }, "cancelled", NOW)).toBe(true);
    expect(bookingMatchesStatus({ status: "accepted", endTime: future }, "cancelled", NOW)).toBe(false);
  });
  it("unconfirmed = pending AND endTime >= now", () => {
    expect(bookingMatchesStatus({ status: "pending", endTime: future }, "unconfirmed", NOW)).toBe(true);
    expect(bookingMatchesStatus({ status: "accepted", endTime: future }, "unconfirmed", NOW)).toBe(false);
    expect(bookingMatchesStatus({ status: "pending", endTime: past }, "unconfirmed", NOW)).toBe(false);
  });
  it("recurring is always false (no recurring model)", () => {
    expect(bookingMatchesStatus({ status: "accepted", endTime: future }, "recurring", NOW)).toBe(false);
  });
  it("undefined status = all", () => {
    expect(bookingMatchesStatus({ status: "cancelled", endTime: past }, undefined, NOW)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// listBookingsCore — owner-scoped list + filter + window + paginate
// ─────────────────────────────────────────────────────────────

describe("listBookingsCore — owner-scoped, filtered, paginated", () => {
  it("joins attendees + an event-type snapshot the cal list/detail sheet read", async () => {
    await seedBooking(ctx, eventTypeId, {
      status: "accepted",
      startTime: NOW + 3_600_000,
      endTime: NOW + 5_400_000,
    });
    const res = await listBookingsCore(ctx, {
      ownerAuthUserId: OWNER,
      nowMs: NOW,
      paginationOpts: PAGE_ALL,
    });
    expect(res.page).toHaveLength(1);
    const row = res.page[0];
    expect(row.attendees).toHaveLength(1);
    expect(row.attendees[0].email).toBe("casey@example.com");
    expect(row.eventType?.slug).toBe(SLUG);
    expect(row.eventType?.title).toBe("Intro Call");
    expect(row.eventType?.durationMinutes).toBe(30);
    expect(row.eventType?.locationText).toBe("Coffee shop on Main St");
    expect(row.eventType?.schedulingType).toBe("collective");
    expect((row.booking as any).status).toBe("accepted");
  });

  it("filters by the upcoming tab (live, future end)", async () => {
    await seedBooking(ctx, eventTypeId, { status: "accepted", startTime: NOW + 3_600_000, endTime: NOW + 5_400_000 });
    await seedBooking(ctx, eventTypeId, { status: "accepted", startTime: NOW - 5_400_000, endTime: NOW - 3_600_000 });
    await seedBooking(ctx, eventTypeId, { status: "cancelled", startTime: NOW + 7_200_000, endTime: NOW + 9_000_000 });
    const res = await listBookingsCore(ctx, {
      ownerAuthUserId: OWNER,
      status: "upcoming",
      nowMs: NOW,
      paginationOpts: PAGE_ALL,
    });
    expect(res.page).toHaveLength(1);
    expect((res.page[0].booking as any).startTime).toBe(NOW + 3_600_000);
  });

  it("filters by the past tab (live, past end)", async () => {
    await seedBooking(ctx, eventTypeId, { status: "accepted", startTime: NOW + 3_600_000, endTime: NOW + 5_400_000 });
    await seedBooking(ctx, eventTypeId, { status: "accepted", startTime: NOW - 5_400_000, endTime: NOW - 3_600_000 });
    const res = await listBookingsCore(ctx, {
      ownerAuthUserId: OWNER,
      status: "past",
      nowMs: NOW,
      paginationOpts: PAGE_ALL,
    });
    expect(res.page).toHaveLength(1);
    expect((res.page[0].booking as any).startTime).toBe(NOW - 5_400_000);
  });

  it("filters by the cancelled tab (cancelled + rescheduled)", async () => {
    await seedBooking(ctx, eventTypeId, { status: "accepted", startTime: NOW + 3_600_000, endTime: NOW + 5_400_000 });
    await seedBooking(ctx, eventTypeId, { status: "cancelled", startTime: NOW + 7_200_000, endTime: NOW + 9_000_000 });
    await seedBooking(ctx, eventTypeId, { status: "rescheduled", startTime: NOW - 9_000_000, endTime: NOW - 7_200_000 });
    const res = await listBookingsCore(ctx, {
      ownerAuthUserId: OWNER,
      status: "cancelled",
      nowMs: NOW,
      paginationOpts: PAGE_ALL,
    });
    expect(res.page).toHaveLength(2);
  });

  it("filters by the unconfirmed tab (pending, future)", async () => {
    await seedBooking(ctx, eventTypeId, { status: "pending", startTime: NOW + 3_600_000, endTime: NOW + 5_400_000 });
    await seedBooking(ctx, eventTypeId, { status: "accepted", startTime: NOW + 7_200_000, endTime: NOW + 9_000_000 });
    const res = await listBookingsCore(ctx, {
      ownerAuthUserId: OWNER,
      status: "unconfirmed",
      nowMs: NOW,
      paginationOpts: PAGE_ALL,
    });
    expect(res.page).toHaveLength(1);
    expect((res.page[0].booking as any).status).toBe("pending");
  });

  it("recurring tab is always empty", async () => {
    await seedBooking(ctx, eventTypeId, { status: "accepted", startTime: NOW + 3_600_000, endTime: NOW + 5_400_000 });
    const res = await listBookingsCore(ctx, {
      ownerAuthUserId: OWNER,
      status: "recurring",
      nowMs: NOW,
      paginationOpts: PAGE_ALL,
    });
    expect(res.page).toHaveLength(0);
  });

  it("bounds the time window via after/before", async () => {
    await seedBooking(ctx, eventTypeId, { status: "accepted", startTime: NOW + 1_000, endTime: NOW + 1_800_000 });
    await seedBooking(ctx, eventTypeId, { status: "accepted", startTime: NOW + 10_000_000, endTime: NOW + 11_800_000 });
    const res = await listBookingsCore(ctx, {
      ownerAuthUserId: OWNER,
      after: NOW,
      before: NOW + 5_000_000,
      nowMs: NOW,
      paginationOpts: PAGE_ALL,
    });
    expect(res.page).toHaveLength(1);
    expect((res.page[0].booking as any).startTime).toBe(NOW + 1_000);
  });

  it("is owner-scoped — another owner's bookings never appear", async () => {
    await seedBooking(ctx, eventTypeId, { owner: OWNER, status: "accepted", startTime: NOW + 3_600_000, endTime: NOW + 5_400_000 });
    await seedBooking(ctx, eventTypeId, { owner: OTHER, status: "accepted", startTime: NOW + 3_600_000, endTime: NOW + 5_400_000 });
    const mine = await listBookingsCore(ctx, { ownerAuthUserId: OWNER, nowMs: NOW, paginationOpts: PAGE_ALL });
    expect(mine.page).toHaveLength(1);
    const theirs = await listBookingsCore(ctx, { ownerAuthUserId: OTHER, nowMs: NOW, paginationOpts: PAGE_ALL });
    expect(theirs.page).toHaveLength(1);
    expect((theirs.page[0].booking as any).ownerAuthUserId).toBe(OTHER);
  });

  it("paginates across pages with the continueCursor + isDone", async () => {
    for (let i = 0; i < 5; i++) {
      await seedBooking(ctx, eventTypeId, {
        status: "accepted",
        startTime: NOW + 3_600_000 + i * 60_000,
        endTime: NOW + 5_400_000 + i * 60_000,
      });
    }
    const p1 = await listBookingsCore(ctx, {
      ownerAuthUserId: OWNER,
      nowMs: NOW,
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(p1.page).toHaveLength(2);
    expect(p1.isDone).toBe(false);
    const p2 = await listBookingsCore(ctx, {
      ownerAuthUserId: OWNER,
      nowMs: NOW,
      paginationOpts: { numItems: 2, cursor: p1.continueCursor },
    });
    expect(p2.page).toHaveLength(2);
    const p3 = await listBookingsCore(ctx, {
      ownerAuthUserId: OWNER,
      nowMs: NOW,
      paginationOpts: { numItems: 2, cursor: p2.continueCursor },
    });
    expect(p3.page).toHaveLength(1);
    expect(p3.isDone).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// adminCancelBooking — ownership guard + flag gate + delegation
// ─────────────────────────────────────────────────────────────

describe("adminCancelBooking — owner cancel (s2s)", () => {
  const call = (ctx: any, a: any) => (adminCancelBooking as any)._handler(ctx, a);

  it("cancels the owner's booking (status → cancelled)", async () => {
    const bId = await seedBooking(ctx, eventTypeId, {
      status: "accepted",
      startTime: NOW + 3_600_000,
      endTime: NOW + 5_400_000,
    });
    const res = await call(ctx, { ownerAuthUserId: OWNER, bookingId: bId, reason: "owner cancel", nowMs: NOW });
    expect(res.status).toBe("cancelled");
    const row = await ctx.db.get(bId);
    expect(row.status).toBe("cancelled");
  });

  it("rejects a cancel for a booking the caller does not own (booking_not_found)", async () => {
    const bId = await seedBooking(ctx, eventTypeId, {
      owner: OWNER,
      status: "accepted",
      startTime: NOW + 3_600_000,
      endTime: NOW + 5_400_000,
    });
    let kind = "";
    try {
      await call(ctx, { ownerAuthUserId: OTHER, bookingId: bId, nowMs: NOW });
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("booking_not_found");
    // Untouched.
    const row = await ctx.db.get(bId);
    expect(row.status).toBe("accepted");
  });

  it("inherits the DEFAULT-OFF booking_enabled flag gate (flag off → booking_disabled)", async () => {
    const off = makeCtx(); // no enableBooking
    const offEt = await seedEventType(off);
    const bId = await seedBooking(off, offEt, {
      status: "accepted",
      startTime: NOW + 3_600_000,
      endTime: NOW + 5_400_000,
    });
    let kind = "";
    try {
      await call(off, { ownerAuthUserId: OWNER, bookingId: bId, nowMs: NOW });
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("booking_disabled");
  });
});

// ─────────────────────────────────────────────────────────────
// adminRescheduleBooking — ownership guard + delegation
// ─────────────────────────────────────────────────────────────

describe("adminRescheduleBooking — owner reschedule (s2s)", () => {
  const call = (ctx: any, a: any) => (adminRescheduleBooking as any)._handler(ctx, a);

  it("reschedules the owner's booking to a new slot (old → rescheduled, new accepted)", async () => {
    const oldStart = NOW + 3_600_000; // 13:00Z (inside 9–17)
    const oldEnd = oldStart + 1_800_000;
    const oldId = await seedBooking(ctx, eventTypeId, {
      status: "accepted",
      startTime: oldStart,
      endTime: oldEnd,
    });
    const newStart = NOW + 7_200_000; // 14:00Z (inside 9–17, free)
    const newEnd = newStart + 1_800_000;
    const res = await call(ctx, {
      ownerAuthUserId: OWNER,
      oldBookingId: oldId,
      newStartTime: newStart,
      newEndTime: newEnd,
      newBookerTimeZone: TZ,
      idempotencyKey: "owner-reslot-1",
      attendee: { name: "Casey Candidate", email: "casey@example.com", timeZone: TZ },
      nowMs: NOW,
    });
    expect(res.status).toBe("accepted");
    const oldRow = await ctx.db.get(oldId);
    expect(oldRow.status).toBe("rescheduled");
    expect(oldRow.rescheduledToBookingId).toBe(res.newBookingId);
    const newRow = await ctx.db.get(res.newBookingId);
    expect(newRow.status).toBe("accepted");
    expect(newRow.startTime).toBe(newStart);
    expect(newRow.rescheduledFromBookingId).toBe(oldId);
  });

  it("rejects a reschedule for a booking the caller does not own (booking_not_found)", async () => {
    const oldId = await seedBooking(ctx, eventTypeId, {
      owner: OWNER,
      status: "accepted",
      startTime: NOW + 3_600_000,
      endTime: NOW + 5_400_000,
    });
    let kind = "";
    try {
      await call(ctx, {
        ownerAuthUserId: OTHER,
        oldBookingId: oldId,
        newStartTime: NOW + 7_200_000,
        newEndTime: NOW + 9_000_000,
        newBookerTimeZone: TZ,
        idempotencyKey: "owner-reslot-2",
        attendee: { name: "X", email: "x@example.com", timeZone: TZ },
        nowMs: NOW,
      });
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("booking_not_found");
    const row = await ctx.db.get(oldId);
    expect(row.status).toBe("accepted");
  });
});
