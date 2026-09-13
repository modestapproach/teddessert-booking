import { getHolidayService } from "@calcom/lib/holidays";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";

import type { TGetUserSettingsSchema } from "./getUserSettings.schema";

type GetUserSettingsOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TGetUserSettingsSchema;
};

export async function getUserSettingsHandler({ ctx }: GetUserSettingsOptions) {
  // no-Postgres fork: HolidayRepository reads `prisma.userHolidaySettings`/`prisma.holidayCache`,
  // which THROW (no DB). On the fork (`ctx.user.uuid` = the dibslist authUserId) holiday settings
  // aren't modeled yet, so return the empty "no country selected" state instead of crashing the
  // Out-of-Office → Holidays tab.
  if (ctx.user.uuid) {
    return { countryCode: null as string | null, holidays: [] };
  }
  const holidayService = getHolidayService();
  return holidayService.getUserSettings(ctx.user.id);
}

export default getUserSettingsHandler;
