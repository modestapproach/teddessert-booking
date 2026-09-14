import logger from "@calcom/lib/logger";
import { OWNER_AUTH_USER_ID } from "@calcom/features/auth/lib/dibslistSession";
import { convexIdToCalInt, listOwnerEventTypeRows } from "@calcom/lib/server/calcomAdminAdapters";
import { markdownToSafeHTML } from "@calcom/lib/markdownToSafeHTML";
import prisma from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import type { baseEventTypeSelect } from "@calcom/prisma/selects";
import { EventTypeMetaDataSchema } from "@calcom/prisma/zod-utils";

import { publicEventTypeRows } from "./publicEventTypesFromConvex";

const log = logger.getSubLogger({ prefix: ["getEventTypesPublic"] });

export type EventTypesPublic = Awaited<ReturnType<typeof getEventTypesPublic>>;

export async function getEventTypesPublic(userId: number) {
  const eventTypesWithHidden = await getEventTypesWithHiddenFromDB(userId);

  const eventTypesRaw = eventTypesWithHidden.filter((evt) => !evt.hidden);

  return eventTypesRaw.map((eventType) => ({
    ...eventType,
    metadata: EventTypeMetaDataSchema.parse(eventType.metadata || {}),
    descriptionAsSafeHTML: markdownToSafeHTML(eventType.description),
  }));
}

type BaseEventType = Prisma.EventTypeGetPayload<{
  select: typeof baseEventTypeSelect;
}>;

type RawEventType = BaseEventType & {
  metadata: Record<string, any> | null;
};

const getEventTypesWithHiddenFromDB = async (userId: number) => {
  // CV-11: the `/[user]` PROFILE SSR leaf. On the fork the profile user is the
  // single owner (CV-10 synthesizes it with `id: 0`), so the Postgres user/
  // event-type graph below does not exist; the public listing comes from the
  // owner's Convex rows instead (the same `adminListEventTypes` read the
  // dashboard uses, best-effort → `[]`). The caller drops `hidden` rows; the
  // profile grid renders id/slug/title. Anonymous public SSR → key off
  // `NEXT_PUBLIC_CONVEX_URL`. Prisma path intact for a real Postgres deploy.
  if (process.env.NEXT_PUBLIC_CONVEX_URL) {
    const rows = await listOwnerEventTypeRows({ ownerAuthUserId: OWNER_AUTH_USER_ID });
    // Built field-for-field from cal's baseEventTypeSelect (see the mapper);
    // the cast only bridges Prisma's generated enum/Json types.
    return publicEventTypeRows(rows, convexIdToCalInt) as unknown as RawEventType[];
  }

  const eventTypes = await prisma.$queryRaw<RawEventType[]>`
    SELECT data."id", data."title", data."description", data."length", data."schedulingType"::text,
      data."recurringEvent", data."slug", data."hidden", data."price", data."currency",
      data."lockTimeZoneToggleOnBookingPage", data."lockedTimeZone", data."requiresConfirmation", data."requiresBookerEmailVerification",
      data."metadata", data."canSendCalVideoTranscriptionEmails"
      FROM (
        SELECT "EventType"."id", "EventType"."title", "EventType"."description",
          "EventType"."position", "EventType"."length", "EventType"."schedulingType"::text,
          "EventType"."recurringEvent", "EventType"."slug", "EventType"."hidden",
          "EventType"."price", "EventType"."currency",
          "EventType"."lockTimeZoneToggleOnBookingPage", "EventType"."lockedTimeZone", "EventType"."requiresConfirmation",
          "EventType"."requiresBookerEmailVerification", "EventType"."metadata",
          "EventType"."canSendCalVideoTranscriptionEmails", "EventType"."seatsPerTimeSlot"
        FROM "EventType"
        WHERE "EventType"."teamId" IS NULL AND "EventType"."userId" = ${userId}
        UNION
        SELECT "EventType"."id", "EventType"."title", "EventType"."description",
        "EventType"."position", "EventType"."length", "EventType"."schedulingType"::text,
        "EventType"."recurringEvent", "EventType"."slug", "EventType"."hidden",
        "EventType"."price", "EventType"."currency",
        "EventType"."lockTimeZoneToggleOnBookingPage", "EventType"."lockedTimeZone", "EventType"."requiresConfirmation",
        "EventType"."requiresBookerEmailVerification", "EventType"."metadata",
        "EventType"."canSendCalVideoTranscriptionEmails", "EventType"."seatsPerTimeSlot"
        FROM "EventType"
        WHERE "EventType"."teamId" IS NULL
        AND "EventType"."userId" IS NOT NULL
        AND "EventType"."id" IN (
          SELECT "uet1"."A" FROM "_user_eventtype" AS "uet1"
          INNER JOIN "users" AS "u1" ON "u1"."id" = "uet1"."B"
          WHERE "u1"."id" = ${userId} AND "uet1"."A" IS NOT NULL
      )
    ) data
    ORDER BY data."position" DESC, data."id" ASC`;

  // map and filter metadata, exclude eventType entirely when faulty metadata is found.
  // report error to exception so we don't lose the error.
  return eventTypes.reduce<typeof eventTypes>((eventTypes, eventType) => {
    const parsedMetadata = EventTypeMetaDataSchema.safeParse(eventType.metadata);
    if (!parsedMetadata.success) {
      log.error(parsedMetadata.error);
      return eventTypes;
    }
    eventTypes.push({
      ...eventType,
      metadata: parsedMetadata.data,
    });
    return eventTypes;
  }, []);
};
