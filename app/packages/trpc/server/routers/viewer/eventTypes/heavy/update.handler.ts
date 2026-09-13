// CV-6 — EVENT-TYPE EDITOR SAVE rewired to Convex (the headline: co-hosts).
//
// WHY THIS FILE WAS REWRITTEN
// ───────────────────────────
// The original cal handler began with `ctx.prisma.eventType.findUniqueOrThrow`
// (line 98) and ended with `ctx.prisma.eventType.update` — 100% Prisma. On the
// no-Postgres fork it THREW on the first statement for any real edit, so the
// editor Save was dead (the CV-5 sweep flagged this; the earlier CV-2c claim that
// "the editor update routes to Convex" was wrong — the dead `adminUpdateEventType`
// adapter had no caller). This rewires the body to Convex via the owner-admin
// adapters, persisting the IN-SCOPE editor fields + the co-host roster (the "both
// founders free" collective panel). OUT-OF-SCOPE cal fields
// (recurring/seats/payments/limits/workflows/team/children/calVideo/locations[]
// structure/customInputs/metadata/period/buffers-beyond-mapping) are destructured
// out and treated as DOCUMENTED NO-OPS — our Convex backend models none of them.
//
// The cal React components, the tRPC client, and the zod input/output schemas are
// UNTOUCHED — only this resolver body changed. The input is still
// `TUpdateInputSchema`; `id` is the cal INT event-type id the editor round-trips.
//
// Co-host wire shape (from types.ts hostSchema): each host = { userId (cal USER
// int), isFixed?, priority?, weight?, scheduleId? (cal SCHEDULE int), groupId?,
// location? }. The adapter reverse-resolves the cal user/schedule ints; the Convex
// core forces isFixed:true for COLLECTIVE and reconciles the roster. `location`
// (per-host) is OUT OF SCOPE (no per-host location model) — dropped.

import { Prisma } from "@calcom/prisma/client";
import { SchedulingType } from "@calcom/prisma/enums";
import {
  updateOwnerEventTypeByCalId,
  setOwnerEventTypeHostsByCalId,
  getOwnerEventTypeByCalId,
  type CalHostInput,
} from "@calcom/lib/server/calcomAdminAdapters";
import { TRPCError } from "@trpc/server";
import type { GetServerSidePropsContext, NextApiResponse } from "next";

import type { TrpcSessionUser } from "../../../../types";
import type { TUpdateInputSchema } from "./update.schema";

type SessionUser = NonNullable<TrpcSessionUser>;

type User = {
  id: SessionUser["id"];
  // CV-6: dibslist authUserId (owner scope for the Convex write).
  uuid: SessionUser["uuid"];
  username: SessionUser["username"];
  profile: {
    id: SessionUser["profile"]["id"] | null;
  };
  userLevelSelectedCalendars: SessionUser["userLevelSelectedCalendars"];
  organizationId: number | null;
  email: SessionUser["email"];
  locale: string;
};

type UpdateOptions = {
  ctx: {
    user: User;
    res?: NextApiResponse | GetServerSidePropsContext["res"];
    // Retained for type-compat with the cal procedure wiring; NOT used (Convex path).
    prisma: unknown;
  };
  input: TUpdateInputSchema;
};

// cal's UPPERCASE SchedulingType enum (the editor only ever sends these); the
// adapter maps it to our backend's lowercase literal.
function toAdapterSchedulingType(
  t: TUpdateInputSchema["schedulingType"]
): SchedulingType | null | undefined {
  if (t === undefined) return undefined;
  if (t === null) return null;
  if (t === "ROUND_ROBIN") return SchedulingType.ROUND_ROBIN;
  if (t === "MANAGED") return SchedulingType.MANAGED;
  return SchedulingType.COLLECTIVE;
}

// Extract a single free-text location string from cal's structured `locations[]`
// (our backend models only `locationText`). We take the first location's address /
// link / explicit string; structured/integration locations collapse to their type
// label. Returns undefined when no locations were sent (don't clobber).
function toLocationText(locations: TUpdateInputSchema["locations"]): string | undefined {
  if (locations === undefined) return undefined;
  if (locations === null || locations.length === 0) return "";
  const first = locations[0] as Record<string, unknown>;
  const candidate =
    (first.address as string | undefined) ??
    (first.link as string | undefined) ??
    (typeof first.type === "string" ? first.type : undefined);
  return candidate ?? "";
}

export type UpdateEventTypeReturn = { eventType: { id: number; slug: string; [k: string]: unknown } };

export const updateHandler = async ({ ctx, input }: UpdateOptions): Promise<UpdateEventTypeReturn> => {
  const {
    // ── IN-SCOPE (rewired to Convex) ──
    id, // cal INT event-type id
    title: newTitle,
    slug: newSlug,
    description: newDescription,
    length,
    hidden,
    schedulingType,
    scheduleId, // cal INT schedule id (null/0 = unset)
    hosts,
    locations,
    minimumBookingNotice,
    slotInterval,

    // ── OUT-OF-SCOPE (documented no-ops; destructured so they never reach a
    //    write — recurring/seats/payments/limits/workflows/team/children/etc.) ──
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    periodType,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    instantMeetingSchedule,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    bookingLimits,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    durationLimits,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    maxActiveBookingsPerBooker,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    destinationCalendar,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    customInputs,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    recurringEvent,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    eventTypeColor,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    users,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    children,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    assignAllTeamMembers,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    multiplePrivateLinks,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    userId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    bookingFields,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    offsetStart,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    secondaryEmailId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    isRRWeightsEnabled,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    autoTranslateDescriptionEnabled,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    autoTranslateInstantMeetingTitleEnabled,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    seatsPerTimeSlot,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    restrictionScheduleId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    calVideoSettings,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    hostGroups,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    enablePerHostLocations,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    teamId,
    // everything else (price/currency/metadata/period*/buffers/requiresConfirmation
    // /seats*/disable*/etc.) is an out-of-scope passthrough we deliberately ignore.
    ...rest
  } = input;
  void rest;

  const ownerAuthUserId = ctx.user.uuid;

  try {
    // 1) Patch the IN-SCOPE scalar fields. We only forward fields the editor
    //    actually sent (the form sends only DIRTY fields), so an unrelated save
    //    never clobbers an unchanged field. `scheduleId` 0/null = "unset"; our
    //    backend has no unlink op, so 0/null is a documented no-op (the link is
    //    simply left as-is). A positive int re-links via the id-map.
    const calScheduleId =
      typeof scheduleId === "number" && scheduleId > 0 ? scheduleId : undefined;

    await updateOwnerEventTypeByCalId({
      ownerAuthUserId,
      calEventTypeId: id,
      ...(newSlug !== undefined ? { slug: newSlug } : {}),
      ...(newTitle !== undefined ? { title: newTitle } : {}),
      ...(newDescription !== undefined && newDescription !== null
        ? { description: newDescription }
        : {}),
      ...(length !== undefined ? { durationMinutes: length } : {}),
      ...(hidden !== undefined ? { hidden } : {}),
      ...(schedulingType !== undefined
        ? { schedulingType: toAdapterSchedulingType(schedulingType) }
        : {}),
      ...(calScheduleId !== undefined ? { calScheduleId } : {}),
      ...(toLocationText(locations) !== undefined
        ? { locationText: toLocationText(locations) }
        : {}),
      ...(minimumBookingNotice !== undefined
        ? { minimumBookingNoticeMinutes: minimumBookingNotice }
        : {}),
      ...(slotInterval !== undefined && slotInterval !== null
        ? { slotIntervalMinutes: slotInterval }
        : {}),
    });

    // 2) THE HEADLINE — co-host roster. Only when the editor sent `hosts`
    //    (host-assignment tab edited). The Convex core forces isFixed for
    //    collective + reconciles. Per-host `location` is dropped (out of scope).
    if (hosts !== undefined) {
      const calHosts: CalHostInput[] = hosts.map((h) => ({
        calUserId: h.userId,
        ...(h.isFixed !== undefined ? { isFixed: h.isFixed } : {}),
        ...(h.groupId !== undefined ? { groupId: h.groupId } : {}),
        ...(h.priority !== undefined ? { priority: h.priority } : {}),
        ...(h.weight !== undefined ? { weight: h.weight } : {}),
        ...(h.scheduleId !== undefined && h.scheduleId !== null && h.scheduleId > 0
          ? { calScheduleId: h.scheduleId }
          : {}),
      }));
      await setOwnerEventTypeHostsByCalId({
        ownerAuthUserId,
        calEventTypeId: id,
        hosts: calHosts,
      });
    }
  } catch (e) {
    // Map a slug collision (Convex throws ConvexError "Slug already taken.") to the
    // same 400 the cal UI expects; everything else → BAD_REQUEST (the form re-renders
    // the toast). The `booking_disabled` flag-gate also lands here while dark.
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("Slug already taken") || msg.includes("error_event_type_url_duplicate")) {
      throw new TRPCError({ message: "error_event_type_url_duplicate", code: "BAD_REQUEST" });
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new TRPCError({ message: "error_event_type_url_duplicate", code: "BAD_REQUEST" });
    }
    throw new TRPCError({ code: "BAD_REQUEST", message: msg });
  }

  // 3) Build the `{ eventType }` return shape the mutation contract expects. The
  //    editor's onSuccess does NOT read this (it re-reads via
  //    revalidateEventTypeEditPage + eventTypes.get.invalidate); it only needs a
  //    structurally-valid object carrying id + slug. Re-read the fresh row for the
  //    slug (falls back to the input slug).
  const fresh = await getOwnerEventTypeByCalId({ ownerAuthUserId, calEventTypeId: id });
  const finalSlug = fresh?.slug ?? newSlug ?? "";

  const res = ctx.res as NextApiResponse;
  if (typeof res?.revalidate !== "undefined" && ctx.user.username) {
    try {
      await res?.revalidate(`/${ctx.user.username}/${finalSlug}`);
    } catch {
      // Page may not exist yet — revalidation is best-effort.
    }
  }

  return {
    eventType: {
      id,
      slug: finalSlug,
      title: fresh?.title ?? newTitle ?? "",
      schedulingType: schedulingType ?? null,
    },
  };
};
