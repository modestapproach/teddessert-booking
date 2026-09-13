// B4 — REAL booking → calendar sync with the per-host partial-failure model
// (PRD §5.2 "DECIDED").
//
// WHAT THIS FILE OWNS
//   - `syncToCalendarsHandler` — the action body wired into
//     `internal.scheduling.booking.syncToCalendars` (registered in booking.ts so
//     `scheduleBookingSideEffects`' existing ref stays valid). For each FIXED
//     host on the booking it independently writes/updates/deletes that host's
//     OWN destination calendar event and tracks status in
//     `bookings.externalEvents[]`.
//   - `resyncBookingHandler` — an organizer-triggered retry of `failed` entries
//     (idempotent; never re-touches `synced` ones).
//   - The internalQuery/internalMutation seams the actions need: read the
//     booking + attendees + per-host destination calendar; patch a single
//     `externalEvents[]` entry; seed the pending host roster.
//
// PARTIAL-FAILURE MODEL (the load-bearing invariant)
//   The `bookings` row is the SOURCE OF TRUTH and is NEVER rolled back here. A
//   host whose calendar write fails gets its entry flipped to `failed` (+`tries`
//   incremented, `lastTriedAt` stamped) and a backoff retry scheduled — WITHOUT
//   throwing, so a sibling host's success and the candidate's confirmed slot are
//   untouched. A host with a dead (`invalid`) credential short-circuits to
//   `failed`. After the retry cap an in-app `notifications` row goes to the
//   ORGANIZER with a reconnect/re-sync affordance.
//
// CODEGEN-PENDING REFS: the booking tables + this `scheduling/sync` module are
// brand-new and not yet on the typed `_generated` `internal`, so cross-module
// refs go through the SAME `(internal as any).scheduling?.…` hop precedent used
// in booking.ts / googleCalendar.ts. The runtime paths are correct; a deploy
// regenerates the types. [R] runtime-unverified (mocked-Google + tsc only).

import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { log } from "../_helpers/log";
import type { CalendarEvent } from "./calendarService";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

// ─────────────────────────────────────────────────────────────
// Retry / backoff policy (mirrors webhooks.ts shape)
// ─────────────────────────────────────────────────────────────

// Attempt N uses RETRY_DELAYS_MS[N-1] (last value repeats via the Math.min
// clamp). `tries` on an externalEvents entry counts attempts already made; the
// next reschedule uses that count to pick the delay and is capped at MAX_TRIES.
export const MAX_SYNC_TRIES = 5;
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000]; // 30s, 2m, 10m, 30m

function backoffDelayMs(triesSoFar: number): number {
  const idx = Math.min(Math.max(triesSoFar - 1, 0), RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[idx];
}

type SyncEvent =
  | "BOOKING_CREATED"
  | "BOOKING_CANCELLED"
  | "BOOKING_RESCHEDULED";

// The shape of a single externalEvents[] entry (mirrors schema §3.7).
interface ExternalEventEntry {
  hostAuthUserId: string;
  credentialId: Id<"calendarCredentials">;
  externalCalendarId: string;
  externalEventId?: string;
  syncStatus: "pending" | "synced" | "failed";
  lastTriedAt?: number;
  tries?: number;
}

// ─────────────────────────────────────────────────────────────
// Read seam — load everything the action needs to build CalendarEvents
// ─────────────────────────────────────────────────────────────

interface HostCalendarTarget {
  hostAuthUserId: string;
  credentialId: Id<"calendarCredentials"> | null; // null = no connected calendar
  externalCalendarId: string; // "primary" fallback when no isDestination row
  invalid: boolean; // credential.invalid (dead grant short-circuit)
}

export interface BookingSyncContext {
  booking: {
    _id: Id<"bookings">;
    eventTypeId: Id<"eventTypes">;
    ownerAuthUserId: string;
    startTime: number;
    endTime: number;
    timeZone: string;
    status: string;
    locationText?: string;
    bookerNotes?: string;
    idempotencyKey: string;
    externalEvents?: ExternalEventEntry[];
  };
  eventTitle: string;
  // `phone` is carried through for the D1 SMS channel; it is absent under the
  // A7 bookingAttendees schema (no phone column) until the deploy-auth attendee
  // schema lands, so the SMS path naturally no-ops while it's undefined.
  attendees: Array<{ name: string; email: string; role: string; phone?: string }>;
  // The fixed-host roster + each host's resolved destination calendar. Built by
  // joining bookingAttendees(role=host) → calendarCredentials → selectedCalendars.
  hostTargets: HostCalendarTarget[];
}

// Resolve a single host's active (non-invalid preferred) Google credential + its
// destination calendar. A host with no connected Google calendar yields
// credentialId:null (skipped — nothing to write).
async function resolveHostTarget(
  ctx: Ctx,
  hostAuthUserId: string,
): Promise<HostCalendarTarget> {
  const creds: Array<Record<string, any>> = await ctx.db
    .query("calendarCredentials")
    .withIndex("by_authUserId", (q: Ctx) => q.eq("authUserId", hostAuthUserId))
    .collect();
  const googleCreds = creds.filter((c) => c.provider === "google");
  // Prefer a valid credential; fall back to an invalid one so the action can
  // short-circuit it to `failed` + notice (rather than silently skipping).
  const active = googleCreds.find((c) => c.invalid !== true) ?? googleCreds[0];
  if (!active) {
    return {
      hostAuthUserId,
      credentialId: null,
      externalCalendarId: "primary",
      invalid: false,
    };
  }
  const dest: Record<string, any> | null = await ctx.db
    .query("selectedCalendars")
    .withIndex("by_credential", (q: Ctx) => q.eq("credentialId", active._id))
    .filter((q: Ctx) => q.eq(q.field("isDestination"), true))
    .first();
  return {
    hostAuthUserId,
    credentialId: active._id as Id<"calendarCredentials">,
    externalCalendarId: dest?.externalCalendarId ?? "primary",
    invalid: active.invalid === true,
  };
}

export async function getBookingSyncContextHandler(
  ctx: Ctx,
  args: { bookingId: Id<"bookings"> },
): Promise<BookingSyncContext | null> {
  const booking = await ctx.db.get(args.bookingId);
  if (!booking) return null;

  const eventType = await ctx.db.get(booking.eventTypeId);
  const eventTitle = (eventType?.title as string) ?? "Booking";

  const attendeeRows: Array<Record<string, any>> = await ctx.db
    .query("bookingAttendees")
    .withIndex("by_booking", (q: Ctx) => q.eq("bookingId", args.bookingId))
    .collect();
  const attendees = attendeeRows.map((a) => ({
    name: a.name as string,
    email: a.email as string,
    role: a.role as string,
    // Optional — present only once the attendee schema carries a phone (D1 SMS).
    ...(a.phone !== undefined ? { phone: a.phone as string } : {}),
  }));

  // The fixed-host roster = the host attendee rows. Each maps to one calendar.
  const hostIds = attendeeRows
    .filter((a) => a.role === "host")
    .map((a) => a.name as string); // host rows carry the hostAuthUserId in `name`
  // Solo event (no eventTypeHosts → no role:"host" attendee rows): the OWNER is
  // the implicit host. Without this fallback the roster is empty, no
  // externalEvents are seeded, and the booking is never written to the owner's
  // calendar. Mirrors the owner-fallback in availableSlots.ts / holds.ts.
  const effectiveHostIds =
    hostIds.length > 0 ? hostIds : [booking.ownerAuthUserId as string];
  const hostTargets: HostCalendarTarget[] = [];
  for (const hostAuthUserId of effectiveHostIds) {
    hostTargets.push(await resolveHostTarget(ctx, hostAuthUserId));
  }

  return {
    booking: {
      _id: booking._id,
      eventTypeId: booking.eventTypeId,
      ownerAuthUserId: booking.ownerAuthUserId,
      startTime: booking.startTime,
      endTime: booking.endTime,
      timeZone: booking.timeZone,
      status: booking.status,
      locationText: booking.locationText,
      bookerNotes: booking.bookerNotes,
      idempotencyKey: booking.idempotencyKey,
      externalEvents: booking.externalEvents as ExternalEventEntry[] | undefined,
    },
    eventTitle,
    attendees,
    hostTargets,
  };
}

export const getBookingSyncContext = internalQuery({
  args: { bookingId: v.id("bookings") },
  handler: getBookingSyncContextHandler,
});

// ─────────────────────────────────────────────────────────────
// Write seams — seed the pending roster + patch one entry by host
// ─────────────────────────────────────────────────────────────

const externalEventEntryValidator = v.object({
  hostAuthUserId: v.string(),
  credentialId: v.id("calendarCredentials"),
  externalCalendarId: v.string(),
  externalEventId: v.optional(v.string()),
  syncStatus: v.union(
    v.literal("pending"),
    v.literal("synced"),
    v.literal("failed"),
  ),
  lastTriedAt: v.optional(v.number()),
  tries: v.optional(v.number()),
});

// Seed (or REPLACE) the booking's externalEvents[] with one `pending` entry per
// host that HAS a connected credential. Idempotent: callers pass the full
// roster they intend to write. Only writes for hosts with a credentialId — a
// host with no connected calendar contributes no entry (nothing to sync).
export async function seedExternalEventsHandler(
  ctx: Ctx,
  args: {
    bookingId: Id<"bookings">;
    entries: ExternalEventEntry[];
  },
): Promise<null> {
  const booking = await ctx.db.get(args.bookingId);
  if (!booking) return null;
  await ctx.db.patch(args.bookingId, {
    externalEvents: args.entries,
    updatedAt: Date.now(),
  });
  return null;
}

export const seedExternalEvents = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    entries: v.array(externalEventEntryValidator),
  },
  handler: seedExternalEventsHandler,
});

// Patch a SINGLE externalEvents[] entry (matched by hostAuthUserId) with the
// supplied fields. Reads the current row, maps the matching entry, writes back.
// The booking status is NEVER touched here — calendar sync is downstream of the
// source of truth.
export async function patchExternalEventHandler(
  ctx: Ctx,
  args: {
    bookingId: Id<"bookings">;
    hostAuthUserId: string;
    patch: Partial<ExternalEventEntry>;
  },
): Promise<null> {
  const booking = await ctx.db.get(args.bookingId);
  if (!booking) return null;
  const entries: ExternalEventEntry[] = (booking.externalEvents ?? []).map(
    (e: ExternalEventEntry) =>
      e.hostAuthUserId === args.hostAuthUserId ? { ...e, ...args.patch } : e,
  );
  await ctx.db.patch(args.bookingId, {
    externalEvents: entries,
    updatedAt: Date.now(),
  });
  return null;
}

export const patchExternalEvent = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    hostAuthUserId: v.string(),
    patch: v.object({
      externalEventId: v.optional(v.string()),
      syncStatus: v.optional(
        v.union(
          v.literal("pending"),
          v.literal("synced"),
          v.literal("failed"),
        ),
      ),
      lastTriedAt: v.optional(v.number()),
      tries: v.optional(v.number()),
    }),
  },
  handler: patchExternalEventHandler,
});

// ─────────────────────────────────────────────────────────────
// CalendarEvent mapping
// ─────────────────────────────────────────────────────────────

// Re-encode an arbitrary idempotency string into a Google-safe event id
// (lowercase base32hex, chars [0-9a-v], 5–1024). We hex-encode then map hex
// nibbles into the base32hex alphabet — deterministic + per-host-stable.
const B32HEX = "0123456789abcdefghijklmnopqrstuv";
function toGoogleEventId(seed: string): string {
  let out = "";
  for (let i = 0; i < seed.length && out.length < 200; i++) {
    const code = seed.charCodeAt(i);
    out += B32HEX[(code >> 4) & 0x0f]; // hi nibble (0-15 → 0-f)
    out += B32HEX[code & 0x0f]; // lo nibble
  }
  // Pad to the 5-char minimum.
  while (out.length < 5) out += "0";
  return out;
}

function buildCalendarEvent(
  sctx: BookingSyncContext,
  hostAuthUserId: string,
): CalendarEvent {
  const b = sctx.booking;
  // Attendees: every row with a real email. Host rows carry email:"" in the A7
  // stub (host profile email resolution is Phase B/D) — skip empty emails so we
  // don't post an invalid attendee to Google.
  const attendees = sctx.attendees
    .filter((a) => a.email.length > 0)
    .map((a) => ({ email: a.email, name: a.name }));
  return {
    title: sctx.eventTitle,
    description: b.bookerNotes,
    location: b.locationText,
    start: b.startTime,
    end: b.endTime,
    timeZone: b.timeZone,
    attendees: attendees.length > 0 ? attendees : undefined,
    // Per-host-stable id so a retry of THE SAME host dedupes Google-side.
    idempotencyKey: toGoogleEventId(`${b.idempotencyKey}:${hostAuthUserId}`),
  };
}

// ─────────────────────────────────────────────────────────────
// Codegen-pending refs
// ─────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
const syncRefs = (internal as any).scheduling?.sync;
const gcalRefs = (internal as any).scheduling?.googleCalendar;
const bookingRefs = (internal as any).scheduling?.booking;
const notifRef = (internal as any).notifications?._create;
/* eslint-enable @typescript-eslint/no-explicit-any */

// ─────────────────────────────────────────────────────────────
// Notification — organizer reconnect/re-sync notice after the cap
// ─────────────────────────────────────────────────────────────

async function notifyOrganizerSyncFailed(
  ctx: Ctx,
  organizerAuthUserId: string,
  eventTitle: string,
): Promise<void> {
  if (!notifRef) {
    log.warn("sync.notify.unregistered", { organizerAuthUserId });
    return;
  }
  try {
    await ctx.runMutation(notifRef, {
      authUserId: organizerAuthUserId,
      kind: "calendar_sync_failed",
      title: "Calendar sync failed — reconnect to re-sync",
      body: `We couldn't add "${eventTitle}" to a host's calendar after several tries. Reconnect the calendar to re-sync.`,
      href: "/settings/integrations",
    });
  } catch (err) {
    log.error("sync.notify.failed", err, { organizerAuthUserId });
  }
}

// ─────────────────────────────────────────────────────────────
// Per-host sync — the partial-failure unit of work
// ─────────────────────────────────────────────────────────────

// Calendar-write a single host's entry. Returns nothing — it patches the
// booking row in place and may schedule a retry. NEVER throws (so a sibling
// host's loop iteration is unaffected) and NEVER touches booking.status.
async function syncOneHost(
  ctx: Ctx,
  sctx: BookingSyncContext,
  event: SyncEvent,
  entry: ExternalEventEntry,
): Promise<void> {
  const { _id: bookingId, ownerAuthUserId } = sctx.booking;
  const now = Date.now();
  const triesSoFar = entry.tries ?? 0;

  // Dead credential → short-circuit to failed + (at cap) organizer notice.
  // We can't reliably write to a revoked grant; mark failed and surface it.
  // (resolveHostTarget already preferred a valid credential; if the only one is
  // invalid we land here.)

  try {
    if (event === "BOOKING_CREATED" || event === "BOOKING_RESCHEDULED") {
      // Create the event (reschedule = recreate on the new slot; any stale
      // event from the old booking lives on the OLD booking's externalEvents
      // and is deleted via that booking's BOOKING_CANCELLED path / reschedule
      // cascade).
      if (!gcalRefs?.createEventForCredential) {
        throw new Error("createEventForCredential ref unresolved (deploy pending)");
      }
      const res = (await ctx.runAction(gcalRefs.createEventForCredential, {
        credentialId: entry.credentialId,
        externalCalendarId: entry.externalCalendarId,
        event: buildCalendarEvent(sctx, entry.hostAuthUserId),
      })) as { externalEventId: string };
      await patchEntry(ctx, bookingId, entry.hostAuthUserId, {
        syncStatus: "synced",
        externalEventId: res.externalEventId,
        lastTriedAt: now,
      });
      return;
    }

    if (event === "BOOKING_CANCELLED") {
      // Only entries that actually wrote an event need deletion.
      if (entry.syncStatus !== "synced" || !entry.externalEventId) {
        return; // nothing was written → nothing to delete
      }
      if (!gcalRefs?.deleteEventForCredential) {
        throw new Error("deleteEventForCredential ref unresolved (deploy pending)");
      }
      await ctx.runAction(gcalRefs.deleteEventForCredential, {
        credentialId: entry.credentialId,
        uid: entry.externalEventId,
        externalCalendarId: entry.externalCalendarId,
      });
      // Leave the entry as-is (synced+id) but stamp lastTriedAt so the delete is
      // observable; the booking is cancelled so the entry is historical.
      await patchEntry(ctx, bookingId, entry.hostAuthUserId, {
        lastTriedAt: now,
      });
      return;
    }
  } catch (err) {
    // FAILURE path — flip to failed, bump tries, schedule backoff, and at the
    // cap notify the organizer. NEVER rethrow (per-host isolation) and NEVER
    // touch booking.status (source of truth).
    const tries = triesSoFar + 1;
    log.warn("sync.host.failed", {
      bookingId,
      hostAuthUserId: entry.hostAuthUserId,
      event,
      tries,
      error: err instanceof Error ? err.message : String(err),
    });
    await patchEntry(ctx, bookingId, entry.hostAuthUserId, {
      syncStatus: "failed",
      lastTriedAt: now,
      tries,
    });
    if (tries < MAX_SYNC_TRIES) {
      if (syncRefs?.syncToCalendars) {
        await ctx.scheduler.runAfter(
          backoffDelayMs(tries),
          syncRefs.syncToCalendars,
          { bookingId, event },
        );
      }
    } else {
      await notifyOrganizerSyncFailed(ctx, ownerAuthUserId, sctx.eventTitle);
    }
  }
}

// Thin wrapper so the create/cancel branches share one patch ref hop.
async function patchEntry(
  ctx: Ctx,
  bookingId: Id<"bookings">,
  hostAuthUserId: string,
  patch: Partial<ExternalEventEntry>,
): Promise<void> {
  if (!syncRefs?.patchExternalEvent) {
    log.warn("sync.patch.unregistered", { bookingId, hostAuthUserId });
    return;
  }
  await ctx.runMutation(syncRefs.patchExternalEvent, {
    bookingId,
    hostAuthUserId,
    patch,
  });
}

// ─────────────────────────────────────────────────────────────
// syncToCalendars — the action body (registered in booking.ts)
// ─────────────────────────────────────────────────────────────

export async function syncToCalendarsHandler(
  ctx: Ctx,
  args: { bookingId: Id<"bookings">; event: string },
): Promise<null> {
  const event = args.event as SyncEvent;
  const sctx: BookingSyncContext | null = syncRefs?.getBookingSyncContext
    ? await ctx.runQuery(syncRefs.getBookingSyncContext, {
        bookingId: args.bookingId,
      })
    : await getBookingSyncContextHandler(ctx, { bookingId: args.bookingId });
  if (!sctx) return null;

  if (event === "BOOKING_CREATED" || event === "BOOKING_RESCHEDULED") {
    // 1) Seed one pending entry per host WITH a connected credential. Preserve
    //    any existing entry's tries/status so a re-entrant retry (scheduled
    //    after a failure) doesn't reset the counter. Hosts with no credential
    //    contribute no entry (nothing to write).
    const existing = sctx.booking.externalEvents ?? [];
    const byHost = new Map(existing.map((e) => [e.hostAuthUserId, e]));
    const entries: ExternalEventEntry[] = [];
    for (const t of sctx.hostTargets) {
      if (!t.credentialId) continue; // no connected calendar → skip
      const prior = byHost.get(t.hostAuthUserId);
      entries.push({
        hostAuthUserId: t.hostAuthUserId,
        credentialId: t.credentialId,
        externalCalendarId: t.externalCalendarId,
        externalEventId: prior?.externalEventId,
        // Re-entrant retry keeps prior tries; a fresh seed starts pending/0.
        syncStatus: prior?.syncStatus === "synced" ? "synced" : "pending",
        tries: prior?.tries,
        lastTriedAt: prior?.lastTriedAt,
      });
    }
    if (entries.length === 0) return null; // no connected hosts → nothing to do
    if (syncRefs?.seedExternalEvents) {
      await ctx.runMutation(syncRefs.seedExternalEvents, {
        bookingId: args.bookingId,
        entries,
      });
    } else {
      await seedExternalEventsHandler(ctx, { bookingId: args.bookingId, entries });
    }

    // 2) Per-host create — INDEPENDENT. A dead-credential host short-circuits to
    //    failed; one host throwing does not stop the others (syncOneHost never
    //    rethrows).
    for (const entry of entries) {
      if (entry.syncStatus === "synced") continue; // already done (re-entrant)
      const target = sctx.hostTargets.find(
        (t) => t.hostAuthUserId === entry.hostAuthUserId,
      );
      if (target?.invalid) {
        await handleDeadCredential(ctx, sctx, entry);
        continue;
      }
      await syncOneHost(ctx, sctx, event, entry);
    }
    return null;
  }

  if (event === "BOOKING_CANCELLED") {
    // Delete every host's SYNCED event. Per-host isolation again.
    for (const entry of sctx.booking.externalEvents ?? []) {
      await syncOneHost(ctx, sctx, event, entry);
    }
    return null;
  }

  return null;
}

// A host whose only credential is invalid: flip to failed (+tries), and at the
// cap notify the organizer. No calendar call is attempted.
async function handleDeadCredential(
  ctx: Ctx,
  sctx: BookingSyncContext,
  entry: ExternalEventEntry,
): Promise<void> {
  const tries = (entry.tries ?? 0) + 1;
  await patchEntry(ctx, sctx.booking._id, entry.hostAuthUserId, {
    syncStatus: "failed",
    lastTriedAt: Date.now(),
    tries,
  });
  // A dead credential won't recover on a blind retry — go straight to the
  // organizer notice (reconnect is the only fix) at/after the first detection.
  await notifyOrganizerSyncFailed(ctx, sctx.booking.ownerAuthUserId, sctx.eventTitle);
}

export const syncToCalendars = internalAction({
  args: { bookingId: v.id("bookings"), event: v.string() },
  handler: syncToCalendarsHandler,
});

// ─────────────────────────────────────────────────────────────
// resyncBooking — organizer-triggered retry of failed entries
// ─────────────────────────────────────────────────────────────

// Idempotent: re-attempts ONLY `failed` (and never-attempted `pending`) entries;
// `synced` entries are left untouched. Resets the failed entries' tries so the
// organizer's manual re-sync gets a fresh backoff budget.
export async function resyncBookingHandler(
  ctx: Ctx,
  args: { bookingId: Id<"bookings"> },
): Promise<{ retried: number }> {
  const sctx: BookingSyncContext | null = syncRefs?.getBookingSyncContext
    ? await ctx.runQuery(syncRefs.getBookingSyncContext, {
        bookingId: args.bookingId,
      })
    : await getBookingSyncContextHandler(ctx, { bookingId: args.bookingId });
  if (!sctx) return { retried: 0 };

  const entries = sctx.booking.externalEvents ?? [];
  let retried = 0;
  for (const entry of entries) {
    if (entry.syncStatus === "synced") continue; // idempotent skip
    // Reset the retry budget for a manual re-sync.
    const fresh: ExternalEventEntry = { ...entry, tries: 0, syncStatus: "pending" };
    await patchEntry(ctx, sctx.booking._id, entry.hostAuthUserId, {
      syncStatus: "pending",
      tries: 0,
    });
    const target = sctx.hostTargets.find(
      (t) => t.hostAuthUserId === entry.hostAuthUserId,
    );
    if (target?.invalid) {
      await handleDeadCredential(ctx, sctx, fresh);
      retried++;
      continue;
    }
    await syncOneHost(ctx, sctx, "BOOKING_CREATED", fresh);
    retried++;
  }
  return { retried };
}

export const resyncBooking = internalAction({
  args: { bookingId: v.id("bookings") },
  handler: resyncBookingHandler,
});

// Silence unused-import lint when bookingRefs/ConvexError aren't referenced in
// every branch (kept for symmetry + future organizer-auth wiring).
void bookingRefs;
void ConvexError;
