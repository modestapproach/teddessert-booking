// CV-9 — rewired off prisma. The original read `ctx.prisma.user.findUnique` to get
// the user's `defaultScheduleId` (which threw on the no-Postgres fork — and was
// OUTSIDE the try, so it degraded to the EMPTY_SCHEDULE for every user rather than
// resolving the real default). We now resolve the owner's DEFAULT schedule from
// Convex via the same `get.handler` the availability editor uses: calling it with
// NO `scheduleId` makes `getDetailedScheduleFromConvex` pick the owner's
// `isDefault` schedule (else the first). For the single-owner / no-team fork the
// only meaningful `input.userId` is the owner themselves; we always resolve the
// authed owner's default (Convex is owner-scoped by `ctx.user.uuid`). On any
// failure we keep cal's "not onboarded" EMPTY_SCHEDULE fallback. NO `ctx.prisma`.
import type { TrpcSessionUser } from "../../../../types";
import { getHandler } from "./get.handler";
import type { TGetByUserIdInputSchema } from "./getScheduleByUserId.schema";

type GetOptions = {
  ctx: {
    user: Pick<NonNullable<TrpcSessionUser>, "id" | "uuid" | "timeZone" | "defaultScheduleId">;
  };
  input: TGetByUserIdInputSchema;
};

const EMPTY_SCHEDULE = [[], [], [], [], [], [], []];

export const getScheduleByUserIdHandler = async ({ ctx, input: _input }: GetOptions) => {
  try {
    // No scheduleId → get.handler resolves the owner's default (isDefault) schedule.
    const schedule = await getHandler({ ctx, input: { scheduleId: undefined } });

    return {
      ...schedule,
      hasDefaultSchedule: true,
    };
  } catch (e) {
    // The owner has no schedule yet (not onboarded) — return the empty default,
    // exactly as cal did when `defaultScheduleId` was unset.
    return {
      id: -1,
      name: "Working Hourse",
      availability: EMPTY_SCHEDULE,
      dateOverrides: [],
      timeZone: ctx.user.timeZone || "Europe/London",
      workingHours: [],
      isDefault: true,
      hasDefaultSchedule: false,
    };
  }
};
