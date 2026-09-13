// CV-2c — sourced from Convex via the int↔string schedule id map. The editor
// holds the cal int (input.scheduleId == calId); the adapter resolves it to the
// Convex `_id` and writes name/timeZone/availability/overrides, returning the
// cal `UpdateScheduleResponse`-compatible shape.
import { getAvailabilityFromSchedule } from "@calcom/lib/availability";
import { updateScheduleFromConvex } from "@calcom/lib/server/calcomAdminAdapters";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";

import type { TUpdateInputSchema } from "./update.schema";

type User = NonNullable<TrpcSessionUser>;
type UpdateOptions = {
  ctx: {
    user: {
      id: User["id"];
      uuid: User["uuid"];
      defaultScheduleId: User["defaultScheduleId"];
      timeZone: User["timeZone"];
    };
  };
  input: TUpdateInputSchema;
};

export const updateHandler = async ({ input, ctx }: UpdateOptions) => {
  const { user } = ctx;

  // cal's input.schedule is Date-of-day windows; convert to minute windows.
  const windows =
    input.schedule !== undefined
      ? getAvailabilityFromSchedule(input.schedule).map((a) => ({
          days: a.days,
          startMinute: a.startTime.getUTCHours() * 60 + a.startTime.getUTCMinutes(),
          endMinute: a.endTime.getUTCHours() * 60 + a.endTime.getUTCMinutes(),
        }))
      : undefined;

  // cal's dateOverrides are {start,end} Dates; the start's date = override date,
  // the times' hour:minute = the window. An all-day block is start==end.
  const dateOverrides = (input.dateOverrides ?? []).map((o) => {
    const dateUtc = Date.UTC(
      o.start.getUTCFullYear(),
      o.start.getUTCMonth(),
      o.start.getUTCDate()
    );
    const startMinute = o.start.getUTCHours() * 60 + o.start.getUTCMinutes();
    const endMinute = o.end.getUTCHours() * 60 + o.end.getUTCMinutes();
    const allDay = startMinute === 0 && endMinute === 0;
    return allDay
      ? { dateUtc }
      : { dateUtc, startMinute, endMinute };
  });

  return updateScheduleFromConvex({
    ownerAuthUserId: user.uuid,
    userCalId: user.id,
    userTimeZone: user.timeZone,
    defaultScheduleCalId: user.defaultScheduleId,
    calScheduleId: input.scheduleId,
    name: input.name,
    timeZone: input.timeZone,
    isDefault: input.isDefault,
    windows,
    dateOverrides,
  });
};
