// BOOKING / A4 — owner CRUD for the `eventTypes` table (the bookable
// "30 min intro" / "panel interview" templates). Mirrors cal.com's event-type
// model: one row per bookable thing, owned by `ownerAuthUserId`, soft-disabled
// via `active`/`hidden` (no hard delete in this milestone).
//
// AUTH + FLAG CONTRACT (every function):
//   1. `const ownerId = await requireAuthUserId(ctx)` FIRST — throws a
//      ConvexError if unauthenticated (message survives prod sanitization).
//   2. WRITE mutations then gate on the DEFAULT-OFF `booking_enabled` flag via
//      `requireFlagEnabled(ctx, "booking_enabled", { defaultValue: false })`,
//      mirroring how `apiV1._authenticate` gates `api_enabled`. The whole write
//      surface is dark until an operator flips the flag.
//   3. READS are NOT flag-gated — the owner can always inspect their own config
//      (otherwise they couldn't see what they built before launch). They are
//      still strictly owner-scoped.
//
// OWNERSHIP: writes set `ownerAuthUserId = ownerId`; reads/updates load the row
// and require `row.ownerAuthUserId === ownerId`, throwing `ConvexError("Not
// found.")` on any miss-or-not-owned (leak-prevention: never distinguish
// "doesn't exist" from "not yours").
//
// TESTABILITY: each handler is also exported as a bare async function
// (`createEventTypeHandler`, …) so the *.test.ts can call it against an
// in-memory fake ctx (the repo convention — see itemPhotos.test.ts) with
// `requireAuthUserId` mocked. The registered `mutation`/`query` wrappers also
// expose `._handler`, which the tests use directly; the named exports just make
// intent explicit.
//
// NOTE: the `eventTypes` / `schedules` tables are NEW (schema pushed, codegen
// pending). `ctx.db.insert("eventTypes", …)` etc. typecheck against the schema
// at runtime; tsc under the stale `_generated` types will flag these string
// table names as "not assignable" until codegen runs — EXPECTED, see the task
// brief.

import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { requireAuthUserId } from "../_helpers/auth";
import { requireFlagEnabled } from "../_helpers/featureFlag";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

const BOOKING_FLAG_GATE = {
  kind: "booking_disabled",
  message: "Booking is not available.",
  defaultValue: false as const,
};

async function gateBooking(ctx: Ctx): Promise<void> {
  const gate = await requireFlagEnabled(ctx, "booking_enabled", BOOKING_FLAG_GATE);
  if (!gate.ok) throw new ConvexError({ kind: gate.kind, message: gate.message });
}

const schedulingType = v.union(
  v.literal("collective"),
  v.literal("round_robin"),
  v.literal("managed"),
);

// ─────────────────────────────────────────────────────────────
// Slug uniqueness helper
// ─────────────────────────────────────────────────────────────

// Slugs are globally unique (the public booking URL is `/<slug>`). Throws if
// `slug` is already taken by a DIFFERENT row. `ignoreId` lets `update` keep its
// own slug.
async function assertSlugFree(
  ctx: Ctx,
  slug: string,
  ignoreId?: Id<"eventTypes">,
): Promise<void> {
  const existing = await ctx.db
    .query("eventTypes")
    .withIndex("by_slug", (q: Ctx) => q.eq("slug", slug))
    .unique();
  if (existing && existing._id !== ignoreId) {
    throw new ConvexError("Slug already taken.");
  }
}

// ─────────────────────────────────────────────────────────────
// createEventType — mutation (flag-gated)
// ─────────────────────────────────────────────────────────────

const createEventTypeArgs = {
  slug: v.string(),
  title: v.string(),
  description: v.optional(v.string()),
  durationMinutes: v.number(),
  schedulingType,
  scheduleId: v.optional(v.id("schedules")),
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
};

type CreateEventTypeArgs = {
  slug: string;
  title: string;
  description?: string;
  durationMinutes: number;
  schedulingType: "collective" | "round_robin" | "managed";
  scheduleId?: Id<"schedules">;
  slotIntervalMinutes?: number;
  minimumBookingNoticeMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  bookingWindowDays?: number;
  dailyBookingLimit?: number;
  requireEmailVerification: boolean;
  hidden: boolean;
  locationText?: string;
  active: boolean;
};

export async function createEventTypeHandler(
  ctx: Ctx,
  args: CreateEventTypeArgs,
): Promise<Id<"eventTypes">> {
  const ownerId = await requireAuthUserId(ctx);
  return createEventTypeCore(ctx, ownerId, args);
}

// CV-2b: post-auth core. The auth-gated handler resolves the owner via the Convex
// identity; the server-to-server admin wrapper (calcomAdmin.ts) passes an explicit
// `ownerId` (the trusted dibslist authUserId from the fork's Better-Auth session).
// Both then run IDENTICAL logic — same flag gate, same validation, same writes.
export async function createEventTypeCore(
  ctx: Ctx,
  ownerId: string,
  args: CreateEventTypeArgs,
): Promise<Id<"eventTypes">> {
  await gateBooking(ctx);

  const slug = args.slug.trim();
  if (!slug) throw new ConvexError("Slug is required.");
  if (!args.title.trim()) throw new ConvexError("Title is required.");
  if (!Number.isFinite(args.durationMinutes) || args.durationMinutes <= 0) {
    throw new ConvexError("durationMinutes must be a positive number.");
  }

  // If a schedule is pinned, it must belong to the caller.
  if (args.scheduleId) {
    const sched = await ctx.db.get(args.scheduleId);
    if (!sched || sched.ownerAuthUserId !== ownerId) {
      throw new ConvexError("Not found.");
    }
  }

  await assertSlugFree(ctx, slug);

  const now = Date.now();
  return await ctx.db.insert("eventTypes", {
    ownerAuthUserId: ownerId,
    slug,
    title: args.title,
    description: args.description,
    durationMinutes: args.durationMinutes,
    schedulingType: args.schedulingType,
    scheduleId: args.scheduleId,
    slotIntervalMinutes: args.slotIntervalMinutes,
    minimumBookingNoticeMinutes: args.minimumBookingNoticeMinutes,
    bufferBeforeMinutes: args.bufferBeforeMinutes,
    bufferAfterMinutes: args.bufferAfterMinutes,
    bookingWindowDays: args.bookingWindowDays,
    dailyBookingLimit: args.dailyBookingLimit,
    requireEmailVerification: args.requireEmailVerification,
    hidden: args.hidden,
    locationText: args.locationText,
    active: args.active,
    createdAt: now,
    updatedAt: now,
  });
}

export const createEventType = mutation({
  args: createEventTypeArgs,
  handler: createEventTypeHandler,
});

// ─────────────────────────────────────────────────────────────
// updateEventType — mutation (flag-gated)
// ─────────────────────────────────────────────────────────────

const updateEventTypeArgs = {
  id: v.id("eventTypes"),
  slug: v.optional(v.string()),
  title: v.optional(v.string()),
  description: v.optional(v.string()),
  durationMinutes: v.optional(v.number()),
  schedulingType: v.optional(schedulingType),
  scheduleId: v.optional(v.id("schedules")),
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
  // BOOKING-LOTTERY §6 — the "???" interaction mode. "none" is the explicit
  // clear sentinel (optional args can't distinguish "absent" from "remove").
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
  // WAVE-2 threshold mode: minimum headcount to confirm; group capacity.
  thresholdMinAttendees: v.optional(v.number()),
  seatsPerSlot: v.optional(v.number()),
};

type UpdateEventTypeArgs = {
  id: Id<"eventTypes">;
  slug?: string;
  title?: string;
  description?: string;
  durationMinutes?: number;
  schedulingType?: "collective" | "round_robin" | "managed";
  scheduleId?: Id<"schedules">;
  slotIntervalMinutes?: number;
  minimumBookingNoticeMinutes?: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  bookingWindowDays?: number;
  dailyBookingLimit?: number;
  requireEmailVerification?: boolean;
  hidden?: boolean;
  locationText?: string;
  active?: boolean;
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
};

export async function updateEventTypeHandler(
  ctx: Ctx,
  args: UpdateEventTypeArgs,
): Promise<null> {
  const ownerId = await requireAuthUserId(ctx);
  return updateEventTypeCore(ctx, ownerId, args);
}

// CV-2b post-auth core (see createEventTypeCore).
export async function updateEventTypeCore(
  ctx: Ctx,
  ownerId: string,
  args: UpdateEventTypeArgs,
): Promise<null> {
  await gateBooking(ctx);

  const row = await ctx.db.get(args.id);
  if (!row || row.ownerAuthUserId !== ownerId) {
    throw new ConvexError("Not found.");
  }

  const patch: Record<string, unknown> = { updatedAt: Date.now() };

  if (args.slug !== undefined) {
    const slug = args.slug.trim();
    if (!slug) throw new ConvexError("Slug is required.");
    if (slug !== row.slug) await assertSlugFree(ctx, slug, args.id);
    patch.slug = slug;
  }
  if (args.title !== undefined) {
    if (!args.title.trim()) throw new ConvexError("Title is required.");
    patch.title = args.title;
  }
  if (args.durationMinutes !== undefined) {
    if (!Number.isFinite(args.durationMinutes) || args.durationMinutes <= 0) {
      throw new ConvexError("durationMinutes must be a positive number.");
    }
    patch.durationMinutes = args.durationMinutes;
  }
  if (args.scheduleId !== undefined) {
    const sched = await ctx.db.get(args.scheduleId);
    if (!sched || sched.ownerAuthUserId !== ownerId) {
      throw new ConvexError("Not found.");
    }
    patch.scheduleId = args.scheduleId;
  }
  if (args.description !== undefined) patch.description = args.description;
  if (args.schedulingType !== undefined) patch.schedulingType = args.schedulingType;
  if (args.slotIntervalMinutes !== undefined)
    patch.slotIntervalMinutes = args.slotIntervalMinutes;
  if (args.minimumBookingNoticeMinutes !== undefined)
    patch.minimumBookingNoticeMinutes = args.minimumBookingNoticeMinutes;
  if (args.bufferBeforeMinutes !== undefined)
    patch.bufferBeforeMinutes = args.bufferBeforeMinutes;
  if (args.bufferAfterMinutes !== undefined)
    patch.bufferAfterMinutes = args.bufferAfterMinutes;
  if (args.bookingWindowDays !== undefined)
    patch.bookingWindowDays = args.bookingWindowDays;
  if (args.dailyBookingLimit !== undefined)
    patch.dailyBookingLimit = args.dailyBookingLimit;
  if (args.requireEmailVerification !== undefined)
    patch.requireEmailVerification = args.requireEmailVerification;
  if (args.hidden !== undefined) patch.hidden = args.hidden;
  if (args.locationText !== undefined) patch.locationText = args.locationText;
  if (args.active !== undefined) patch.active = args.active;
  // BOOKING-LOTTERY §6 — "none" clears the field (patch-with-undefined removes
  // it), restoring standard direct booking.
  if (args.interactionMode !== undefined) {
    patch.interactionMode =
      args.interactionMode === "none" ? undefined : args.interactionMode;
  }
  if (args.lotteryCloseLeadMinutes !== undefined) {
    if (
      !Number.isFinite(args.lotteryCloseLeadMinutes) ||
      args.lotteryCloseLeadMinutes <= 0
    ) {
      throw new ConvexError("lotteryCloseLeadMinutes must be a positive number.");
    }
    patch.lotteryCloseLeadMinutes = args.lotteryCloseLeadMinutes;
  }
  if (args.seatsPerSlot !== undefined) {
    if (!Number.isFinite(args.seatsPerSlot) || args.seatsPerSlot < 1) {
      throw new ConvexError("seatsPerSlot must be a positive number.");
    }
    patch.seatsPerSlot = args.seatsPerSlot;
  }
  if (args.thresholdMinAttendees !== undefined) {
    if (
      !Number.isFinite(args.thresholdMinAttendees) ||
      args.thresholdMinAttendees < 2
    ) {
      throw new ConvexError("thresholdMinAttendees must be at least 2.");
    }
    patch.thresholdMinAttendees = args.thresholdMinAttendees;
  }
  // WAVE-2 threshold coupling: a threshold event needs a group slot big
  // enough to ever reach its minimum, else every round would cancel.
  const effectiveMode =
    (patch.interactionMode as string | undefined) ??
    (args.interactionMode === undefined ? (row.interactionMode as string | undefined) : undefined);
  if (effectiveMode === "threshold") {
    const minA =
      (patch.thresholdMinAttendees as number | undefined) ??
      (row.thresholdMinAttendees as number | undefined);
    const seats =
      (patch.seatsPerSlot as number | undefined) ??
      (row.seatsPerSlot as number | undefined) ??
      1;
    if (!minA || minA < 2) {
      throw new ConvexError("Threshold mode requires thresholdMinAttendees ≥ 2.");
    }
    if (seats < minA) {
      throw new ConvexError(
        "Threshold mode requires seatsPerSlot ≥ thresholdMinAttendees.",
      );
    }
  }

  await ctx.db.patch(args.id, patch);
  return null;
}

export const updateEventType = mutation({
  args: updateEventTypeArgs,
  handler: updateEventTypeHandler,
});

// ─────────────────────────────────────────────────────────────
// CV-6 — setEventTypeHosts (co-host assignment — THE HEADLINE)
// ─────────────────────────────────────────────────────────────
//
// Reconcile the full host roster for one event type in a single mutation: the
// editor's host/co-host picker hands the COMPLETE desired set, so we diff against
// the live `eventTypeHosts` rows and insert-new / patch-changed / delete-removed.
// This is the "both founders free" collective setup: assign two hosts, mark them
// fixed, and the availableSlots/holds/booking READ paths (which already read
// `eventTypeHosts.by_eventType`) intersect their free ranges.
//
// COLLECTIVE invariant: when the event type's schedulingType is "collective"
// (or "managed", treated as collective in the MVP), EVERY host must attend, so
// we force `isFixed = true` regardless of what the caller passed (mirrors cal's
// `isFixed = schedulingType === COLLECTIVE` in heavy/update.handler.ts:502).
// For round_robin we honor the caller's `isFixed` (default false → RR pool).
//
// Hosts are addressed by their dibslist authUserId here (the post-auth core
// contract). The s2s wrapper (calcomAdmin.ts) reverse-resolves cal user ints →
// authUserId before calling this, exactly as the editor round-trips ids.
//
// Owner-rechecked + flag-gated like every other write. The denormalized
// `ownerAuthUserId` on each host row is set to the event type's owner.

export interface EventTypeHostInput {
  hostAuthUserId: string;
  isFixed?: boolean;
  groupId?: string;
  priority?: number;
  weight?: number;
  scheduleId?: Id<"schedules">;
}

export interface SetEventTypeHostsArgs {
  eventTypeId: Id<"eventTypes">;
  hosts: EventTypeHostInput[];
}

export async function setEventTypeHostsHandler(
  ctx: Ctx,
  args: SetEventTypeHostsArgs,
): Promise<{ assigned: number }> {
  const ownerId = await requireAuthUserId(ctx);
  return setEventTypeHostsCore(ctx, ownerId, args);
}

// CV-6 post-auth core (see createEventTypeCore for the auth/flag/ownership model).
export async function setEventTypeHostsCore(
  ctx: Ctx,
  ownerId: string,
  args: SetEventTypeHostsArgs,
): Promise<{ assigned: number }> {
  await gateBooking(ctx);

  const eventType = await ctx.db.get(args.eventTypeId);
  if (!eventType || eventType.ownerAuthUserId !== ownerId) {
    throw new ConvexError("Not found.");
  }

  // Collective (and managed) ⇒ all hosts fixed; round_robin honors the caller.
  const forceFixed = eventType.schedulingType !== "round_robin";

  // De-dupe the desired set by hostAuthUserId (last write wins) so a malformed
  // payload with the same host twice can't create duplicate rows.
  const desired = new Map<string, EventTypeHostInput>();
  for (const h of args.hosts) {
    if (!h.hostAuthUserId) continue;
    desired.set(h.hostAuthUserId, h);
  }

  // Validate any pinned per-host schedule belongs to the event-type owner (the
  // host's schedule lives under the same owner in the single-team model).
  for (const h of desired.values()) {
    if (h.scheduleId) {
      const sched = await ctx.db.get(h.scheduleId);
      if (!sched || sched.ownerAuthUserId !== ownerId) {
        throw new ConvexError("Not found.");
      }
    }
  }

  const existing: Array<Record<string, any>> = await ctx.db
    .query("eventTypeHosts")
    .withIndex("by_eventType", (q: Ctx) => q.eq("eventTypeId", args.eventTypeId))
    .collect();
  const existingByHost = new Map<string, Record<string, any>>();
  for (const row of existing) existingByHost.set(row.hostAuthUserId, row);

  const now = Date.now();

  // Insert new + patch changed.
  for (const [hostAuthUserId, h] of desired) {
    const isFixed = forceFixed ? true : h.isFixed ?? false;
    const fields = {
      isFixed,
      groupId: h.groupId,
      priority: h.priority,
      weight: h.weight,
      scheduleId: h.scheduleId,
    };
    const prior = existingByHost.get(hostAuthUserId);
    if (prior) {
      await ctx.db.patch(prior._id, fields);
    } else {
      await ctx.db.insert("eventTypeHosts", {
        eventTypeId: args.eventTypeId,
        ownerAuthUserId: ownerId,
        hostAuthUserId,
        ...fields,
        createdAt: now,
      });
    }
  }

  // Delete removed (present in DB, absent from the desired set).
  for (const row of existing) {
    if (!desired.has(row.hostAuthUserId)) {
      await ctx.db.delete(row._id);
    }
  }

  await ctx.db.patch(args.eventTypeId, { updatedAt: now });
  return { assigned: desired.size };
}

export const setEventTypeHosts = mutation({
  args: {
    eventTypeId: v.id("eventTypes"),
    hosts: v.array(
      v.object({
        hostAuthUserId: v.string(),
        isFixed: v.optional(v.boolean()),
        groupId: v.optional(v.string()),
        priority: v.optional(v.number()),
        weight: v.optional(v.number()),
        scheduleId: v.optional(v.id("schedules")),
      }),
    ),
  },
  handler: setEventTypeHostsHandler,
});

// CV-6 — owner-scoped READ of an event type's current host roster (NOT
// flag-gated; the owner can inspect what they configured before launch). Each
// row carries the dibslist authUserId; the s2s wrapper enriches with cal ints.
export async function listEventTypeHostsCore(
  ctx: Ctx,
  ownerId: string,
  args: { eventTypeId: Id<"eventTypes"> },
): Promise<Array<Record<string, unknown>>> {
  const eventType = await ctx.db.get(args.eventTypeId);
  if (!eventType || eventType.ownerAuthUserId !== ownerId) {
    throw new ConvexError("Not found.");
  }
  return await ctx.db
    .query("eventTypeHosts")
    .withIndex("by_eventType", (q: Ctx) => q.eq("eventTypeId", args.eventTypeId))
    .collect();
}

export async function listEventTypeHostsHandler(
  ctx: Ctx,
  args: { eventTypeId: Id<"eventTypes"> },
): Promise<Array<Record<string, unknown>>> {
  const ownerId = await requireAuthUserId(ctx);
  return listEventTypeHostsCore(ctx, ownerId, args);
}

export const listEventTypeHosts = query({
  args: { eventTypeId: v.id("eventTypes") },
  handler: listEventTypeHostsHandler,
});

// ─────────────────────────────────────────────────────────────
// CV-8 — duplicateEventType (owner clicks "Duplicate" in the list)
// ─────────────────────────────────────────────────────────────
//
// cal's `eventTypesHeavy.duplicate` clones the full Prisma row + a long tail of
// connected models (customInputs / hashedLink / calVideoSettings / destination
// calendar / webhooks / restriction schedule / recurring + booking/duration
// limits). NONE of those are modeled in our Convex backend, so this CV-8 clone
// copies ONLY the in-scope template fields + the co-host roster (the headline
// "both founders free" panel) — exactly the subset createEventTypeCore +
// setEventTypeHostsCore already write. The dialog pre-uniquifies the slug
// client-side, but we re-mangle defensively so a same-slug clone never throws.
//
// Compose: read source (owner-rechecked) → create with the in-scope scalars →
// clone the host roster verbatim → return the new id. assertSlugFree inside the
// create core still guards a genuine collision (→ ConvexError "Slug already
// taken." which the fork maps to cal's duplicate_event_slug_conflict).

export interface DuplicateEventTypeArgs {
  // The source event type to clone.
  id: Id<"eventTypes">;
  // The dialog supplies the new title/slug (already suffixed/uniquified client-
  // side); we still re-mangle the slug if it collides so a write never throws.
  slug: string;
  title: string;
  description?: string;
  // cal lets the user override the duration in the dialog (input.length).
  durationMinutes?: number;
}

export async function duplicateEventTypeCore(
  ctx: Ctx,
  ownerId: string,
  args: DuplicateEventTypeArgs,
): Promise<{ id: Id<"eventTypes">; slug: string }> {
  await gateBooking(ctx);

  // Source must exist + be owned (createEventTypeCore re-gates the flag too).
  const source = await ctx.db.get(args.id);
  if (!source || source.ownerAuthUserId !== ownerId) {
    throw new ConvexError("Not found.");
  }

  // Defensive slug uniquification: the dialog pre-uniquifies, but if the chosen
  // slug is already taken (race / stale dialog) append a numeric suffix until
  // free, so the clone never hits assertSlugFree's throw. Bounded retries.
  const baseSlug = args.slug.trim() || `${source.slug}-copy`;
  let slug = baseSlug;
  for (let n = 1; n <= 50; n++) {
    const taken = await ctx.db
      .query("eventTypes")
      .withIndex("by_slug", (q: Ctx) => q.eq("slug", slug))
      .unique();
    if (!taken) break;
    slug = `${baseSlug}-${n}`;
  }

  // Create the clone copying ONLY the in-scope template fields from the source
  // (the rest — recurring/limits/customInputs/hashedLink/calVideo/destCal/
  // secondaryEmail/restriction — are NOT modeled and intentionally dropped).
  const newId = await createEventTypeCore(ctx, ownerId, {
    slug,
    title: args.title.trim() || source.title,
    description: args.description ?? source.description,
    durationMinutes: args.durationMinutes ?? source.durationMinutes,
    schedulingType: source.schedulingType,
    scheduleId: source.scheduleId,
    slotIntervalMinutes: source.slotIntervalMinutes,
    minimumBookingNoticeMinutes: source.minimumBookingNoticeMinutes,
    bufferBeforeMinutes: source.bufferBeforeMinutes,
    bufferAfterMinutes: source.bufferAfterMinutes,
    bookingWindowDays: source.bookingWindowDays,
    dailyBookingLimit: source.dailyBookingLimit,
    requireEmailVerification: source.requireEmailVerification ?? false,
    hidden: source.hidden ?? false,
    locationText: source.locationText,
    active: source.active ?? true,
  });

  // Clone the co-host roster (the headline). Read the source hosts and re-assign
  // them onto the clone via the same reconcile core (forces isFixed for
  // collective). Per-host scheduleId is carried verbatim (same owner).
  const sourceHosts = await ctx.db
    .query("eventTypeHosts")
    .withIndex("by_eventType", (q: Ctx) => q.eq("eventTypeId", args.id))
    .collect();
  if (sourceHosts.length > 0) {
    await setEventTypeHostsCore(ctx, ownerId, {
      eventTypeId: newId,
      hosts: sourceHosts.map((h: Record<string, any>) => ({
        hostAuthUserId: h.hostAuthUserId as string,
        isFixed: h.isFixed as boolean | undefined,
        groupId: h.groupId as string | undefined,
        priority: h.priority as number | undefined,
        weight: h.weight as number | undefined,
        scheduleId: h.scheduleId as Id<"schedules"> | undefined,
      })),
    });
  }

  return { id: newId, slug };
}

export async function duplicateEventTypeHandler(
  ctx: Ctx,
  args: DuplicateEventTypeArgs,
): Promise<{ id: Id<"eventTypes">; slug: string }> {
  const ownerId = await requireAuthUserId(ctx);
  return duplicateEventTypeCore(ctx, ownerId, args);
}

export const duplicateEventType = mutation({
  args: {
    id: v.id("eventTypes"),
    slug: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    durationMinutes: v.optional(v.number()),
  },
  handler: duplicateEventTypeHandler,
});

// ─────────────────────────────────────────────────────────────
// listEventTypes — query (owner-scoped, NOT flag-gated)
// ─────────────────────────────────────────────────────────────

export async function listEventTypesHandler(
  ctx: Ctx,
  args: { activeOnly?: boolean },
): Promise<Array<Record<string, unknown>>> {
  const ownerId = await requireAuthUserId(ctx);
  return listEventTypesCore(ctx, ownerId, args);
}

// CV-2b post-auth core (see createEventTypeCore).
export async function listEventTypesCore(
  ctx: Ctx,
  ownerId: string,
  args: { activeOnly?: boolean },
): Promise<Array<Record<string, unknown>>> {
  const rows = args.activeOnly
    ? await ctx.db
        .query("eventTypes")
        .withIndex("by_owner_active", (q: Ctx) =>
          q.eq("ownerAuthUserId", ownerId).eq("active", true),
        )
        .collect()
    : await ctx.db
        .query("eventTypes")
        .withIndex("by_owner", (q: Ctx) => q.eq("ownerAuthUserId", ownerId))
        .collect();

  // Sorted by createdAt descending (newest first).
  return [...rows].sort(
    (a: Record<string, number>, b: Record<string, number>) =>
      (b.createdAt ?? 0) - (a.createdAt ?? 0),
  );
}

export const listEventTypes = query({
  args: { activeOnly: v.optional(v.boolean()) },
  handler: listEventTypesHandler,
});

// ─────────────────────────────────────────────────────────────
// getEventType — query (owner-scoped, NOT flag-gated)
// ─────────────────────────────────────────────────────────────

export async function getEventTypeHandler(
  ctx: Ctx,
  args: { id: Id<"eventTypes"> },
): Promise<Record<string, unknown>> {
  const ownerId = await requireAuthUserId(ctx);
  return getEventTypeCore(ctx, ownerId, args);
}

// CV-2b post-auth core (see createEventTypeCore).
export async function getEventTypeCore(
  ctx: Ctx,
  ownerId: string,
  args: { id: Id<"eventTypes"> },
): Promise<Record<string, unknown>> {
  const row = await ctx.db.get(args.id);
  if (!row || row.ownerAuthUserId !== ownerId) {
    throw new ConvexError("Not found.");
  }
  return row;
}

export const getEventType = query({
  args: { id: v.id("eventTypes") },
  handler: getEventTypeHandler,
});

// ─────────────────────────────────────────────────────────────
// getEventTypeBySlug — query (owner-scoped variant, NOT flag-gated)
// ─────────────────────────────────────────────────────────────
//
// Owner-scoped: returns the full row only if the caller owns it; else null.
// A separate public-safe (unauthenticated, field-stripped) variant will be
// added later as an httpAction — NOT here.

export async function getEventTypeBySlugHandler(
  ctx: Ctx,
  args: { slug: string },
): Promise<Record<string, unknown> | null> {
  const ownerId = await requireAuthUserId(ctx);
  return getEventTypeBySlugCore(ctx, ownerId, args);
}

// CV-2b post-auth core (see createEventTypeCore).
export async function getEventTypeBySlugCore(
  ctx: Ctx,
  ownerId: string,
  args: { slug: string },
): Promise<Record<string, unknown> | null> {
  const row = await ctx.db
    .query("eventTypes")
    .withIndex("by_slug", (q: Ctx) => q.eq("slug", args.slug))
    .unique();
  if (!row || row.ownerAuthUserId !== ownerId) return null;
  return row;
}

export const getEventTypeBySlug = query({
  args: { slug: v.string() },
  handler: getEventTypeBySlugHandler,
});
