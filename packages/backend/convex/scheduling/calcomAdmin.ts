// CV-2b — SERVER-TO-SERVER owner-admin surface for the forked cal.com app.
//
// WHY THIS EXISTS
// ───────────────
// The owner-admin Convex fns in `eventTypes.ts` / `schedules.ts`
// (`createEventType`, `listSchedules`, …) gate on `requireAuthUserId(ctx)`, which
// reads the BetterAuth identity from the Convex request context. The forked
// cal.com app reaches Convex through `getConvex()` — a `ConvexHttpClient` with NO
// identity token (the fork validates the dibslist Better-Auth COOKIE itself in
// `getServerSession`, then mints a stable integer `calId`; it never mints a
// Convex-verifiable JWT). So the fork CANNOT call the `requireAuthUserId`-gated
// fns as the user.
//
// This module is the bridge, modeled VERBATIM on the established
// `scheduling/calcomUsers:resolveOrCreateCalcomUser` precedent: a set of
// registered `query`/`mutation` fns that take an EXPLICIT `ownerAuthUserId`
// argument (the trusted dibslist authUserId string the fork already carries on
// `session.user.uuid`) and delegate to the post-auth `*Core(ctx, ownerId, args)`
// functions in eventTypes.ts / schedules.ts. The cores run IDENTICAL logic to the
// auth-gated handlers — same `booking_enabled` flag gate, same validation, same
// ownership checks, same writes — only the identity source differs.
//
// TRUST MODEL (same as resolveOrCreateCalcomUser):
//   - These fns perform NO Convex auth check. They are NOT meant to be called by
//     an end-user client. The ONLY caller is the fork's tRPC resolver layer, which
//     runs server-side AFTER `getServerSession` has validated the dibslist
//     Better-Auth cookie (fail-closed) and resolved the authUserId. The fork passes
//     that authUserId as `ownerAuthUserId`.
//   - Ownership is still enforced INSIDE the cores (`row.ownerAuthUserId ===
//     ownerId`), so even if a caller passed a different authUserId it could only act
//     on rows it already owns — there is no privilege escalation, just delegation.
//   - WRITES still hit the DEFAULT-OFF `booking_enabled` flag gate via the cores'
//     `gateBooking`, so this whole write surface stays dark until launch.
//
// NETWORK EXPOSURE: like `resolveOrCreateCalcomUser`, these are registered public
// functions (reachable by the Convex client API). That is acceptable because (a)
// reads are owner-scoped by the explicit arg and leak nothing cross-owner, and (b)
// writes are flag-gated off. A future hardening step (out of scope for CV-2b)
// could add a shared-secret arg, mirroring any future hardening of
// resolveOrCreateCalcomUser. See CONVEX-REWIRE-NOTES.md.

import { v, ConvexError } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import {
  createEventTypeCore,
  updateEventTypeCore,
  listEventTypesCore,
  getEventTypeCore,
  getEventTypeBySlugCore,
  setEventTypeHostsCore,
  listEventTypeHostsCore,
  duplicateEventTypeCore,
  type EventTypeHostInput,
} from "./eventTypes";
import {
  createScheduleCore,
  updateScheduleCore,
  listSchedulesCore,
  getScheduleCore,
  setAvailabilityCore,
  addDateOverrideCore,
  removeDateOverrideCore,
  deleteScheduleCore,
  duplicateScheduleCore,
  bulkUpdateToDefaultAvailabilityCore,
} from "./schedules";
import {
  resolveEventTypeCalIdImpl,
  getEventTypeByCalIdImpl,
  getEventTypeCalIdByConvexIdImpl,
  resolveScheduleCalIdImpl,
  getScheduleByCalIdImpl,
  getScheduleCalIdByConvexIdImpl,
  resolveCalendarCredentialCalIdImpl,
  getCalendarCredentialByCalIdImpl,
  convexIdToCalIntRO,
  backfillScheduleCalIdsImpl,
  backfillEventTypeCalIdsImpl,
} from "./calcomIdMaps";
import {
  getCalcomUserByCalIdImpl,
  getCalcomUserByAuthUserIdImpl,
  getCalcomUserByEmailImpl,
  updateCalcomUserPrefsImpl,
} from "./calcomUsers";
import {
  listConnectedCalendarsCore,
  setCalendarConflictFlagCore,
  setDestinationCalendarCore,
  disconnectCalendarCore,
} from "./calendarOauth";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

const schedulingType = v.union(
  v.literal("collective"),
  v.literal("round_robin"),
  v.literal("managed"),
);

// ─────────────────────────────────────────────────────────────
// CV-2c — cal-int-id resolution helpers.
//
// The fork rounds an INTEGER id back into update/delete/setAvailability (cal's
// Prisma-Int contract). These helpers turn that int into the Convex string `_id`
// via the id-map (calcomIdMaps.ts) so the existing cores keep taking real Convex
// ids. Each admin fn now accepts EITHER the Convex string `id` (callers that
// already hold it) OR the cal `calId` int (the editor round-trip) — never both.
//
// Reads/creates ENRICH their result with the row's stable calId (minting it on
// first sight) so the fork gets the round-trippable int without a second call.
// ─────────────────────────────────────────────────────────────

async function resolveEventTypeConvexId(
  ctx: Ctx,
  id: Id<"eventTypes"> | undefined,
  calId: number | undefined,
): Promise<Id<"eventTypes">> {
  if (id) return id;
  if (calId === undefined) {
    throw new ConvexError("Either id or calEventTypeId is required.");
  }
  const map = await getEventTypeByCalIdImpl(ctx, calId);
  if (!map) throw new ConvexError("Not found.");
  return map.convexId as Id<"eventTypes">;
}

async function resolveScheduleConvexId(
  ctx: Ctx,
  id: Id<"schedules"> | undefined,
  calId: number | undefined,
): Promise<Id<"schedules">> {
  if (id) return id;
  if (calId === undefined) {
    throw new ConvexError("Either id or calScheduleId is required.");
  }
  const map = await getScheduleByCalIdImpl(ctx, calId);
  if (!map) throw new ConvexError("Not found.");
  return map.convexId as Id<"schedules">;
}

// CV-5 — resolve the Convex calendarCredentials `_id` from EITHER the string id
// (callers that hold it) OR the round-tripped cal int credential id (the
// disconnect / conflict-toggle UI only holds the int). Never both.
async function resolveCalendarCredentialConvexId(
  ctx: Ctx,
  id: Id<"calendarCredentials"> | undefined,
  calId: number | undefined,
): Promise<Id<"calendarCredentials">> {
  if (id) return id;
  if (calId === undefined) {
    throw new ConvexError("Either credentialId or calCredentialId is required.");
  }
  const map = await getCalendarCredentialByCalIdImpl(ctx, calId);
  if (!map) throw new ConvexError("Not found.");
  return map.convexId as Id<"calendarCredentials">;
}

// Attach the stable calId to an event-type row. READ-ONLY: these run inside
// QUERIES (adminListEventTypes/adminGetEventType), so they must NOT mint —
// a Convex query's ctx.db has no .patch/.insert, and the old resolve*CalIdImpl
// path (nextSeqId → db.patch) threw "db.patch is not a function" for any
// unmapped row. Minting happens in the create/update mutations + backfillCalIdMaps;
// here we read the existing map with a deterministic fallback so the query never crashes.
async function withEventTypeCalId(
  ctx: Ctx,
  _ownerAuthUserId: string,
  row: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
  if (!row) return null;
  const map = await getEventTypeCalIdByConvexIdImpl(ctx, row._id as Id<"eventTypes">);
  const calId = map ? map.calId : convexIdToCalIntRO(row._id as string);
  return { ...row, calId };
}

// Attach the stable calId to a schedule row. READ-ONLY (see withEventTypeCalId).
async function withScheduleCalId(
  ctx: Ctx,
  _ownerAuthUserId: string,
  row: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
  if (!row) return null;
  const map = await getScheduleCalIdByConvexIdImpl(ctx, row._id as Id<"schedules">);
  const calId = map ? map.calId : convexIdToCalIntRO(row._id as string);
  return { ...row, calId };
}

// MAINTENANCE (mutation): mint *IdMap rows for any pre-existing schedules /
// event types that lack one, so the read-only queries above always find a real
// map (the FNV fallback is then only a never-hit safety net). Run once via
// `npx convex run scheduling/calcomAdmin:backfillCalIdMaps`.
export const backfillCalIdMaps = mutation({
  args: {},
  handler: async (ctx) => ({
    schedules: await backfillScheduleCalIdsImpl(ctx),
    eventTypes: await backfillEventTypeCalIdsImpl(ctx),
  }),
});

// ─────────────────────────────────────────────────────────────
// EVENT TYPES (s2s)
// ─────────────────────────────────────────────────────────────

export const adminCreateEventType = mutation({
  args: {
    ownerAuthUserId: v.string(),
    slug: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    durationMinutes: v.number(),
    schedulingType,
    scheduleId: v.optional(v.id("schedules")),
    // CV-2c: a schedule can also be pinned by its round-tripped cal int id.
    calScheduleId: v.optional(v.number()),
    slotIntervalMinutes: v.optional(v.number()),
    minimumBookingNoticeMinutes: v.number(),
    bufferBeforeMinutes: v.number(),
    bufferAfterMinutes: v.number(),
    bookingWindowDays: v.optional(v.number()),
    dailyBookingLimit: v.optional(v.number()),
    requireEmailVerification: v.boolean(),
    hidden: v.boolean(),
    locationText: v.optional(v.string()),
    active: v.boolean(),
  },
  // Returns the created event type's stable cal int id so the fork can round-trip it.
  handler: async (ctx, { ownerAuthUserId, calScheduleId, scheduleId, ...rest }) => {
    const resolvedScheduleId =
      scheduleId ?? (calScheduleId !== undefined
        ? await resolveScheduleConvexId(ctx, undefined, calScheduleId)
        : undefined);
    const newId = await createEventTypeCore(ctx, ownerAuthUserId, {
      ...rest,
      scheduleId: resolvedScheduleId,
    });
    const { calId } = await resolveEventTypeCalIdImpl(ctx, newId, ownerAuthUserId);
    return { _id: newId, calId };
  },
});

export const adminUpdateEventType = mutation({
  args: {
    ownerAuthUserId: v.string(),
    // Accept EITHER the Convex string id OR the round-tripped cal int id.
    id: v.optional(v.id("eventTypes")),
    calEventTypeId: v.optional(v.number()),
    slug: v.optional(v.string()),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    durationMinutes: v.optional(v.number()),
    schedulingType: v.optional(schedulingType),
    scheduleId: v.optional(v.id("schedules")),
    calScheduleId: v.optional(v.number()),
    slotIntervalMinutes: v.optional(v.number()),
    minimumBookingNoticeMinutes: v.optional(v.number()),
    bufferBeforeMinutes: v.optional(v.number()),
    bufferAfterMinutes: v.optional(v.number()),
    bookingWindowDays: v.optional(v.number()),
    dailyBookingLimit: v.optional(v.number()),
    requireEmailVerification: v.optional(v.boolean()),
    hidden: v.optional(v.boolean()),
    locationText: v.optional(v.string()),
    active: v.optional(v.boolean()),
    // BOOKING-LOTTERY §6 — the "???" interaction mode ("none" clears it) +
    // the entries-close lead. Carried via ...rest into updateEventTypeCore.
    interactionMode: v.optional(
      v.union(
        v.literal("lottery"),
        v.literal("first_come"),
        v.literal("application"),
        v.literal("threshold"),
        v.literal("pair"),
        v.literal("none"),
      ),
    ),
    lotteryCloseLeadMinutes: v.optional(v.number()),
    thresholdMinAttendees: v.optional(v.number()),
    seatsPerSlot: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { ownerAuthUserId, id, calEventTypeId, scheduleId, calScheduleId, ...rest },
  ) => {
    const convexId = await resolveEventTypeConvexId(ctx, id, calEventTypeId);
    const resolvedScheduleId =
      scheduleId ?? (calScheduleId !== undefined
        ? await resolveScheduleConvexId(ctx, undefined, calScheduleId)
        : undefined);
    return updateEventTypeCore(ctx, ownerAuthUserId, {
      id: convexId,
      ...rest,
      scheduleId: resolvedScheduleId,
    });
  },
});

export const adminDeleteEventType = mutation({
  args: {
    ownerAuthUserId: v.string(),
    id: v.optional(v.id("eventTypes")),
    calEventTypeId: v.optional(v.number()),
  },
  // Soft-delete = set active:false (cal's editor "delete" hides the event type;
  // our eventTypes core has no hard-delete, mirroring the cal cores' surface).
  handler: async (ctx, { ownerAuthUserId, id, calEventTypeId }) => {
    const convexId = await resolveEventTypeConvexId(ctx, id, calEventTypeId);
    await updateEventTypeCore(ctx, ownerAuthUserId, { id: convexId, active: false });
    return { calId: calEventTypeId ?? null };
  },
});

export const adminListEventTypes = query({
  args: { ownerAuthUserId: v.string(), activeOnly: v.optional(v.boolean()) },
  handler: async (ctx, { ownerAuthUserId, activeOnly }) => {
    const rows = await listEventTypesCore(ctx, ownerAuthUserId, { activeOnly });
    // Enrich with each row's stable cal int id (minting on first sight) so the
    // fork can map ids in BOTH directions from the list response.
    return Promise.all(rows.map((r) => withEventTypeCalId(ctx, ownerAuthUserId, r)));
  },
});

export const adminGetEventType = query({
  args: {
    ownerAuthUserId: v.string(),
    id: v.optional(v.id("eventTypes")),
    calEventTypeId: v.optional(v.number()),
  },
  handler: async (ctx, { ownerAuthUserId, id, calEventTypeId }) => {
    const convexId = await resolveEventTypeConvexId(ctx, id, calEventTypeId);
    const row = await getEventTypeCore(ctx, ownerAuthUserId, { id: convexId });
    return withEventTypeCalId(ctx, ownerAuthUserId, row);
  },
});

export const adminGetEventTypeBySlug = query({
  args: { ownerAuthUserId: v.string(), slug: v.string() },
  handler: async (ctx, { ownerAuthUserId, slug }) => {
    const row = await getEventTypeBySlugCore(ctx, ownerAuthUserId, { slug });
    return withEventTypeCalId(ctx, ownerAuthUserId, row);
  },
});

// ─────────────────────────────────────────────────────────────
// CV-9 — LIGHTWEIGHT EVENT-TYPE OWNERSHIP CHECK (s2s) — THE CHOKEPOINT BACKING
//
// The fork's `createEventPbacProcedure` tRPC middleware (the gate on the entire
// event-type editor lifecycle: get/update/delete/duplicate + the host
// sub-queries) USED to do an UNCONDITIONAL `ctx.prisma.eventType.findUnique`
// before its ownership check — which throws on the no-Postgres fork, 500ing the
// whole editor before the already-Convex-rewired handler bodies run. CV-9 rewires
// that middleware to call THIS query instead.
//
// It answers exactly the question the personal-owner middleware needs: "does
// `ownerAuthUserId` own the event type addressed by this cal int?" — with a SINGLE
// id-map read (the map row already denormalises `ownerAuthUserId`, so no second
// `eventTypes` fetch is needed). Returns `{ found, owned }`:
//   - found:false            → the cal int maps to no event type      → middleware throws NOT_FOUND
//   - found:true, owned:false → maps to a row owned by someone else    → middleware throws FORBIDDEN
//   - found:true, owned:true  → the caller owns it                     → middleware proceeds
//
// This PRESERVES the original owner-only semantics (cal's personal-event branch
// authorised iff `event.userId === ctx.user.id`): an owner-scoped Convex row is
// the owner's by construction, so `ownerAuthUserId === map.ownerAuthUserId` is the
// faithful equivalent. dibslist has NO team/PBAC model, so the dead team branch is
// dropped. Owner-scoped + leaks nothing cross-owner; no `booking_enabled` gate
// (the editor must gate while the public surface is dark, exactly like the rest of
// this read surface). The fork additionally keeps the pure in-memory
// `input.users.every(u => u === ctx.user.id)` assignment guard (no DB).
export const adminCheckEventTypeOwner = query({
  args: { ownerAuthUserId: v.string(), calEventTypeId: v.number() },
  returns: v.object({ found: v.boolean(), owned: v.boolean() }),
  handler: async (ctx, { ownerAuthUserId, calEventTypeId }) => {
    const map = await getEventTypeByCalIdImpl(ctx, calEventTypeId);
    if (!map) return { found: false, owned: false };
    return { found: true, owned: map.ownerAuthUserId === ownerAuthUserId };
  },
});

// ─────────────────────────────────────────────────────────────
// CV-6 — HOST / CO-HOST ASSIGNMENT (s2s) — THE HEADLINE
//
// The editor's host picker round-trips each co-host as a cal USER int
// (`userId`) and each per-host schedule as a cal SCHEDULE int (`scheduleId`).
// Neither rides the eventType/schedule id-maps — host identities live in the
// `calcomUserMap` (CV-1). This wrapper reverse-resolves:
//   - calHostUserId (cal user int) → dibslist authUserId via getCalcomUserByCalId
//   - calScheduleId (cal schedule int) → Convex schedules `_id` via the id-map
// then delegates to setEventTypeHostsCore (which owner-rechecks + forces isFixed
// for collective). A cal user int with no map row is SKIPPED (can't assign a host
// we've never minted a calId for) rather than throwing — the editor only ever
// passes ids it received from a prior read, so this is defensive.
// ─────────────────────────────────────────────────────────────

const adminHostInput = v.object({
  // The co-host's cal USER int (from calcomUserMap). Reverse-resolved to authUserId.
  calHostUserId: v.number(),
  isFixed: v.optional(v.boolean()),
  groupId: v.optional(v.string()),
  priority: v.optional(v.number()),
  weight: v.optional(v.number()),
  // This host's per-event schedule, as a cal SCHEDULE int (optional).
  calScheduleId: v.optional(v.number()),
});

export const adminSetEventTypeHosts = mutation({
  args: {
    ownerAuthUserId: v.string(),
    id: v.optional(v.id("eventTypes")),
    calEventTypeId: v.optional(v.number()),
    hosts: v.array(adminHostInput),
  },
  handler: async (ctx, { ownerAuthUserId, id, calEventTypeId, hosts }) => {
    const convexId = await resolveEventTypeConvexId(ctx, id, calEventTypeId);

    const resolved: EventTypeHostInput[] = [];
    for (const h of hosts) {
      const userMap = await getCalcomUserByCalIdImpl(ctx, h.calHostUserId);
      // Unknown cal user int → skip (defensive; the editor only passes minted ids).
      if (!userMap) continue;
      let scheduleId: Id<"schedules"> | undefined;
      if (h.calScheduleId !== undefined) {
        const schedMap = await getScheduleByCalIdImpl(ctx, h.calScheduleId);
        scheduleId = schedMap?.convexId as Id<"schedules"> | undefined;
      }
      resolved.push({
        hostAuthUserId: userMap.authUserId as string,
        isFixed: h.isFixed,
        groupId: h.groupId,
        priority: h.priority,
        weight: h.weight,
        scheduleId,
      });
    }

    return setEventTypeHostsCore(ctx, ownerAuthUserId, {
      eventTypeId: convexId,
      hosts: resolved,
    });
  },
});

// CV-6 — READ the event type's host roster, enriched with each host's cal USER
// int (minting on first sight via the calcomUserMap is NOT done here — the map
// is minted by resolveOrCreateCalcomUser; we only READ it) + each host's cal
// SCHEDULE int. A host whose authUserId has no calcomUserMap row yet is returned
// with `calHostUserId: null` (the editor will have minted it for any real co-host).
export const adminListEventTypeHosts = query({
  args: {
    ownerAuthUserId: v.string(),
    id: v.optional(v.id("eventTypes")),
    calEventTypeId: v.optional(v.number()),
  },
  handler: async (ctx, { ownerAuthUserId, id, calEventTypeId }) => {
    const convexId = await resolveEventTypeConvexId(ctx, id, calEventTypeId);
    const rows = await listEventTypeHostsCore(ctx, ownerAuthUserId, {
      eventTypeId: convexId,
    });
    return Promise.all(
      rows.map(async (row) => {
        const r = row as Record<string, unknown>;
        const userMap = await getCalcomUserByAuthUserIdImpl(
          ctx,
          r.hostAuthUserId as string,
        );
        let calScheduleId: number | null = null;
        if (r.scheduleId) {
          const schedMap = await getScheduleCalIdByConvexIdImpl(
            ctx,
            r.scheduleId as Id<"schedules">,
          );
          calScheduleId = schedMap?.calId ?? null;
        }
        return {
          ...r,
          calHostUserId: userMap?.calId ?? null,
          calScheduleId,
        };
      }),
    );
  },
});

// ─────────────────────────────────────────────────────────────
// CV-7 — RESOLVE A CO-HOST BY DIBSLIST EMAIL (s2s) — THE HEADLINE UI BACKING
//
// dibslist has NO team concept. The owner adds a co-host by typing their
// dibslist EMAIL into the event-type editor's co-host picker. This query is the
// resolution seam the fork's tRPC procedure calls (via getConvex()):
//
//   email → (a) a calcomUserMap row (the person has signed into booking + been
//               minted a stable cal int) ⇒ status "assignable", calUserId set.
//               The picker emits this int into the form hosts[] field.
//           (b) NO map row, but a Better-Auth user with that email exists
//               (a real dibslist user who simply hasn't touched booking yet) ⇒
//               status "needs_signin", calUserId null. The picker shows a clear
//               "ask them to sign into booking + connect a calendar" state and
//               does NOT add them (an unminted int would be silently dropped by
//               adminSetEventTypeHosts at the calcomUserMap reverse-resolve).
//           (c) no Better-Auth user at all ⇒ found:false (status "not_found").
//
// OWNER-SCOPED: takes the trusted `ownerAuthUserId` the fork carries on
// `session.user.uuid` (same trust model as the rest of this s2s surface). The
// owner cannot add THEMSELVES as a co-host (the form already lists the owner as
// the implicit host); resolving the owner's own email returns status
// "self" so the UI can reject it cleanly.
//
// PRIVACY: this is a READ that reveals whether a given email maps to a dibslist
// account (existence oracle). That is acceptable here for the same reason the
// rest of calcomUsers/* deliberately does not gate on `booking_enabled`: it is
// identity infra reached only server-to-server AFTER the fork has validated the
// owner's Better-Auth cookie, and it returns nothing beyond name/avatar that the
// owner could not already see by inviting that person. It does NOT gate on the
// booking flag (the picker must resolve while the public surface is dark), but
// the WRITE it feeds (adminSetEventTypeHosts) is still flag-gated off.
//
// Better-Auth lookup mirrors adminUsers.findUserByEmail but with operator "eq"
// (exact) + no admin gate, since the caller is the authed owner, not an operator.
// ─────────────────────────────────────────────────────────────

export type ResolveCoHostStatus =
  | "assignable" // has a calcomUserMap row → calUserId set, ready for hosts[]
  | "needs_signin" // dibslist account exists but no booking mint yet → calUserId null
  | "self" // resolves to the owner themselves → can't co-host yourself
  | "not_found"; // no dibslist account with that email

export interface ResolveCoHostResult {
  found: boolean;
  status: ResolveCoHostStatus;
  calUserId: number | null;
  authUserId: string | null;
  name: string | null;
  email: string | null;
  avatar: string | null;
}

export async function resolveCoHostByEmailImpl(
  ctx: Ctx,
  ownerAuthUserId: string,
  rawEmail: string,
): Promise<ResolveCoHostResult> {
  const email = (rawEmail ?? "").trim().toLowerCase();
  const empty: ResolveCoHostResult = {
    found: false,
    status: "not_found",
    calUserId: null,
    authUserId: null,
    name: null,
    email: null,
    avatar: null,
  };
  if (!email) return empty;

  // (1) Fast path — already minted into calcomUserMap (has signed into booking).
  const mapped = await getCalcomUserByEmailImpl(ctx, email);
  if (mapped) {
    const isSelf = mapped.authUserId === ownerAuthUserId;
    return {
      found: true,
      status: isSelf ? "self" : "assignable",
      calUserId: mapped.calId,
      authUserId: mapped.authUserId,
      name: mapped.name ?? null,
      email: mapped.email ?? email,
      avatar: mapped.avatarUrl ?? null,
    };
  }

  // (2) Standalone deployment: there is no user directory beyond calcomUserMap,
  // so an unknown email cannot be resolved to an account.
  return empty;
}

export const resolveCoHostByEmail = query({
  args: { ownerAuthUserId: v.string(), email: v.string() },
  returns: v.object({
    found: v.boolean(),
    status: v.union(
      v.literal("assignable"),
      v.literal("needs_signin"),
      v.literal("self"),
      v.literal("not_found"),
    ),
    calUserId: v.union(v.number(), v.null()),
    authUserId: v.union(v.string(), v.null()),
    name: v.union(v.string(), v.null()),
    email: v.union(v.string(), v.null()),
    avatar: v.union(v.string(), v.null()),
  }),
  handler: (ctx, { ownerAuthUserId, email }) =>
    resolveCoHostByEmailImpl(ctx, ownerAuthUserId, email),
});

// ─────────────────────────────────────────────────────────────
// SCHEDULES / AVAILABILITY (s2s)
// ─────────────────────────────────────────────────────────────

export const adminCreateSchedule = mutation({
  args: {
    ownerAuthUserId: v.string(),
    name: v.string(),
    timeZone: v.string(),
    isDefault: v.boolean(),
  },
  // Returns the created schedule's stable cal int id so the fork can round-trip it.
  handler: async (ctx, { ownerAuthUserId, name, timeZone, isDefault }) => {
    const newId = await createScheduleCore(ctx, ownerAuthUserId, {
      name,
      timeZone,
      isDefault,
    });
    const { calId } = await resolveScheduleCalIdImpl(ctx, newId, ownerAuthUserId);
    return { _id: newId, calId };
  },
});

export const adminUpdateSchedule = mutation({
  args: {
    ownerAuthUserId: v.string(),
    id: v.optional(v.id("schedules")),
    calScheduleId: v.optional(v.number()),
    name: v.optional(v.string()),
    timeZone: v.optional(v.string()),
    isDefault: v.optional(v.boolean()),
  },
  handler: async (ctx, { ownerAuthUserId, id, calScheduleId, ...args }) => {
    const convexId = await resolveScheduleConvexId(ctx, id, calScheduleId);
    return updateScheduleCore(ctx, ownerAuthUserId, { id: convexId, ...args });
  },
});

export const adminListSchedules = query({
  args: { ownerAuthUserId: v.string() },
  handler: async (ctx, { ownerAuthUserId }) => {
    const rows = await listSchedulesCore(ctx, ownerAuthUserId);
    return Promise.all(rows.map((r) => withScheduleCalId(ctx, ownerAuthUserId, r)));
  },
});

export const adminGetSchedule = query({
  args: {
    ownerAuthUserId: v.string(),
    id: v.optional(v.id("schedules")),
    calScheduleId: v.optional(v.number()),
  },
  handler: async (ctx, { ownerAuthUserId, id, calScheduleId }) => {
    const convexId = await resolveScheduleConvexId(ctx, id, calScheduleId);
    const row = await getScheduleCore(ctx, ownerAuthUserId, { id: convexId });
    return withScheduleCalId(ctx, ownerAuthUserId, row);
  },
});

export const adminSetAvailability = mutation({
  args: {
    ownerAuthUserId: v.string(),
    scheduleId: v.optional(v.id("schedules")),
    calScheduleId: v.optional(v.number()),
    windows: v.array(
      v.object({
        days: v.array(v.number()),
        startMinute: v.number(),
        endMinute: v.number(),
      }),
    ),
  },
  handler: async (ctx, { ownerAuthUserId, scheduleId, calScheduleId, windows }) => {
    const convexId = await resolveScheduleConvexId(ctx, scheduleId, calScheduleId);
    return setAvailabilityCore(ctx, ownerAuthUserId, { scheduleId: convexId, windows });
  },
});

export const adminAddDateOverride = mutation({
  args: {
    ownerAuthUserId: v.string(),
    scheduleId: v.optional(v.id("schedules")),
    calScheduleId: v.optional(v.number()),
    dateUtc: v.number(),
    startMinute: v.optional(v.number()),
    endMinute: v.optional(v.number()),
  },
  handler: async (ctx, { ownerAuthUserId, scheduleId, calScheduleId, ...args }) => {
    const convexId = await resolveScheduleConvexId(ctx, scheduleId, calScheduleId);
    return addDateOverrideCore(ctx, ownerAuthUserId, { scheduleId: convexId, ...args });
  },
});

export const adminRemoveDateOverride = mutation({
  args: { ownerAuthUserId: v.string(), id: v.id("dateOverrides") },
  handler: async (ctx, { ownerAuthUserId, id }) =>
    removeDateOverrideCore(ctx, ownerAuthUserId, { id }),
});

// CV-5 — schedule DELETE. Accepts EITHER the Convex string id or the round-tripped
// cal int. The core enforces ownership + the at-least-one / default-reassign guard.
export const adminDeleteSchedule = mutation({
  args: {
    ownerAuthUserId: v.string(),
    id: v.optional(v.id("schedules")),
    calScheduleId: v.optional(v.number()),
  },
  handler: async (ctx, { ownerAuthUserId, id, calScheduleId }) => {
    const convexId = await resolveScheduleConvexId(ctx, id, calScheduleId);
    await deleteScheduleCore(ctx, ownerAuthUserId, { id: convexId });
    return { ok: true as const };
  },
});

// ─────────────────────────────────────────────────────────────
// CONNECTED CALENDARS (s2s) — CV-2c
// ─────────────────────────────────────────────────────────────

// Owner's connected calendar credentials + their selected sub-calendars. Read
// only, owner-scoped by the explicit arg (leaks nothing cross-owner). The fork's
// connectedCalendars resolver maps this to cal's CalendarManager wire shape.
export const adminListConnectedCalendars = query({
  args: { ownerAuthUserId: v.string() },
  handler: async (ctx, { ownerAuthUserId }) =>
    listConnectedCalendarsCore(ctx, ownerAuthUserId),
});

// CV-5 — mint/resolve the STABLE, round-trippable cal int for EACH of the owner's
// calendar credentials. The connectedCalendars READ (a query) can't write, so the
// fork resolver calls this MUTATION first to get `[{ credentialId, calId }]`, then
// the pure `mapConvexConnectedCalendars` uses the persistent int as the UI's
// numeric `credentialId` (instead of the non-reversible FNV-1a hash). That int is
// what the disconnect / conflict-toggle writes round-trip back. Idempotent (mints
// only on first sight; repeat calls are cheap reads). Owner-scoped by the explicit
// arg; the map carries no PII and leaks nothing cross-owner.
export const adminResolveCredentialCalIds = mutation({
  args: { ownerAuthUserId: v.string() },
  returns: v.array(
    v.object({ credentialId: v.id("calendarCredentials"), calId: v.number() }),
  ),
  handler: async (ctx, { ownerAuthUserId }) => {
    const creds = await ctx.db
      .query("calendarCredentials")
      .withIndex("by_authUserId", (q: Ctx) => q.eq("authUserId", ownerAuthUserId))
      .collect();
    const out: Array<{ credentialId: Id<"calendarCredentials">; calId: number }> = [];
    for (const cred of creds) {
      const { calId } = await resolveCalendarCredentialCalIdImpl(
        ctx,
        cred._id as Id<"calendarCredentials">,
        ownerAuthUserId,
      );
      out.push({ credentialId: cred._id as Id<"calendarCredentials">, calId });
    }
    return out;
  },
});

// CV-5 — conflict-toggle (selected-calendar busy/conflict). The UI rounds back the
// cal int `credentialId` + the externalCalendarId string. cal's POST = select
// (checkForConflicts:true), DELETE = deselect (checkForConflicts:false). We resolve
// the int → Convex `_id`, then flip the flag via the owner-rechecked core.
export const adminSetCalendarConflictFlag = mutation({
  args: {
    ownerAuthUserId: v.string(),
    credentialId: v.optional(v.id("calendarCredentials")),
    calCredentialId: v.optional(v.number()),
    externalCalendarId: v.string(),
    checkForConflicts: v.boolean(),
  },
  handler: async (
    ctx,
    { ownerAuthUserId, credentialId, calCredentialId, externalCalendarId, checkForConflicts },
  ) => {
    const convexId = await resolveCalendarCredentialConvexId(
      ctx,
      credentialId,
      calCredentialId,
    );
    return setCalendarConflictFlagCore(ctx, ownerAuthUserId, {
      credentialId: convexId,
      externalCalendarId,
      checkForConflicts,
    });
  },
});

// CV-5 — set-destination. Keyed by (provider, externalCalendarId) strings — cal's
// `setDestinationCalendar` carries NO credential int, so no id-map resolution here.
export const adminSetDestinationCalendar = mutation({
  args: {
    ownerAuthUserId: v.string(),
    provider: v.optional(v.union(v.literal("google"), v.literal("caldav"))),
    externalCalendarId: v.string(),
  },
  handler: async (ctx, { ownerAuthUserId, provider, externalCalendarId }) =>
    setDestinationCalendarCore(ctx, ownerAuthUserId, { provider, externalCalendarId }),
});

// CV-5 — disconnect / delete-credential. The UI rounds back ONLY the bare cal int
// credential id (no externalId fallback), so this genuinely needs the id-map.
export const adminDisconnectCalendar = mutation({
  args: {
    ownerAuthUserId: v.string(),
    credentialId: v.optional(v.id("calendarCredentials")),
    calCredentialId: v.optional(v.number()),
  },
  handler: async (ctx, { ownerAuthUserId, credentialId, calCredentialId }) => {
    const convexId = await resolveCalendarCredentialConvexId(
      ctx,
      credentialId,
      calCredentialId,
    );
    return disconnectCalendarCore(ctx, ownerAuthUserId, { credentialId: convexId });
  },
});

// ─────────────────────────────────────────────────────────────
// CV-8 — RESIDUAL DATA-LAYER CLEANUP (s2s)
//
// The last reachable throwing WRITE paths the fork left on Prisma:
//   - eventTypesHeavy.duplicate            → adminDuplicateEventType
//   - availability.schedule.duplicate      → adminDuplicateSchedule
//   - availability.bulkUpdateToDefault…    → adminBulkUpdateToDefaultAvailability
//   - me.updateProfile (booking-prefs)     → adminUpdateCalcomUserPrefs
// All take the trusted `ownerAuthUserId`, accept the round-tripped cal ints, and
// resolve them to Convex `_id`s via the existing id-maps. Reads/creates ENRICH
// their result with the new row's stable cal int so the fork can round-trip it.
// ─────────────────────────────────────────────────────────────

// DUPLICATE an event type (owner clicks "Duplicate"). Source addressed by the cal
// int (or string id); the clone copies the in-scope template fields + the co-host
// roster. Returns the clone's NEW stable cal int + its final (uniquified) slug.
export const adminDuplicateEventType = mutation({
  args: {
    ownerAuthUserId: v.string(),
    id: v.optional(v.id("eventTypes")),
    calEventTypeId: v.optional(v.number()),
    slug: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    durationMinutes: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { ownerAuthUserId, id, calEventTypeId, slug, title, description, durationMinutes },
  ) => {
    const convexId = await resolveEventTypeConvexId(ctx, id, calEventTypeId);
    const { id: newId, slug: finalSlug } = await duplicateEventTypeCore(
      ctx,
      ownerAuthUserId,
      { id: convexId, slug, title, description, durationMinutes },
    );
    const { calId } = await resolveEventTypeCalIdImpl(ctx, newId, ownerAuthUserId);
    return { _id: newId, calId, slug: finalSlug };
  },
});

// DUPLICATE a schedule (owner clicks "Duplicate" in the availability list). Source
// addressed by the cal int (or string id); the clone copies availability +
// dateOverrides under a "<name> (Copy)" name, forced non-default. Returns the
// clone's NEW stable cal int + its name.
export const adminDuplicateSchedule = mutation({
  args: {
    ownerAuthUserId: v.string(),
    id: v.optional(v.id("schedules")),
    calScheduleId: v.optional(v.number()),
  },
  handler: async (ctx, { ownerAuthUserId, id, calScheduleId }) => {
    const convexId = await resolveScheduleConvexId(ctx, id, calScheduleId);
    const { id: newId, name } = await duplicateScheduleCore(ctx, ownerAuthUserId, {
      id: convexId,
    });
    const { calId } = await resolveScheduleCalIdImpl(ctx, newId, ownerAuthUserId);
    return { _id: newId, calId, name };
  },
});

// BULK-REPOINT event types onto the default schedule (owner sets a schedule as
// default). `calEventTypeIds` are the round-tripped cal ints to repoint; the
// optional default is given as a cal int. Any cal int with no map row is skipped
// (defensive). Returns `{ count }` to match cal's BatchPayload.
export const adminBulkUpdateToDefaultAvailability = mutation({
  args: {
    ownerAuthUserId: v.string(),
    calEventTypeIds: v.array(v.number()),
    calSelectedDefaultScheduleId: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { ownerAuthUserId, calEventTypeIds, calSelectedDefaultScheduleId },
  ) => {
    // Resolve each cal event-type int → Convex `_id` (skip unknown ints).
    const eventTypeIds: Id<"eventTypes">[] = [];
    for (const calId of calEventTypeIds) {
      const map = await getEventTypeByCalIdImpl(ctx, calId);
      if (map) eventTypeIds.push(map.convexId as Id<"eventTypes">);
    }
    // Resolve the optional selected-default cal int → Convex `_id`.
    let selectedDefaultScheduleId: Id<"schedules"> | undefined;
    if (calSelectedDefaultScheduleId !== undefined) {
      const sMap = await getScheduleByCalIdImpl(ctx, calSelectedDefaultScheduleId);
      selectedDefaultScheduleId = sMap?.convexId as Id<"schedules"> | undefined;
    }
    return bulkUpdateToDefaultAvailabilityCore(ctx, ownerAuthUserId, {
      eventTypeIds,
      selectedDefaultScheduleId,
    });
  },
});

// UPDATE the owner's booking PREFS (the cal me.updateProfile save subset). Only
// timeZone / weekStart / timeFormat / locale are written; an optional
// `calDefaultScheduleId` (cal int) resolves to the Convex `_id`. IDENTITY fields
// are NOT accepted here — the fork handler no-ops them before calling this.
export const adminUpdateCalcomUserPrefs = mutation({
  args: {
    ownerAuthUserId: v.string(),
    timeZone: v.optional(v.string()),
    weekStart: v.optional(v.string()),
    timeFormat: v.optional(v.number()),
    locale: v.optional(v.string()),
    calDefaultScheduleId: v.optional(v.number()),
    propagateTimeZoneToDefaultSchedule: v.optional(v.boolean()),
    // Onboarding-writable identity/profile fields (getting-started flow only).
    bookingUsername: v.optional(v.string()),
    bio: v.optional(v.string()),
    completedBookingOnboarding: v.optional(v.boolean()),
    // Appearance settings: booking-page theme + dashboard appTheme (null = system).
    theme: v.optional(v.union(v.string(), v.null())),
    appTheme: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({ updated: v.boolean() }),
  handler: async (
    ctx,
    {
      ownerAuthUserId,
      timeZone,
      weekStart,
      timeFormat,
      locale,
      calDefaultScheduleId,
      propagateTimeZoneToDefaultSchedule,
      bookingUsername,
      bio,
      completedBookingOnboarding,
      theme,
      appTheme,
    },
  ) => {
    let defaultScheduleId: Id<"schedules"> | undefined;
    if (calDefaultScheduleId !== undefined) {
      const sMap = await getScheduleByCalIdImpl(ctx, calDefaultScheduleId);
      defaultScheduleId = sMap?.convexId as Id<"schedules"> | undefined;
    }
    return updateCalcomUserPrefsImpl(ctx, {
      authUserId: ownerAuthUserId,
      timeZone,
      weekStart,
      timeFormat,
      locale,
      defaultScheduleId,
      propagateTimeZoneToDefaultSchedule,
      bookingUsername,
      bio,
      completedBookingOnboarding,
      theme,
      appTheme,
    });
  },
});
