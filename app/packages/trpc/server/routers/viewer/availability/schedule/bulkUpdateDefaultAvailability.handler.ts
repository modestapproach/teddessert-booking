// CV-8 — bulkUpdateToDefaultAvailability rewired to Convex.
//
// The original cal handler did one `prisma.eventType.updateMany` to repoint the
// listed event types' `scheduleId` onto the (selected or current) default. On the
// no-Postgres fork that THREW. This rewires the body to Convex via the owner-admin
// adapter, which resolves the cal ints via the id-map, owner-scopes each patch,
// and throws "Default schedule not set" when neither a selection nor a current
// default resolves.
//
// In our model the default is the `isDefault` flag on a schedule row (there is no
// `user.defaultScheduleId` column — see CONVEX-REWIRE-NOTES §CV-8), so the Convex
// core resolves the current default from that flag. The cal React components, the
// tRPC client, and the zod input/output schema are UNTOUCHED. The returned
// `{ count }` matches cal's Prisma BatchPayload shape.
import { TRPCError } from "@trpc/server";

import type { TrpcSessionUser } from "../../../../types";
import { bulkUpdateToDefaultAvailability } from "@calcom/lib/server/calcomAdminAdapters";
import type { TBulkUpdateToDefaultAvailabilityInputSchema } from "./bulkUpdateDefaultAvailability.schema";

type BulkUpdateToDefaultAvailabilityOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TBulkUpdateToDefaultAvailabilityInputSchema;
};

export const bulkUpdateToDefaultAvailabilityHandler = async ({
  ctx,
  input,
}: BulkUpdateToDefaultAvailabilityOptions) => {
  const { eventTypeIds, selectedDefaultScheduleId } = input;
  const ownerAuthUserId = ctx.user.uuid;

  try {
    // `eventTypeIds` + `selectedDefaultScheduleId` are cal INTs the availability
    // UI round-trips; the adapter resolves them via the id-map server-side.
    return await bulkUpdateToDefaultAvailability({
      ownerAuthUserId,
      calEventTypeIds: eventTypeIds,
      calSelectedDefaultScheduleId: selectedDefaultScheduleId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The Convex core throws "Default schedule not set" → cal's BAD_REQUEST (the
    // same message the original handler raised). The dark booking_disabled gate +
    // any other error also surface as BAD_REQUEST rather than a raw throw.
    if (/default schedule not set/i.test(message)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Default schedule not set" });
    }
    throw new TRPCError({ code: "BAD_REQUEST", message });
  }
};
