// CV-5 — the SCHEDULE DELETE write path is rewired off Prisma (schedule.delete +
// the reassign-default cascade + HostRepository) onto Convex's deleteSchedule (via
// the s2s admin wrapper). The editor holds the cal int (input.scheduleId == the
// round-tripped scheduleId); the adapter resolves it → the Convex `_id` via the
// EXISTING scheduleIdMap (no new map needed for this path). The Convex core
// owner-gates, REFUSES deleting the last schedule, promotes the oldest remaining
// schedule to default when the deleted one was default, reassigns pinned event
// types / hosts, and cascades availability + dateOverrides.
//
// The zod input schema + the React components are UNTOUCHED. We map the Convex
// ConvexError back to cal's TRPCError contract (UNAUTHORIZED / BAD_REQUEST) so the
// availability UI keeps its exact behaviour.
import { deleteOwnerScheduleByCalId } from "@calcom/lib/server/calcomAdminAdapters";

import { TRPCError } from "@trpc/server";

import type { TrpcSessionUser } from "../../../../types";
import type { TDeleteInputSchema } from "./delete.schema";

type DeleteOptions = {
  ctx: {
    user: {
      id: NonNullable<TrpcSessionUser>["id"];
      uuid: NonNullable<TrpcSessionUser>["uuid"];
    };
  };
  input: TDeleteInputSchema;
};

export const deleteHandler = async ({ input, ctx }: DeleteOptions) => {
  const { user } = ctx;

  try {
    await deleteOwnerScheduleByCalId({
      ownerAuthUserId: user.uuid,
      calScheduleId: input.scheduleId,
    });
  } catch (err) {
    // Map the Convex core's ConvexError messages to cal's TRPCError contract so
    // the UI behaves identically (UNAUTHORIZED on not-owned/missing; BAD_REQUEST
    // when refusing to delete the only/last schedule).
    const message = err instanceof Error ? err.message : String(err);
    if (/only schedule|last schedule/i.test(message)) {
      throw new TRPCError({ code: "BAD_REQUEST" });
    }
    if (/not found/i.test(message)) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }
    throw err;
  }
};
