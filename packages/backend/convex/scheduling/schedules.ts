// BOOKING / A4 — owner CRUD for `schedules` and their child tables
// (`availability` weekly windows + `dateOverrides` single-date exceptions).
// A schedule is a named availability profile ("Working hours") with one tz.
//
// AUTH + FLAG CONTRACT (identical to eventTypes.ts):
//   1. `const ownerId = await requireAuthUserId(ctx)` FIRST.
//   2. WRITE mutations gate on the DEFAULT-OFF `booking_enabled` flag.
//   3. READS are owner-scoped but NOT flag-gated.
// OWNERSHIP violations / missing rows → `ConvexError("Not found.")`.
//
// DENORM: `availability`/`dateOverrides` rows carry `ownerAuthUserId` copied
// from the PARENT schedule row (NOT from args) so owner-scoped scans work and
// a caller can't forge ownership.
//
// TESTABILITY: each handler is exported as a bare async fn AND registered; the
// tests call the registered wrapper's `._handler` against an in-memory fake ctx
// with `requireAuthUserId` mocked (repo convention — see itemPhotos.test.ts).
//
// NOTE: `schedules`/`availability`/`dateOverrides` are NEW tables (codegen
// pending). tsc will flag the string table names against the stale `_generated`
// types — EXPECTED per the task brief.

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

// Load a schedule and assert the caller owns it. Throws "Not found." on any
// miss-or-not-owned (leak-prevention).
async function requireOwnedSchedule(
  ctx: Ctx,
  scheduleId: Id<"schedules">,
  ownerId: string,
): Promise<Record<string, unknown>> {
  const row = await ctx.db.get(scheduleId);
  if (!row || row.ownerAuthUserId !== ownerId) {
    throw new ConvexError("Not found.");
  }
  return row;
}

// Clears any existing default schedule for this owner (at-most-one-default
// invariant). `exceptId` keeps the row being created/updated untouched.
async function clearOtherDefaults(
  ctx: Ctx,
  ownerId: string,
  exceptId?: Id<"schedules">,
): Promise<void> {
  const defaults = await ctx.db
    .query("schedules")
    .withIndex("by_owner_default", (q: Ctx) =>
      q.eq("ownerAuthUserId", ownerId).eq("isDefault", true),
    )
    .collect();
  for (const d of defaults) {
    if (d._id !== exceptId) {
      await ctx.db.patch(d._id, { isDefault: false, updatedAt: Date.now() });
    }
  }
}

// Validates a [startMinute, endMinute) window. Both must be in [0, 1440] and
// start < end. Throws ConvexError otherwise.
function assertWindow(startMinute: number, endMinute: number): void {
  if (
    !Number.isFinite(startMinute) ||
    !Number.isFinite(endMinute) ||
    startMinute < 0 ||
    endMinute > 1440 ||
    startMinute >= endMinute
  ) {
    throw new ConvexError(
      "Invalid window: require 0 <= startMinute < endMinute <= 1440.",
    );
  }
}

// ─────────────────────────────────────────────────────────────
// createSchedule — mutation (flag-gated)
// ─────────────────────────────────────────────────────────────

export async function createScheduleHandler(
  ctx: Ctx,
  args: { name: string; timeZone: string; isDefault: boolean },
): Promise<Id<"schedules">> {
  const ownerId = await requireAuthUserId(ctx);
  return createScheduleCore(ctx, ownerId, args);
}

// CV-2b post-auth core. The auth-gated handler resolves the owner via the Convex
// identity; the server-to-server admin wrapper (calcomAdmin.ts) passes an explicit
// trusted `ownerId`. Both run identical logic.
export async function createScheduleCore(
  ctx: Ctx,
  ownerId: string,
  args: { name: string; timeZone: string; isDefault: boolean },
): Promise<Id<"schedules">> {
  await gateBooking(ctx);

  if (!args.name.trim()) throw new ConvexError("Name is required.");
  if (!args.timeZone.trim()) throw new ConvexError("timeZone is required.");

  if (args.isDefault) await clearOtherDefaults(ctx, ownerId);

  const now = Date.now();
  return await ctx.db.insert("schedules", {
    ownerAuthUserId: ownerId,
    name: args.name,
    timeZone: args.timeZone,
    isDefault: args.isDefault,
    createdAt: now,
    updatedAt: now,
  });
}

export const createSchedule = mutation({
  args: { name: v.string(), timeZone: v.string(), isDefault: v.boolean() },
  handler: createScheduleHandler,
});

// ─────────────────────────────────────────────────────────────
// updateSchedule — mutation (flag-gated)
// ─────────────────────────────────────────────────────────────

export async function updateScheduleHandler(
  ctx: Ctx,
  args: {
    id: Id<"schedules">;
    name?: string;
    timeZone?: string;
    isDefault?: boolean;
  },
): Promise<null> {
  const ownerId = await requireAuthUserId(ctx);
  return updateScheduleCore(ctx, ownerId, args);
}

// CV-2b post-auth core (see createScheduleCore).
export async function updateScheduleCore(
  ctx: Ctx,
  ownerId: string,
  args: {
    id: Id<"schedules">;
    name?: string;
    timeZone?: string;
    isDefault?: boolean;
  },
): Promise<null> {
  await gateBooking(ctx);

  await requireOwnedSchedule(ctx, args.id, ownerId);

  const patch: Record<string, unknown> = { updatedAt: Date.now() };
  if (args.name !== undefined) {
    if (!args.name.trim()) throw new ConvexError("Name is required.");
    patch.name = args.name;
  }
  if (args.timeZone !== undefined) {
    if (!args.timeZone.trim()) throw new ConvexError("timeZone is required.");
    patch.timeZone = args.timeZone;
  }
  if (args.isDefault !== undefined) {
    // Setting THIS as default clears the others first; opting out (false) just
    // leaves the owner with no default until they set another — no enforcement.
    if (args.isDefault) await clearOtherDefaults(ctx, ownerId, args.id);
    patch.isDefault = args.isDefault;
  }

  await ctx.db.patch(args.id, patch);
  return null;
}

export const updateSchedule = mutation({
  args: {
    id: v.id("schedules"),
    name: v.optional(v.string()),
    timeZone: v.optional(v.string()),
    isDefault: v.optional(v.boolean()),
  },
  handler: updateScheduleHandler,
});

// ─────────────────────────────────────────────────────────────
// listSchedules — query (owner-scoped, NOT flag-gated)
// ─────────────────────────────────────────────────────────────

export async function listSchedulesHandler(
  ctx: Ctx,
  _args: Record<string, never>,
): Promise<Array<Record<string, unknown>>> {
  const ownerId = await requireAuthUserId(ctx);
  return listSchedulesCore(ctx, ownerId);
}

// CV-2b post-auth core (see createScheduleCore).
export async function listSchedulesCore(
  ctx: Ctx,
  ownerId: string,
): Promise<Array<Record<string, unknown>>> {
  const rows = await ctx.db
    .query("schedules")
    .withIndex("by_owner", (q: Ctx) => q.eq("ownerAuthUserId", ownerId))
    .collect();
  // Default first, then oldest→newest.
  return [...rows].sort(
    (
      a: { isDefault?: boolean; createdAt?: number },
      b: { isDefault?: boolean; createdAt?: number },
    ) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return (a.createdAt ?? 0) - (b.createdAt ?? 0);
    },
  );
}

export const listSchedules = query({
  args: {},
  handler: listSchedulesHandler,
});

// ─────────────────────────────────────────────────────────────
// getSchedule — query (owner-scoped, NOT flag-gated). Embeds child rows.
// ─────────────────────────────────────────────────────────────

export async function getScheduleHandler(
  ctx: Ctx,
  args: { id: Id<"schedules"> },
): Promise<Record<string, unknown>> {
  const ownerId = await requireAuthUserId(ctx);
  return getScheduleCore(ctx, ownerId, args);
}

// CV-2b post-auth core (see createScheduleCore).
export async function getScheduleCore(
  ctx: Ctx,
  ownerId: string,
  args: { id: Id<"schedules"> },
): Promise<Record<string, unknown>> {
  const schedule = await requireOwnedSchedule(ctx, args.id, ownerId);

  const availability = await ctx.db
    .query("availability")
    .withIndex("by_schedule", (q: Ctx) => q.eq("scheduleId", args.id))
    .collect();
  const dateOverrides = await ctx.db
    .query("dateOverrides")
    .withIndex("by_schedule", (q: Ctx) => q.eq("scheduleId", args.id))
    .collect();

  // Embed children so the schedule editor needs only one round-trip.
  return { ...schedule, availability, dateOverrides };
}

export const getSchedule = query({
  args: { id: v.id("schedules") },
  handler: getScheduleHandler,
});

// ─────────────────────────────────────────────────────────────
// setAvailability — mutation (flag-gated). Full replace of weekly windows.
// ─────────────────────────────────────────────────────────────

export async function setAvailabilityHandler(
  ctx: Ctx,
  args: {
    scheduleId: Id<"schedules">;
    windows: Array<{ days: number[]; startMinute: number; endMinute: number }>;
  },
): Promise<null> {
  const ownerId = await requireAuthUserId(ctx);
  return setAvailabilityCore(ctx, ownerId, args);
}

// CV-2b post-auth core (see createScheduleCore).
export async function setAvailabilityCore(
  ctx: Ctx,
  ownerId: string,
  args: {
    scheduleId: Id<"schedules">;
    windows: Array<{ days: number[]; startMinute: number; endMinute: number }>;
  },
): Promise<null> {
  await gateBooking(ctx);

  const schedule = await requireOwnedSchedule(ctx, args.scheduleId, ownerId);

  // Validate every window before mutating anything (atomic-by-validation).
  for (const w of args.windows) {
    assertWindow(w.startMinute, w.endMinute);
    if (!Array.isArray(w.days) || w.days.length === 0) {
      throw new ConvexError("Each window needs at least one day.");
    }
    for (const d of w.days) {
      if (!Number.isInteger(d) || d < 0 || d > 6) {
        throw new ConvexError("Day values must be integers in [0, 6].");
      }
    }
  }

  // Delete-then-insert (full replace) in one transaction.
  const existing = await ctx.db
    .query("availability")
    .withIndex("by_schedule", (q: Ctx) => q.eq("scheduleId", args.scheduleId))
    .collect();
  for (const row of existing) await ctx.db.delete(row._id);

  const now = Date.now();
  for (const w of args.windows) {
    await ctx.db.insert("availability", {
      scheduleId: args.scheduleId,
      // Denormalized from the PARENT row, never from args.
      ownerAuthUserId: schedule.ownerAuthUserId,
      days: w.days,
      startMinute: w.startMinute,
      endMinute: w.endMinute,
      createdAt: now,
    });
  }
  return null;
}

export const setAvailability = mutation({
  args: {
    scheduleId: v.id("schedules"),
    windows: v.array(
      v.object({
        days: v.array(v.number()),
        startMinute: v.number(),
        endMinute: v.number(),
      }),
    ),
  },
  handler: setAvailabilityHandler,
});

// ─────────────────────────────────────────────────────────────
// addDateOverride — mutation (flag-gated). Upsert per (schedule, date).
// ─────────────────────────────────────────────────────────────

export async function addDateOverrideHandler(
  ctx: Ctx,
  args: {
    scheduleId: Id<"schedules">;
    dateUtc: number;
    startMinute?: number;
    endMinute?: number;
  },
): Promise<Id<"dateOverrides">> {
  const ownerId = await requireAuthUserId(ctx);
  return addDateOverrideCore(ctx, ownerId, args);
}

// CV-2b post-auth core (see createScheduleCore).
export async function addDateOverrideCore(
  ctx: Ctx,
  ownerId: string,
  args: {
    scheduleId: Id<"schedules">;
    dateUtc: number;
    startMinute?: number;
    endMinute?: number;
  },
): Promise<Id<"dateOverrides">> {
  await gateBooking(ctx);

  const schedule = await requireOwnedSchedule(ctx, args.scheduleId, ownerId);

  // Both-or-neither: a partial window is a client bug. Neither = all-day off.
  const hasStart = args.startMinute !== undefined;
  const hasEnd = args.endMinute !== undefined;
  if (hasStart !== hasEnd) {
    throw new ConvexError(
      "startMinute and endMinute must be provided together (or both omitted for an all-day block).",
    );
  }
  if (hasStart && hasEnd) {
    assertWindow(args.startMinute as number, args.endMinute as number);
  }

  // Upsert: overwrite the existing override for this exact date rather than
  // inserting a duplicate (calendar UI re-sets dates freely).
  const existing = await ctx.db
    .query("dateOverrides")
    .withIndex("by_schedule_dateUtc", (q: Ctx) =>
      q.eq("scheduleId", args.scheduleId).eq("dateUtc", args.dateUtc),
    )
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, {
      startMinute: args.startMinute,
      endMinute: args.endMinute,
    });
    return existing._id;
  }

  return await ctx.db.insert("dateOverrides", {
    scheduleId: args.scheduleId,
    ownerAuthUserId: schedule.ownerAuthUserId,
    dateUtc: args.dateUtc,
    startMinute: args.startMinute,
    endMinute: args.endMinute,
    createdAt: Date.now(),
  });
}

export const addDateOverride = mutation({
  args: {
    scheduleId: v.id("schedules"),
    dateUtc: v.number(),
    startMinute: v.optional(v.number()),
    endMinute: v.optional(v.number()),
  },
  handler: addDateOverrideHandler,
});

// ─────────────────────────────────────────────────────────────
// removeDateOverride — mutation (flag-gated)
// ─────────────────────────────────────────────────────────────

export async function removeDateOverrideHandler(
  ctx: Ctx,
  args: { id: Id<"dateOverrides"> },
): Promise<null> {
  const ownerId = await requireAuthUserId(ctx);
  return removeDateOverrideCore(ctx, ownerId, args);
}

// CV-2b post-auth core (see createScheduleCore).
export async function removeDateOverrideCore(
  ctx: Ctx,
  ownerId: string,
  args: { id: Id<"dateOverrides"> },
): Promise<null> {
  await gateBooking(ctx);

  const row = await ctx.db.get(args.id);
  if (!row || row.ownerAuthUserId !== ownerId) {
    throw new ConvexError("Not found.");
  }
  await ctx.db.delete(args.id);
  return null;
}

export const removeDateOverride = mutation({
  args: { id: v.id("dateOverrides") },
  handler: removeDateOverrideHandler,
});

// ─────────────────────────────────────────────────────────────
// deleteSchedule — mutation (flag-gated). CV-5.
// ─────────────────────────────────────────────────────────────
//
// cal's `availability.schedule.delete` deletes a schedule, refusing to delete the
// LAST one, and — if the deleted schedule was the user's default — promotes another
// schedule to default (reassigning host references off the deleted one). Our model
// stores the default as the `isDefault` flag on the schedule row (not a separate
// `user.defaultScheduleId`), so the cascade is:
//   1. owner-gate (requireOwnedSchedule).
//   2. REFUSE if it's the owner's only schedule (BAD_REQUEST — can't delete last).
//   3. If the deleted schedule isDefault, promote the oldest remaining schedule to
//      default (so the owner always has a default).
//   4. Reassign any `eventTypes.scheduleId` / `eventTypeHosts.scheduleId` that pin
//      the deleted schedule onto the new/remaining default (no dangling FK).
//   5. Cascade child `availability` + `dateOverrides` rows.
//   6. Delete the schedule row. (The scheduleIdMap row is left — calIds never reuse.)

export async function deleteScheduleHandler(
  ctx: Ctx,
  args: { id: Id<"schedules"> },
): Promise<null> {
  const ownerId = await requireAuthUserId(ctx);
  return deleteScheduleCore(ctx, ownerId, args);
}

// CV-5 post-auth core (see createScheduleCore).
export async function deleteScheduleCore(
  ctx: Ctx,
  ownerId: string,
  args: { id: Id<"schedules"> },
): Promise<null> {
  await gateBooking(ctx);

  const schedule = await requireOwnedSchedule(ctx, args.id, ownerId);

  // Owner's full schedule set (to enforce at-least-one + pick a new default).
  const all = await ctx.db
    .query("schedules")
    .withIndex("by_owner", (q: Ctx) => q.eq("ownerAuthUserId", ownerId))
    .collect();

  // Refuse to delete the last remaining schedule (cal's BAD_REQUEST).
  if (all.length <= 1) {
    throw new ConvexError("Cannot delete your only schedule.");
  }

  const remaining = all.filter((s: Ctx) => s._id !== args.id);
  // If we're deleting the default, promote the oldest remaining schedule.
  let newDefaultId: Id<"schedules"> | undefined;
  if (schedule.isDefault === true) {
    const promote = [...remaining].sort(
      (a: { createdAt?: number }, b: { createdAt?: number }) =>
        (a.createdAt ?? 0) - (b.createdAt ?? 0),
    )[0];
    if (promote) {
      newDefaultId = promote._id;
      await ctx.db.patch(promote._id, { isDefault: true, updatedAt: Date.now() });
    }
  }

  // Reassign event types / hosts that pin the deleted schedule so no FK dangles.
  // Prefer the freshly-promoted default; else fall back to any remaining default;
  // else the oldest remaining schedule.
  const fallbackTarget =
    newDefaultId ??
    (remaining.find((s: Ctx) => s.isDefault === true)?._id as
      | Id<"schedules">
      | undefined) ??
    (remaining[0]?._id as Id<"schedules"> | undefined);

  try {
    const pinnedEventTypes = await ctx.db
      .query("eventTypes")
      .withIndex("by_owner", (q: Ctx) => q.eq("ownerAuthUserId", ownerId))
      .collect();
    for (const et of pinnedEventTypes) {
      if (et.scheduleId === args.id) {
        await ctx.db.patch(et._id, {
          scheduleId: fallbackTarget,
          updatedAt: Date.now(),
        });
      }
    }
  } catch {
    // eventTypes shape may be codegen-pending; reassignment is best-effort.
  }

  try {
    // eventTypeHosts has no by_owner index; scan via the owner's event types.
    const myEventTypes = await ctx.db
      .query("eventTypes")
      .withIndex("by_owner", (q: Ctx) => q.eq("ownerAuthUserId", ownerId))
      .collect();
    for (const et of myEventTypes) {
      const hosts = await ctx.db
        .query("eventTypeHosts")
        .withIndex("by_eventType", (q: Ctx) => q.eq("eventTypeId", et._id))
        .collect();
      for (const h of hosts) {
        if (h.scheduleId === args.id) {
          await ctx.db.patch(h._id, { scheduleId: fallbackTarget });
        }
      }
    }
  } catch {
    // best-effort host reassignment.
  }

  // Cascade child availability + dateOverrides rows.
  const availability = await ctx.db
    .query("availability")
    .withIndex("by_schedule", (q: Ctx) => q.eq("scheduleId", args.id))
    .collect();
  for (const row of availability) await ctx.db.delete(row._id);

  const overrides = await ctx.db
    .query("dateOverrides")
    .withIndex("by_schedule", (q: Ctx) => q.eq("scheduleId", args.id))
    .collect();
  for (const row of overrides) await ctx.db.delete(row._id);

  await ctx.db.delete(args.id);
  return null;
}

export const deleteSchedule = mutation({
  args: { id: v.id("schedules") },
  handler: deleteScheduleHandler,
});

// ─────────────────────────────────────────────────────────────
// CV-8 — duplicateSchedule (owner clicks "Duplicate" in the availability list)
// ─────────────────────────────────────────────────────────────
//
// cal's `availability.schedule.duplicate` clones a schedule + its availability
// blocks under a "<name> (Copy)" name. Our model also has dateOverrides; we
// clone those too. The clone is FORCED non-default (never steals the default).
// Compose: read source (owner-rechecked, embeds children) → create a new
// schedule (isDefault:false) → full-replace its weekly windows from the source
// → upsert each date override. availability/dateOverrides rows denormalize
// ownerAuthUserId from the PARENT, so the clone auto-owns its children.

export async function duplicateScheduleCore(
  ctx: Ctx,
  ownerId: string,
  args: { id: Id<"schedules"> },
): Promise<{ id: Id<"schedules">; name: string }> {
  await gateBooking(ctx);

  const source = await requireOwnedSchedule(ctx, args.id, ownerId);

  const availability = await ctx.db
    .query("availability")
    .withIndex("by_schedule", (q: Ctx) => q.eq("scheduleId", args.id))
    .collect();
  const overrides = await ctx.db
    .query("dateOverrides")
    .withIndex("by_schedule", (q: Ctx) => q.eq("scheduleId", args.id))
    .collect();

  // Create the clone — NEVER default (don't steal the owner's default).
  const newId = await createScheduleCore(ctx, ownerId, {
    name: `${source.name} (Copy)`,
    timeZone: (source.timeZone as string) ?? "UTC",
    isDefault: false,
  });

  // Clone weekly windows (full replace — clone starts empty).
  if (availability.length > 0) {
    await setAvailabilityCore(ctx, ownerId, {
      scheduleId: newId,
      windows: availability.map((w: Record<string, any>) => ({
        days: w.days as number[],
        startMinute: w.startMinute as number,
        endMinute: w.endMinute as number,
      })),
    });
  }

  // Clone date overrides (each upserts per date on the empty clone).
  for (const o of overrides) {
    await addDateOverrideCore(ctx, ownerId, {
      scheduleId: newId,
      dateUtc: o.dateUtc as number,
      startMinute: o.startMinute as number | undefined,
      endMinute: o.endMinute as number | undefined,
    });
  }

  return { id: newId, name: `${source.name} (Copy)` };
}

export async function duplicateScheduleHandler(
  ctx: Ctx,
  args: { id: Id<"schedules"> },
): Promise<{ id: Id<"schedules">; name: string }> {
  const ownerId = await requireAuthUserId(ctx);
  return duplicateScheduleCore(ctx, ownerId, args);
}

export const duplicateSchedule = mutation({
  args: { id: v.id("schedules") },
  handler: duplicateScheduleHandler,
});

// ─────────────────────────────────────────────────────────────
// CV-8 — bulkUpdateToDefaultAvailability (owner sets a schedule as default →
// repoint many event types onto it)
// ─────────────────────────────────────────────────────────────
//
// cal's `availability.schedule.bulkUpdateToDefaultAvailability` does one
// `eventType.updateMany` to set `scheduleId` on the listed event types to the
// (selected or current) default. Our model has no defaultScheduleId column on
// the user; the default is the `isDefault` flag on a schedule row. So:
//   - resolve the target schedule = the explicit one (if given + owned) else the
//     owner's isDefault schedule (by_owner_default).
//   - REFUSE (BAD_REQUEST-equivalent ConvexError) if neither resolves (mirrors
//     cal's "Default schedule not set").
//   - loop the listed event types (owner-scoped), patch each `scheduleId`.
// Returns `{ count }` (the number actually repointed) to match cal's BatchPayload.

export async function bulkUpdateToDefaultAvailabilityCore(
  ctx: Ctx,
  ownerId: string,
  args: {
    eventTypeIds: Id<"eventTypes">[];
    selectedDefaultScheduleId?: Id<"schedules">;
  },
): Promise<{ count: number }> {
  await gateBooking(ctx);

  // Resolve the target default schedule.
  let targetId: Id<"schedules"> | undefined = args.selectedDefaultScheduleId;
  if (targetId) {
    // Explicit selection must belong to the owner.
    await requireOwnedSchedule(ctx, targetId, ownerId);
  } else {
    const def = await ctx.db
      .query("schedules")
      .withIndex("by_owner_default", (q: Ctx) =>
        q.eq("ownerAuthUserId", ownerId).eq("isDefault", true),
      )
      .first();
    targetId = def?._id as Id<"schedules"> | undefined;
  }
  if (!targetId) {
    throw new ConvexError("Default schedule not set");
  }

  // Repoint each listed event type the owner actually owns.
  let count = 0;
  for (const etId of args.eventTypeIds) {
    const et = await ctx.db.get(etId);
    if (!et || et.ownerAuthUserId !== ownerId) continue; // skip not-owned/missing
    await ctx.db.patch(etId, { scheduleId: targetId, updatedAt: Date.now() });
    count += 1;
  }

  return { count };
}

export async function bulkUpdateToDefaultAvailabilityHandler(
  ctx: Ctx,
  args: {
    eventTypeIds: Id<"eventTypes">[];
    selectedDefaultScheduleId?: Id<"schedules">;
  },
): Promise<{ count: number }> {
  const ownerId = await requireAuthUserId(ctx);
  return bulkUpdateToDefaultAvailabilityCore(ctx, ownerId, args);
}

export const bulkUpdateToDefaultAvailability = mutation({
  args: {
    eventTypeIds: v.array(v.id("eventTypes")),
    selectedDefaultScheduleId: v.optional(v.id("schedules")),
  },
  handler: bulkUpdateToDefaultAvailabilityHandler,
});
