// CV-2c — Cal.com int↔string id maps for EVENT TYPES + SCHEDULES.
//
// THE PROBLEM
// ───────────
// cal.com keys event types / schedules by a Prisma INTEGER PK that is
// ROUND-TRIPPED: a GET returns the int (`data.eventType.id`, `scheduleData.id`),
// the editor stores it as a form default + a route param, and feeds the SAME int
// back into the update/delete mutation. Convex uses opaque STRING `_id`s, so the
// fork cannot recover the Convex `_id` from a fabricated int — that is the
// id-bijection blocker documented in CONVEX-REWIRE-NOTES §CV-2b.
//
// THE FIX
// ───────
// A persistent int↔string map, modeled VERBATIM on the CV-1 calcomUserMap /
// calcomSeq precedent: a monotonic counter row mints a stable integer per Convex
// `_id`, and two indexes give a bijection in both directions:
//   - by_convexId : Convex string `_id` → stable cal int  (the GET path mints/reads)
//   - by_calId    : cal int → Convex string `_id`         (the mutation path resolves)
//
// STABLE ID STRATEGY: a single-row counter per entity (`eventTypeIdSeq` /
// `scheduleIdSeq`). Convex serialises mutations per document key, so the
// read-bump-write of `nextId` inside one mutation is atomic — no SEQUENCE
// primitive. The counter NEVER decrements, so a calId is never reused even after
// the underlying event type / schedule is deleted (the map row may be cascaded on
// account purge, but the counter is not — see userDeletion.ts / _clear.ts).
//
// NO PII: these maps carry only a Convex id, an int, and the owner's authUserId
// (denormalised for owner-scoped cascade on account purge). The `*IdSeq` counters
// carry no user data and are KEPT on a dev wipe.
//
// TESTABILITY: each function's logic is exported as a bare async handler
// (`*Impl`) so calcomIdMaps.test.ts can exercise it against an in-memory fake ctx
// (repo convention — see calcomUsers.test.ts / schedules.test.ts). The registered
// mutation/query wrappers delegate to the same impls.
//
// NO AUTH GATE: identity/id infrastructure, not a user-facing surface — only ever
// called server-to-server by the fork's tRPC resolver layer AFTER it has validated
// the Better-Auth cookie and resolved ownership through the owner-scoped
// calcomAdmin reads. Mirrors resolveOrCreateCalcomUser: no requireAuthUserId, no
// booking_enabled gate (the map must resolve even while the public surface is dark).

import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

// ─────────────────────────────────────────────────────────────
// Shared return validators.
// ─────────────────────────────────────────────────────────────

const eventTypeIdMapRow = v.object({
  _id: v.id("eventTypeIdMap"),
  _creationTime: v.number(),
  convexId: v.id("eventTypes"),
  calId: v.number(),
  ownerAuthUserId: v.string(),
  createdAt: v.number(),
});

const scheduleIdMapRow = v.object({
  _id: v.id("scheduleIdMap"),
  _creationTime: v.number(),
  convexId: v.id("schedules"),
  calId: v.number(),
  ownerAuthUserId: v.string(),
  createdAt: v.number(),
});

// CV-5 — calendar credential int↔string id map row. Same shape as the others;
// `convexId` points at the `calendarCredentials` table.
const calendarCredentialIdMapRow = v.object({
  _id: v.id("calendarCredentialIdMap"),
  _creationTime: v.number(),
  convexId: v.id("calendarCredentials"),
  calId: v.number(),
  ownerAuthUserId: v.string(),
  createdAt: v.number(),
});

export interface ResolveIdResult {
  calId: number;
  // The map-row id. Typed loosely so the shared impl works for both entities;
  // the registered wrappers narrow it via their return validators.
  mapId: string;
  created: boolean;
}

// ─────────────────────────────────────────────────────────────
// Generic seq + map helpers (shared by both entities).
//
// `seqTable` / `mapTable` are passed in so we can run the IDENTICAL atomic
// read-bump-write + upsert for event types and schedules without duplicating
// the body. The Convex value validators on the registered wrappers keep the
// field types honest; here we operate on the string table names.
// ─────────────────────────────────────────────────────────────

async function nextSeqId(ctx: Ctx, seqTable: string): Promise<number> {
  // At most one row; create it on first call. Pre-increment so the NEXT caller
  // reads the already-bumped value — identical to calcomSeq.
  const seqRow = await ctx.db.query(seqTable).first();
  if (seqRow) {
    const nextId = seqRow.nextId;
    await ctx.db.patch(seqRow._id, { nextId: nextId + 1 });
    return nextId;
  }
  await ctx.db.insert(seqTable, { nextId: 2 });
  return 1;
}

async function resolveCalIdImpl(
  ctx: Ctx,
  opts: {
    mapTable: string;
    seqTable: string;
    convexId: string;
    ownerAuthUserId: string;
  },
): Promise<ResolveIdResult> {
  const existing = await ctx.db
    .query(opts.mapTable)
    .withIndex("by_convexId", (q: Ctx) => q.eq("convexId", opts.convexId))
    .unique();

  if (existing) {
    return { calId: existing.calId, mapId: existing._id, created: false };
  }

  const calId = await nextSeqId(ctx, opts.seqTable);
  const mapId = await ctx.db.insert(opts.mapTable, {
    convexId: opts.convexId,
    calId,
    ownerAuthUserId: opts.ownerAuthUserId,
    createdAt: Date.now(),
  });
  return { calId, mapId, created: true };
}

async function getByCalIdImpl(ctx: Ctx, mapTable: string, calId: number) {
  return await ctx.db
    .query(mapTable)
    .withIndex("by_calId", (q: Ctx) => q.eq("calId", calId))
    .unique();
}

async function getByConvexIdImpl(ctx: Ctx, mapTable: string, convexId: string) {
  return await ctx.db
    .query(mapTable)
    .withIndex("by_convexId", (q: Ctx) => q.eq("convexId", convexId))
    .unique();
}

// ─────────────────────────────────────────────────────────────
// EVENT TYPES
// ─────────────────────────────────────────────────────────────

export async function resolveEventTypeCalIdImpl(
  ctx: Ctx,
  convexId: Id<"eventTypes">,
  ownerAuthUserId: string,
): Promise<ResolveIdResult> {
  return resolveCalIdImpl(ctx, {
    mapTable: "eventTypeIdMap",
    seqTable: "eventTypeIdSeq",
    convexId,
    ownerAuthUserId,
  });
}

export const resolveEventTypeCalId = mutation({
  args: { convexId: v.id("eventTypes"), ownerAuthUserId: v.string() },
  returns: v.object({
    calId: v.number(),
    mapId: v.id("eventTypeIdMap"),
    created: v.boolean(),
  }),
  handler: async (ctx, { convexId, ownerAuthUserId }) => {
    const r = await resolveEventTypeCalIdImpl(ctx, convexId, ownerAuthUserId);
    return { calId: r.calId, mapId: r.mapId as Id<"eventTypeIdMap">, created: r.created };
  },
});

export async function getEventTypeByCalIdImpl(ctx: Ctx, calId: number) {
  return getByCalIdImpl(ctx, "eventTypeIdMap", calId);
}

export const getEventTypeByCalId = query({
  args: { calId: v.number() },
  returns: v.union(eventTypeIdMapRow, v.null()),
  handler: (ctx, { calId }) => getEventTypeByCalIdImpl(ctx, calId),
});

export async function getEventTypeCalIdByConvexIdImpl(
  ctx: Ctx,
  convexId: Id<"eventTypes">,
) {
  return getByConvexIdImpl(ctx, "eventTypeIdMap", convexId);
}

export const getEventTypeCalIdByConvexId = query({
  args: { convexId: v.id("eventTypes") },
  returns: v.union(eventTypeIdMapRow, v.null()),
  handler: (ctx, { convexId }) => getEventTypeCalIdByConvexIdImpl(ctx, convexId),
});

// ─────────────────────────────────────────────────────────────
// SCHEDULES
// ─────────────────────────────────────────────────────────────

export async function resolveScheduleCalIdImpl(
  ctx: Ctx,
  convexId: Id<"schedules">,
  ownerAuthUserId: string,
): Promise<ResolveIdResult> {
  return resolveCalIdImpl(ctx, {
    mapTable: "scheduleIdMap",
    seqTable: "scheduleIdSeq",
    convexId,
    ownerAuthUserId,
  });
}

export const resolveScheduleCalId = mutation({
  args: { convexId: v.id("schedules"), ownerAuthUserId: v.string() },
  returns: v.object({
    calId: v.number(),
    mapId: v.id("scheduleIdMap"),
    created: v.boolean(),
  }),
  handler: async (ctx, { convexId, ownerAuthUserId }) => {
    const r = await resolveScheduleCalIdImpl(ctx, convexId, ownerAuthUserId);
    return { calId: r.calId, mapId: r.mapId as Id<"scheduleIdMap">, created: r.created };
  },
});

export async function getScheduleByCalIdImpl(ctx: Ctx, calId: number) {
  return getByCalIdImpl(ctx, "scheduleIdMap", calId);
}

export const getScheduleByCalId = query({
  args: { calId: v.number() },
  returns: v.union(scheduleIdMapRow, v.null()),
  handler: (ctx, { calId }) => getScheduleByCalIdImpl(ctx, calId),
});

export async function getScheduleCalIdByConvexIdImpl(
  ctx: Ctx,
  convexId: Id<"schedules">,
) {
  return getByConvexIdImpl(ctx, "scheduleIdMap", convexId);
}

export const getScheduleCalIdByConvexId = query({
  args: { convexId: v.id("schedules") },
  returns: v.union(scheduleIdMapRow, v.null()),
  handler: (ctx, { convexId }) => getScheduleCalIdByConvexIdImpl(ctx, convexId),
});

// ─────────────────────────────────────────────────────────────
// CALENDAR CREDENTIALS (CV-5)
//
// WHY THIS MAP EXISTS — the calendar disconnect + conflict-toggle write paths
// round-trip an INTEGER credential id. cal's `connectedCalendars` read hands the
// UI a numeric `credentialId`; the UI feeds the SAME int back into
// `viewer.credentials.delete` ({ id }) and the `/api/availability/calendar`
// POST/DELETE ({ credentialId }). CV-2c's read used `convexIdToCalInt` (FNV-1a) for
// that int, which is DISPLAY-ONLY and NOT reversible — so a write keyed by the int
// could not recover the Convex `_id`. This map mints a STABLE, reversible integer
// per `calendarCredentials._id`, identical in every way to the eventType/schedule
// maps, giving the bijection the disconnect/conflict-toggle writes need.
//
// (set-destination is keyed by integration+externalId, not the int, so it does NOT
// use this map; schedule-delete reuses the existing scheduleIdMap.)
// ─────────────────────────────────────────────────────────────

export async function resolveCalendarCredentialCalIdImpl(
  ctx: Ctx,
  convexId: Id<"calendarCredentials">,
  ownerAuthUserId: string,
): Promise<ResolveIdResult> {
  return resolveCalIdImpl(ctx, {
    mapTable: "calendarCredentialIdMap",
    seqTable: "calendarCredentialIdSeq",
    convexId,
    ownerAuthUserId,
  });
}

export const resolveCalendarCredentialCalId = mutation({
  args: { convexId: v.id("calendarCredentials"), ownerAuthUserId: v.string() },
  returns: v.object({
    calId: v.number(),
    mapId: v.id("calendarCredentialIdMap"),
    created: v.boolean(),
  }),
  handler: async (ctx, { convexId, ownerAuthUserId }) => {
    const r = await resolveCalendarCredentialCalIdImpl(ctx, convexId, ownerAuthUserId);
    return {
      calId: r.calId,
      mapId: r.mapId as Id<"calendarCredentialIdMap">,
      created: r.created,
    };
  },
});

export async function getCalendarCredentialByCalIdImpl(ctx: Ctx, calId: number) {
  return getByCalIdImpl(ctx, "calendarCredentialIdMap", calId);
}

export const getCalendarCredentialByCalId = query({
  args: { calId: v.number() },
  returns: v.union(calendarCredentialIdMapRow, v.null()),
  handler: (ctx, { calId }) => getCalendarCredentialByCalIdImpl(ctx, calId),
});

export async function getCalendarCredentialCalIdByConvexIdImpl(
  ctx: Ctx,
  convexId: Id<"calendarCredentials">,
) {
  return getByConvexIdImpl(ctx, "calendarCredentialIdMap", convexId);
}

export const getCalendarCredentialCalIdByConvexId = query({
  args: { convexId: v.id("calendarCredentials") },
  returns: v.union(calendarCredentialIdMapRow, v.null()),
  handler: (ctx, { convexId }) =>
    getCalendarCredentialCalIdByConvexIdImpl(ctx, convexId),
});

// ─────────────────────────────────────────────────────────────
// READ-ONLY cal-id resolution + maintenance backfill
//
// The `with{Schedule,EventType}CalId` helpers run inside QUERIES. A Convex
// query has a read-only `ctx.db` (no `.patch`/`.insert`), so the old lazy
// "mint on first sight" path (resolve*CalIdImpl → nextSeqId → db.patch) THREW
// `db.patch is not a function` for any row lacking a map row — 500ing the whole
// availability list. Minting must happen only in MUTATIONS (the create/update
// paths already do) + the one-time backfill below. Queries use these read-only
// resolvers with a deterministic fallback so they can never crash.
// ─────────────────────────────────────────────────────────────

// Deterministic READ-ONLY fallback cal int for a row with no map yet (safety
// net only — real ids come from the *IdMap tables). 31-bit FNV-1a; never 0.
export function convexIdToCalIntRO(convexId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < convexId.length; i++) {
    h ^= convexId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 1) || 1;
}

// MUTATION-ONLY (writes): mint scheduleIdMap rows for any schedules missing one.
export async function backfillScheduleCalIdsImpl(ctx: Ctx): Promise<number> {
  const rows = await ctx.db.query("schedules").collect();
  let minted = 0;
  for (const s of rows) {
    const existing = await getByConvexIdImpl(ctx, "scheduleIdMap", s._id);
    if (!existing) {
      await resolveScheduleCalIdImpl(ctx, s._id, s.ownerAuthUserId);
      minted++;
    }
  }
  return minted;
}

// MUTATION-ONLY (writes): mint eventTypeIdMap rows for any event types missing one.
export async function backfillEventTypeCalIdsImpl(ctx: Ctx): Promise<number> {
  const rows = await ctx.db.query("eventTypes").collect();
  let minted = 0;
  for (const e of rows) {
    const existing = await getByConvexIdImpl(ctx, "eventTypeIdMap", e._id);
    if (!existing) {
      await resolveEventTypeCalIdImpl(ctx, e._id, e.ownerAuthUserId);
      minted++;
    }
  }
  return minted;
}
