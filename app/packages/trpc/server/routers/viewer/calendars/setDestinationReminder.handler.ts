// CV-8 — setDestinationReminder CLEANLY DISABLED (no Convex destination-reminder model).
//
// cal's `calendars.setDestinationReminder` writes a custom-reminder setting onto a
// connected DESTINATION calendar (via the DestinationCalendar DI repo → Prisma).
// dibslist's Convex backend models a destination calendar flag (CV-5
// setDestinationCalendar) but NOT a per-destination custom-reminder field, so
// there is nothing to write here. The original body called the Prisma-backed
// `destinationCalendarRepository.updateCustomReminder`, which THREW on the
// no-Postgres fork.
//
// Per the CV-8 "never leave a raw prisma throw reachable" rule, this is a clean
// NO-OP returning the original `{ success: true }` shape, so the destination-
// calendar settings panel does not error when the owner picks a reminder. The
// reminder selection simply isn't persisted (documented in CONVEX-REWIRE-NOTES
// §CV-8). The zod input schema + the React settings UI are UNTOUCHED.
import type { TrpcSessionUser } from "@calcom/trpc/server/types";

import type { TSetDestinationReminderInputSchema } from "./setDestinationReminder.schema";

type SetDestinationReminderOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TSetDestinationReminderInputSchema;
};

export const setDestinationReminderHandler = async (
  _opts: SetDestinationReminderOptions
): Promise<{ success: true }> => {
  // No-op: our Convex backend has no per-destination custom-reminder field.
  // Return the original success shape so the settings panel doesn't throw.
  return { success: true };
};
