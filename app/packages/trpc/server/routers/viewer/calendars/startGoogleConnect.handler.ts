// booking-calendar-integration-prd B7 — start the Google Calendar OAuth connect
// for the authenticated owner. Returns the Google consent URL; the client
// navigates there. The owner-scoped Convex mutation (adminStartCalendarConnect)
// signs the OAuth state with ctx.user.uuid, so the callback (on convex.site) needs
// no session — cross-domain-safe.
import { startOwnerCalendarConnect } from "@calcom/lib/server/calcomAdminAdapters";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";

type StartGoogleConnectOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
};

export const startGoogleConnectHandler = async ({
  ctx,
}: StartGoogleConnectOptions): Promise<{ authorizeUrl: string }> => {
  return await startOwnerCalendarConnect({ ownerAuthUserId: ctx.user.uuid });
};
