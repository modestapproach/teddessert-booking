"use server";

import { revalidateTag } from "next/cache";

import { TravelScheduleRepository } from "@calcom/features/travelSchedule/repositories/TravelScheduleRepository";
import { NEXTJS_CACHE_TTL } from "@calcom/lib/constants";
import { unstable_cache } from "@calcom/lib/unstable_cache";

const CACHE_TAGS = {
  TRAVEL_SCHEDULES: "TravelRepository.findTravelSchedulesByUserId",
} as const;

export const getTravelSchedule = unstable_cache(
  async (userId: number) => {
    // CV (booking-onboarding-flow-prd step 19): findTravelSchedulesByUserId is a raw
    // prisma.travelSchedule.findMany that THROWS on the no-Postgres fork → 500s
    // /settings/my-account/general (reachable from the user-dropdown "My settings").
    // The booking fork has no travel-schedule feature, so return []. Prisma path
    // preserved for a real Postgres deploy.
    if (process.env.NEXT_PUBLIC_CONVEX_URL) return [];
    return await TravelScheduleRepository.findTravelSchedulesByUserId(userId);
  },
  ["getTravelSchedule"],
  {
    revalidate: NEXTJS_CACHE_TTL,
    tags: [CACHE_TAGS.TRAVEL_SCHEDULES],
  }
);

export const revalidateTravelSchedules = async () => {
  revalidateTag(CACHE_TAGS.TRAVEL_SCHEDULES, "max");
};
