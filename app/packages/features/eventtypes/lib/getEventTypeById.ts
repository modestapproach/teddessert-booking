//import "server-only";
import type { LocationObject } from "@calcom/app-store/locations";
import { defaultLocationGroupedOptions, getLocationGroupedOptions } from "@calcom/app-store/server";
import { getEventTypeAppData } from "@calcom/app-store/utils";
import { eventTypeMetaDataSchemaWithTypedApps } from "@calcom/app-store/zod-utils";
import { getBookingFieldsWithSystemFields } from "@calcom/features/bookings/lib/getBookingFields";
import { EventTypeRepository } from "@calcom/features/eventtypes/repositories/eventTypeRepository";
import { ProfileRepository } from "@calcom/features/profile/repositories/ProfileRepository";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { WEBSITE_URL } from "@calcom/lib/constants";
import { getUserAvatarUrl } from "@calcom/lib/getAvatarUrl";
import { parseBookingLimit } from "@calcom/lib/intervalLimits/isBookingLimits";
import { parseDurationLimit } from "@calcom/lib/intervalLimits/isDurationLimits";
import { parseEventTypeColor } from "@calcom/lib/isEventTypeColor";
import { parseRecurringEvent } from "@calcom/lib/isRecurringEvent";
import { getTranslation } from "@calcom/i18n/server";
import type { PrismaClient } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import { MembershipRole, SchedulingType } from "@calcom/prisma/enums";
import { customInputSchema } from "@calcom/prisma/zod-utils";
import { TRPCError } from "@trpc/server";

const getOrganizationRepository = () => ({ findById: async (..._args: unknown[]) => null });
const getBookerBaseUrl = async (_orgSlug?: string | number | null): Promise<string> =>
  process.env.NEXT_PUBLIC_WEBAPP_URL || "https://app.cal.com";

interface getEventTypeByIdProps {
  eventTypeId: number;
  userId: number;
  prisma: PrismaClient;
  isTrpcCall?: boolean;
  isUserOrganizationAdmin: boolean;
  currentOrganizationId: number | null;
  userLocale?: string | null;
  // CV-2c: dibslist authUserId. When present, getRawEventType resolves the
  // cal int `eventTypeId` → the Convex `_id` via the int↔string id map and
  // OVERLAYS the Convex-sourced core fields (title/slug/description/length/
  // hidden/schedule) onto the raw row so the editor reflects Convex state.
  ownerAuthUserId?: string;
}

export type EventType = Awaited<ReturnType<typeof getEventTypeById>>;

export const getEventTypeById = async ({
  currentOrganizationId,
  eventTypeId,
  userId,
  prisma,
  isTrpcCall = false,
  isUserOrganizationAdmin,
  userLocale,
  ownerAuthUserId,
}: getEventTypeByIdProps) => {
  const userSelect = {
    name: true,
    avatarUrl: true,
    username: true,
    id: true,
    email: true,
    locale: true,
    defaultScheduleId: true,
    isPlatformManaged: true,
    timeZone: true,
  } satisfies Prisma.UserSelect;

  const rawEventType = await getRawEventType({
    userId,
    eventTypeId,
    isUserOrganizationAdmin,
    currentOrganizationId,
    prisma,
    ownerAuthUserId,
  });

  if (!rawEventType) {
    if (isTrpcCall) {
      throw new TRPCError({ code: "NOT_FOUND" });
    } else {
      throw new Error("Event type not found");
    }
  }

  const { locations, metadata, ...restEventType } = rawEventType;
  const newMetadata = eventTypeMetaDataSchemaWithTypedApps.parse(metadata || {}) || {};
  const apps = newMetadata?.apps || {};
  const eventTypeWithParsedMetadata = { ...rawEventType, metadata: newMetadata };
  const userRepo = new UserRepository(prisma);
  const eventTeamMembershipsWithUserProfile = [];
  for (const eventTeamMembership of rawEventType.team?.members || []) {
    eventTeamMembershipsWithUserProfile.push({
      ...eventTeamMembership,
      user: await userRepo.enrichUserWithItsProfile({
        user: eventTeamMembership.user,
      }),
    });
  }

  const childrenWithUserProfile = [];
  for (const child of rawEventType.children || []) {
    childrenWithUserProfile.push({
      ...child,
      owner: child.owner
        ? await userRepo.enrichUserWithItsProfile({
            user: child.owner,
          })
        : null,
    });
  }

  const eventTypeUsersWithUserProfile = [];
  for (const eventTypeUser of rawEventType.users) {
    eventTypeUsersWithUserProfile.push(
      await userRepo.enrichUserWithItsProfile({
        user: eventTypeUser,
      })
    );
  }

  newMetadata.apps = {
    ...apps,
    giphy: getEventTypeAppData(eventTypeWithParsedMetadata, "giphy", true) ?? undefined,
  };

  const parsedMetaData = newMetadata;

  const parsedCustomInputs = (rawEventType.customInputs || []).map((input) => customInputSchema.parse(input));

  const eventType = {
    ...restEventType,
    schedule:
      rawEventType.schedule?.id ||
      (!rawEventType.team ? rawEventType.users[0]?.defaultScheduleId : null) ||
      null,
    restrictionScheduleId: rawEventType.restrictionScheduleId || null,
    restrictionScheduleName: rawEventType.restrictionSchedule?.name || null,
    useBookerTimezone: rawEventType.useBookerTimezone || false,
    instantMeetingSchedule: rawEventType.instantMeetingSchedule?.id || null,
    scheduleName: rawEventType.schedule?.name || null,
    recurringEvent: parseRecurringEvent(restEventType.recurringEvent),
    bookingLimits: parseBookingLimit(restEventType.bookingLimits),
    durationLimits: parseDurationLimit(restEventType.durationLimits),
    eventTypeColor: parseEventTypeColor(restEventType.eventTypeColor),
    locations: locations as unknown as LocationObject[],
    metadata: parsedMetaData,
    customInputs: parsedCustomInputs,
    users: rawEventType.users,
    bookerUrl: restEventType.team
      ? await getBookerBaseUrl(restEventType.team.parentId)
      : restEventType.owner
        ? await getBookerBaseUrl(currentOrganizationId)
        : WEBSITE_URL,
    children: childrenWithUserProfile.flatMap((ch) =>
      ch.owner !== null
        ? {
            ...ch,
            owner: {
              ...ch.owner,
              avatar: getUserAvatarUrl(ch.owner),
              email: ch.owner.email,
              name: ch.owner.name ?? "",
              username: ch.owner.username ?? "",
              membership:
                restEventType.team?.members.find((tm) => tm.user.id === ch.owner?.id)?.role ||
                MembershipRole.MEMBER,
            },
            created: true,
          }
        : []
    ),
  };

  // backwards compat
  if (eventType.users.length === 0 && !eventType.team) {
    // CV-9: on the no-Postgres fork (ownerAuthUserId set) the synthesized base has
    // `users: []`, so this branch IS reached — and `prisma.user.findUnique` would
    // THROW. Synthesize a fallback user from the known cal `userId` instead. The
    // Prisma read is kept only for a (non-fork) Postgres deployment.
    //
    // CV-FIX (the recurring editor `users[0].username` crash CLASS): this fallback
    // is the SINGLE source feeding every editor consumer's `eventType.users[0]`
    // (the EventTypeLayout permalink/embed, the react-hook-form `users` value, the
    // advanced tab, the schedule default). Several read `users[0].username`/`.name`
    // WITHOUT optional chaining, so the user MUST (a) carry the owner's REAL
    // username and (b) actually reach the RETURNED `users` array. We resolve the
    // username from Convex (getOwnerSessionPrefs — same source as the /me query)
    // and push the user into `eventTypeUsersWithUserProfile` (which feeds the
    // returned `users`), synthesizing the profile DB-free via
    // buildPersonalProfileFromUser (enrichUserWithItsProfile hits prisma → throws).
    const ownerPrefs = ownerAuthUserId
      ? await (
          await import("@calcom/lib/server/calcomAdminAdapters")
        ).getOwnerSessionPrefs({ ownerAuthUserId })
      : null;
    const fallbackUser = ownerAuthUserId
      ? ({
          id: userId,
          name: null,
          avatarUrl: null,
          username: ownerPrefs?.username ?? null,
          email: "",
          locale: ownerPrefs?.locale ?? userLocale ?? "en",
          defaultScheduleId: ownerPrefs?.defaultScheduleCalId ?? null,
          isPlatformManaged: false,
          timeZone: ownerPrefs?.timeZone ?? "Europe/London",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)
      : await prisma.user.findUnique({
          where: {
            id: userId,
          },
          select: userSelect,
        });
    if (!fallbackUser) {
      if (isTrpcCall) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "The event type doesn't have user and no fallback user was found",
        });
      } else {
        throw Error("The event type doesn't have user and no fallback user was found");
      }
    }
    eventType.users.push(fallbackUser);
    // Surface the owner in the enriched list that feeds the RETURNED `users`
    // (eventTypeUsers below). Without this the output `users` stays [] and every
    // `users[0].username` consumer 500s the editor.
    if (ownerAuthUserId) {
      eventTypeUsersWithUserProfile.push({
        ...fallbackUser,
        nonProfileUsername: fallbackUser.username ?? null,
        profile: ProfileRepository.buildPersonalProfileFromUser({ user: fallbackUser }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    }
  }

  const eventTypeUsers: ((typeof eventType.users)[number] & { avatar: string })[] =
    eventTypeUsersWithUserProfile.map((user) => ({
      ...user,
      avatar: getUserAvatarUrl(user),
    }));

  const currentUser = eventType.users.find((u) => u.id === userId);

  const t = await getTranslation(userLocale ?? currentUser?.locale ?? "en", "common");

  if (!currentUser?.id && !eventType.teamId) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Could not find user or team",
    });
  }

  // CV-10: THE residual blocking leaf. The original `getLocationGroupedOptions({ userId })`
  // ran UNCONDITIONALLY and hit `prisma.user.findUnique` + `prisma.credential.findMany`
  // (app-store/server.ts) to enrich the groups with the owner's installed video apps —
  // which THROWS on the no-Postgres fork, 500ing the event-type EDITOR load BEFORE the
  // (CV-9-guarded) destinationCalendar skip below ever runs. On the Convex path
  // (`ownerAuthUserId` set) we have no cal credential/app-store graph, so we return the
  // cal-shaped default location groups (in-person/custom/phone/link — built purely from
  // `defaultLocations`, no DB) — mirroring the CV-9 getRawEventType/fallback-user/
  // destinationCalendar skips in this same file. The original prisma path is LEFT INTACT
  // for the `ownerAuthUserId`-absent case so a real Postgres cal.com deploy is unaffected.
  const locationOptions = ownerAuthUserId
    ? defaultLocationGroupedOptions(t)
    : await getLocationGroupedOptions(
        eventType.teamId ? { teamId: eventType.teamId } : { userId },
        t
      );
  if (eventType.schedulingType === SchedulingType.MANAGED) {
    locationOptions.splice(0, 0, {
      label: t("default"),
      options: [
        {
          label: t("members_default_location"),
          value: "",
          icon: "/user-check.svg",
        },
      ],
    });
  }

  const isOrgTeamEvent = !!eventType?.teamId && !!eventType.team?.parentId;
  const eventTypeObject = Object.assign({}, eventType, {
    users: eventTypeUsers,
    periodStartDate: eventType.periodStartDate?.toString() ?? null,
    periodEndDate: eventType.periodEndDate?.toString() ?? null,
    bookingFields: getBookingFieldsWithSystemFields({ ...eventType, isOrgTeamEvent }),
  });

  const isOrgEventType = !!eventTypeObject.team?.parentId;
  const teamMembers = eventTypeObject.team
    ? eventTeamMembershipsWithUserProfile
        .filter((member) => member.accepted || isOrgEventType)
        .map((member) => {
          const user: typeof member.user & { avatar: string } = {
            ...member.user,
            avatar: getUserAvatarUrl(member.user),
          };
          return {
            ...user,
            profileId: user.profile.id,
            eventTypes: user.eventTypes.map((evTy) => evTy.slug),
            membership: member.role,
          };
        })
    : [];

  // Find the current users membership so we can check role to enable/disable deletion.
  // Sets to null if no membership is found - this must mean we are in a none team event type
  const currentUserMembership = eventTypeObject.team?.members.find((el) => el.user.id === userId) ?? null;

  let destinationCalendar = eventTypeObject.destinationCalendar;
  // CV-9: skip the user-default destinationCalendar Prisma read on the no-Postgres
  // fork (ownerAuthUserId set) — it THROWS. The editor reads connected calendars +
  // the destination via the separate (Convex-rewired) `calendars.connectedCalendars`
  // surface; leaving this null is the correct cal-shaped default here. The Prisma
  // read is kept only for a (non-fork) Postgres deployment.
  if (!destinationCalendar && !ownerAuthUserId) {
    destinationCalendar = await prisma.destinationCalendar.findFirst({
      where: {
        userId: userId,
        eventTypeId: null,
      },
    });
  }

  const finalObj = {
    eventType: eventTypeObject,
    locationOptions,
    destinationCalendar,
    team: eventTypeObject.team || null,
    teamMembers,
    currentUserMembership,
    isUserOrganizationAdmin,
  };
  return finalObj;
};

export async function getRawEventType({
  userId,
  eventTypeId,
  isUserOrganizationAdmin,
  currentOrganizationId,
  prisma,
  ownerAuthUserId,
}: Omit<getEventTypeByIdProps, "isTrpcCall">) {
  const eventTypeRepo = new EventTypeRepository(prisma);

  // Platform org admins can access any event type within their organization
  if (isUserOrganizationAdmin && currentOrganizationId) {
    const org = await prisma.team.findUnique({
      where: { id: currentOrganizationId },
      select: { isPlatform: true },
    });

    if (org?.isPlatform) {
      const orgResult = await eventTypeRepo.findByIdForOrgAdmin({
        id: eventTypeId,
        organizationId: currentOrganizationId,
      });
      if (orgResult) return orgResult;
    }
  }

  // CV-9: on the no-Postgres fork (ownerAuthUserId set) the `eventTypeRepo.findById`
  // Prisma read (eventTypeRepository.ts:795) THROWS — and it ran BEFORE the
  // `if (!ownerAuthUserId)` overlay short-circuit below, so even with the pbac
  // middleware fixed, GET still 500'd here. We now SKIP it entirely on the Convex
  // path and synthesize the base from `buildDefaultRawEventType`; the Convex
  // overlay then sets the real core fields. The Prisma read is kept ONLY for a
  // (non-fork) Postgres deployment where `ownerAuthUserId` is absent.
  const prismaResult = ownerAuthUserId
    ? null
    : await eventTypeRepo.findById({
        id: eventTypeId,
        userId,
      });

  // CV-2c: overlay the Convex-sourced core fields. `eventTypeId` is the cal int;
  // adminGetEventType resolves it via the int↔string id map (calEventTypeId →
  // Convex `_id`) and returns the row (carrying its `calId`). We overlay the
  // fields the editor renders + round-trips. When the fork runs with no
  // Postgres, prismaResult is null and we synthesize a base from cal's default
  // event so the editor still hydrates (the rich Prisma-only surface defaults).
  if (!ownerAuthUserId) return prismaResult;
  const { getOwnerEventTypeByCalId } = await import("@calcom/lib/server/calcomAdminAdapters");
  const convexRow = await getOwnerEventTypeByCalId({
    ownerAuthUserId,
    calEventTypeId: eventTypeId,
  });
  if (!convexRow) return prismaResult;

  const base = prismaResult ?? buildDefaultRawEventType({ userId, eventTypeId });
  const overlay = {
    id: convexRow.calId ?? eventTypeId,
    title: convexRow.title,
    slug: convexRow.slug,
    description: convexRow.description ?? null,
    length: convexRow.durationMinutes,
    hidden: convexRow.hidden ?? false,
    minimumBookingNotice: convexRow.minimumBookingNoticeMinutes ?? base.minimumBookingNotice,
    beforeEventBuffer: convexRow.bufferBeforeMinutes ?? base.beforeEventBuffer,
    afterEventBuffer: convexRow.bufferAfterMinutes ?? base.afterEventBuffer,
  };
  // The Prisma row type is fully structural; the overlay only narrows known
  // primitives, so the cast is safe (same field types).
  return { ...base, ...overlay } as typeof base;
}

// A minimal cal rawEventType base for the no-Postgres fork. Only the fields the
// downstream getEventTypeById pipeline reads without a relation are populated;
// the Convex overlay then sets the real core values. Cast to the findById return
// type — the cal editor re-derives most rich fields client-side.
function buildDefaultRawEventType({
  userId,
  eventTypeId,
}: {
  userId: number;
  eventTypeId: number;
}): NonNullable<Awaited<ReturnType<EventTypeRepository["findById"]>>> {
  return {
    id: eventTypeId,
    title: "",
    slug: "",
    description: "",
    length: 30,
    hidden: false,
    locations: [],
    metadata: {},
    customInputs: [],
    recurringEvent: null,
    bookingLimits: null,
    durationLimits: null,
    eventTypeColor: null,
    periodStartDate: null,
    periodEndDate: null,
    minimumBookingNotice: 120,
    beforeEventBuffer: 0,
    afterEventBuffer: 0,
    schedulingType: null,
    schedule: null,
    instantMeetingSchedule: null,
    restrictionSchedule: null,
    restrictionScheduleId: null,
    useBookerTimezone: false,
    userId,
    teamId: null,
    team: null,
    parent: null,
    owner: { id: userId, timeZone: "UTC" },
    users: [],
    hosts: [],
    children: [],
    // The editor form (`useEventTypeForm`) does `eventType.hashedLink.map(...)`;
    // the fork has no private-link feature, so default to [] to avoid a client
    // "Cannot read properties of undefined (reading 'map')" crash on the editor.
    hashedLink: [],
    destinationCalendar: null,
    webhooks: [],
    bookingFields: undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

export default getEventTypeById;
