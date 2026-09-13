// CV-2c — sourced from Convex via the int↔string schedule id map. The Convex
// `adminGetSchedule`/`adminListSchedules` fns key on the round-tripped cal int
// (calScheduleId); the adapter reproduces the cal `findDetailedScheduleById`
// projection so the availability editor's contract is unchanged.
import { getDetailedScheduleFromConvex } from "@calcom/lib/server/calcomAdminAdapters";

import type { TrpcSessionUser } from "../../../../types";
import type { TGetInputSchema } from "./get.schema";

type GetOptions = {
  ctx: {
    user: Pick<NonNullable<TrpcSessionUser>, "id" | "uuid" | "timeZone" | "defaultScheduleId">;
  };
  input: TGetInputSchema;
};

export const getHandler = async ({ ctx, input }: GetOptions) => {
  return await getDetailedScheduleFromConvex({
    ownerAuthUserId: ctx.user.uuid,
    userCalId: ctx.user.id,
    userTimeZone: ctx.user.timeZone,
    defaultScheduleCalId: ctx.user.defaultScheduleId,
    requestedCalScheduleId: input.scheduleId,
  });
};
