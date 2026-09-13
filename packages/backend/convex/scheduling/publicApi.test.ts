// BOOKING / F1 — tests for the public booking API cores (scheduling/publicApi.ts).
//
// HARNESS: the repo FakeDb + bare-`*Impl`-function convention (see
// scheduling/booking.test.ts). convex-test's `t.fetch` is NOT used for these
// httpActions — the established practice is to factor the logic into plain async
// functions (`getPublicEventTypeImpl`, `getPublicSlotsImpl`, `createBookingImpl`,
// …) and unit-test THOSE against an in-memory ctx, leaving the httpAction wrapper
// as thin glue (URL/body parse → Impl → Response). So these tests exercise the
// public-safe projection, the flag gate, slot computation, idempotency,
// slot_unavailable → 409 mapping, the rate-limit helper, and the field-stripping
// — i.e. every assertion the F1 task asks for, against the real code paths.
//
// [R] LIVE HTTP DEFERRED: the actual httpAction request/response cycle (URL
// routing, CORS headers, 404/429 Response bodies) is not exercised here — it's
// covered by the live smoke test after deploy + flag-flip (M-DA3/M-DA10). The
// Response-mapping logic (kind → status) is tested indirectly via the thrown
// ConvexError kinds the wrappers consume.

import { describe, it, expect, beforeEach } from "vitest";
import { ConvexError } from "convex/values";
import {
  getPublicEventTypeImpl,
  getPublicEventTypeBySlug,
  getPublicSlotsImpl,
  createBookingImpl,
  createBookingPublic,
  cancelBookingImpl,
  rescheduleBookingImpl,
  parseSlotQuery,
  buildIcs,
  type PublicEventTypeDto,
} from "./publicApi";
import { isFlagEnabled } from "../_helpers/featureFlag";
import { checkAndLogRateLimitByIp } from "../_helpers/rateLimit";

// ─────────────────────────────────────────────────────────────
// FakeDb (eq + range chaining) + FakeStorage + FakeScheduler
// (lifted from scheduling/booking.test.ts so we run the REAL handlers)
// ─────────────────────────────────────────────────────────────

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

class FakeStorage {
  async getUrl(storageId: string): Promise<string | null> {
    return storageId ? `https://files.test/${storageId}` : null;
  }
}

class FakeScheduler {
  calls: Array<{ delayMs: number; args: any }> = [];
  async runAfter(delayMs: number, _ref: any, args: any) {
    this.calls.push({ delayMs, args });
  }
}

function makeCtx() {
  return {
    db: new FakeDb(),
    storage: new FakeStorage(),
    scheduler: new FakeScheduler(),
  } as any;
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
const WINDOW_END = Date.UTC(2026, 5, 1, 17, 0, 0);

const SLOT2_START = Date.UTC(2026, 5, 1, 11, 0, 0);
const SLOT2_END = Date.UTC(2026, 5, 1, 11, 30, 0);

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
  opts: { active?: boolean; withProfile?: boolean } = {},
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
    active: opts.active ?? true,
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
  if (opts.withProfile) {
    await ctx.db.insert("sellerProfiles", {
      authUserId: HOST,
      handle: "host-handle",
      displayName: "Dr. Avery Host",
      avatarStorageId: "avatar123",
      joinedAt: Date.now(),
      ratingCount: 0,
      positiveCount: 0,
      itemsSold: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  return eventTypeId;
}

const ATTENDEE_BASE = { name: "Casey Candidate", email: "casey@example.com" };

let ctx: any;
beforeEach(async () => {
  ctx = makeCtx();
  await enableBooking(ctx);
});

// ─────────────────────────────────────────────────────────────
// (a) slots endpoint returns slots for an active published event-type
// ─────────────────────────────────────────────────────────────

describe("getPublicSlotsImpl — happy path", () => {
  it("returns opaque {start,end} slots grouped by date for an active event type", async () => {
    await seedEventType(ctx);
    // Use a FAR-FUTURE full-day window (mirrors availableSlots.test.ts) so the
    // engine enumerates the host's 9–17 working hours independent of wall-clock.
    const slotsNow = Date.UTC(2027, 4, 7, 0, 0, 0); // a month before the window
    const slotsWindowStart = Date.UTC(2027, 5, 7, 0, 0, 0); // Mon 2027-06-07 00:00Z
    const slotsWindowEnd = Date.UTC(2027, 5, 8, 0, 0, 0); // Tue 00:00Z
    const res = await getPublicSlotsImpl(
      ctx,
      {
        slug: SLUG,
        windowStart: slotsWindowStart,
        windowEnd: slotsWindowEnd,
        viewerTimeZone: TZ,
      },
      slotsNow,
    );

    expect(res.durationMinutes).toBe(30);
    const dateKey = "2027-06-07";
    expect(res.slotsByDate[dateKey]).toBeDefined();
    expect(res.slotsByDate[dateKey].length).toBeGreaterThan(0);

    // First slot is at/after 09:00 and shaped {start,end} ONLY (30 min apart).
    const first = res.slotsByDate[dateKey][0];
    expect(typeof first.start).toBe("number");
    expect(typeof first.end).toBe("number");
    expect(first.end - first.start).toBe(30 * 60_000);

    // (g) PUBLIC-SAFE: slot objects expose ONLY start+end — no host idxs,
    // no authUserId, no event title, no eligibleHostIdxs.
    expect(Object.keys(first).sort()).toEqual(["end", "start"]);
  });
});

// ─────────────────────────────────────────────────────────────
// (b) flag OFF → the gate query reports disabled (handler → 404)
// ─────────────────────────────────────────────────────────────

describe("booking_enabled flag gate", () => {
  it("isFlagEnabled defaults to FALSE when no booking_enabled row exists (→ httpAction 404)", async () => {
    const off = makeCtx(); // no enableBooking
    await seedEventType(off);
    // This is exactly what `_bookingEnabled` evaluates; the httpAction returns
    // problem(404, "not_found") when it is false.
    const enabled = await isFlagEnabled(off, "booking_enabled", false);
    expect(enabled).toBe(false);
  });

  it("isFlagEnabled is TRUE once the flag row is seeded ON", async () => {
    // `ctx` already has enableBooking() from beforeEach.
    const enabled = await isFlagEnabled(ctx, "booking_enabled", false);
    expect(enabled).toBe(true);
  });

  it("createBooking still refuses (booking_disabled) when the flag is OFF even if reached", async () => {
    const off = makeCtx();
    await seedEventType(off);
    let kind = "";
    try {
      await createBookingImpl(off, {
        slug: SLUG,
        start: SLOT_START,
        end: SLOT_END,
        ...ATTENDEE_BASE,
        idempotencyKey: "k1",
        timeZone: TZ,
      });
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("booking_disabled");
  });
});

// ─────────────────────────────────────────────────────────────
// (c) 404 for missing / unpublished slug
// ─────────────────────────────────────────────────────────────

describe("getPublicEventTypeImpl — not found / unpublished", () => {
  it("throws event_type_not_found for a missing slug", async () => {
    let kind = "";
    try {
      await getPublicEventTypeImpl(ctx, "does-not-exist");
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("event_type_not_found");
  });

  it("throws event_type_not_found for an INACTIVE (unpublished) slug", async () => {
    await seedEventType(ctx, { active: false });
    let kind = "";
    try {
      await getPublicEventTypeImpl(ctx, SLUG);
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("event_type_not_found");
  });

  it("slots for a missing slug normalize to event_type_not_found (→ 404)", async () => {
    let kind = "";
    try {
      await getPublicSlotsImpl(
        ctx,
        { slug: "nope", windowStart: NOW, windowEnd: WINDOW_END, viewerTimeZone: TZ },
        NOW,
      );
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("event_type_not_found");
  });
});

// ─────────────────────────────────────────────────────────────
// (g) only public-safe fields exposed (no owner internals leaked)
// ─────────────────────────────────────────────────────────────

describe("getPublicEventTypeImpl — public-safe projection", () => {
  it("exposes ONLY public-safe fields; never owner internals", async () => {
    await seedEventType(ctx, { withProfile: true });
    const dto: PublicEventTypeDto = await getPublicEventTypeImpl(ctx, SLUG);

    // Exact public surface — adding a field here is a deliberate decision.
    // BOOKING-LOTTERY §6 (2026-06-09): interactionMode + lotteryCloseLeadMinutes
    // are deliberately public — the Booker needs them to switch a lottery-mode
    // event to the enter-the-drawing flow. Both are config shape, not PII.
    expect(Object.keys(dto).sort()).toEqual(
      [
        "description",
        "durationMinutes",
        "hosts",
        "interactionMode",
        "location",
        "lotteryCloseLeadMinutes",
        "requireLogin",
        "slug",
        "thresholdMinAttendees",
        "title",
      ].sort(),
    );

    expect(dto.title).toBe("Intro Call");
    expect(dto.durationMinutes).toBe(30);
    expect(dto.location).toBe("Coffee shop on Main St");
    expect(dto.requireLogin).toBe(false);

    // Host display name + avatar resolved; raw authUserId NEVER present.
    expect(dto.hosts).toHaveLength(1);
    expect(dto.hosts[0].displayName).toBe("Dr. Avery Host");
    expect(dto.hosts[0].avatarUrl).toBe("https://files.test/avatar123");
    expect(Object.keys(dto.hosts[0]).sort()).toEqual(["avatarUrl", "displayName"]);

    // OWNER INTERNALS must NOT leak anywhere in the serialized DTO.
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain(OWNER);
    expect(serialized).not.toContain(HOST);
    for (const leak of [
      "ownerAuthUserId",
      "schedulingType",
      "scheduleId",
      "minimumBookingNoticeMinutes",
      "bufferBeforeMinutes",
      "bufferAfterMinutes",
      "active",
      "hidden",
      "requireEmailVerification",
    ]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("falls back to 'Host' when no profile/preferences display name exists", async () => {
    await seedEventType(ctx); // no profile
    const dto = await getPublicEventTypeImpl(ctx, SLUG);
    expect(dto.hosts[0].displayName).toBe("Host");
    expect(dto.hosts[0].avatarUrl).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// CV-2b: the PUBLIC (registered, no-auth) getPublicEventTypeBySlug query.
// This is the function the cal fork's anonymous getConvex().query() reaches for
// the Booker SSR (it CANNOT reach the internalQuery _publicEventType). We invoke
// the registered wrapper's `._handler` directly against the FakeDb (the repo
// convention noted in the task brief). It must:
//   - return the SAME public-safe DTO as getPublicEventTypeImpl on the happy path,
//   - collapse a missing/inactive event type to null (not a thrown error) so the
//     anonymous Booker renders 404 with no enumeration oracle,
//   - NOT be gated on booking_enabled (it works even with the flag off — proving
//     the SSR path renders before the public HTTP surface is un-darked).
// ─────────────────────────────────────────────────────────────

describe("getPublicEventTypeBySlug — CV-2b public registered query", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = (c: any, slug: string) =>
    (getPublicEventTypeBySlug as any)._handler(c, { slug });

  it("returns the public-safe DTO for an active slug (host meta resolved)", async () => {
    await seedEventType(ctx, { withProfile: true });
    const dto = (await run(ctx, SLUG)) as PublicEventTypeDto | null;
    expect(dto).not.toBeNull();
    expect(dto!.title).toBe("Intro Call");
    expect(dto!.durationMinutes).toBe(30);
    expect(dto!.location).toBe("Coffee shop on Main St");
    expect(dto!.requireLogin).toBe(false);
    expect(dto!.hosts).toHaveLength(1);
    expect(dto!.hosts[0].displayName).toBe("Dr. Avery Host");
    expect(dto!.hosts[0].avatarUrl).toBe("https://files.test/avatar123");
    // Exact public surface — identical to getPublicEventTypeImpl.
    expect(Object.keys(dto!).sort()).toEqual(
      ["description", "durationMinutes", "hosts", "interactionMode", "location", "lotteryCloseLeadMinutes", "requireLogin", "slug", "thresholdMinAttendees", "title"].sort(),
    );
    // No owner internals leak through the registered query either.
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain(OWNER);
    expect(serialized).not.toContain(HOST);
    for (const leak of ["ownerAuthUserId", "schedulingType", "scheduleId", "active", "hidden"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("returns null (not a thrown error) for a missing slug", async () => {
    const dto = await run(ctx, "does-not-exist");
    expect(dto).toBeNull();
  });

  it("returns null for an INACTIVE (unpublished) slug (no enumeration oracle)", async () => {
    await seedEventType(ctx, { active: false });
    const dto = await run(ctx, SLUG);
    expect(dto).toBeNull();
  });

  it("is NOT gated on booking_enabled — resolves even with the flag OFF", async () => {
    const off = makeCtx(); // fresh ctx, never calls enableBooking
    await seedEventType(off, { withProfile: true });
    const dto = (await run(off, SLUG)) as PublicEventTypeDto | null;
    expect(dto).not.toBeNull();
    expect(dto!.title).toBe("Intro Call");
  });
});

// ─────────────────────────────────────────────────────────────
// CV-3: the PUBLIC (registered, no-auth) createBookingPublic mutation.
// This is the function the cal fork's `/api/book/event` route reaches via
// getConvex().mutation() — it CANNOT reach the internalMutation `_createBooking`
// nor `scheduling/booking:createBooking`. We invoke the registered wrapper's
// `._handler` directly against the FakeDb (repo convention). It must:
//   - create an accepted booking + return the SAME enriched CreateBookingConfirmation
//     the httpAction returns (ics + tokens + CV-3 echo fields for the OUT adapter),
//   - STILL honour the booking_enabled flag gate (dark before launch),
//   - STILL be idempotent on a repeat idempotencyKey,
//   - STILL throw slot_unavailable on a conflicting second create (→ cal 409).
// ─────────────────────────────────────────────────────────────

describe("createBookingPublic — CV-3 public registered mutation", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = (c: any, body: any) =>
    (createBookingPublic as any)._handler(c, { body });

  // The registered mutation takes ONLY { body } (no injectable nowMs param — the
  // production path uses the real Date.now()). So unlike the createBookingImpl
  // unit tests (which pass NOW), these use a FAR-FUTURE Monday 10:00–10:30Z slot
  // (2027-06-07, inside the seeded 9–17 working window) so the real wall-clock
  // min-booking-notice check passes without a clock override.
  const PUB_START = Date.UTC(2027, 5, 7, 10, 0, 0);
  const PUB_END = Date.UTC(2027, 5, 7, 10, 30, 0);

  it("creates an accepted booking and returns the enriched CV-3 confirmation", async () => {
    await seedEventType(ctx);
    const res = await run(ctx, {
      slug: SLUG,
      start: PUB_START,
      end: PUB_END,
      ...ATTENDEE_BASE,
      notes: "see you there",
      idempotencyKey: "pub-A",
      timeZone: TZ,
    });

    expect(res.status).toBe("accepted");
    const booking = await ctx.db.get(res.bookingId);
    expect(booking.status).toBe("accepted");

    // F1 confirmation fields (same as the httpAction path).
    expect(res.ics).toContain("BEGIN:VCALENDAR");
    expect(res.cancelToken).toBe(String(res.bookingId));
    expect(res.rescheduleToken).toBe(String(res.bookingId));

    // CV-3 echo fields the cal OUT adapter consumes to build BookingResponse.
    expect(res.eventTitle).toBe("Intro Call");
    expect(res.eventLocation).toBe("Coffee shop on Main St");
    expect(res.start).toBe(PUB_START);
    expect(res.end).toBe(PUB_END);
    expect(res.bookerName).toBe(ATTENDEE_BASE.name);
    expect(res.bookerEmail).toBe(ATTENDEE_BASE.email);
    expect(res.bookerTimeZone).toBe(TZ);
    expect(res.notes).toBe("see you there");
  });

  it("STILL refuses (booking_disabled) when the flag is OFF — dark before launch", async () => {
    const off = makeCtx(); // never calls enableBooking
    await seedEventType(off);
    let kind = "";
    try {
      await run(off, {
        slug: SLUG,
        start: PUB_START,
        end: PUB_END,
        ...ATTENDEE_BASE,
        idempotencyKey: "pub-dark",
        timeZone: TZ,
      });
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("booking_disabled");
    expect(await off.db.query("bookings").collect()).toHaveLength(0);
  });

  it("is idempotent on a repeat idempotencyKey (same bookingId, no duplicate)", async () => {
    await seedEventType(ctx);
    const body = {
      slug: SLUG,
      start: PUB_START,
      end: PUB_END,
      ...ATTENDEE_BASE,
      idempotencyKey: "pub-IDEM",
      timeZone: TZ,
    };
    const first = await run(ctx, body);
    const again = await run(ctx, body);
    expect(again.bookingId).toBe(first.bookingId);
    expect(again.deduplicated).toBe(true);
    expect(await ctx.db.query("bookings").collect()).toHaveLength(1);
  });

  it("throws slot_unavailable on a conflicting second create (→ cal 409)", async () => {
    await seedEventType(ctx);
    const first = await run(ctx, {
      slug: SLUG,
      start: PUB_START,
      end: PUB_END,
      ...ATTENDEE_BASE,
      idempotencyKey: "pub-c1",
      timeZone: TZ,
    });
    expect(first.status).toBe("accepted");

    let kind = "";
    try {
      await run(ctx, {
        slug: SLUG,
        start: PUB_START,
        end: PUB_END,
        name: "Other",
        email: "other@example.com",
        idempotencyKey: "pub-c2",
        timeZone: TZ,
      });
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("slot_unavailable");
    expect(await ctx.db.query("bookings").collect()).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────
// (d) booking POST creates a booking + is idempotent on repeat idempotencyKey
// ─────────────────────────────────────────────────────────────

describe("createBookingImpl — create + idempotency", () => {
  it("creates an accepted booking, returns an .ics + capability tokens", async () => {
    await seedEventType(ctx);
    const res = await createBookingImpl(
      ctx,
      {
        slug: SLUG,
        start: SLOT_START,
        end: SLOT_END,
        ...ATTENDEE_BASE,
        notes: "see you there",
        idempotencyKey: "key-A",
        timeZone: TZ,
      },
      NOW,
    );

    expect(res.status).toBe("accepted");
    const booking = await ctx.db.get(res.bookingId);
    expect(booking.status).toBe("accepted");

    // .ics is a valid single-event VCALENDAR carrying the slot times.
    expect(res.ics).toContain("BEGIN:VCALENDAR");
    expect(res.ics).toContain("BEGIN:VEVENT");
    expect(res.ics).toContain("SUMMARY:Intro Call");
    expect(res.ics).toContain("DTSTART:20260601T100000Z");
    expect(res.ics).toContain("END:VCALENDAR");

    // Capability tokens (F1: == bookingId).
    expect(res.cancelToken).toBe(String(res.bookingId));
    expect(res.rescheduleToken).toBe(String(res.bookingId));
  });

  it("is idempotent: a repeat with the SAME idempotencyKey returns the same booking, no duplicate", async () => {
    await seedEventType(ctx);
    const first = await createBookingImpl(
      ctx,
      { slug: SLUG, start: SLOT_START, end: SLOT_END, ...ATTENDEE_BASE, idempotencyKey: "key-IDEM", timeZone: TZ },
      NOW,
    );
    const again = await createBookingImpl(
      ctx,
      { slug: SLUG, start: SLOT_START, end: SLOT_END, ...ATTENDEE_BASE, idempotencyKey: "key-IDEM", timeZone: TZ },
      NOW,
    );

    expect(again.bookingId).toBe(first.bookingId);
    expect(again.deduplicated).toBe(true);

    const bookings = await ctx.db.query("bookings").collect();
    expect(bookings).toHaveLength(1);
  });

  it("rejects a malformed body (missing idempotencyKey) with invalid_request", async () => {
    await seedEventType(ctx);
    let kind = "";
    try {
      await createBookingImpl(ctx, {
        slug: SLUG,
        start: SLOT_START,
        end: SLOT_END,
        ...ATTENDEE_BASE,
        // idempotencyKey missing
      } as any);
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("invalid_request");
  });
});

// ─────────────────────────────────────────────────────────────
// (e) slot_unavailable → (handler maps to) 409
// ─────────────────────────────────────────────────────────────

describe("createBookingImpl — slot_unavailable (→ 409)", () => {
  it("a second create for the SAME slot throws slot_unavailable (handler → HTTP 409)", async () => {
    await seedEventType(ctx);
    const first = await createBookingImpl(
      ctx,
      { slug: SLUG, start: SLOT_START, end: SLOT_END, ...ATTENDEE_BASE, idempotencyKey: "k1", timeZone: TZ },
      NOW,
    );
    expect(first.status).toBe("accepted");

    let kind = "";
    let convexErr: ConvexError<any> | null = null;
    try {
      await createBookingImpl(
        ctx,
        {
          slug: SLUG,
          start: SLOT_START,
          end: SLOT_END,
          name: "Other",
          email: "other@example.com",
          idempotencyKey: "k2",
          timeZone: TZ,
        },
        NOW,
      );
    } catch (e) {
      if (e instanceof ConvexError) {
        convexErr = e;
        kind = (e.data as any)?.kind;
      }
    }
    // The handler's bookingErrorToProblem maps this kind → 409 slot_unavailable.
    expect(kind).toBe("slot_unavailable");
    expect(convexErr).not.toBeNull();

    const bookings = await ctx.db.query("bookings").collect();
    expect(bookings).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────
// (f) rate-limit blocks after the threshold
// ─────────────────────────────────────────────────────────────

describe("IP rate-limit (booking.slots / booking.create) — the helper the handler delegates to", () => {
  it("allows up to the limit then blocks; ok:false after the threshold", async () => {
    const rl = makeCtx();
    const ipHash = "deadbeef".repeat(8); // 64 hex chars
    const LIMIT = 3;
    const args = { ipHash, kind: "booking.create", windowMs: 60_000, limit: LIMIT };

    const gates = [];
    for (let i = 0; i < LIMIT; i++) {
      gates.push(await checkAndLogRateLimitByIp(rl, args));
    }
    // The first LIMIT calls are allowed.
    expect(gates.every((g) => g.ok)).toBe(true);

    // The (LIMIT+1)-th call is blocked.
    const blocked = await checkAndLogRateLimitByIp(rl, args);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.resetInMs).toBeGreaterThan(0);
    }

    // No quota slot was burned on the rejected call (still exactly LIMIT logs).
    const logs = await rl.db.query("apiCallLog").collect();
    expect(logs).toHaveLength(LIMIT);
    // Keyed under the namespaced ip: id, never a real authUserId.
    expect(logs.every((l: any) => l.authUserId === `ip:${ipHash}`)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// cancel + reschedule — token-guarded self-service
// ─────────────────────────────────────────────────────────────

describe("cancelBookingImpl — token-guarded", () => {
  it("cancels with a matching token (token == bookingId) and frees the slot", async () => {
    await seedEventType(ctx);
    const created = await createBookingImpl(
      ctx,
      { slug: SLUG, start: SLOT_START, end: SLOT_END, ...ATTENDEE_BASE, idempotencyKey: "k1", timeZone: TZ },
      NOW,
    );

    const res = await cancelBookingImpl(
      ctx,
      { bookingId: created.bookingId, cancelToken: created.cancelToken },
      NOW,
    );
    expect(res.status).toBe("cancelled");
    const row = await ctx.db.get(created.bookingId);
    expect(row.status).toBe("cancelled");
  });

  it("rejects a WRONG token as booking_not_found (no info leak)", async () => {
    await seedEventType(ctx);
    const created = await createBookingImpl(
      ctx,
      { slug: SLUG, start: SLOT_START, end: SLOT_END, ...ATTENDEE_BASE, idempotencyKey: "k1", timeZone: TZ },
      NOW,
    );
    let kind = "";
    try {
      await cancelBookingImpl(
        ctx,
        { bookingId: created.bookingId, cancelToken: "wrong-token" },
        NOW,
      );
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("booking_not_found");
    // Booking untouched.
    const row = await ctx.db.get(created.bookingId);
    expect(row.status).toBe("accepted");
  });
});

describe("rescheduleBookingImpl — token-guarded", () => {
  it("reschedules with a matching token, links old→new, returns fresh tokens", async () => {
    await seedEventType(ctx);
    const created = await createBookingImpl(
      ctx,
      { slug: SLUG, start: SLOT_START, end: SLOT_END, ...ATTENDEE_BASE, idempotencyKey: "k1", timeZone: TZ },
      NOW,
    );

    const res = await rescheduleBookingImpl(
      ctx,
      {
        bookingId: created.bookingId,
        rescheduleToken: created.rescheduleToken,
        start: SLOT2_START,
        end: SLOT2_END,
        ...ATTENDEE_BASE,
        idempotencyKey: "k-resched",
        timeZone: TZ,
      },
      NOW,
    );

    expect(res.status).toBe("accepted");
    expect(res.newBookingId).not.toBe(created.bookingId);
    const old = await ctx.db.get(created.bookingId);
    expect(old.status).toBe("rescheduled");
    expect(old.rescheduledToBookingId).toBe(res.newBookingId);
    // New capability tokens point at the new booking.
    expect(res.cancelToken).toBe(String(res.newBookingId));
  });

  it("rejects a WRONG reschedule token as booking_not_found", async () => {
    await seedEventType(ctx);
    const created = await createBookingImpl(
      ctx,
      { slug: SLUG, start: SLOT_START, end: SLOT_END, ...ATTENDEE_BASE, idempotencyKey: "k1", timeZone: TZ },
      NOW,
    );
    let kind = "";
    try {
      await rescheduleBookingImpl(
        ctx,
        {
          bookingId: created.bookingId,
          rescheduleToken: "nope",
          start: SLOT2_START,
          end: SLOT2_END,
          ...ATTENDEE_BASE,
          idempotencyKey: "k-resched",
          timeZone: TZ,
        },
        NOW,
      );
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("booking_not_found");
  });
});

// ─────────────────────────────────────────────────────────────
// parseSlotQuery + buildIcs — pure helpers
// ─────────────────────────────────────────────────────────────

describe("parseSlotQuery", () => {
  it("defaults from=now, to=now+14d, tz=UTC when unspecified", () => {
    const p = parseSlotQuery(new URLSearchParams(), NOW);
    expect(p.windowStart).toBe(NOW);
    expect(p.windowEnd).toBe(NOW + 14 * 86_400_000);
    expect(p.viewerTimeZone).toBe("UTC");
  });

  it("accepts epoch-ms and ISO strings; reads tz", () => {
    const params = new URLSearchParams();
    params.set("from", String(SLOT_START));
    params.set("to", "2026-06-02T00:00:00Z");
    params.set("tz", "America/New_York");
    const p = parseSlotQuery(params, NOW);
    expect(p.windowStart).toBe(SLOT_START);
    expect(p.windowEnd).toBe(Date.parse("2026-06-02T00:00:00Z"));
    expect(p.viewerTimeZone).toBe("America/New_York");
  });

  it("throws invalid_request on an inverted window", () => {
    const params = new URLSearchParams();
    params.set("from", String(SLOT_END));
    params.set("to", String(SLOT_START));
    let kind = "";
    try {
      parseSlotQuery(params, NOW);
    } catch (e) {
      if (e instanceof ConvexError) kind = (e.data as any)?.kind;
    }
    expect(kind).toBe("invalid_request");
  });
});

describe("buildIcs", () => {
  it("escapes commas/semicolons and emits CRLF-joined VCALENDAR", () => {
    const ics = buildIcs({
      uid: "abc@dibslist.app",
      title: "Intro; with, punctuation",
      startMs: SLOT_START,
      endMs: SLOT_END,
      location: "123 Main St, Suite 4",
    });
    expect(ics).toContain("\r\n");
    expect(ics).toContain("SUMMARY:Intro\\; with\\, punctuation");
    expect(ics).toContain("LOCATION:123 Main St\\, Suite 4");
    expect(ics.startsWith("BEGIN:VCALENDAR")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR")).toBe(true);
  });
});
