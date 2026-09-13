// CV-5 — the SET-DESTINATION write path is rewired off Prisma's
// DestinationCalendarRepository.upsert (+ the CalendarManager getConnectedCalendars
// lookup + the eventType ownership Prisma read) onto Convex's
// setDestinationCalendar (via the s2s admin wrapper). cal keys this by
// `integration` + `externalId` strings (NO credential int), so it needs no id-map.
// The Convex core sets the targeted sub-calendar as the owner's single destination
// (`selectedCalendars.isDestination`), clearing the prior one.
//
// The zod input schema + the React components are UNTOUCHED. DOCUMENTED GAPS
// (§CV-5): our backend models destination at the USER level only — the
// `eventTypeId` / `bookingId`-scoped destination cal supports has NO Convex
// equivalent, so those inputs are ignored. `primaryEmail` / `delegationCredentialId`
// are cal-only concepts with no Convex field.
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { setOwnerDestinationCalendar } from "@calcom/lib/server/calcomAdminAdapters";

import type { TSetDestinationCalendarInputSchema } from "./setDestinationCalendar.schema";

type SessionUser = NonNullable<TrpcSessionUser>;
// `uuid` is optional so the eventType-scoped INTERNAL caller
// (eventTypes/heavy/update.handler.ts, whose `ctx.user` type predates uuid) stays
// type-assignable. The owner-facing tRPC call always carries uuid (authedProcedure).
type User = {
  id: SessionUser["id"];
  uuid?: SessionUser["uuid"];
  email: SessionUser["email"];
  userLevelSelectedCalendars: SessionUser["userLevelSelectedCalendars"];
};

type SetDestinationCalendarOptions = {
  ctx: {
    user: User;
  };
  input: TSetDestinationCalendarInputSchema;
};

export const setDestinationCalendarHandler = async ({ ctx, input }: SetDestinationCalendarOptions) => {
  const { user } = ctx;
  const { integration, externalId, eventTypeId } = input;

  // CV-5 — eventType-scoped (or bookingId-scoped) destinations have NO Convex
  // model (user-level only). The internal caller in eventTypes/heavy/update passes
  // `eventTypeId`; that path is a NO-OP here (documented gap §CV-5). Only the
  // owner-facing user-level destination dropdown reaches the Convex write.
  if (eventTypeId) return;

  // Without uuid we can't address the owner in Convex — skip rather than throw
  // (defensive; the owner-facing path always supplies uuid).
  if (!user.uuid) return;

  // Owner-scoped by user.uuid (the dibslist authUserId). The Convex core finds the
  // owner's selected calendar matching externalId (+ provider derived from
  // integration), sets it as the single destination, and clears the prior one.
  await setOwnerDestinationCalendar({
    ownerAuthUserId: user.uuid,
    integration,
    externalCalendarId: externalId,
  });
};
