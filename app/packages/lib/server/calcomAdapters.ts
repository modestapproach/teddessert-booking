// CV-2a — Convex ↔ cal.com public-booking adapters.
//
// The public Booker (`/[user]/[type]`) needs two pieces of data:
//   1. the event-type META (title/description/length/locations/profile/…),
//      consumed by `getPublicEvent` + the SSR loader, and
//   2. the available SLOTS, consumed by `slots.getSchedule`.
//
// Both used to come from cal's Postgres via Prisma. This module sources them
// from dibslist's Convex backend (meadowlark) instead, and maps the Convex
// shapes onto the exact objects cal's UI/types expect.
//
// ─── What Convex gives us ─────────────────────────────────────────────────────
//
// `scheduling/availableSlots:getAvailableSlots` — a PUBLIC, key-less, NOT
// flag-gated callable `query`. Given `{ slug | eventTypeId, windowStart,
// windowEnd, viewerTimeZone, nowMs? }` (epoch-ms window) it:
//   - validates the event type exists + is active (throws ConvexError("Not
//     found.") otherwise),
//   - returns `{ slotsByDate: Record<"YYYY-MM-DD", AvailableSlot[]>,
//     hosts: {authUserId}[], eventTypeDurationMinutes: number }`
//   where AvailableSlot = `{ startMs, endMs, eligibleHostIdxs?, seatsRemaining? }`.
// This is the authoritative PUBLIC reader: it both confirms the event exists and
// yields its duration, with no auth.
//
// `scheduling/eventTypes:getEventTypeBySlug` — an OWNER-SCOPED callable `query`
// (`requireAuthUserId` then `row.ownerAuthUserId === ownerId`, else null). For an
// ANONYMOUS public Booker hit this ALWAYS returns null — it is only useful when
// the event's OWNER is previewing their own page with a Convex identity token on
// the client. We call it best-effort (never fatal) to enrich title/description/
// location when the viewer happens to own the row.
//
// ─── username ↔ owner-slug mapping decision ───────────────────────────────────
//
// cal's public URL is `/[user]/[type]` (e.g. `/john/30min`). dibslist's event
// type slug is GLOBALLY UNIQUE and flat — there is no per-owner namespace and no
// public "owner handle" on the row (`getEventTypeBySlug` keys on `slug` alone,
// and `eventTypes` carries only the internal `ownerAuthUserId`, never a public
// handle — RECON gap #6). So we map cal's URL to our backend by the **event-type
// slug only**, treating the `[type]` segment as our `slug`. The `[user]` segment
// is retained purely for cal's profile/theme display; it does NOT scope the
// lookup. (If two owners could ever want the same `[type]` slug, our global
// uniqueness constraint already forbids it, so the flat slug is unambiguous.)
//
// We try the `[type]` segment as the slug first; if that misses we fall back to
// `${user}-${type}` and `${user}/${type}` so a future "namespaced slug" scheme
// keeps working without touching this adapter.
//
// ─── Field-gap defaults (documented) ──────────────────────────────────────────
//
// Our backend does NOT model most of cal's rich event-type surface. For every
// such field we supply a cal-shaped default by spreading `getDefaultEvent(slug)`
// (cal's own canonical "minimal valid public event") and overriding only the
// fields we have real Convex data for. Concretely we DEFAULT (not source):
//   - locations         → from `locationText` when present (wrapped as a single
//                          cal location), else the default daily location.
//   - bookingFields     → system-only fields (name/email/phone/location/notes/…)
//                          via getBookingFieldsWithSystemFields with no user
//                          fields (we have no custom booking-field model).
//   - profile/host meta → name/avatar/brandColor/theme are unavailable on the
//                          anonymous read (RECON gap #1: hosts[] is just
//                          {authUserId}); we use cal's placeholder defaults and
//                          the `[user]` URL segment as the display username.
//   - price/currency    → 0 / "usd" (no paid-booking model).
//   - schedulingType    → COLLECTIVE (cal enum); our row's lowercase
//                          collective/round_robin/managed is mapped when the
//                          owner-scoped read succeeds.
//   - seats/recurring/period/instant/team/org → cal defaults (null/false/empty).
//
// See CONVEX-REWIRE-NOTES.md (CV-2a) for the full rationale.

import { DailyLocationType } from "@calcom/app-store/constants";
import type { LocationObject } from "@calcom/app-store/locations";
import { privacyFilteredLocations } from "@calcom/app-store/locations";

// `PrivacyFilteredLocationObject` is not exported from @calcom/app-store/locations;
// derive it from the function's return type so we stay in lock-step with cal.
type PrivacyFilteredLocationObject = ReturnType<typeof privacyFilteredLocations>[number];
import { eventTypeMetaDataSchemaWithTypedApps } from "@calcom/app-store/zod-utils";
import { getBookingFieldsWithSystemFields } from "@calcom/features/bookings/lib/getBookingFields";
import { getDefaultEvent } from "@calcom/features/eventtypes/lib/defaultEvents";
import { getPlaceholderAvatar } from "@calcom/lib/defaultAvatarImage";
import { markdownToSafeHTML } from "@calcom/lib/markdownToSafeHTML";
import { bookerLayouts as bookerLayoutsSchema } from "@calcom/prisma/zod-utils";
import { getConvex } from "@calcom/lib/server/convex";
import { makeFunctionReference } from "convex/server";

// ─── Convex function references (addressed by path; the fork has no _generated) ─

/** PUBLIC, key-less, NOT flag-gated. The authoritative anonymous reader. */
const getAvailableSlotsRef = makeFunctionReference<"query">(
  "scheduling/availableSlots:getAvailableSlots"
);

/** OWNER-SCOPED (returns null for anonymous). Best-effort meta enrichment only. */
const getEventTypeBySlugRef = makeFunctionReference<"query">(
  "scheduling/eventTypes:getEventTypeBySlug"
);

/**
 * CV-2b — PUBLIC, key-less, no-auth event-type META. Unlike `getEventTypeBySlug`
 * (owner-scoped, always null for anonymous), this returns the public-safe DTO
 * (title/description/durationMinutes/location/requireLogin + resolved host
 * displayName+avatarUrl) for ANY caller, so the anonymous Booker SSR finally
 * gets real meta instead of placeholders. Returns null for a missing/inactive
 * event type (→ 404). Registered at `scheduling/publicApi:getPublicEventTypeBySlug`.
 */
const getPublicEventTypeBySlugRef = makeFunctionReference<"query">(
  "scheduling/publicApi:getPublicEventTypeBySlug"
);

// ─── Convex return shapes (mirrors scheduling/availableSlots.ts + eventTypes.ts) ─

export interface ConvexAvailableSlot {
  startMs: number;
  endMs: number;
  eligibleHostIdxs?: number[];
  seatsRemaining?: number;
}

export interface ConvexAvailableSlotsResult {
  slotsByDate: Record<string, ConvexAvailableSlot[]>;
  hosts: Array<{ authUserId: string }>;
  eventTypeDurationMinutes: number;
}

/**
 * CV-2b — the PUBLIC-safe DTO returned by
 * `scheduling/publicApi:getPublicEventTypeBySlug`. Mirrors `PublicEventTypeDto`
 * in the Convex backend (publicApi.ts). Owner internals (ownerAuthUserId,
 * scheduleId, schedulingType, buffers/limits, active/hidden) are NEVER present.
 */
export interface ConvexPublicEventTypeDto {
  slug: string;
  title: string;
  description: string | null;
  durationMinutes: number;
  /** Free-text meeting location / instructions; null when unset. */
  location: string | null;
  /** Reserved per-event-type "must be logged in" gate; false today. */
  requireLogin: boolean;
  /** BOOKING-LOTTERY / WAVE-2 — the "???" mode; drives the Booker flow + copy. */
  interactionMode:
    | "lottery"
    | "first_come"
    | "application"
    | "threshold"
    | "pair"
    | null;
  /** Round modes: entries close this many minutes before the slot. */
  lotteryCloseLeadMinutes: number | null;
  /** Threshold only: minimum attendees for the session to confirm. */
  thresholdMinAttendees: number | null;
  hosts: Array<{ displayName: string; avatarUrl: string | null }>;
}

/** The owner-scoped eventTypes row (partial — only the fields we map). */
export interface ConvexEventTypeRow {
  _id: string;
  slug: string;
  title?: string;
  description?: string;
  durationMinutes: number;
  schedulingType?: "collective" | "round_robin" | "managed";
  locationText?: string;
  requireEmailVerification?: boolean;
  hidden?: boolean;
  seatsPerSlot?: number;
  [k: string]: unknown;
}

// ────────────────────────────────────────────────────────────────────────────
// Slot adapters (slots.getSchedule)
// ────────────────────────────────────────────────────────────────────────────

/**
 * IN adapter: cal's `getScheduleSchema` input → our `getAvailableSlots` args.
 *
 * cal passes ISO date strings + (eventTypeId | usernameList+eventTypeSlug) + a
 * viewer `timeZone`. We pass a `[windowStart, windowEnd)` epoch-ms window + tz,
 * and resolve the event type by SLUG (our flat global slug). The cal numeric
 * `eventTypeId` is a Prisma id that does NOT correspond to a Convex
 * `Id<"eventTypes">`, so we never forward it; we always resolve by slug
 * (`eventTypeSlug`). `duration` is ignored by our backend (the event type owns
 * its duration).
 */
export function toGetAvailableSlotsArgs(input: {
  startTime: string;
  endTime: string;
  eventTypeSlug?: string;
  usernameList?: string[];
  timeZone?: string;
  // cal's getScheduleSchema transforms `duration` to `number | "" | undefined`.
  // Our backend ignores it (the event type owns its duration), so we accept the
  // widened type and never read it.
  duration?: number | "";
}): {
  slug: string;
  windowStart: number;
  windowEnd: number;
  viewerTimeZone: string;
} {
  const slug = input.eventTypeSlug;
  if (!slug) {
    // Our public reader keys on the global slug; an eventTypeId-only request
    // (cal Prisma int) cannot be served by the Convex backend.
    throw new Error(
      "toGetAvailableSlotsArgs: eventTypeSlug is required (Convex resolves by slug, not cal's numeric eventTypeId)"
    );
  }
  return {
    slug,
    windowStart: new Date(input.startTime).getTime(),
    windowEnd: new Date(input.endTime).getTime(),
    // Our backend keys date grouping off this tz; cal almost always sends one.
    viewerTimeZone: input.timeZone || "UTC",
  };
}

/**
 * OUT adapter: our `getAvailableSlots` result → cal's `IGetAvailableSlots`.
 *
 * cal's Booker store (`useAvailableTimeSlots`) reads:
 *   `{ slots: { [YYYY-MM-DD]: Array<{ time: ISOString; attendees?; bookingUid?;
 *      away?; … }> } }`.
 * It destructures `{ time, ...rest }` and turns `time` into a Date. So the ONLY
 * field it strictly needs is `time` (a UTC ISO string); everything else is
 * passed through. Our slots carry `startMs` (epoch-ms) → `new
 * Date(startMs).toISOString()`. We also surface `seatsRemaining` as cal's
 * `attendees`-adjacent group hint when present (group events): cal exposes
 * `attendees` as the BOOKED count, so we don't fake it — we only forward
 * fields cal actually models. `eligibleHostIdxs`/host identities are dropped
 * (cal's public Booker doesn't render host ids; this also avoids leaking the
 * roster). Date keys are already `YYYY-MM-DD` in the viewer's tz, matching cal.
 */
export function toCalSchedule(result: ConvexAvailableSlotsResult): {
  slots: Record<string, Array<{ time: string }>>;
} {
  const slots: Record<string, Array<{ time: string }>> = {};
  for (const [date, daySlots] of Object.entries(result.slotsByDate)) {
    slots[date] = daySlots.map((s) => ({
      time: new Date(s.startMs).toISOString(),
    }));
  }
  return { slots };
}

/**
 * Full slots path: IN-adapt → call Convex (public) → OUT-adapt. Returns cal's
 * `IGetAvailableSlots`-compatible object. A "Not found." ConvexError (missing /
 * inactive event type) maps to an empty `{ slots: {} }` (cal renders "no
 * availability" rather than 500ing the page).
 */
export async function getCalScheduleFromConvex(input: {
  startTime: string;
  endTime: string;
  eventTypeSlug?: string;
  usernameList?: string[];
  timeZone?: string;
  duration?: number | "";
}): Promise<{ slots: Record<string, Array<{ time: string }>> }> {
  const args = toGetAvailableSlotsArgs(input);
  try {
    const result = (await getConvex().query(
      getAvailableSlotsRef,
      args
    )) as ConvexAvailableSlotsResult;
    return toCalSchedule(result);
  } catch (err) {
    // Missing / inactive event type (or any backend miss) → no slots, not a 500.
    return { slots: {} };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Public-event meta adapter (public.event + SSR getPublicEvent)
// ────────────────────────────────────────────────────────────────────────────

// cal SchedulingType enum values are uppercase; our backend stores lowercase.
function toCalSchedulingType(t: string | undefined): "COLLECTIVE" | "ROUND_ROBIN" | "MANAGED" {
  if (t === "round_robin") return "ROUND_ROBIN";
  if (t === "managed") return "MANAGED";
  return "COLLECTIVE";
}

// Wrap our free-text `locationText` as a single cal location object. cal models
// locations structurally; an opaque address string maps to `attendeeInPerson`
// with `displayLocationPublicly` so the Booker renders it. When unset we fall
// back to cal's default daily (video) location (RECON gap #5).
function toCalLocations(locationText: string | undefined): PrivacyFilteredLocationObject[] {
  const locations: LocationObject[] = locationText
    ? [
        {
          type: "inPerson",
          address: locationText,
          displayLocationPublicly: true,
        } as unknown as LocationObject,
      ]
    : [{ type: DailyLocationType }];
  return privacyFilteredLocations(locations);
}

/**
 * Build the cal public-event object for a slug from the Convex backend.
 *
 * Strategy: spread `getDefaultEvent(slug)` (cal's canonical minimal public event
 * — provides EVERY field cal's UI/types touch with sane defaults) and override
 * only the fields we have real Convex data for. This guarantees the returned
 * object is structurally a `PublicEventType` without us having to hand-author
 * dozens of Prisma-derived fields.
 *
 * Data sources, in order of authority:
 *   1. `getPublicEventTypeBySlug` (CV-2b, PUBLIC no-auth) — the authoritative
 *      anonymous reader. Confirms the event EXISTS + is active and yields the
 *      public-safe meta (title, description, durationMinutes, location, and each
 *      host's REAL displayName + avatarUrl). Returns null for a missing/inactive
 *      event type → we return `null` (caller renders 404). This single read works
 *      identically for anonymous visitors AND the owner — no auth token needed.
 *   2. `getEventTypeBySlug` (OWNER-SCOPED, best-effort) — when the viewer owns
 *      the row (a Convex identity token is supplied) we additionally enrich the
 *      few owner-only fields the public DTO intentionally omits
 *      (`schedulingType`, `requireEmailVerification`, `seatsPerSlot`). For an
 *      anonymous hit this is null and the public defaults stand.
 *
 * @param username the cal `[user]` URL segment (display-only; does NOT scope the
 *                 lookup — see the module header's mapping decision). Used only
 *                 as a fallback display name when the host DTO has none.
 * @param eventSlug the cal `[type]` URL segment = our flat global slug.
 * @param authToken optional Convex identity token (the owner's), enabling the
 *                  owner-scoped enrichment read (step 2). Retained for signature
 *                  compatibility; the public meta (step 1) no longer needs it.
 */
export async function mapConvexEventToPublicEvent(args: {
  username: string;
  eventSlug: string;
  fromRedirectOfNonOrgLink: boolean;
  authToken?: string;
}) {
  const { username, eventSlug, fromRedirectOfNonOrgLink, authToken } = args;

  // 1. CV-2b: single PUBLIC read. Works for anonymous visitors and the owner
  //    alike — returns the public-safe DTO (incl. real host displayName/avatar)
  //    or null for a missing/inactive event type → 404. This replaces the old
  //    two-step probe (a wasted getAvailableSlots existence-check + an
  //    owner-scoped read that was ALWAYS null for anonymous visitors, leaving
  //    the page with placeholder title/host meta).
  let dto: ConvexPublicEventTypeDto | null = null;
  try {
    dto = (await getConvex().query(getPublicEventTypeBySlugRef, {
      slug: eventSlug,
    })) as ConvexPublicEventTypeDto | null;
  } catch {
    // The public query never throws (it null-collapses internally), but be
    // defensive about a transport-level failure → 404 rather than a 500.
    return null;
  }
  if (!dto) return null;

  // 2. OWNER-SCOPED best-effort enrichment (null for anonymous viewers). Only
  //    used to recover the few owner-only fields the public DTO omits.
  let row: ConvexEventTypeRow | null = null;
  if (authToken) {
    try {
      row = (await getConvex(authToken).query(getEventTypeBySlugRef, {
        slug: eventSlug,
      })) as ConvexEventTypeRow | null;
    } catch {
      row = null;
    }
  }

  // Real host meta from the public DTO (CV-2b). Falls back to the URL's `[user]`
  // segment for the display name when the host has no profile/preferences name.
  const primaryHost = dto.hosts[0] ?? null;
  const displayName = primaryHost?.displayName ?? username ?? null;
  const avatarUrl = primaryHost?.avatarUrl ?? null;

  const length = dto.durationMinutes;
  const title = dto.title;
  const descriptionMarkdown = dto.description;
  const metadata = eventTypeMetaDataSchemaWithTypedApps.parse({});

  // Start from cal's canonical minimal public event (every field defaulted),
  // then override what we know. getDefaultEvent sets isDynamic:true; the
  // single-event public path must be isDynamic:false.
  const defaultEvent = getDefaultEvent(eventSlug);

  const profileUsername = username || null;

  return {
    ...defaultEvent,
    id: 0, // RECON gap: our id is a Convex string id, not cal's Prisma int. 0 is
    // a harmless placeholder; the Booker keys off slug for the public read path.
    title,
    slug: eventSlug,
    length,
    description: markdownToSafeHTML(descriptionMarkdown),
    eventName: null,
    // schedulingType is NOT in the public DTO (internal routing). Default
    // COLLECTIVE for anonymous reads; recover the real value for an owner preview.
    schedulingType: toCalSchedulingType(row?.schedulingType),
    requiresBookerEmailVerification: row?.requireEmailVerification ?? false,
    hidden: row?.hidden ?? false,
    seatsPerTimeSlot:
      typeof row?.seatsPerSlot === "number" && row.seatsPerSlot > 1 ? row.seatsPerSlot : null,
    // BOOKING-LOTTERY — public "???" mode: the Booker switches to the
    // enter-the-drawing flow (useBookings routes the submit to /api/lottery/enter
    // and redirects to the countdown page). Extra (non-cal) fields ride the
    // inferred return type into the trpc public-event output.
    interactionMode: dto.interactionMode ?? null,
    lotteryCloseLeadMinutes: dto.lotteryCloseLeadMinutes ?? null,
    thresholdMinAttendees: dto.thresholdMinAttendees ?? null,
    metadata,
    // CV-2b: location now comes from the public DTO (was owner-scoped only).
    locations: toCalLocations(dto.location ?? row?.locationText),
    bookingFields: getBookingFieldsWithSystemFields({
      bookingFields: [],
      disableGuests: defaultEvent.disableGuests ?? true,
      customInputs: [],
      metadata,
      // Single (non-dynamic) event → show the booking-title system field.
      disableBookingTitle: true,
    }),
    bookerLayouts: bookerLayoutsSchema.parse(null),
    recurringEvent: null,
    isDynamic: false,
    isInstantEvent: false,
    instantMeetingParameters: [],
    showInstantEventConnectNowModal: false,
    autoTranslateDescriptionEnabled: false,
    fieldTranslations: [],
    customInputs: [],
    // CV-2b: real host display name + avatar from the public DTO (no longer a
    // placeholder). Falls back to the URL `[user]` segment + a placeholder avatar
    // only when the host has no profile/preferences name or stored avatar.
    profile: {
      username: profileUsername,
      name: displayName,
      weekStart: "Sunday",
      image: avatarUrl ?? getPlaceholderAvatar(null, profileUsername),
      // cal's default brand colors (getDefaultEvent doesn't carry brand colors).
      brandColor: "#292929",
      darkBrandColor: "#fafafa",
      theme: null,
      bookerLayouts: bookerLayoutsSchema.parse(null),
    },
    subsetOfUsers: [
      {
        username: profileUsername,
        name: displayName,
        avatarUrl,
        weekStart: "Sunday",
        organizationId: null,
        bookerUrl: process.env.NEXT_PUBLIC_WEBAPP_URL || "https://app.cal.com",
        profile: {
          id: null,
          upId: `usr-0`,
          username: profileUsername,
          organizationId: null,
          organization: null,
        },
      },
    ],
    users: undefined,
    owner: null,
    schedule: null,
    instantMeetingSchedule: null,
    team: null,
    entity: {
      fromRedirectOfNonOrgLink,
      considerUnpublished: false,
      orgSlug: null,
      teamSlug: null,
      name: null,
      hideProfileLink: false,
    },
  };
}
