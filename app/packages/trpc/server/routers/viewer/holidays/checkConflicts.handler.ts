import { getHolidayService } from "@calcom/lib/holidays";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";

import type { TCheckConflictsSchema } from "./checkConflicts.schema";

type CheckConflictsOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TCheckConflictsSchema;
};

export type { ConflictingBooking, HolidayConflict } from "@calcom/lib/holidays/HolidayService";

export async function checkConflictsHandler({ ctx, input }: CheckConflictsOptions) {
  // no-Postgres fork: checkConflicts reads `prisma.holidayCache`/`prisma.booking`, which THROW
  // (no DB). On the fork (`ctx.user.uuid` = the dibslist authUserId) there are no holiday-vs-booking
  // conflicts to compute, so return the empty conflict set.
  if (ctx.user.uuid) {
    return { conflicts: [] as HolidayConflict[] };
  }
  const holidayService = getHolidayService();
  return holidayService.checkConflicts(ctx.user.id, input.countryCode, input.disabledIds);
}

export default checkConflictsHandler;
