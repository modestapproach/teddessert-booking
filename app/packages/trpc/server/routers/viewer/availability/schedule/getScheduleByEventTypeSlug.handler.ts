// CV-9 — rewired off prisma. The original resolved the event type's `scheduleId`
// via `ctx.prisma.eventType.findUnique({ where: { userId_slug } })` (line 19,
// OUTSIDE the try → it threw uncaught and 500'd the slug-availability path on the
// no-Postgres fork) then fell back to `ctx.prisma.user.findUnique` for the user's
// default. We now resolve the event type's pinned schedule cal int from Convex
// (owner-scoped by slug), and when it has none, fall back to the owner's DEFAULT
// schedule via `get.handler` (called with no scheduleId → picks the isDefault
// schedule). On any failure we keep cal's EMPTY_SCHEDULE fallback. NO `ctx.prisma`.
import { resolveOwnerEventScheduleCalIdBySlug } from "@calcom/lib/server/calcomAdminAdapters";

import type { TrpcSessionUser } from "../../../../types";
import { getHandler } from "./get.handler";
import type { TGetByEventSlugInputSchema } from "./getScheduleByEventTypeSlug.schema";

type GetOptions = {
  ctx: {
    // CV-2c: `uuid` (dibslist authUserId) forwarded to the Convex-backed get.handler.
    user: Pick<NonNullable<TrpcSessionUser>, "id" | "uuid" | "timeZone" | "defaultScheduleId">;
  };
  input: TGetByEventSlugInputSchema;
};

const EMPTY_SCHEDULE = [[], [], [], [], [], [], []];

export const getScheduleByEventSlugHandler = async ({ ctx, input }: GetOptions) => {
  // Resolve the event type's pinned schedule (cal int) from Convex, owner-scoped.
  const pinnedScheduleCalId = await resolveOwnerEventScheduleCalIdBySlug({
    ownerAuthUserId: ctx.user.uuid,
    slug: input.eventSlug,
  });

  try {
    // Explicit schedule when the event pins one; otherwise resolve the owner's
    // default (get.handler with no scheduleId picks the isDefault schedule, else
    // the first; it throws "Schedule not found" when the owner has none).
    return await getHandler({
      ctx,
      input: { scheduleId: pinnedScheduleCalId ?? undefined },
    });
  } catch (e) {
    console.log(e);
    return {
      id: -1,
      name: "No schedules found",
      availability: EMPTY_SCHEDULE,
      dateOverrides: [],
      timeZone: ctx.user.timeZone || "Europe/London",
      workingHours: [],
      isDefault: true,
    };
  }
};
