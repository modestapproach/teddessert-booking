// CV-5 — the calendar CONFLICT-TOGGLE (select/deselect a sub-calendar for busy
// checks) is rewired off Prisma's SelectedCalendarRepository onto Convex's
// setCalendarConflictFlag (via the s2s admin wrapper). cal's POST = select
// (checkForConflicts:true), DELETE = deselect (false). The UI rounds back the
// PERSISTENT cal int `credentialId` minted by the connectedCalendars read; the
// Convex core resolves it → the Convex `_id` (calendarCredentialIdMap) and flips
// the flag on the owner's selectedCalendars row.
//
// The zod input schema + the CalendarSwitch component are UNTOUCHED. SEMANTIC GAP
// (documented §CV-5): cal's DELETE REMOVES the selected row entirely; our model
// keeps the enumerated row and sets checkForConflicts=false (the row reappears as
// "not conflict-checked", not gone). `eventTypeId`-scoped selection has no Convex
// model — ignored (user-level only). The legacy GET (unused by the app) keeps its
// shape but no longer hits a calendar provider.
import { defaultResponderForAppDir } from "app/api/defaultResponderForAppDir";
import { cookies, headers } from "next/headers";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { HttpError } from "@calcom/lib/http-error";
import { setOwnerCalendarConflictFlagByCalId } from "@calcom/lib/server/calcomAdminAdapters";

import { buildLegacyRequest } from "@lib/buildLegacyCtx";

const selectedCalendarSelectSchema = z.object({
  integration: z.string(),
  externalId: z.string(),
  credentialId: z.coerce.number(),
  delegationCredentialId: z.string().nullish().default(null),
  eventTypeId: z.coerce.number().nullish(),
});

// CV-5 — resolve the owner's dibslist authUserId (carried on session.user.uuid)
// from the validated Better-Auth cookie. No Prisma user/credential lookup.
async function authMiddleware(): Promise<{ ownerAuthUserId: string }> {
  const session = await getServerSession({ req: buildLegacyRequest(await headers(), await cookies()) });

  if (!session?.user?.id || !session.user.uuid) {
    throw new HttpError({ statusCode: 401, message: "Not authenticated" });
  }

  return { ownerAuthUserId: session.user.uuid };
}

// TODO: It doesn't seem to be used from within the app. It is possible that someone outside Cal.diy is using this GET endpoint
// CV-5 — the legacy "list selectable calendars" GET (unused by the app; the
// connectedCalendars tRPC read drives the UI). Kept for any external caller but no
// longer hits a calendar provider; returns an empty list.
async function getHandler() {
  await authMiddleware();
  return NextResponse.json([]);
}

async function postHandler(req: NextRequest) {
  const { ownerAuthUserId } = await authMiddleware();

  const body = await req.json();
  const { externalId, credentialId } = selectedCalendarSelectSchema.parse(body);

  // POST = select for conflict checking.
  await setOwnerCalendarConflictFlagByCalId({
    ownerAuthUserId,
    calCredentialId: credentialId,
    externalCalendarId: externalId,
    checkForConflicts: true,
  });

  return NextResponse.json({ message: "Calendar Selection Saved" });
}

async function deleteHandler(req: NextRequest) {
  const { ownerAuthUserId } = await authMiddleware();
  const searchParams = Object.fromEntries(req.nextUrl.searchParams.entries());

  const { externalId, credentialId } = selectedCalendarSelectSchema.parse(searchParams);

  // DELETE = deselect (stop conflict checking).
  await setOwnerCalendarConflictFlagByCalId({
    ownerAuthUserId,
    calCredentialId: credentialId,
    externalCalendarId: externalId,
    checkForConflicts: false,
  });

  return NextResponse.json({ message: "Calendar Selection Saved" });
}

export const POST = defaultResponderForAppDir(postHandler);
export const DELETE = defaultResponderForAppDir(deleteHandler);
export const GET = defaultResponderForAppDir(getHandler);
