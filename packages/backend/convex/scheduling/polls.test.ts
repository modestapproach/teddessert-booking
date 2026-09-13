// BOOKING / E3 — tests for `scheduling/polls.ts` (meeting polls).
//
// HARNESS: the repo FakeDb + bare-handler convention (see booking.test.ts).
// `requireAuthUserId` is mocked (organizer mutations need it); votePoll is the
// public path and needs no identity. The DEFAULT-OFF `booking_enabled` flag is
// exercised through the REAL featureFlag read path (seed a flag row to enable).
//
// The headline flow assertion: createPoll → vote(x2) → closePoll(pickWinner)
// DELEGATES to the real createBookingHandler and a booking row is created at the
// winning option's slot. We also assert a closed poll rejects votes and that the
// public DTO exposes only safe fields (no organizer id, no voter emails).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ConvexError } from "convex/values";

vi.mock("../_helpers/auth", () => ({
  requireAuthUserId: async (ctx: any) => {
    if (!ctx.__identity) throw new ConvexError("Not authenticated. Please sign in.");
    return ctx.__identity as string;
  },
}));

import {
  createPollHandler,
  votePollHandler,
  closePollHandler,
  cancelPollHandler,
  getPollWithVotesHandler,
  getPublicPollImpl,
} from "./polls";

// ─────────────────────────────────────────────────────────────
// FakeDb (eq + range) + FakeScheduler — same shape as booking.test.ts
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

function makeCtx(identity?: string) {
  return {
    db: new FakeDb(),
    scheduler: new FakeScheduler(),
    __identity: identity,
  } as any;
}

// ─────────────────────────────────────────────────────────────
// Seed — one collective event type (so closePoll → createBooking works) +
// constants. Mirrors booking.test.ts's seedEventType.
// ─────────────────────────────────────────────────────────────

const ORGANIZER = "owner_x";
const HOST = "host_a";
const TZ = "UTC";
const SLUG = "intro";

// 2026-06-01 is a Monday. Two distinct 30-min slots inside 9–17Z.
const OPT0_START = Date.UTC(2026, 5, 1, 10, 0, 0);
const OPT0_END = Date.UTC(2026, 5, 1, 10, 30, 0);
const OPT1_START = Date.UTC(2026, 5, 1, 11, 0, 0);
const OPT1_END = Date.UTC(2026, 5, 1, 11, 30, 0);
const NOW = Date.UTC(2026, 5, 1, 9, 0, 0);

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
    startMinute: 540, // 09:00
    endMinute: 1020, // 17:00
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const eventTypeId = await ctx.db.insert("eventTypes", {
    ownerAuthUserId: ORGANIZER,
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
    ownerAuthUserId: ORGANIZER,
    hostAuthUserId: HOST,
    isFixed: true,
    createdAt: Date.now(),
  });
  return eventTypeId;
}

let ctx: any;
beforeEach(async () => {
  ctx = makeCtx(ORGANIZER);
  await enableBooking(ctx);
});

// ─────────────────────────────────────────────────────────────
// (a) HEADLINE FLOW — create → vote(x2) → pick winner → booking created
// ─────────────────────────────────────────────────────────────

describe("polls — create → vote → close creates a booking at the winning slot", () => {
  it("closePoll delegates to createBooking and writes a booking at the winning option", async () => {
    const eventTypeId = await seedEventType(ctx);

    const pollId = await createPollHandler(ctx, {
      eventTypeId: eventTypeId as any,
      title: "When should we meet?",
      options: [
        { startMs: OPT0_START, endMs: OPT0_END },
        { startMs: OPT1_START, endMs: OPT1_END },
      ],
      nowMs: NOW,
    });

    // Two voters (public, no auth). Both available for option 1 (idx 1).
    await votePollHandler(ctx, {
      pollId: pollId as any,
      voterEmail: "alice@example.com",
      voterName: "Alice",
      selectedOptionIdxs: [0, 1],
      nowMs: NOW,
    });
    await votePollHandler(ctx, {
      pollId: pollId as any,
      voterEmail: "bob@example.com",
      voterName: "Bob",
      selectedOptionIdxs: [1],
      nowMs: NOW,
    });

    // Tally: idx 1 has 2 yes, idx 0 has 1 yes. Organizer picks the winner (idx 1).
    const closed = await closePollHandler(ctx, {
      pollId: pollId as any,
      pickedOptionIdx: 1,
      bookerName: "Organizer",
      bookerEmail: "org@example.com",
      idempotencyKey: "poll-close-1",
      nowMs: NOW,
    });

    // A booking exists at the WINNING option's slot (OPT1).
    expect(closed.bookingId).toBeTruthy();
    const booking = await ctx.db.get(closed.bookingId);
    expect(booking.status).toBe("accepted");
    expect(booking.startTime).toBe(OPT1_START);
    expect(booking.endTime).toBe(OPT1_END);
    expect(booking.eventTypeId).toBe(eventTypeId);

    // Exactly ONE booking row was created by the close.
    const allBookings = await ctx.db.query("bookings").collect();
    expect(allBookings).toHaveLength(1);

    // The poll is now closed + records the pick + the result booking.
    const poll = await ctx.db.get(pollId);
    expect(poll.status).toBe("closed");
    expect(poll.pickedOptionIdx).toBe(1);
    expect(poll.resultBookingId).toBe(closed.bookingId);
  });
});

// ─────────────────────────────────────────────────────────────
// (b) A closed poll rejects further votes
// ─────────────────────────────────────────────────────────────

describe("polls — closed poll rejects votes", () => {
  it("votePoll on a closed poll throws poll_closed", async () => {
    const eventTypeId = await seedEventType(ctx);
    const pollId = await createPollHandler(ctx, {
      eventTypeId: eventTypeId as any,
      title: "Closed-vote test",
      options: [{ startMs: OPT0_START, endMs: OPT0_END }],
      nowMs: NOW,
    });
    await closePollHandler(ctx, {
      pollId: pollId as any,
      pickedOptionIdx: 0,
      idempotencyKey: "poll-close-2",
      nowMs: NOW,
    });

    let kind = "";
    try {
      await votePollHandler(ctx, {
        pollId: pollId as any,
        voterEmail: "late@example.com",
        selectedOptionIdxs: [0],
        nowMs: NOW,
      });
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("poll_closed");
  });
});

// ─────────────────────────────────────────────────────────────
// (c) Public poll DTO exposes only safe fields
// ─────────────────────────────────────────────────────────────

describe("polls — public DTO is safe", () => {
  it("getPublicPollImpl exposes tally but NOT the organizer id or voter emails", async () => {
    const eventTypeId = await seedEventType(ctx);
    const pollId = await createPollHandler(ctx, {
      eventTypeId: eventTypeId as any,
      title: "Public-safe test",
      description: "desc",
      location: "Cafe",
      options: [
        { startMs: OPT0_START, endMs: OPT0_END },
        { startMs: OPT1_START, endMs: OPT1_END },
      ],
      nowMs: NOW,
    });
    await votePollHandler(ctx, {
      pollId: pollId as any,
      voterEmail: "secret@example.com",
      selectedOptionIdxs: [0],
      ifNeededOptionIdxs: [1],
      nowMs: NOW,
    });

    const dto = await getPublicPollImpl(ctx, String(pollId));
    expect(dto).not.toBeNull();
    // Safe fields present.
    expect(dto!.title).toBe("Public-safe test");
    expect(dto!.status).toBe("open");
    expect(dto!.voteCount).toBe(1);
    expect(dto!.options).toHaveLength(2);
    expect(dto!.options[0]).toMatchObject({ idx: 0, yesCount: 1, ifNeededCount: 0 });
    expect(dto!.options[1]).toMatchObject({ idx: 1, yesCount: 0, ifNeededCount: 1 });
    // Sensitive fields ABSENT — no organizer id, no raw voter emails anywhere.
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain("organizerAuthUserId");
    expect(serialized).not.toContain(ORGANIZER);
    expect(serialized).not.toContain("secret@example.com");
    expect(serialized).not.toContain("voterEmail");
  });
});

// ─────────────────────────────────────────────────────────────
// (d) Vote upsert — a voter updating their choices patches (no dupe row)
// ─────────────────────────────────────────────────────────────

describe("polls — vote upsert", () => {
  it("a returning voter patches their existing vote (no duplicate row)", async () => {
    const eventTypeId = await seedEventType(ctx);
    const pollId = await createPollHandler(ctx, {
      eventTypeId: eventTypeId as any,
      title: "Upsert test",
      options: [
        { startMs: OPT0_START, endMs: OPT0_END },
        { startMs: OPT1_START, endMs: OPT1_END },
      ],
      nowMs: NOW,
    });
    const v1 = await votePollHandler(ctx, {
      pollId: pollId as any,
      voterEmail: "amy@example.com",
      selectedOptionIdxs: [0],
      nowMs: NOW,
    });
    const v2 = await votePollHandler(ctx, {
      pollId: pollId as any,
      voterEmail: "amy@example.com",
      selectedOptionIdxs: [1],
      nowMs: NOW + 1000,
    });
    expect(v2).toBe(v1); // same row id (patched)
    const votes = await ctx.db.query("bookingPollVotes").collect();
    expect(votes).toHaveLength(1);
    expect(votes[0].selectedOptionIdxs).toEqual([1]);

    const withVotes = await getPollWithVotesHandler(ctx, { pollId: pollId as any });
    expect(withVotes!.tally.find((t) => t.idx === 1)?.yesCount).toBe(1);
    expect(withVotes!.tally.find((t) => t.idx === 0)?.yesCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// (e) Ownership + auth + flag guards
// ─────────────────────────────────────────────────────────────

describe("polls — guards", () => {
  it("createPoll requires auth (no identity throws)", async () => {
    const anon = makeCtx(undefined);
    await enableBooking(anon);
    await expect(
      createPollHandler(anon, {
        title: "x",
        options: [{ startMs: OPT0_START, endMs: OPT0_END }],
        nowMs: NOW,
      }),
    ).rejects.toThrow(ConvexError);
  });

  it("closePoll by a non-organizer is Not found (ownership guard)", async () => {
    const eventTypeId = await seedEventType(ctx);
    const pollId = await createPollHandler(ctx, {
      eventTypeId: eventTypeId as any,
      title: "Owned test",
      options: [{ startMs: OPT0_START, endMs: OPT0_END }],
      nowMs: NOW,
    });
    // A different user tries to close it.
    const other = makeCtx("someone_else");
    other.db = ctx.db; // share the same store
    await enableBooking(other); // (flag row already in shared store; harmless dup)
    await expect(
      closePollHandler(other, {
        pollId: pollId as any,
        pickedOptionIdx: 0,
        idempotencyKey: "poll-close-x",
        nowMs: NOW,
      }),
    ).rejects.toThrow(ConvexError);
  });

  it("votePoll throws booking_disabled when the flag is OFF", async () => {
    const off = makeCtx(); // no enableBooking
    const eventTypeId = await seedEventType(off);
    // Insert a poll directly (createPoll would also be flag-gated).
    const pollId = await off.db.insert("bookingPolls", {
      organizerAuthUserId: ORGANIZER,
      eventTypeId,
      title: "flag off",
      options: [{ idx: 0, startMs: OPT0_START, endMs: OPT0_END }],
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });
    let kind = "";
    try {
      await votePollHandler(off, {
        pollId: pollId as any,
        voterEmail: "x@example.com",
        selectedOptionIdxs: [0],
        nowMs: NOW,
      });
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("booking_disabled");
  });

  it("cancelPoll closes without a winner (no booking created)", async () => {
    const eventTypeId = await seedEventType(ctx);
    const pollId = await createPollHandler(ctx, {
      eventTypeId: eventTypeId as any,
      title: "Cancel test",
      options: [{ startMs: OPT0_START, endMs: OPT0_END }],
      nowMs: NOW,
    });
    await cancelPollHandler(ctx, { pollId: pollId as any, nowMs: NOW });
    const poll = await ctx.db.get(pollId);
    expect(poll.status).toBe("closed");
    expect(poll.pickedOptionIdx).toBeUndefined();
    const bookings = await ctx.db.query("bookings").collect();
    expect(bookings).toHaveLength(0);
  });
});
