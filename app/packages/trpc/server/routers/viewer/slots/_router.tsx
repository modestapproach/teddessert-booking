import type { NextApiRequest, NextApiResponse } from "next";

import publicProcedure from "../../../procedures/publicProcedure";
import { router } from "../../../trpc";
import { ZIsAvailableInputSchema, ZIsAvailableOutputSchema } from "./isAvailable.schema";
import { ZRemoveSelectedSlotInputSchema } from "./removeSelectedSlot.schema";
import { ZReserveSlotInputSchema } from "./reserveSlot.schema";
import { ZGetScheduleInputSchema } from "./types";

type SlotsRouterHandlerCache = {
  getSchedule?: typeof import("./getSchedule.handler").getScheduleHandler;
  reserveSlot?: typeof import("./reserveSlot.handler").reserveSlotHandler;
  isAvailable?: typeof import("./isAvailable.handler").isAvailableHandler;
};

/** This should be called getAvailableSlots */
export const slotsRouter = router({
  getSchedule: publicProcedure.input(ZGetScheduleInputSchema).query(async ({ input, ctx }) => {
    const { getScheduleHandler } = await import("./getSchedule.handler");

    return getScheduleHandler({
      ctx,
      input,
    });
  }),
  reserveSlot: publicProcedure.input(ZReserveSlotInputSchema).mutation(async ({ input, ctx }) => {
    const { reserveSlotHandler } = await import("./reserveSlot.handler");

    return reserveSlotHandler({
      ctx: { ...ctx, req: ctx.req as NextApiRequest, res: ctx.res as NextApiResponse },
      input,
    });
  }),
  isAvailable: publicProcedure
    .input(ZIsAvailableInputSchema)
    .output(ZIsAvailableOutputSchema)
    .query(async ({ input, ctx }) => {
      const { isAvailableHandler } = await import("./isAvailable.handler");

      return isAvailableHandler({
        ctx: { ...ctx, req: ctx.req as NextApiRequest },
        input,
      });
    }),
  // This endpoint has no dependencies, it doesn't need its own file
  removeSelectedSlotMark: publicProcedure
    .input(ZRemoveSelectedSlotInputSchema)
    .mutation(async () => {
      // CV-9 — PUBLIC/anonymous path. CLEANLY DISABLED-as-no-op. This was a
      // best-effort `prisma.selectedSlots.deleteMany` slot-hold cleanup (the Booker
      // calls it on slot deselect/unmount), which THROWS on the no-Postgres fork.
      // We mint no holds (see reserveSlot), so there is nothing to release — return
      // a no-op. NO `ctx.prisma`.
      return;
    }),
});
