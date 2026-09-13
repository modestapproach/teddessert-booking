import { handleMarkHostNoShow } from "@calcom/features/handleMarkNoShow";

import type { TNoShowInputSchema } from "./markHostAsNoShow.schema";

type NoShowOptions = {
  input: TNoShowInputSchema;
};

// TODO: Track which attendee actually called this endpoint to mark host as no-show.
// Currently this is completely anonymous and public endpoint.
export const noShowHandler = async ({ input }: NoShowOptions) => {
  const { bookingUid, noShowHost } = input;

  // no-Postgres fork: handleMarkHostNoShow is raw prisma (booking read + write)
  // and THROWS. This is a PUBLIC endpoint auto-fired by /booking/[uid]?noShow=true
  // (the confirmation page's useEffect), so an anonymous booker can trip a 500.
  // Host-no-show isn't modeled on the fork's Convex bookings yet — degrade to a
  // graceful no-op shaped like ResponsePayloadResult. Prisma path kept for Postgres.
  if (process.env.NEXT_PUBLIC_CONVEX_URL) {
    return {
      attendees: [],
      noShowHost: false,
      message: "No-show tracking is not available.",
    };
  }

  return handleMarkHostNoShow({
    bookingUid,
    noShowHost,
  });
};

export default noShowHandler;
