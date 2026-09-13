// CV-2c — the schedules list, sourced from Convex via the int↔string id map.
// Each row carries its stable cal int `calId` (echoed as `id`) so the list page's
// links round-trip into `/availability/[id]`. `availability` is the cal
// Prisma-`Availability`-shaped array (the list UI reads only id/name/isDefault).
import {
  listOwnerSchedules,
  toCalAvailabilityRows,
} from "@calcom/lib/server/calcomAdminAdapters";

import type { TrpcSessionUser } from "../../../types";

type ListOptions = {
  ctx: {
    user: Pick<NonNullable<TrpcSessionUser>, "id" | "uuid" | "defaultScheduleId">;
  };
};

export type GetAvailabilityListHandlerReturn = Awaited<ReturnType<typeof listHandler>>;

export const listHandler = async ({ ctx }: ListOptions) => {
  const { user } = ctx;

  const rows = await listOwnerSchedules({ ownerAuthUserId: user.uuid });

  if (rows.length === 0) {
    return {
      schedules: [],
    };
  }

  // The default is the row flagged isDefault (our backend owns the default flag),
  // falling back to the first schedule (cal's getDefaultScheduleId behavior).
  const defaultRow = rows.find((s) => s.isDefault) ?? rows[0];
  const defaultCalId = defaultRow?.calId ?? null;

  return {
    schedules: rows.map((schedule) => ({
      id: schedule.calId ?? 0,
      name: schedule.name,
      // cal Prisma-`Availability`-shaped rows (weekly windows + overrides).
      availability: toCalAvailabilityRows(schedule),
      timeZone: schedule.timeZone ?? null,
      isDefault: (schedule.calId ?? 0) === defaultCalId,
    })),
  };
};
