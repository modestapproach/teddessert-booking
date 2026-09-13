// CV-5 — the calendar DISCONNECT write path (`viewer.credentials.delete`) is
// rewired off Prisma's `handleDeleteCredential` (the large app-uninstall cascade)
// onto Convex's disconnectCalendar (via the s2s admin wrapper). The UI rounds back
// ONLY the bare cal int credential id (no externalId fallback), so this genuinely
// needs the credentialIdMap: the Convex core resolves the int → the Convex `_id`
// (calendarCredentialIdMap), owner-rechecks, deletes the credential, and cascades
// its selectedCalendars + freebusyCache.
//
// SCOPE NOTE: in dibslist the only connected credentials are CALENDARS (no Stripe/
// Zoom/etc. app installs — those features are disabled per the booking PRD), so
// routing every `credentials.delete` to the calendar disconnect is correct for the
// in-scope surface. `teamId` is team/org-only (dead in our single-user model) and
// is ignored. The zod input schema + the DisconnectIntegration component are
// UNTOUCHED.
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { disconnectOwnerCalendarByCalId } from "@calcom/lib/server/calcomAdminAdapters";

import type { TDeleteCredentialInputSchema } from "./deleteCredential.schema";

type DeleteCredentialOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TDeleteCredentialInputSchema;
};

export const deleteCredentialHandler = async ({ ctx, input }: DeleteCredentialOptions) => {
  const { user } = ctx;
  const { id } = input;

  await disconnectOwnerCalendarByCalId({
    ownerAuthUserId: user.uuid,
    calCredentialId: id,
  });
};
