import { z } from "zod";

// BOOKING-LOTTERY ("???" tab) — read + write the event type's interaction mode.
// `id` is the cal int event-type id (the createEventPbacProcedure ownership
// middleware requires it).

export const ZGetInteractionModeSchema = z.object({
  id: z.number(),
});
export type TGetInteractionModeSchema = z.infer<typeof ZGetInteractionModeSchema>;

export const ZUpdateInteractionModeSchema = z.object({
  id: z.number(),
  // "none" clears the mode (standard direct booking).
  interactionMode: z.enum([
    "lottery",
    "first_come",
    "application",
    "threshold",
    "pair",
    "none",
  ]),
  thresholdMinAttendees: z.number().int().min(2).max(500).optional(),
  seatsPerSlot: z.number().int().min(1).max(500).optional(),
  // Entries close N minutes before the slot (lottery only; server clamps to
  // max(this, minimumBookingNotice) at draw-time math).
  lotteryCloseLeadMinutes: z.number().int().positive().max(60 * 24 * 30).optional(),
});
export type TUpdateInteractionModeSchema = z.infer<typeof ZUpdateInteractionModeSchema>;
