// CV-2b — `viewer.eventTypes.list` rewired off Prisma onto the dibslist Convex
// backend. This is a SAFE rewire (see calcomAdminAdapters.ts header): the numeric
// id this returns is display-only — the consumers (onboarding default-seeding +
// the profile getting-started step) only read `length`/`title`/`slug` and check
// `.length === 0`; the id is never round-tripped back into a Convex write.
//
// The return SHAPE is unchanged (`{ id, title, description, length,
// schedulingType, slug, hidden, metadata }[]`) so no consumer or React component
// changes. Personal (non-team) event types only — our backend has no team model.
//
// `ctx.user.uuid` is the dibslist authUserId string (carried through
// getServerSession → the cal Session → ctx.user). We pass it to the Convex
// server-to-server `adminListEventTypes` fn as the owner scope.

import { checkRateLimitAndThrowError } from "@calcom/lib/checkRateLimitAndThrowError";
import { getOwnerEventTypeListFromConvex } from "@calcom/lib/server/calcomAdminAdapters";

import type { TrpcSessionUser } from "../../../types";

type ListOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
};

export const listHandler = async ({ ctx }: ListOptions) => {
  await checkRateLimitAndThrowError({
    identifier: `eventTypes:list:${ctx.user.id}`,
    rateLimitingType: "common",
  });

  // `uuid` is the dibslist authUserId (the Convex owner scope). If it is somehow
  // absent (shouldn't happen for an authed session), the adapter degrades to [].
  return await getOwnerEventTypeListFromConvex({
    ownerAuthUserId: ctx.user.uuid,
  });
};
