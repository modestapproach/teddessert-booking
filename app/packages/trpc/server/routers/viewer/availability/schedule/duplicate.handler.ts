// CV-8 — SCHEDULE DUPLICATE rewired to Convex.
//
// The original cal handler did `prisma.schedule.findUnique` + `prisma.schedule.
// create` (cloning availability via createMany). On the no-Postgres fork it THREW
// on the first statement, so the availability list's "Duplicate" was dead. This
// rewires the body to Convex via the owner-admin adapter, which clones the
// schedule's availability blocks AND date overrides under a "<name> (Copy)" name,
// forced non-default (never steals the owner's default).
//
// The cal React components, the tRPC client, and the zod input/output schema are
// UNTOUCHED — only this resolver body changed. `input.scheduleId` is the cal INT
// the list round-trips; the adapter resolves it via the EXISTING scheduleIdMap.
// The returned `{ schedule: { id, name } }` is what the list's onSuccess reads
// (it navigates to `/availability/{id}` + toasts the name).
import { TRPCError } from "@trpc/server";

import type { TrpcSessionUser } from "../../../../types";
import { duplicateOwnerScheduleByCalId } from "@calcom/lib/server/calcomAdminAdapters";
import type { TScheduleDuplicateSchema } from "./duplicate.schema";

type DuplicateScheduleOptions = {
  ctx: {
    user: Pick<NonNullable<TrpcSessionUser>, "id" | "uuid" | "timeZone">;
  };
  input: TScheduleDuplicateSchema;
};

export type DuplicateScheduleHandlerReturn = Awaited<ReturnType<typeof duplicateHandler>>;

export const duplicateHandler = async ({ ctx, input }: DuplicateScheduleOptions) => {
  const { scheduleId } = input;
  const ownerAuthUserId = ctx.user.uuid;

  try {
    const { calId, name } = await duplicateOwnerScheduleByCalId({
      ownerAuthUserId,
      calScheduleId: scheduleId,
    });
    // The list's onSuccess reads schedule.id (navigate) + schedule.name (toast).
    return { schedule: { id: calId, name } };
  } catch (err) {
    // Map the Convex ConvexError to cal's TRPCError contract (UNAUTHORIZED on
    // not-owned/missing; everything else — incl. the dark booking_disabled gate —
    // → INTERNAL_SERVER_ERROR, matching the original handler's catch-all).
    const message = err instanceof Error ? err.message : String(err);
    if (/not found/i.test(message)) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  }
};
