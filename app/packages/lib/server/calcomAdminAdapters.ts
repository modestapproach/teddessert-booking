// CV-2b — OWNER-ADMIN Convex↔cal adapters (server-side, authed-user-scoped).
//
// Companion to calcomAdapters.ts (which handles the PUBLIC booker meta + slots).
// This module sources the OWNER's own event types / schedules from Convex via the
// server-to-server `scheduling/calcomAdmin:*` fns, which take an explicit
// `ownerAuthUserId` (the trusted dibslist authUserId the fork carries on
// `session.user.uuid`). See the Convex calcomAdmin.ts header for the trust model.
//
// ─── The id-bijection problem — SOLVED in CV-2c (READ THIS) ──────────────────
//
// cal's UI + routing key event types / schedules by a Prisma INTEGER id. Convex
// rows are addressed by an opaque STRING `_id`. cal's `Session.user.id` solved
// the same problem for users via a persistent int↔string map (`calcomUserMap`,
// minted by resolveOrCreateCalcomUser).
//
// CV-2c adds the equivalent for event types + schedules: the Convex
// `eventTypeIdMap` / `scheduleIdMap` tables (mirroring `calcomUserMap`/`calcomSeq`)
// mint a STABLE integer per Convex `_id` and give a bijection in both directions.
// The `scheduling/calcomAdmin:*` fns now:
//   - RETURN the stable `calId` int on every read row + on create (`{ _id, calId }`),
//     so a GET hands the editor the SAME int cal expects, and
//   - ACCEPT that int back as `calEventTypeId` / `calScheduleId` on update / delete /
//     setAvailability / addDateOverride, resolving it to the Convex `_id` server-side.
//
// CONSEQUENCE: the full editor + availability round-trip
// (`get({id}) → update({id})`) is now rewireable to Convex. The fork resolvers
// pass the cal int and read it back; this module is the mapping layer.
//
// `convexIdToCalInt` (FNV-1a) is RETAINED only for the legacy `eventTypes.list`
// display-only path that predates the map — it is NOT used for any round-tripped
// id. New code uses the persistent `calId` from the map.

import { SchedulingType } from "@calcom/prisma/enums";
import { getConvex } from "@calcom/lib/server/convex";
import {
  transformWorkingHoursForAtom,
  transformAvailabilityForAtom,
  transformDateOverridesForAtom,
} from "@calcom/lib/schedules/transformers/for-atom";
import { makeFunctionReference } from "convex/server";

// ─── server-to-server fn refs (addressed by path; fork has no _generated) ─────

/** s2s, explicit ownerAuthUserId. Owner's event types (newest-first). */
const adminListEventTypesRef = makeFunctionReference<"query">(
  "scheduling/calcomAdmin:adminListEventTypes"
);

// CV-2c — the full owner-admin surface, now that the int↔string id map lands.
// Reads/creates return rows carrying the stable cal int `calId`; mutations accept
// EITHER the Convex string id or the round-tripped `calEventTypeId`/`calScheduleId`
// int (we always pass the int — the editor only ever holds it).
const adminGetEventTypeRef = makeFunctionReference<"query">(
  "scheduling/calcomAdmin:adminGetEventType"
);
// CV-9 — lightweight owner-check for the createEventPbacProcedure middleware.
const adminCheckEventTypeOwnerRef = makeFunctionReference<"query">(
  "scheduling/calcomAdmin:adminCheckEventTypeOwner"
);
// CV-9 — the cal user's prefs (for the isAuthed session-user hydration; replaces
// the prisma `findUnlockedUserForSession` read in getUserFromSession).
const getCalcomUserByAuthUserIdRef = makeFunctionReference<"query">(
  "scheduling/calcomUsers:getCalcomUserByAuthUserId"
);
const getScheduleCalIdByConvexIdRef = makeFunctionReference<"query">(
  "scheduling/calcomIdMaps:getScheduleCalIdByConvexId"
);
const adminCreateEventTypeRef = makeFunctionReference<"mutation">(
  "scheduling/calcomAdmin:adminCreateEventType"
);
const adminUpdateEventTypeRef = makeFunctionReference<"mutation">(
  "scheduling/calcomAdmin:adminUpdateEventType"
);
const adminDeleteEventTypeRef = makeFunctionReference<"mutation">(
  "scheduling/calcomAdmin:adminDeleteEventType"
);
// CV-6 — co-host assignment (the headline). The editor's host picker round-trips
// each co-host as a cal USER int + each per-host schedule as a cal SCHEDULE int;
// the s2s fn reverse-resolves them.
const adminSetEventTypeHostsRef = makeFunctionReference<"mutation">(
  "scheduling/calcomAdmin:adminSetEventTypeHosts"
);

// booking-calendar-integration-prd B7 — owner-scoped Google Calendar connect start.
// The fork's tRPC layer calls this s2s with the authed owner's authUserId
// (ctx.user.uuid) because a browser nav from book.dibslist.app can't carry the
// dibslist cookie to convex.site. Returns the Google consent URL; the UI navigates there.
const adminStartCalendarConnectRef = makeFunctionReference<"mutation">(
  "scheduling/calendarOauth:adminStartCalendarConnect"
);
export async function startOwnerCalendarConnect(args: {
  ownerAuthUserId: string;
}): Promise<{ authorizeUrl: string }> {
  return await getConvex().mutation(adminStartCalendarConnectRef, {
    authUserId: args.ownerAuthUserId,
  });
}
const adminListEventTypeHostsRef = makeFunctionReference<"query">(
  "scheduling/calcomAdmin:adminListEventTypeHosts"
);
// CV-9 — resolve an owner's event type by slug (for the slug→schedule read path).
const adminGetEventTypeBySlugRef = makeFunctionReference<"query">(
  "scheduling/calcomAdmin:adminGetEventTypeBySlug"
);
// CV-7 — resolve a co-host by dibslist EMAIL (the add-co-host picker calls this).
const resolveCoHostByEmailRef = makeFunctionReference<"query">(
  "scheduling/calcomAdmin:resolveCoHostByEmail"
);
const adminListSchedulesRef = makeFunctionReference<"query">(
  "scheduling/calcomAdmin:adminListSchedules"
);
const adminGetScheduleRef = makeFunctionReference<"query">(
  "scheduling/calcomAdmin:adminGetSchedule"
);
const adminCreateScheduleRef = makeFunctionReference<"mutation">(
  "scheduling/calcomAdmin:adminCreateSchedule"
);
const adminUpdateScheduleRef = makeFunctionReference<"mutation">(
  "scheduling/calcomAdmin:adminUpdateSchedule"
);
const adminSetAvailabilityRef = makeFunctionReference<"mutation">(
  "scheduling/calcomAdmin:adminSetAvailability"
);
const adminAddDateOverrideRef = makeFunctionReference<"mutation">(
  "scheduling/calcomAdmin:adminAddDateOverride"
);
const adminListConnectedCalendarsRef = makeFunctionReference<"query">(
  "scheduling/calcomAdmin:adminListConnectedCalendars"
);

// CV-8 — the residual data-layer cleanup write paths.
const adminDuplicateEventTypeRef = makeFunctionReference<"mutation">(
  "scheduling/calcomAdmin:adminDuplicateEventType"
);
const adminDuplicateScheduleRef = makeFunctionReference<"mutation">(
  "scheduling/calcomAdmin:adminDuplicateSchedule"
);
const adminBulkUpdateToDefaultAvailabilityRef = makeFunctionReference<"mutation">(
  "scheduling/calcomAdmin:adminBulkUpdateToDefaultAvailability"
);
const adminUpdateCalcomUserPrefsRef = makeFunctionReference<"mutation">(
  "scheduling/calcomAdmin:adminUpdateCalcomUserPrefs"
);

// CV-5 — the four deferred calendar/schedule WRITE paths, now on Convex.
const adminDeleteScheduleRef = makeFunctionReference<"mutation">(
  "scheduling/calcomAdmin:adminDeleteSchedule"
);
// Mints/returns the STABLE round-trippable cal int for each connected credential.
const adminResolveCredentialCalIdsRef = makeFunctionReference<"mutation">(
  "scheduling/calcomAdmin:adminResolveCredentialCalIds"
);
const adminSetCalendarConflictFlagRef = makeFunctionReference<"mutation">(
  "scheduling/calcomAdmin:adminSetCalendarConflictFlag"
);
const adminSetDestinationCalendarRef = makeFunctionReference<"mutation">(
  "scheduling/calcomAdmin:adminSetDestinationCalendar"
);
const adminDisconnectCalendarRef = makeFunctionReference<"mutation">(
  "scheduling/calcomAdmin:adminDisconnectCalendar"
);

// ─── Convex owner-admin row shapes (partial — only the fields we map) ─────────

export interface ConvexOwnerEventTypeRow {
  _id: string;
  calId?: number; // CV-2c stable cal int id (present on reads + create)
  slug: string;
  title: string;
  description?: string | null;
  durationMinutes: number;
  schedulingType?: "collective" | "round_robin" | "managed";
  scheduleId?: string | null;
  hidden?: boolean;
  active?: boolean;
  locationText?: string | null;
  minimumBookingNoticeMinutes?: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  slotIntervalMinutes?: number;
  requireEmailVerification?: boolean;
  [k: string]: unknown;
}

export interface ConvexAvailabilityRow {
  _id: string;
  days: number[];
  startMinute: number;
  endMinute: number;
}

export interface ConvexDateOverrideRow {
  _id: string;
  dateUtc: number;
  startMinute?: number;
  endMinute?: number;
}

export interface ConvexScheduleRow {
  _id: string;
  calId?: number; // CV-2c stable cal int id
  name: string;
  timeZone?: string;
  isDefault?: boolean;
  availability?: ConvexAvailabilityRow[];
  dateOverrides?: ConvexDateOverrideRow[];
  [k: string]: unknown;
}

/**
 * Derive a stable, collision-resistant POSITIVE 31-bit integer from a Convex
 * string `_id`. DISPLAY-ONLY — used solely to satisfy cal's `id: number` type
 * where the id is never round-tripped back into a Convex write (see header). FNV-1a.
 */
export function convexIdToCalInt(convexId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < convexId.length; i++) {
    hash ^= convexId.charCodeAt(i);
    // FNV prime, kept in 32-bit range via Math.imul.
    hash = Math.imul(hash, 0x01000193);
  }
  // Fold to a positive 31-bit int (cal ids are positive).
  return (hash >>> 0) % 2_000_000_000;
}

// cal's SchedulingType enum is uppercase; our backend stores lowercase. The
// personal-event `list` shape allows `SchedulingType | null`.
function toCalSchedulingTypeEnum(
  t: "collective" | "round_robin" | "managed" | undefined
): SchedulingType | null {
  if (t === "round_robin") return SchedulingType.ROUND_ROBIN;
  if (t === "managed") return SchedulingType.MANAGED;
  if (t === "collective") return SchedulingType.COLLECTIVE;
  return null;
}

/**
 * Map one Convex owner event-type row → the cal `viewer.eventTypes.list` item
 * shape: `{ id, title, description, length, schedulingType, slug, hidden,
 * metadata }`. `metadata` is defaulted to `null` (our backend has no per-event
 * metadata blob — documented gap). `id` is the display-only derived int.
 */
export function toCalEventTypeListItem(row: ConvexOwnerEventTypeRow): {
  id: number;
  title: string;
  description: string | null;
  length: number;
  schedulingType: SchedulingType | null;
  slug: string;
  hidden: boolean;
  metadata: null;
} {
  return {
    id: convexIdToCalInt(row._id),
    title: row.title,
    description: row.description ?? null,
    length: row.durationMinutes,
    schedulingType: toCalSchedulingTypeEnum(row.schedulingType),
    slug: row.slug,
    hidden: row.hidden ?? false,
    // Our eventTypes row has no cal-style `metadata` JSON blob. cal's list
    // consumers only read it opportunistically; null is a valid default.
    metadata: null,
  };
}

/**
 * `viewer.eventTypes.list` body, rewired to Convex. Returns the owner's personal
 * (non-team) event types in cal's list-item shape. `ownerAuthUserId` is the
 * dibslist authUserId from `ctx.user.uuid`. On any backend failure returns `[]`
 * (the list page renders "no event types" rather than 500ing — matching how the
 * public adapter degrades).
 */
export async function getOwnerEventTypeListFromConvex(args: {
  ownerAuthUserId: string;
}): Promise<
  Array<{
    id: number;
    title: string;
    description: string | null;
    length: number;
    schedulingType: SchedulingType | null;
    slug: string;
    hidden: boolean;
    metadata: null;
  }>
> {
  try {
    const rows = (await getConvex().query(adminListEventTypesRef, {
      ownerAuthUserId: args.ownerAuthUserId,
    })) as ConvexOwnerEventTypeRow[];
    return rows.map(toCalEventTypeListItem);
  } catch {
    return [];
  }
}

/**
 * CV-10 — RAW owner event-type rows from Convex (each carrying the stable `calId`),
 * newest-first. Backs the `getEventTypesFromGroup` LIST-page rewire, which synthesizes
 * a cal `EventType` base per row + maps it WITHOUT the prisma user-enrich (the rows are
 * single-owner, no co-hosts to enrich on the list). Best-effort → `[]`.
 */
export async function listOwnerEventTypeRows(args: {
  ownerAuthUserId: string;
}): Promise<ConvexOwnerEventTypeRow[]> {
  try {
    return (await getConvex().query(adminListEventTypesRef, {
      ownerAuthUserId: args.ownerAuthUserId,
    })) as ConvexOwnerEventTypeRow[];
  } catch {
    return [];
  }
}

/**
 * CV-10 — `viewer.eventTypes.bulkEventFetch` body, rewired to Convex. Backs the
 * AVAILABILITY LIST + EDITOR "apply default availability to these event types" bulk
 * dialog. The original `getBulkUserEventTypes(ctx.user.id)` ran a raw
 * `prisma.eventType.findMany` → THROWS on the no-Postgres fork (it fires client-side
 * on the availability list/editor mount). Sources the owner's personal event types
 * from `adminListEventTypes` and maps each to the bulk-fetch item shape
 * `{ id, title, slug, description, length, locations, parentId, logo }`. CRITICAL:
 * `id` is the PERSISTENT, round-trippable `calId` (NOT the FNV-1a display hash) —
 * the dialog feeds these ids straight into `bulkUpdateToDefaultAvailability`
 * (CV-8, which resolves cal ints via the id-map). DEFAULTS for our gaps: `locations`
 * → null (our backend stores free-text `locationText`, not the cal locations JSON the
 * dialog never reads), `parentId` → null (no managed children), `logo` → undefined
 * (the cal `getAppFromLocationValue` enrichment has no backing here). On any backend
 * failure returns `{ eventTypes: [] }` (the dialog shows "no event types" rather than
 * 500ing — matching how the other owner-admin adapters degrade).
 */
export async function getOwnerBulkEventTypesFromConvex(args: {
  ownerAuthUserId: string;
}): Promise<{
  eventTypes: Array<{
    id: number;
    title: string;
    slug: string;
    description: string | null;
    length: number;
    locations: null;
    parentId: null;
    logo: undefined;
  }>;
}> {
  try {
    const rows = (await getConvex().query(adminListEventTypesRef, {
      ownerAuthUserId: args.ownerAuthUserId,
    })) as ConvexOwnerEventTypeRow[];
    return {
      eventTypes: rows.map((row) => ({
        // The persistent round-trippable cal int (NOT the display hash) — the bulk
        // dialog feeds it back into bulkUpdateToDefaultAvailability.
        id: row.calId ?? convexIdToCalInt(row._id),
        title: row.title,
        slug: row.slug,
        description: row.description ?? null,
        length: row.durationMinutes,
        locations: null,
        parentId: null,
        logo: undefined,
      })),
    };
  } catch {
    return { eventTypes: [] };
  }
}

// ─────────────────────────────────────────────────────────────
// CV-2c — int↔string round-trip helpers + cal-shape mappers.
//
// `calId` is the PERSISTENT, round-trippable int the Convex map mints (NOT the
// FNV-1a display hash). All editor/availability mutations key off it.
// ─────────────────────────────────────────────────────────────

// Map cal's UPPERCASE SchedulingType (the editor only ever uses these 3) to our
// backend's lowercase literal. Defaults to "collective" (cal's personal default).
function fromCalSchedulingType(
  t: SchedulingType | null | undefined
): "collective" | "round_robin" | "managed" {
  if (t === SchedulingType.ROUND_ROBIN) return "round_robin";
  if (t === SchedulingType.MANAGED) return "managed";
  return "collective";
}

// ── EVENT TYPES ──────────────────────────────────────────────

/** GET one owner event type by its cal int id. Returns the Convex row (carrying
 *  `calId`) or null. */
export async function getOwnerEventTypeByCalId(args: {
  ownerAuthUserId: string;
  calEventTypeId: number;
}): Promise<ConvexOwnerEventTypeRow | null> {
  try {
    return (await getConvex().query(adminGetEventTypeRef, {
      ownerAuthUserId: args.ownerAuthUserId,
      calEventTypeId: args.calEventTypeId,
    })) as ConvexOwnerEventTypeRow | null;
  } catch {
    return null;
  }
}

/**
 * CV-9 — resolve whether `ownerAuthUserId` OWNS the event type addressed by the
 * cal int. Backs the `createEventPbacProcedure` tRPC middleware (the gate on the
 * whole event-type editor lifecycle), replacing the unconditional
 * `ctx.prisma.eventType.findUnique` that throws on the no-Postgres fork.
 *   - `{ found:false }`            → the middleware throws NOT_FOUND
 *   - `{ found:true, owned:false }`→ the middleware throws FORBIDDEN
 *   - `{ found:true, owned:true }` → the middleware proceeds
 * On a transport error we FAIL CLOSED (`{ found:false, owned:false }`) so a backend
 * blip becomes a clean NOT_FOUND rather than a 500 (and never silently authorises).
 */
export async function checkOwnerEventTypeOwnership(args: {
  ownerAuthUserId: string;
  calEventTypeId: number;
}): Promise<{ found: boolean; owned: boolean }> {
  try {
    return (await getConvex().query(adminCheckEventTypeOwnerRef, {
      ownerAuthUserId: args.ownerAuthUserId,
      calEventTypeId: args.calEventTypeId,
    })) as { found: boolean; owned: boolean };
  } catch {
    return { found: false, owned: false };
  }
}

/**
 * CV-9 — the cal user's stored booking PREFS for the isAuthed session-user
 * hydration. `getUserFromSession` used to read these off the no-Postgres prisma
 * `findUnlockedUserForSession` (which threw on EVERY authed request, gating the
 * whole authed tRPC surface). This sources them from the Convex `calcomUserMap`
 * row, mapping the Convex `defaultScheduleId` → its cal int via the schedule
 * id-map. Best-effort: any miss → cal-shaped null/undefined defaults (the session
 * still hydrates; the schedule adapters fall back to the `isDefault` flag when
 * `defaultScheduleId` is null).
 */
export async function getOwnerSessionPrefs(args: {
  ownerAuthUserId: string;
}): Promise<{
  timeZone: string | null;
  weekStart: string | null;
  timeFormat: number | null;
  locale: string | null;
  defaultScheduleCalId: number | null;
  username: string | null;
  bio: string | null;
  completedBookingOnboarding: boolean;
  theme: string | null;
  appTheme: string | null;
}> {
  const empty = {
    timeZone: null,
    weekStart: null,
    timeFormat: null,
    locale: null,
    defaultScheduleCalId: null,
    username: null,
    bio: null,
    completedBookingOnboarding: false,
    theme: null,
    appTheme: null,
  };
  try {
    const row = (await getConvex().query(getCalcomUserByAuthUserIdRef, {
      authUserId: args.ownerAuthUserId,
    })) as {
      timeZone?: string;
      weekStart?: string;
      timeFormat?: number;
      locale?: string;
      defaultScheduleId?: string;
      username?: string;
      bio?: string;
      completedBookingOnboarding?: boolean;
      theme?: string | null;
      appTheme?: string | null;
    } | null;
    if (!row) return empty;
    let defaultScheduleCalId: number | null = null;
    if (row.defaultScheduleId) {
      const map = (await getConvex().query(getScheduleCalIdByConvexIdRef, {
        convexId: row.defaultScheduleId,
      })) as { calId: number } | null;
      defaultScheduleCalId = map?.calId ?? null;
    }
    return {
      timeZone: row.timeZone ?? null,
      weekStart: row.weekStart ?? null,
      timeFormat: row.timeFormat ?? null,
      locale: row.locale ?? null,
      defaultScheduleCalId,
      username: row.username ?? null,
      bio: row.bio ?? null,
      completedBookingOnboarding: row.completedBookingOnboarding ?? false,
      theme: row.theme ?? null,
      appTheme: row.appTheme ?? null,
    };
  } catch (err) {
    // Fail-closed to "not onboarded / no prefs" so a Convex blip can't 500 the
    // page. Logged because a silent fallback here makes an onboarded owner read as
    // completedOnboarding=false (→ the onboarding bounce); this is the one place to
    // look when a known-onboarded owner is unexpectedly routed to /getting-started.
    console.warn("[booking] getOwnerSessionPrefs Convex read failed; defaulting to empty prefs", err);
    return empty;
  }
}

/**
 * CV-9 — resolve the cal int of the schedule attached to the owner's event type
 * with this slug (for `getScheduleByEventTypeSlug`). Returns the schedule's cal int
 * if the event type both exists (owner-scoped) and pins a specific schedule; `null`
 * when the event type isn't found OR has no explicit schedule (caller then falls
 * back to the owner's default). Best-effort: any transport error → null. The
 * event-type row's `scheduleId` is a Convex id, mapped to its cal int via the
 * schedule id-map.
 */
export async function resolveOwnerEventScheduleCalIdBySlug(args: {
  ownerAuthUserId: string;
  slug: string;
}): Promise<number | null> {
  try {
    const row = (await getConvex().query(adminGetEventTypeBySlugRef, {
      ownerAuthUserId: args.ownerAuthUserId,
      slug: args.slug,
    })) as { scheduleId?: string | null } | null;
    if (!row || !row.scheduleId) return null;
    const map = (await getConvex().query(getScheduleCalIdByConvexIdRef, {
      convexId: row.scheduleId,
    })) as { calId: number } | null;
    return map?.calId ?? null;
  } catch {
    return null;
  }
}

/** CREATE an owner event type. Returns `{ _id, calId }` (the new stable cal int). */
export async function createOwnerEventType(args: {
  ownerAuthUserId: string;
  slug: string;
  title: string;
  description?: string;
  durationMinutes: number;
  schedulingType?: SchedulingType | null;
  calScheduleId?: number;
  hidden?: boolean;
}): Promise<{ _id: string; calId: number }> {
  return (await getConvex().mutation(adminCreateEventTypeRef, {
    ownerAuthUserId: args.ownerAuthUserId,
    slug: args.slug,
    title: args.title,
    description: args.description,
    durationMinutes: args.durationMinutes,
    schedulingType: fromCalSchedulingType(args.schedulingType),
    ...(args.calScheduleId !== undefined ? { calScheduleId: args.calScheduleId } : {}),
    // cal-shaped defaults for our backend's required fields (the editor's rich
    // surface — buffers/notice/limits — is not modeled 1:1; documented gap).
    minimumBookingNoticeMinutes: 120,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    requireEmailVerification: false,
    hidden: args.hidden ?? false,
    active: true,
  })) as { _id: string; calId: number };
}

/** UPDATE an owner event type by its cal int id. CV-6 widens the in-scope field
 *  set the editor Save can persist: + locationText, minimumBookingNoticeMinutes,
 *  slotIntervalMinutes (the trivially-mappable editor fields). OUT-OF-SCOPE editor
 *  fields (recurring/seats/payments/limits/workflows/team) are NOT forwarded —
 *  they have no backing column and are documented no-ops. */
export async function updateOwnerEventTypeByCalId(args: {
  ownerAuthUserId: string;
  calEventTypeId: number;
  slug?: string;
  title?: string;
  description?: string;
  durationMinutes?: number;
  schedulingType?: SchedulingType | null;
  calScheduleId?: number;
  hidden?: boolean;
  // CV-6 — additional trivially-mappable in-scope editor fields.
  locationText?: string;
  minimumBookingNoticeMinutes?: number;
  slotIntervalMinutes?: number;
  // BOOKING-LOTTERY / WAVE-2 ("???" tab) — interaction mode ("none" clears
  // the field server-side) + per-mode settings.
  interactionMode?:
    | "lottery"
    | "first_come"
    | "application"
    | "threshold"
    | "pair"
    | "none";
  lotteryCloseLeadMinutes?: number;
  thresholdMinAttendees?: number;
  seatsPerSlot?: number;
}): Promise<void> {
  await getConvex().mutation(adminUpdateEventTypeRef, {
    ownerAuthUserId: args.ownerAuthUserId,
    calEventTypeId: args.calEventTypeId,
    ...(args.slug !== undefined ? { slug: args.slug } : {}),
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(args.durationMinutes !== undefined ? { durationMinutes: args.durationMinutes } : {}),
    ...(args.schedulingType !== undefined
      ? { schedulingType: fromCalSchedulingType(args.schedulingType) }
      : {}),
    ...(args.calScheduleId !== undefined ? { calScheduleId: args.calScheduleId } : {}),
    ...(args.hidden !== undefined ? { hidden: args.hidden } : {}),
    ...(args.locationText !== undefined ? { locationText: args.locationText } : {}),
    ...(args.minimumBookingNoticeMinutes !== undefined
      ? { minimumBookingNoticeMinutes: args.minimumBookingNoticeMinutes }
      : {}),
    ...(args.slotIntervalMinutes !== undefined
      ? { slotIntervalMinutes: args.slotIntervalMinutes }
      : {}),
    ...(args.interactionMode !== undefined
      ? { interactionMode: args.interactionMode }
      : {}),
    ...(args.lotteryCloseLeadMinutes !== undefined
      ? { lotteryCloseLeadMinutes: args.lotteryCloseLeadMinutes }
      : {}),
    ...(args.thresholdMinAttendees !== undefined
      ? { thresholdMinAttendees: args.thresholdMinAttendees }
      : {}),
    ...(args.seatsPerSlot !== undefined ? { seatsPerSlot: args.seatsPerSlot } : {}),
  });
}

// ── CV-6 — CO-HOST ASSIGNMENT (the headline) ─────────────────

/** One co-host the editor's host picker hands us. `calUserId` is the cal USER int
 *  (calcomUserMap); `calScheduleId` is this host's per-event schedule as a cal
 *  SCHEDULE int. Both are reverse-resolved server-side. */
export interface CalHostInput {
  calUserId: number;
  isFixed?: boolean;
  groupId?: string | null;
  priority?: number | null;
  weight?: number | null;
  calScheduleId?: number | null;
}

/** Replace an event type's co-host roster by its cal int id. The Convex core
 *  forces isFixed:true for COLLECTIVE (the "both founders free" panel), honors
 *  isFixed for round_robin, and reconciles (insert/patch/delete) against the live
 *  set. Returns the count actually assigned (unknown cal user ints are skipped). */
export async function setOwnerEventTypeHostsByCalId(args: {
  ownerAuthUserId: string;
  calEventTypeId: number;
  hosts: CalHostInput[];
}): Promise<{ assigned: number }> {
  return (await getConvex().mutation(adminSetEventTypeHostsRef, {
    ownerAuthUserId: args.ownerAuthUserId,
    calEventTypeId: args.calEventTypeId,
    hosts: args.hosts.map((h) => ({
      calHostUserId: h.calUserId,
      ...(h.isFixed !== undefined ? { isFixed: h.isFixed } : {}),
      ...(h.groupId !== undefined && h.groupId !== null ? { groupId: h.groupId } : {}),
      ...(h.priority !== undefined && h.priority !== null ? { priority: h.priority } : {}),
      ...(h.weight !== undefined && h.weight !== null ? { weight: h.weight } : {}),
      ...(h.calScheduleId !== undefined && h.calScheduleId !== null
        ? { calScheduleId: h.calScheduleId }
        : {}),
    })),
  })) as { assigned: number };
}

/** A co-host roster row read back from Convex (cal-int-enriched). */
export interface ConvexEventTypeHostRow {
  hostAuthUserId: string;
  calHostUserId: number | null;
  isFixed: boolean;
  groupId?: string;
  priority?: number;
  weight?: number;
  scheduleId?: string | null;
  calScheduleId: number | null;
}

/** READ an event type's current co-host roster by cal int id (best-effort → []). */
export async function listOwnerEventTypeHostsByCalId(args: {
  ownerAuthUserId: string;
  calEventTypeId: number;
}): Promise<ConvexEventTypeHostRow[]> {
  try {
    return (await getConvex().query(adminListEventTypeHostsRef, {
      ownerAuthUserId: args.ownerAuthUserId,
      calEventTypeId: args.calEventTypeId,
    })) as ConvexEventTypeHostRow[];
  } catch {
    return [];
  }
}

/** DELETE (soft) an owner event type by its cal int id. */
export async function deleteOwnerEventTypeByCalId(args: {
  ownerAuthUserId: string;
  calEventTypeId: number;
}): Promise<void> {
  await getConvex().mutation(adminDeleteEventTypeRef, {
    ownerAuthUserId: args.ownerAuthUserId,
    calEventTypeId: args.calEventTypeId,
  });
}

/** CV-8 — DUPLICATE an owner event type by its cal int id. The clone copies the
 *  in-scope template fields + the co-host roster; the slug is uniquified
 *  server-side. The dialog supplies the new slug/title (+ optional duration).
 *  Returns the clone's NEW stable cal int + the final (possibly suffixed) slug.
 *  A genuine slug collision the server can't resolve surfaces as a thrown
 *  ConvexError "Slug already taken." which the handler maps to cal's conflict. */
export async function duplicateOwnerEventTypeByCalId(args: {
  ownerAuthUserId: string;
  calEventTypeId: number;
  slug: string;
  title: string;
  description?: string;
  durationMinutes?: number;
}): Promise<{ calId: number; slug: string }> {
  const res = (await getConvex().mutation(adminDuplicateEventTypeRef, {
    ownerAuthUserId: args.ownerAuthUserId,
    calEventTypeId: args.calEventTypeId,
    slug: args.slug,
    title: args.title,
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(args.durationMinutes !== undefined ? { durationMinutes: args.durationMinutes } : {}),
  })) as { _id: string; calId: number; slug: string };
  return { calId: res.calId, slug: res.slug };
}

// ── CO-HOST RESOLUTION (CV-7) ────────────────────────────────

/** Resolution of a typed dibslist email into a co-host candidate. */
export type ResolveCoHostStatus = "assignable" | "needs_signin" | "self" | "not_found";
export interface ResolveCoHostResult {
  found: boolean;
  status: ResolveCoHostStatus;
  /** The minted cal USER int — present ONLY when status === "assignable". This is
   *  the value the picker emits into the event-type form `hosts[].userId`. */
  calUserId: number | null;
  name: string | null;
  email: string | null;
  avatar: string | null;
}

/**
 * CV-7 — resolve a dibslist email to a co-host candidate (the "both founders free"
 * add-by-email picker). Owner-scoped: pass the trusted `ownerAuthUserId`. Maps:
 *   - "assignable"   → has a calcomUserMap row (signed into booking) → calUserId set.
 *   - "needs_signin" → a dibslist account exists but no booking mint → calUserId null.
 *   - "self"         → resolves to the owner (can't co-host yourself).
 *   - "not_found"    → no dibslist account with that email.
 * Best-effort: a transport error resolves to "not_found" so the picker degrades cleanly.
 */
export async function resolveCoHostByEmail(args: {
  ownerAuthUserId: string;
  email: string;
}): Promise<ResolveCoHostResult> {
  try {
    return (await getConvex().query(resolveCoHostByEmailRef, {
      ownerAuthUserId: args.ownerAuthUserId,
      email: args.email,
    })) as ResolveCoHostResult;
  } catch {
    return { found: false, status: "not_found", calUserId: null, name: null, email: null, avatar: null };
  }
}

// ── SCHEDULES / AVAILABILITY ─────────────────────────────────

/** A cal Prisma-`Availability`-shaped row, as the atom transforms + the
 *  `Schedule.availability` type expect. The relational ids are placeholders
 *  (our backend embeds availability in the schedule, so they're never read). */
export interface CalAvailabilityShape {
  id: number;
  userId: number | null;
  eventTypeId: number | null;
  scheduleId: number | null;
  days: number[];
  startTime: Date;
  endTime: Date;
  date: Date | null;
}

// Build a UTC Date whose hour:minute encode `minutesFromMidnight` (the atom
// transforms read only getUTCHours()/getUTCMinutes()). The date part is the cal
// epoch placeholder (1970-01-01) for weekly windows.
function minuteToUtcDate(minutesFromMidnight: number, dateUtcMs?: number): Date {
  const base = dateUtcMs !== undefined ? new Date(dateUtcMs) : new Date(0);
  return new Date(
    Date.UTC(
      base.getUTCFullYear(),
      base.getUTCMonth(),
      base.getUTCDate(),
      Math.floor(minutesFromMidnight / 60),
      minutesFromMidnight % 60
    )
  );
}

/**
 * Map a Convex schedule row (with embedded `availability` + `dateOverrides`) into
 * the cal Prisma-`Availability[]` shape the atom transforms consume. Weekly
 * windows carry `date: null`; overrides carry a concrete `date` + a single day.
 */
export function toCalAvailabilityRows(row: ConvexScheduleRow): CalAvailabilityShape[] {
  // Relational ids are placeholders — our backend embeds availability rows in the
  // schedule, so cal's `availability.{id,userId,eventTypeId,scheduleId}` are never
  // read by the editor/atoms (only days/startTime/endTime/date are).
  const ids = { id: 0, userId: null, eventTypeId: null, scheduleId: null };
  const weekly: CalAvailabilityShape[] = (row.availability ?? []).map((w) => ({
    ...ids,
    days: w.days,
    startTime: minuteToUtcDate(w.startMinute),
    endTime: minuteToUtcDate(w.endMinute),
    date: null,
  }));
  const overrides: CalAvailabilityShape[] = (row.dateOverrides ?? []).map((o) => ({
    ...ids,
    days: [],
    // An all-day block (no start/end) maps to a 00:00–00:00 window (cal treats
    // a zero-length override as "unavailable that day").
    startTime: minuteToUtcDate(o.startMinute ?? 0, o.dateUtc),
    endTime: minuteToUtcDate(o.endMinute ?? 0, o.dateUtc),
    date: new Date(o.dateUtc),
  }));
  return [...weekly, ...overrides];
}

/** LIST the owner's schedules (each carrying `calId`). */
export async function listOwnerSchedules(args: {
  ownerAuthUserId: string;
}): Promise<ConvexScheduleRow[]> {
  try {
    return (await getConvex().query(adminListSchedulesRef, {
      ownerAuthUserId: args.ownerAuthUserId,
    })) as ConvexScheduleRow[];
  } catch {
    return [];
  }
}

/** GET one schedule by cal int id (embeds availability + dateOverrides). */
export async function getOwnerScheduleByCalId(args: {
  ownerAuthUserId: string;
  calScheduleId: number;
}): Promise<ConvexScheduleRow | null> {
  try {
    return (await getConvex().query(adminGetScheduleRef, {
      ownerAuthUserId: args.ownerAuthUserId,
      calScheduleId: args.calScheduleId,
    })) as ConvexScheduleRow | null;
  } catch {
    return null;
  }
}

/** CREATE a schedule. Returns `{ _id, calId }`. */
export async function createOwnerSchedule(args: {
  ownerAuthUserId: string;
  name: string;
  timeZone: string;
  isDefault: boolean;
}): Promise<{ _id: string; calId: number }> {
  return (await getConvex().mutation(adminCreateScheduleRef, {
    ownerAuthUserId: args.ownerAuthUserId,
    name: args.name,
    timeZone: args.timeZone,
    isDefault: args.isDefault,
  })) as { _id: string; calId: number };
}

/** UPDATE a schedule by cal int id (name / timeZone / isDefault). */
export async function updateOwnerScheduleByCalId(args: {
  ownerAuthUserId: string;
  calScheduleId: number;
  name?: string;
  timeZone?: string;
  isDefault?: boolean;
}): Promise<void> {
  await getConvex().mutation(adminUpdateScheduleRef, {
    ownerAuthUserId: args.ownerAuthUserId,
    calScheduleId: args.calScheduleId,
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.timeZone !== undefined ? { timeZone: args.timeZone } : {}),
    ...(args.isDefault !== undefined ? { isDefault: args.isDefault } : {}),
  });
}

/** Replace a schedule's weekly windows by cal int id. `windows` are minutes. */
export async function setOwnerAvailabilityByCalId(args: {
  ownerAuthUserId: string;
  calScheduleId: number;
  windows: Array<{ days: number[]; startMinute: number; endMinute: number }>;
}): Promise<void> {
  await getConvex().mutation(adminSetAvailabilityRef, {
    ownerAuthUserId: args.ownerAuthUserId,
    calScheduleId: args.calScheduleId,
    windows: args.windows,
  });
}

/** Add/replace one date override by cal int id. */
export async function addOwnerDateOverrideByCalId(args: {
  ownerAuthUserId: string;
  calScheduleId: number;
  dateUtc: number;
  startMinute?: number;
  endMinute?: number;
}): Promise<void> {
  await getConvex().mutation(adminAddDateOverrideRef, {
    ownerAuthUserId: args.ownerAuthUserId,
    calScheduleId: args.calScheduleId,
    dateUtc: args.dateUtc,
    ...(args.startMinute !== undefined ? { startMinute: args.startMinute } : {}),
    ...(args.endMinute !== undefined ? { endMinute: args.endMinute } : {}),
  });
}

/** DELETE a schedule by cal int id (CV-5). The Convex core enforces ownership +
 *  the at-least-one / default-reassign guard, throwing on the last schedule. */
export async function deleteOwnerScheduleByCalId(args: {
  ownerAuthUserId: string;
  calScheduleId: number;
}): Promise<void> {
  await getConvex().mutation(adminDeleteScheduleRef, {
    ownerAuthUserId: args.ownerAuthUserId,
    calScheduleId: args.calScheduleId,
  });
}

/** CV-8 — DUPLICATE a schedule by cal int id. The clone copies availability +
 *  date overrides under a "<name> (Copy)" name, FORCED non-default. Returns the
 *  clone's NEW stable cal int + its name. */
export async function duplicateOwnerScheduleByCalId(args: {
  ownerAuthUserId: string;
  calScheduleId: number;
}): Promise<{ calId: number; name: string }> {
  const res = (await getConvex().mutation(adminDuplicateScheduleRef, {
    ownerAuthUserId: args.ownerAuthUserId,
    calScheduleId: args.calScheduleId,
  })) as { _id: string; calId: number; name: string };
  return { calId: res.calId, name: res.name };
}

/** CV-8 — BULK-REPOINT the listed event types onto the (selected or current)
 *  default schedule. The `calEventTypeIds` are the round-tripped cal ints; an
 *  optional selected default is a cal int. The Convex core resolves them via the
 *  id-map, owner-scopes the writes, and throws "Default schedule not set" when
 *  neither a selection nor a current default resolves. Returns `{ count }`. */
export async function bulkUpdateToDefaultAvailability(args: {
  ownerAuthUserId: string;
  calEventTypeIds: number[];
  calSelectedDefaultScheduleId?: number | null;
}): Promise<{ count: number }> {
  return (await getConvex().mutation(adminBulkUpdateToDefaultAvailabilityRef, {
    ownerAuthUserId: args.ownerAuthUserId,
    calEventTypeIds: args.calEventTypeIds,
    ...(args.calSelectedDefaultScheduleId !== undefined &&
    args.calSelectedDefaultScheduleId !== null
      ? { calSelectedDefaultScheduleId: args.calSelectedDefaultScheduleId }
      : {}),
  })) as { count: number };
}

/** CV-8 — UPDATE the owner's BOOKING PREFS (the cal me.updateProfile save subset).
 *  Only timeZone / weekStart / timeFormat / locale are persisted, plus an optional
 *  default schedule (cal int). IDENTITY fields (name/email/avatar/username/bio) are
 *  NOT forwarded here — the handler no-ops them. Best-effort: a transport error is
 *  swallowed (the prefs save degrades to a no-op rather than 500ing). */
export async function updateOwnerBookingPrefs(args: {
  ownerAuthUserId: string;
  timeZone?: string;
  weekStart?: string;
  timeFormat?: number;
  locale?: string;
  calDefaultScheduleId?: number;
  propagateTimeZoneToDefaultSchedule?: boolean;
  // Onboarding-writable identity/profile fields (getting-started flow only).
  bookingUsername?: string;
  bio?: string;
  completedBookingOnboarding?: boolean;
  // Appearance settings: booking-page theme + dashboard appTheme (null = system).
  theme?: string | null;
  appTheme?: string | null;
}): Promise<{ updated: boolean }> {
  try {
    return (await getConvex().mutation(adminUpdateCalcomUserPrefsRef, {
      ownerAuthUserId: args.ownerAuthUserId,
      ...(args.timeZone !== undefined ? { timeZone: args.timeZone } : {}),
      ...(args.weekStart !== undefined ? { weekStart: args.weekStart } : {}),
      ...(args.timeFormat !== undefined ? { timeFormat: args.timeFormat } : {}),
      ...(args.locale !== undefined ? { locale: args.locale } : {}),
      ...(args.calDefaultScheduleId !== undefined
        ? { calDefaultScheduleId: args.calDefaultScheduleId }
        : {}),
      ...(args.propagateTimeZoneToDefaultSchedule !== undefined
        ? { propagateTimeZoneToDefaultSchedule: args.propagateTimeZoneToDefaultSchedule }
        : {}),
      ...(args.bookingUsername !== undefined ? { bookingUsername: args.bookingUsername } : {}),
      ...(args.bio !== undefined ? { bio: args.bio } : {}),
      ...(args.completedBookingOnboarding !== undefined
        ? { completedBookingOnboarding: args.completedBookingOnboarding }
        : {}),
      ...(args.theme !== undefined ? { theme: args.theme } : {}),
      ...(args.appTheme !== undefined ? { appTheme: args.appTheme } : {}),
    })) as { updated: boolean };
  } catch {
    return { updated: false };
  }
}

// ── Composite: the cal `findDetailedScheduleById` return shape from Convex ────
//
// Reproduces ScheduleRepository.findDetailedScheduleById's projection so the
// availability editor's `schedule.get` resolver + SSR loader keep their exact
// contract. `userCalId` is the owner's stable cal user int (== schedule.userId
// in cal's shape — single-owner only, no teams). DEFAULTS for our gaps:
//   - isManaged / readOnly → false (no team/managed schedules in our backend)
//   - workingHours/availability/dateOverrides → derived from the Convex rows via
//     cal's own atom transforms (we synthesize the Prisma-Availability shape).

export interface CalDetailedSchedule {
  id: number;
  name: string;
  isManaged: boolean;
  workingHours: ReturnType<typeof transformWorkingHoursForAtom>;
  schedule: CalAvailabilityShape[];
  availability: ReturnType<typeof transformAvailabilityForAtom>;
  timeZone: string;
  dateOverrides: ReturnType<typeof transformDateOverridesForAtom>;
  isDefault: boolean;
  isLastSchedule: boolean;
  readOnly: boolean;
  userId: number;
}

function mapConvexScheduleToDetailed(args: {
  row: ConvexScheduleRow;
  userCalId: number;
  userTimeZone: string;
  scheduleCount: number;
  requestedCalScheduleId?: number;
  defaultScheduleCalId: number | null;
}): CalDetailedSchedule {
  const { row, userCalId, userTimeZone } = args;
  const calId = row.calId ?? 0;
  const rows = toCalAvailabilityRows(row);
  const timeZone = row.timeZone || userTimeZone;
  return {
    id: calId,
    name: row.name,
    isManaged: false,
    workingHours: transformWorkingHoursForAtom({ timeZone, availability: rows }),
    schedule: rows,
    availability: transformAvailabilityForAtom({ availability: rows }),
    timeZone,
    dateOverrides: transformDateOverridesForAtom({ availability: rows }, timeZone),
    // When no explicit scheduleId was requested we resolved the default, so it IS
    // the default; otherwise compare to the user's default cal id.
    isDefault:
      args.requestedCalScheduleId === undefined ||
      args.defaultScheduleCalId === calId ||
      !!row.isDefault,
    isLastSchedule: args.scheduleCount <= 1,
    readOnly: false,
    userId: userCalId,
  };
}

// ── Composite: the cal `ScheduleService.update` flow, rewired to Convex ───────
//
// The availability editor's save path. It splits the input into weekly windows
// (`schedule`) + date overrides, writes them via the id-map keyed mutations, and
// returns the `UpdateScheduleResponse`-compatible shape (schedule/availability/
// timeZone/isDefault/prev+currentDefaultId). DEFAULTS: prevDefaultId /
// currentDefaultId come off the cal user's `defaultScheduleId` (we don't persist
// a separate user.defaultScheduleId — isDefault lives on the schedule row).
export interface CalUpdateScheduleResult {
  schedule: { id: number; userId: number; name: string; timeZone: string | null };
  availability: ReturnType<typeof transformAvailabilityForAtom>;
  timeZone: string;
  isDefault: boolean;
  prevDefaultId: number | null;
  currentDefaultId: number | null;
}

export async function updateScheduleFromConvex(args: {
  ownerAuthUserId: string;
  userCalId: number;
  userTimeZone: string;
  defaultScheduleCalId: number | null;
  calScheduleId: number;
  name?: string;
  timeZone?: string;
  isDefault?: boolean;
  // Weekly windows already converted to minute windows by the handler.
  windows?: Array<{ days: number[]; startMinute: number; endMinute: number }>;
  // Date overrides as { dateUtc, startMinute?, endMinute? }.
  dateOverrides?: Array<{ dateUtc: number; startMinute?: number; endMinute?: number }>;
}): Promise<CalUpdateScheduleResult> {
  // Verify ownership + existence first (throws if not owned).
  const existing = await getOwnerScheduleByCalId({
    ownerAuthUserId: args.ownerAuthUserId,
    calScheduleId: args.calScheduleId,
  });
  if (!existing) throw new Error("UNAUTHORIZED");

  // Patch name / timeZone / isDefault.
  if (args.name !== undefined || args.timeZone !== undefined || args.isDefault !== undefined) {
    await updateOwnerScheduleByCalId({
      ownerAuthUserId: args.ownerAuthUserId,
      calScheduleId: args.calScheduleId,
      name: args.name,
      timeZone: args.timeZone,
      isDefault: args.isDefault,
    });
  }

  // Replace weekly windows (full-replace, matching cal's deleteMany+createMany).
  if (args.windows !== undefined) {
    await setOwnerAvailabilityByCalId({
      ownerAuthUserId: args.ownerAuthUserId,
      calScheduleId: args.calScheduleId,
      windows: args.windows,
    });
  }

  // Upsert each date override.
  for (const o of args.dateOverrides ?? []) {
    await addOwnerDateOverrideByCalId({
      ownerAuthUserId: args.ownerAuthUserId,
      calScheduleId: args.calScheduleId,
      dateUtc: o.dateUtc,
      startMinute: o.startMinute,
      endMinute: o.endMinute,
    });
  }

  // Re-read for the response projection.
  const fresh =
    (await getOwnerScheduleByCalId({
      ownerAuthUserId: args.ownerAuthUserId,
      calScheduleId: args.calScheduleId,
    })) ?? existing;
  const rows = toCalAvailabilityRows(fresh);
  const timeZone = fresh.timeZone || args.userTimeZone;
  const isDefault = args.isDefault ?? !!fresh.isDefault;
  // When the caller set this schedule as default, it becomes the current default.
  const currentDefaultId = isDefault ? args.calScheduleId : args.defaultScheduleCalId;

  return {
    schedule: {
      id: args.calScheduleId,
      userId: args.userCalId,
      name: fresh.name,
      timeZone: fresh.timeZone ?? null,
    },
    availability: transformAvailabilityForAtom({ availability: rows }),
    timeZone,
    isDefault,
    prevDefaultId: args.defaultScheduleCalId,
    currentDefaultId,
  };
}

/**
 * `schedule.get` body, rewired to Convex. `requestedCalScheduleId` is the cal int
 * from the route param / input (optional → resolve the owner's default). Throws
 * "Schedule not found" / "UNAUTHORIZED" to match the cal repo's error contract.
 */
export async function getDetailedScheduleFromConvex(args: {
  ownerAuthUserId: string;
  userCalId: number;
  userTimeZone: string;
  defaultScheduleCalId: number | null;
  requestedCalScheduleId?: number;
}): Promise<CalDetailedSchedule | null> {
  const all = await listOwnerSchedules({ ownerAuthUserId: args.ownerAuthUserId });
  // Resolve the target schedule: explicit id, else the default, else the first.
  let targetCalId = args.requestedCalScheduleId;
  if (targetCalId === undefined) {
    const def = all.find((s) => s.isDefault) ?? all[0];
    targetCalId = def?.calId;
  }
  // why: return null (not throw) so the availability page's notFound() fires as a clean
  // 404 instead of a 500 during the post-save revalidatePath re-render (an empty Convex
  // read here is "no such schedule", not an error).
  if (targetCalId === undefined) return null;

  const row = await getOwnerScheduleByCalId({
    ownerAuthUserId: args.ownerAuthUserId,
    calScheduleId: targetCalId,
  });
  if (!row) return null;

  return mapConvexScheduleToDetailed({
    row,
    userCalId: args.userCalId,
    userTimeZone: args.userTimeZone,
    scheduleCount: all.length,
    requestedCalScheduleId: args.requestedCalScheduleId,
    defaultScheduleCalId: args.defaultScheduleCalId,
  });
}

// ─────────────────────────────────────────────────────────────
// CV-2c — connectedCalendars: Convex → cal CalendarManager wire shape.
//
// The cal UI keys off `integration.{slug,name,logo,type}` + a numeric
// `credentialId` and per-calendar `{ externalId, name, isSelected, readOnly,
// primary }`. Our Convex `selectedCalendars` use different field names
// (externalCalendarId / displayName / checkForConflicts / isDestination) and a
// STRING credential `_id`. We synthesize the integration block from `provider`
// and derive a numeric `credentialId` from the Convex `_id` (FNV-1a, display
// only — the disconnect + conflict-toggle MUTATION paths are separate handlers,
// NOT yet rewired; see CONVEX-REWIRE-NOTES §CV-2c "Deferred").
//
// DEFAULTS for cal fields our backend lacks: readOnly=false, delegationCredentialId
// =null, cacheUpdatedAt=null. An `invalid` credential maps to `error:{message}`
// + empty calendars.
//
// CV-5 — the UI's numeric `credentialId` is now the PERSISTENT, round-trippable int
// from the Convex `calendarCredentialIdMap` (NOT the FNV-1a display hash), so the
// disconnect + conflict-toggle writes can recover the Convex `_id`. The
// connectedCalendars resolver mints/fetches that int via
// `resolveOwnerCredentialCalIds` and passes the `calId`-by-`_id` map into the
// mapper below. (We fall back to `convexIdToCalInt` only if a credential is somehow
// missing from the map — defensive; should not happen.)
// ─────────────────────────────────────────────────────────────

export interface ConvexConnectedCalendarRow {
  _id: string;
  externalCalendarId: string;
  displayName?: string;
  checkForConflicts: boolean;
  isDestination: boolean;
  timeZone?: string;
}

export interface ConvexConnectedCredential {
  _id: string;
  provider: "google" | "caldav";
  label: string;
  invalid: boolean;
  calendars: ConvexConnectedCalendarRow[];
}

const PROVIDER_INTEGRATION: Record<
  "google" | "caldav",
  { slug: string; name: string; type: string; title: string; logo: string }
> = {
  google: {
    slug: "google-calendar",
    name: "Google Calendar",
    type: "google_calendar",
    // The fork has no /api/app-store asset route (app-store is unwired), so the
    // upstream "/api/app-store/.../icon.svg" path 404s. We ship the real provider
    // icons as static public assets under /apps/ instead (public/app-store is
    // gitignored — cal generates it at build — so we use the committed public/apps).
    title: "Google Calendar",
    logo: "/apps/googlecalendar.svg",
  },
  caldav: {
    slug: "caldav-calendar",
    name: "CalDav (Beta)",
    type: "caldav_calendar",
    title: "CalDav (Beta)",
    logo: "/apps/caldavcalendar.svg",
  },
};

/**
 * Map the Convex connected-calendar credentials → the cal `connectedCalendars` +
 * `destinationCalendar` wire shape. Returns a structurally-compatible object that
 * the handler casts to cal's exact result type (the cal UI reads only the fields
 * synthesized here).
 */
export function mapConvexConnectedCalendars(
  creds: ConvexConnectedCredential[],
  // CV-5 — persistent cal int per credential `_id` (from the
  // calendarCredentialIdMap). When provided, the UI's numeric `credentialId` is the
  // round-trippable int the disconnect/conflict-toggle writes feed back. Optional
  // for back-compat; falls back to the FNV-1a display hash when absent.
  calIdByConvexId?: Record<string, number>
): {
  connectedCalendars: unknown[];
  destinationCalendar: unknown;
} {
  let destinationCalendar: unknown = null;

  const connectedCalendars = creds.map((cred) => {
    const integration = PROVIDER_INTEGRATION[cred.provider];
    const credentialId = calIdByConvexId?.[cred._id] ?? convexIdToCalInt(cred._id);

    if (cred.invalid) {
      return {
        integration: { ...integration, credentialId },
        credentialId,
        delegationCredentialId: null,
        error: { message: "Access token expired or revoked" },
        calendars: [],
        primary: undefined,
      };
    }

    const calendars = cred.calendars.map((c) => {
      const cal = {
        externalId: c.externalCalendarId,
        name: c.displayName,
        primary: c.isDestination ? true : null,
        isSelected: c.checkForConflicts,
        readOnly: false,
        credentialId,
        delegationCredentialId: null,
        email: cred.label,
        integration: integration.type,
      };
      // The destination calendar is the first row flagged isDestination.
      if (c.isDestination && !destinationCalendar) {
        destinationCalendar = {
          ...cal,
          integrationTitle: integration.title,
          primaryEmail: cred.label,
          primary: true,
        };
      }
      return cal;
    });

    const primary = calendars.find((c) => c.primary === true) ?? calendars[0];

    return {
      integration: { ...integration, credentialId },
      credentialId,
      delegationCredentialId: null,
      primary,
      calendars,
    };
  });

  return { connectedCalendars, destinationCalendar };
}

/** Fetch the owner's connected calendars from Convex (s2s, owner-scoped). */
export async function listOwnerConnectedCalendars(args: {
  ownerAuthUserId: string;
}): Promise<ConvexConnectedCredential[]> {
  try {
    return (await getConvex().query(adminListConnectedCalendarsRef, {
      ownerAuthUserId: args.ownerAuthUserId,
    })) as ConvexConnectedCredential[];
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// CV-5 — calendar credential int round-trip + the three calendar write paths.
// ─────────────────────────────────────────────────────────────

/**
 * Mint/fetch the PERSISTENT cal int for each of the owner's connected credentials
 * and return a `{ [convexId]: calId }` lookup. The connectedCalendars resolver
 * calls this (a mutation — the list query can't write) so the UI's numeric
 * `credentialId` is the round-trippable int the disconnect/conflict-toggle writes
 * feed back. Best-effort: on failure returns `{}` (the mapper falls back to the
 * display hash, and writes by int would then 404 — degrades, doesn't 500).
 */
export async function resolveOwnerCredentialCalIds(args: {
  ownerAuthUserId: string;
}): Promise<Record<string, number>> {
  try {
    const rows = (await getConvex().mutation(adminResolveCredentialCalIdsRef, {
      ownerAuthUserId: args.ownerAuthUserId,
    })) as Array<{ credentialId: string; calId: number }>;
    const map: Record<string, number> = {};
    for (const r of rows) map[r.credentialId] = r.calId;
    return map;
  } catch {
    return {};
  }
}

// cal's `integration` slug/type → our Convex provider. The conflict-toggle route
// passes the integration `type` (e.g. "google_calendar"); set-destination passes
// the same. Anything caldav-ish maps to "caldav"; default to google.
export function calIntegrationToProvider(
  integration: string | null | undefined
): "google" | "caldav" {
  if (!integration) return "google";
  const s = integration.toLowerCase();
  if (s.includes("caldav") || s.includes("apple") || s.includes("icloud")) {
    return "caldav";
  }
  return "google";
}

/**
 * CONFLICT-TOGGLE (selected-calendar busy/conflict). cal's POST = select
 * (checkForConflicts:true), DELETE = deselect (false). Keyed by the round-tripped
 * cal int `credentialId` + the externalCalendarId string. The Convex core
 * owner-rechecks + flips the boolean (it does NOT delete the row — our model keeps
 * the enumerated row and toggles the flag; semantic gap vs cal's DELETE-removes
 * documented in CONVEX-REWIRE-NOTES §CV-5).
 */
export async function setOwnerCalendarConflictFlagByCalId(args: {
  ownerAuthUserId: string;
  calCredentialId: number;
  externalCalendarId: string;
  checkForConflicts: boolean;
}): Promise<void> {
  await getConvex().mutation(adminSetCalendarConflictFlagRef, {
    ownerAuthUserId: args.ownerAuthUserId,
    calCredentialId: args.calCredentialId,
    externalCalendarId: args.externalCalendarId,
    checkForConflicts: args.checkForConflicts,
  });
}

/**
 * SET-DESTINATION. Keyed by (provider, externalCalendarId) strings — cal's
 * `setDestinationCalendar` carries NO credential int, so no id-map round-trip. The
 * Convex core sets the targeted calendar as the owner's single destination,
 * clearing the prior one.
 */
export async function setOwnerDestinationCalendar(args: {
  ownerAuthUserId: string;
  integration: string;
  externalCalendarId: string;
}): Promise<void> {
  await getConvex().mutation(adminSetDestinationCalendarRef, {
    ownerAuthUserId: args.ownerAuthUserId,
    provider: calIntegrationToProvider(args.integration),
    externalCalendarId: args.externalCalendarId,
  });
}

/**
 * DISCONNECT / delete-credential. The UI rounds back ONLY the bare cal int
 * credential id (no externalId fallback), so this genuinely needs the id-map. The
 * Convex core owner-rechecks, deletes the credential, and cascades its
 * selectedCalendars + freebusyCache.
 */
export async function disconnectOwnerCalendarByCalId(args: {
  ownerAuthUserId: string;
  calCredentialId: number;
}): Promise<void> {
  await getConvex().mutation(adminDisconnectCalendarRef, {
    ownerAuthUserId: args.ownerAuthUserId,
    calCredentialId: args.calCredentialId,
  });
}
