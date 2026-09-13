// CV-8 — EVENT-TYPE DUPLICATE rewired to Convex.
//
// WHY THIS FILE WAS REWRITTEN
// ───────────────────────────
// The original cal handler opened with `prisma.eventType.findUnique` and ran a
// fan-out of Prisma writes (eventType.create + customInputs/hashedLink/calVideo/
// destinationCalendar/membership). On the no-Postgres fork it THREW on the first
// statement, so the list's "Duplicate" action was dead. This rewires the body to
// Convex via the owner-admin adapter, which clones ONLY the in-scope template
// fields (title/slug/description/length + schedulingType/scheduleId/buffers/
// notice/slotInterval/locationText) PLUS the co-host roster. The long tail of
// connected models cal copies (customInputs, hashedLink/private-booking-links,
// calVideoSettings, destinationCalendar, restrictionSchedule, recurringEvent,
// booking/duration limits, secondaryEmail, webhooks) is NOT modeled in our Convex
// backend and is intentionally DROPPED — documented in CONVEX-REWIRE-NOTES §CV-8.
//
// The cal React DuplicateDialog, the tRPC client, and the zod input/output schema
// are UNTOUCHED — only this resolver body changed. `input.id` is the cal INT
// event-type id the dialog round-trips; `slug` is pre-uniquified client-side (we
// re-mangle defensively server-side so a same-slug clone never throws). The
// returned `{ eventType: { id, slug, ... } }` shape is what the dialog's onSuccess
// consumes (it then redirects to the new event type's edit page by slug).

import { TRPCError } from "@trpc/server";

import type { TrpcSessionUser } from "../../../../types";
import { duplicateOwnerEventTypeByCalId } from "@calcom/lib/server/calcomAdminAdapters";
import type { TDuplicateInputSchema } from "./duplicate.schema";

type DuplicateOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TDuplicateInputSchema;
};

export const duplicateHandler = async ({ ctx, input }: DuplicateOptions) => {
  const {
    id: originalEventTypeId,
    title: newEventTitle,
    slug: newSlug,
    description: newDescription,
    length: newLength,
    // `teamId` is team-only (dead in our single-owner model) — ignored.
  } = input;

  const ownerAuthUserId = ctx.user.uuid;

  try {
    const { calId, slug } = await duplicateOwnerEventTypeByCalId({
      ownerAuthUserId,
      calEventTypeId: originalEventTypeId,
      slug: newSlug,
      title: newEventTitle,
      description: newDescription,
      durationMinutes: newLength,
    });

    // The dialog's onSuccess reads `eventType.id` (to navigate) + `slug`. We
    // return the clone's stable cal int id + its final (server-uniquified) slug,
    // plus the echoed title/length so any consumer reading them stays valid.
    return {
      eventType: {
        id: calId,
        slug,
        title: newEventTitle,
        length: newLength,
        description: newDescription,
      },
    };
  } catch (error) {
    // Map a Convex slug collision the server couldn't auto-resolve to cal's
    // CONFLICT contract (the dialog surfaces "duplicate_event_slug_conflict").
    const msg = error instanceof Error ? error.message : String(error);
    if (/slug already taken/i.test(msg) || /duplicate_event_slug_conflict/i.test(msg)) {
      throw new TRPCError({ code: "CONFLICT", message: "duplicate_event_slug_conflict" });
    }
    // The `booking_disabled` flag-gate (dark before launch) + any other backend
    // error land here. Surface a clean 400/500 rather than leaking the raw error.
    if (/not available|booking_disabled|not found/i.test(msg)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: msg });
    }
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Error duplicating event type ${error}`,
    });
  }
};
