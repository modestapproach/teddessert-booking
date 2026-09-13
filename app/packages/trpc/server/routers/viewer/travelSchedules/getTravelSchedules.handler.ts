import { TravelScheduleRepository } from "@calcom/features/travelSchedule/repositories/TravelScheduleRepository";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";

type GetTravelSchedulesOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
};

export const getTravelSchedulesHandler = async ({ ctx }: GetTravelSchedulesOptions) => {
  // CV-10: reached on the AVAILABILITY EDITOR load (`/availability/[schedule]` SSR runs
  // `travelSchedulesCaller.get()` in parallel with the Convex-safe `schedule.get`). The
  // repository's raw `prisma.travelSchedule.findMany` THROWS on the no-Postgres fork → 500s
  // the editor. dibslist's booking backend does not model per-user travel schedules, so on
  // the fork (`ctx.user.uuid` = the dibslist authUserId, the no-Postgres signal) we return
  // the empty list — the cal-shaped default the editor renders as "no travel schedules". The
  // original prisma path is LEFT INTACT for the `uuid`-absent case (a real Postgres deploy).
  if (ctx.user.uuid) {
    return [] as Awaited<ReturnType<typeof TravelScheduleRepository.findTravelSchedulesByUserId>>;
  }
  return await TravelScheduleRepository.findTravelSchedulesByUserId(ctx.user.id);
};
