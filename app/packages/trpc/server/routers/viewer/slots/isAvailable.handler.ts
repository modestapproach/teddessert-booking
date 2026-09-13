import type { NextApiRequest } from "next";

import { EventTypeRepository } from "@calcom/features/eventtypes/repositories/eventTypeRepository";
import { PrismaSelectedSlotRepository } from "@calcom/features/selectedSlots/repositories/PrismaSelectedSlotRepository";
import { HttpError } from "@calcom/lib/http-error";
import { getPastTimeAndMinimumBookingNoticeBoundsStatus } from "@calcom/lib/isOutOfBounds";
import type { PrismaClient } from "@calcom/prisma";

import type { TIsAvailableInputSchema, TIsAvailableOutputSchema } from "./isAvailable.schema";

interface IsAvailableOptions {
  ctx: {
    prisma: PrismaClient;
    req?: NextApiRequest | undefined;
  };
  input: TIsAvailableInputSchema;
}

/**
 * It does a super quick check whether that slot is bookable or not.
 * It doesn't consider slow things like querying the bookings, checking the calendars.
 *
 * getSchedule call is the only(but very slow) way to know if a slot is bookable
 */
export const isAvailableHandler = async ({
  ctx: _ctx,
  input,
}: IsAvailableOptions): Promise<TIsAvailableOutputSchema> => {
  const { slots } = input;

  // CV-9 — PUBLIC/anonymous path. CLEANLY DISABLED. This is a "super quick" optimistic
  // pre-check the Booker runs before the authoritative `slots.getSchedule` (already
  // Convex-rewired) load. The original body did
  // `new EventTypeRepository(ctx.prisma).findByIdMinimal` +
  // `new PrismaSelectedSlotRepository(ctx.prisma).findManyReservedByOthers` — which
  // THROW on the no-Postgres fork (500ing anonymous visitors). There is no Convex
  // transient slot-hold model (see reserveSlot above), so we return every requested
  // slot as `available`; the real availability + booking race-guard live in
  // `getSchedule` + the Convex booking write path. NO `ctx.prisma`.
  const slotsWithStatus: TIsAvailableOutputSchema["slots"] = slots.map((slot) => ({
    ...slot,
    status: "available" as const,
  }));

  return {
    slots: slotsWithStatus,
  };
};
