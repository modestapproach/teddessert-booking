// CV-2c — sourced from Convex via the int↔string schedule id map. Creating a
// schedule mints a stable cal int (calId) which we echo back as the cal
// `schedule.id`; the editor immediately round-trips it into setAvailability.
import { DEFAULT_SCHEDULE, getAvailabilityFromSchedule } from "@calcom/lib/availability";
import {
  createOwnerSchedule,
  setOwnerAvailabilityByCalId,
} from "@calcom/lib/server/calcomAdminAdapters";

import type { TrpcSessionUser } from "../../../../types";
import type { TCreateInputSchema } from "./create.schema";

type CreateOptions = {
  ctx: {
    user: Pick<NonNullable<TrpcSessionUser>, "id" | "uuid" | "timeZone" | "defaultScheduleId">;
  };
  input: TCreateInputSchema;
};

export type CreateScheduleHandlerReturn = Awaited<ReturnType<typeof createHandler>>;

// Convert cal's day/time-of-day availability (Date-based) to our minute windows.
function toMinuteWindows(
  availability: ReturnType<typeof getAvailabilityFromSchedule>
): Array<{ days: number[]; startMinute: number; endMinute: number }> {
  return availability.map((a) => ({
    days: a.days,
    startMinute: a.startTime.getUTCHours() * 60 + a.startTime.getUTCMinutes(),
    endMinute: a.endTime.getUTCHours() * 60 + a.endTime.getUTCMinutes(),
  }));
}

export const createHandler = async ({ input, ctx }: CreateOptions) => {
  const { user } = ctx;
  // CV-2c: a brand-new schedule becomes the user's default when they have none
  // (cal previously wrote user.defaultScheduleId; we mark the schedule default
  // in our backend instead).
  const isDefault = !user.defaultScheduleId;

  const { _id, calId } = await createOwnerSchedule({
    ownerAuthUserId: user.uuid,
    name: input.name,
    timeZone: user.timeZone,
    isDefault,
  });

  // Seed the weekly windows (cal's create seeds DEFAULT_SCHEDULE when none given).
  const availability = getAvailabilityFromSchedule(input.schedule || DEFAULT_SCHEDULE);
  await setOwnerAvailabilityByCalId({
    ownerAuthUserId: user.uuid,
    calScheduleId: calId,
    windows: toMinuteWindows(availability),
  });

  // cal callers read `schedule.id` (int) + `schedule.name`. We return the stable
  // cal int + the convex _id (the latter unused by the UI but handy for logs).
  return {
    schedule: {
      id: calId,
      name: input.name,
      userId: user.id,
      timeZone: user.timeZone,
      _convexId: _id,
    },
  };
};
