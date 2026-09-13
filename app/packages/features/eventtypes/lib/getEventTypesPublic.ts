import logger from "@calcom/lib/logger";
import { markdownToSafeHTML } from "@calcom/lib/markdownToSafeHTML";
import prisma from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import type { baseEventTypeSelect } from "@calcom/prisma/selects";
import { EventTypeMetaDataSchema } from "@calcom/prisma/zod-utils";

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
  // CV-11: the `/[user]` PROFILE SSR leaf (NOT in the CV-10 table — that only traced
  // `/[user]/[type]`). `getServerSideProps.ts:165` calls `getEventTypesPublic(user.id)`
  // UNCONDITIONALLY on every profile load; this raw `prisma.$queryRaw` against
  // `"EventType"`/`"users"`/`"_user_eventtype"` THROWS on the no-Postgres fork → 500.
  // On the fork the CV-10 `getUsersInOrgContext` synthesizes a public user with `id: 0`,
  // so there is no real Postgres user/event-type graph to read here anyway. The fork has
  // no per-owner public-event-type-LIST Convex read (the only public Convex surface is the
  // single-event `EventRepository.getPublicEvent`, slug-scoped — §CV-2a); the profile grid
  // is a display-only listing, so the cal-shaped default is an EMPTY event-type array (the
  // SSR `eventTypes.length === 1` redirect and the `.map` both tolerate `[]`). Anonymous
  // public SSR → key off `NEXT_PUBLIC_CONVEX_URL`. Prisma path intact for a real Postgres deploy.
  if (process.env.NEXT_PUBLIC_CONVEX_URL) {
    return [] as RawEventType[];
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
