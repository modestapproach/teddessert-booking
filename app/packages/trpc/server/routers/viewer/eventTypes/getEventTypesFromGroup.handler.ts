import { EventTypeRepository } from "@calcom/features/eventtypes/repositories/eventTypeRepository";
import { hasFilter } from "@calcom/features/filters/lib/hasFilter";
import {
  type ConvexOwnerEventTypeRow,
  listOwnerEventTypeRows,
} from "@calcom/lib/server/calcomAdminAdapters";
import { checkRateLimitAndThrowError } from "@calcom/lib/checkRateLimitAndThrowError";
import logger from "@calcom/lib/logger";
import type { PrismaClient } from "@calcom/prisma";
import { prisma } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import { SchedulingType } from "@calcom/prisma/enums";
import type { TrpcSessionUser } from "../../../types";
import type { TGetEventTypesFromGroupSchema } from "./getByViewer.schema";
import { mapEventType } from "./util";

const log = logger.getSubLogger({ prefix: ["getEventTypesFromGroup"] });

type GetByViewerOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
    prisma: PrismaClient;
  };
  input: TGetEventTypesFromGroupSchema;
};

type EventType = Awaited<ReturnType<EventTypeRepository["findAllByUpId"]>>[number];
type MappedEventType = Awaited<ReturnType<typeof mapEventType>>;
type MappedEventTypeWithHostFlag = MappedEventType & { isCurrentUserHost: boolean };

// CV-10: synthesize the cal `EventType` row the list-mapper consumes from ONE Convex
// owner event-type row. Mirrors `getEventTypeById.ts:buildDefaultRawEventType` — only the
// fields the listing UI renders (id/title/slug/description/length/hidden/schedulingType/
// position/eventTypeColor/recurringEvent/userId/teamId + the empty relations) are populated;
// `users`/`hosts`/`children` are [] so `mapEventType`'s `enrichUserWithItsProfile` (prisma)
// never runs. `id` is the PERSISTENT cal int (round-tripped by the row's edit/reorder/delete
// actions). Cast to the findAllByUpId row type — the cast only widens primitives we set.
function buildDefaultEventTypeRowForList(row: ConvexOwnerEventTypeRow, userId: number): EventType {
  const schedulingType =
    row.schedulingType === "round_robin"
      ? SchedulingType.ROUND_ROBIN
      : row.schedulingType === "managed"
        ? SchedulingType.MANAGED
        : row.schedulingType === "collective"
          ? SchedulingType.COLLECTIVE
          : null;
  return {
    id: row.calId ?? 0,
    title: row.title,
    slug: row.slug,
    description: row.description ?? null,
    length: row.durationMinutes,
    hidden: row.hidden ?? false,
    position: 0,
    userId,
    teamId: null,
    team: null,
    schedulingType,
    eventTypeColor: null,
    recurringEvent: null,
    metadata: null,
    seatsPerTimeSlot: null,
    requiresConfirmation: false,
    hashedLink: [],
    users: [],
    hosts: [],
    children: [],
    parentId: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

export const getEventTypesFromGroup = async ({
  ctx,
  input,
}: GetByViewerOptions): Promise<{
  eventTypes: MappedEventTypeWithHostFlag[];
  nextCursor: number | null | undefined;
}> => {
  await checkRateLimitAndThrowError({
    identifier: `eventTypes:getEventTypesFromGroup:${ctx.user.id}`,
    rateLimitingType: "common",
  });

  // CV-10: this fires on the EVENT-TYPE LIST page mount (client `useInfiniteQuery`).
  // The prisma path below runs `EventTypeRepository.findAllByUpId` + `prisma.host.findMany`
  // + `prisma.membership.findFirst` → ALL THROW on the no-Postgres fork → the list page
  // surfaces an error. On the Convex path (`ctx.user.uuid` = the dibslist authUserId, the
  // no-Postgres signal) we source the owner's PERSONAL event types from Convex and map them
  // to the cal list-item shape. The single-owner/no-team model has no co-hosts to enrich, no
  // team filter, and no managed children — so we synthesize an `EventType` base per Convex
  // row (overlaying the real core fields) with empty users/hosts/children, and run cal's own
  // `mapEventType` (which is prisma-FREE for empty users) to keep the EXACT return shape. The
  // original prisma path is LEFT INTACT for the `uuid`-absent case (a real Postgres deploy).
  if (ctx.user.uuid) {
    const rows = await listOwnerEventTypeRows({ ownerAuthUserId: ctx.user.uuid });
    const mapped = await Promise.all(
      rows.map(async (row) => ({
        ...(await mapEventType(buildDefaultEventTypeRowForList(row, ctx.user.id))),
        // No co-host roster on the personal list (single-owner model) → never a host.
        isCurrentUserHost: false,
      }))
    );
    return { eventTypes: mapped, nextCursor: undefined };
  }

  const userProfile = ctx.user.profile;
  const { group, limit, cursor, filters, searchQuery } = input;
  const { teamId, parentId } = group;

  const isFilterSet = (filters && hasFilter(filters)) || !!teamId;
  const isUpIdInFilter = filters?.upIds?.includes(userProfile.upId);

  const shouldListUserEvents =
    !isFilterSet || isUpIdInFilter || (isFilterSet && filters?.upIds && !isUpIdInFilter);

  const eventTypes: EventType[] = [];
  const eventTypeRepo = new EventTypeRepository(ctx.prisma);

  if (shouldListUserEvents || !teamId) {
    const baseQueryConditions = {
      teamId: null,
      schedulingType: null,
      ...(searchQuery ? { title: { contains: searchQuery, mode: "insensitive" as Prisma.QueryMode } } : {}),
    };

    const [nonChildEventTypes, childEventTypes] = await Promise.all([
      eventTypeRepo.findAllByUpId(
        {
          upId: userProfile.upId,
          userId: ctx.user.id,
        },
        {
          where: {
            ...baseQueryConditions,
            parentId: null,
          },
          orderBy: [
            {
              position: "desc",
            },
            {
              id: "desc",
            },
          ],
          limit,
          cursor,
        }
      ),
      eventTypeRepo.findAllByUpId(
        {
          upId: userProfile.upId,
          userId: ctx.user.id,
        },
        {
          where: {
            ...baseQueryConditions,
            parentId: { not: null },
            userId: ctx.user.id,
          },
          orderBy: [
            {
              position: "desc",
            },
            {
              id: "desc",
            },
          ],
          limit,
          cursor,
        }
      ),
    ]);

    const userEventTypes = [...(nonChildEventTypes ?? []), ...(childEventTypes ?? [])].sort((a, b) => {
      // First sort by position in descending order
      if (a.position !== b.position) {
        return b.position - a.position;
      }
      // Then by id in descending order
      return b.id - a.id;
    });

    eventTypes.push(...userEventTypes);
  }

  if (teamId) {
    const teamEventTypes =
      (await eventTypeRepo.findTeamEventTypes({
        teamId,
        parentId,
        userId: ctx.user.id,
        limit,
        cursor,
        where: {
          ...(isFilterSet && !!filters?.schedulingTypes
            ? {
                schedulingType: { in: filters.schedulingTypes },
              }
            : null),
          ...(searchQuery ? { title: { contains: searchQuery, mode: "insensitive" } } : {}),
        },
        orderBy: [
          {
            position: "desc",
          },
          {
            id: "desc",
          },
        ],
      })) ?? [];

    eventTypes.push(...teamEventTypes);
  }

  let nextCursor: number | null | undefined;
  if (eventTypes.length > limit) {
    const nextItem = eventTypes.pop();
    nextCursor = nextItem?.id;
  }

  const mappedEventTypes: MappedEventType[] = await Promise.all(eventTypes.map(mapEventType));

  const eventTypeIds = mappedEventTypes.map((et) => et.id);
  const userHostEntries = await prisma.host.findMany({
    where: {
      userId: ctx.user.id,
      eventTypeId: { in: eventTypeIds },
    },
    select: {
      eventTypeId: true,
    },
  });
  const eventTypeIdsWhereUserIsHost = new Set(userHostEntries.map((h) => h.eventTypeId));

  const eventTypesWithHostFlag = mappedEventTypes.map((eventType) => ({
    ...eventType,
    isCurrentUserHost: eventTypeIdsWhereUserIsHost.has(eventType.id),
  }));

  const membership = await prisma.membership.findFirst({
    where: {
      userId: ctx.user.id,
      teamId: teamId ?? 0,
      accepted: true,
      role: "MEMBER",
    },
    include: {
      team: {
        select: {
          isPrivate: true,
        },
      },
    },
  });

  if (membership && membership.team.isPrivate)
    eventTypesWithHostFlag.forEach((evType) => {
      evType.users = [];
      evType.hosts = [];
      evType.children = [];
    });

  return { eventTypes: eventTypesWithHostFlag, nextCursor: nextCursor ?? undefined };
};
