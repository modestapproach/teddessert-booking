import { getBulkUserEventTypes } from "@calcom/app-store/_utils/getBulkEventTypes";
import { getOwnerBulkEventTypesFromConvex } from "@calcom/lib/server/calcomAdminAdapters";

import type { TrpcSessionUser } from "../../../types";

type BulkEventFetchOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
};

export const bulkEventFetchHandler = async ({ ctx }: BulkEventFetchOptions) => {
  // CV-10: fires client-side on the AVAILABILITY LIST + EDITOR mount (the "apply
  // default availability" bulk dialog). `getBulkUserEventTypes` runs a raw
  // `prisma.eventType.findMany` → THROWS on the no-Postgres fork. On the Convex path
  // (`ctx.user.uuid` = the dibslist authUserId, the no-Postgres signal) we source the
  // owner's personal event types from Convex; the returned ids are the persistent cal
  // ints the dialog feeds back into bulkUpdateToDefaultAvailability (CV-8). The original
  // prisma path is LEFT INTACT for the `uuid`-absent case (a real Postgres deploy).
  if (ctx.user.uuid) {
    return getOwnerBulkEventTypesFromConvex({ ownerAuthUserId: ctx.user.uuid });
  }
  return getBulkUserEventTypes(ctx.user.id);
};
