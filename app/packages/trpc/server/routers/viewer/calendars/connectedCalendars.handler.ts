// CV-2c — sourced from Convex via the s2s adminListConnectedCalendars query
// (owner-scoped by ctx.user.uuid). The Convex selectedCalendars shape is mapped
// to cal's CalendarManager wire shape (integration block synthesized from
// provider; per-calendar field renames).
//
// CV-5 — the conflict-toggle, set-destination, and disconnect MUTATION paths are
// now on Convex too. This read mints/fetches the PERSISTENT cal int per credential
// (resolveOwnerCredentialCalIds) and feeds it into the mapper so the UI's numeric
// `credentialId` round-trips back into those writes (instead of the non-reversible
// FNV-1a display hash). See CONVEX-REWIRE-NOTES §CV-5.
import { getConnectedDestinationCalendarsAndEnsureDefaultsInDb } from "@calcom/features/calendars/lib/getConnectedDestinationCalendars";
import {
  listOwnerConnectedCalendars,
  mapConvexConnectedCalendars,
  resolveOwnerCredentialCalIds,
} from "@calcom/lib/server/calcomAdminAdapters";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { PrismaClient } from "@calcom/prisma";
import type { TConnectedCalendarsInputSchema } from "./connectedCalendars.schema";

type ConnectedCalendarsOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
    prisma: PrismaClient;
  };
  input: TConnectedCalendarsInputSchema;
};

type GetConnectedDestinationCalendarsAndEnsureDefaultsInDbResult = Awaited<
  ReturnType<typeof getConnectedDestinationCalendarsAndEnsureDefaultsInDb>
>;

type ConnectedCalendarsHandlerResult = {
  destinationCalendar: GetConnectedDestinationCalendarsAndEnsureDefaultsInDbResult["destinationCalendar"];
  connectedCalendars: (GetConnectedDestinationCalendarsAndEnsureDefaultsInDbResult["connectedCalendars"][number] & {
    cacheUpdatedAt: null;
  })[];
};

export const connectedCalendarsHandler = async ({
  ctx: { user },
  input: _input,
}: ConnectedCalendarsOptions): Promise<ConnectedCalendarsHandlerResult> => {
  const creds = await listOwnerConnectedCalendars({ ownerAuthUserId: user.uuid });

  // CV-5 — mint/fetch the round-trippable cal int per credential so the UI's
  // numeric `credentialId` feeds back into the disconnect/conflict-toggle writes.
  const calIdByConvexId = await resolveOwnerCredentialCalIds({ ownerAuthUserId: user.uuid });

  const { connectedCalendars, destinationCalendar } = mapConvexConnectedCalendars(
    creds,
    calIdByConvexId
  );

  const enrichedConnectedCalendars = connectedCalendars.map((calendar) => ({
    ...(calendar as object),
    cacheUpdatedAt: null,
  }));

  // The synthesized shape mirrors cal's CalendarManager projection; the cast
  // bridges to cal's exact (Prisma-derived) result type. The UI reads only the
  // fields produced by mapConvexConnectedCalendars (documented gap defaults).
  return {
    connectedCalendars: enrichedConnectedCalendars,
    destinationCalendar,
  } as unknown as ConnectedCalendarsHandlerResult;
};
