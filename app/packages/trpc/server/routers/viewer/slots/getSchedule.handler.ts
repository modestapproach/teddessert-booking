// CV-2a — available slots now come from Convex, not the Prisma-backed DI service.
//
// `viewer.slots.getSchedule` is the Booker's availability feed. We replace the
// heavyweight `getAvailableSlotsService()` (Prisma + cal's DI graph) with a thin
// call to the dibslist Convex `scheduling/availableSlots:getAvailableSlots`
// query, IN/OUT-adapted to cal's `getScheduleSchema` input + `IGetAvailableSlots`
// output by the CV-2a adapter helpers.
//
// The handler signature + return type are unchanged (`GetScheduleOptions` →
// `IGetAvailableSlots`), so the tRPC client + Booker store are untouched. See
// packages/lib/server/calcomAdapters.ts for the exact slot IN/OUT mapping.

import { getCalScheduleFromConvex } from "@calcom/lib/server/calcomAdapters";

import type { GetScheduleOptions } from "./types";

export const getScheduleHandler = async ({ input }: GetScheduleOptions) => {
  return await getCalScheduleFromConvex({
    startTime: input.startTime,
    endTime: input.endTime,
    eventTypeSlug: input.eventTypeSlug,
    usernameList: input.usernameList,
    timeZone: input.timeZone,
    duration: input.duration,
  });
};
