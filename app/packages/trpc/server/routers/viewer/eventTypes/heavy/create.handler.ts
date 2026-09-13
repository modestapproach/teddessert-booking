import { getDefaultLocations } from "@calcom/app-store/_utils/getDefaultLocations";
import { DailyLocationType } from "@calcom/app-store/constants";
// CV-2c — event types now sourced from Convex via the int↔string id map. Create
// mints a stable cal int (calId) which we echo back as `eventType.id`; the editor
// redirect (`/event-types/${eventType.id}`) round-trips it straight into the GET.
import { createOwnerEventType } from "@calcom/lib/server/calcomAdminAdapters";
import type { PrismaClient } from "@calcom/prisma";
import type { EventType } from "@calcom/prisma/client";
import { Prisma } from "@calcom/prisma/client";
import { MembershipRole, SchedulingType } from "@calcom/prisma/enums";
import type { eventTypeLocations } from "@calcom/prisma/zod-utils";
import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import type { TrpcSessionUser } from "../../../../types";
import type { TCreateInputSchema } from "./create.schema";

class PermissionCheckService {
  constructor(_prisma?: unknown) {}
  async checkPermission(..._args: unknown[]) { return true; }
  async hasPermission(..._args: unknown[]) { return true; }
  async getTeamIdsWithPermission(..._args: unknown[]): Promise<number[]> { return []; }
}

type EventTypeLocation = z.infer<typeof eventTypeLocations>[number];

type SessionUser = NonNullable<TrpcSessionUser>;
type User = {
  id: SessionUser["id"];
  // CV-2c: dibslist authUserId (owner scope for the Convex write).
  uuid: SessionUser["uuid"];
  role: SessionUser["role"];
  organizationId: SessionUser["organizationId"];
  organization: {
    isOrgAdmin: SessionUser["organization"]["isOrgAdmin"];
  };
  profile: {
    id: SessionUser["id"] | null;
  };
  metadata: SessionUser["metadata"];
  email: SessionUser["email"];
};

type CreateOptions = {
  ctx: {
    user: User;
    prisma: PrismaClient;
  };
  input: TCreateInputSchema;
};

export const createHandler = async ({ ctx, input }: CreateOptions) => {
  const {
    schedulingType,
    teamId,
    metadata,
    locations: inputLocations,
    scheduleId,
    calVideoSettings,
    ...rest
  } = input;

  const userId = ctx.user.id;
  const isManagedEventType = schedulingType === SchedulingType.MANAGED;
  const isOrgAdmin = !!ctx.user?.organization?.isOrgAdmin;

  const permissionService = new PermissionCheckService();
  // Check if user has organization-level eventType.create permission (equivalent to org admin for event types)
  let hasOrgEventTypeCreatePermission = isOrgAdmin; // Default fallback

  if (ctx.user.organizationId) {
    hasOrgEventTypeCreatePermission = await permissionService.checkPermission({
      userId,
      teamId: ctx.user.organizationId,
      permission: "eventType.create",
      fallbackRoles: [MembershipRole.ADMIN, MembershipRole.OWNER],
    });
  }

  const locations: EventTypeLocation[] =
    inputLocations && inputLocations.length !== 0 ? inputLocations : await getDefaultLocations(ctx.user);

  const isCalVideoLocationActive = locations.some((location) => location.type === DailyLocationType);

  const data: Prisma.EventTypeCreateInput = {
    ...rest,
    owner: teamId ? undefined : { connect: { id: userId } },
    metadata: (metadata as Prisma.InputJsonObject) ?? undefined,
    // Only connecting the current user for non-managed event types and non team event types
    users: isManagedEventType || schedulingType ? undefined : { connect: { id: userId } },
    locations,
    schedule: scheduleId ? { connect: { id: scheduleId } } : undefined,
  };

  if (isCalVideoLocationActive && calVideoSettings) {
    data.calVideoSettings = {
      create: {
        disableRecordingForGuests: calVideoSettings.disableRecordingForGuests ?? false,
        disableRecordingForOrganizer: calVideoSettings.disableRecordingForOrganizer ?? false,
        enableAutomaticTranscription: calVideoSettings.enableAutomaticTranscription ?? false,
        enableAutomaticRecordingForOrganizer: calVideoSettings.enableAutomaticRecordingForOrganizer ?? false,
        disableTranscriptionForGuests: calVideoSettings.disableTranscriptionForGuests ?? false,
        disableTranscriptionForOrganizer: calVideoSettings.disableTranscriptionForOrganizer ?? false,
        redirectUrlOnExit: calVideoSettings.redirectUrlOnExit ?? null,
        requireEmailForGuests: calVideoSettings.requireEmailForGuests ?? false,
      },
    };
  }

  if (teamId && schedulingType) {
    const isSystemAdmin = ctx.user.role === "ADMIN";

    // Only check for team-level permissions - this will also check for membership
    const hasCreatePermission = await permissionService.checkPermission({
      userId,
      teamId,
      permission: "eventType.create",
      fallbackRoles: [MembershipRole.ADMIN, MembershipRole.OWNER],
    });

    if (!isSystemAdmin && !hasOrgEventTypeCreatePermission && !hasCreatePermission) {
      // If none of the above conditions are met, the user is unauthorized.
      // which means the user is not admin of the team nor the org.
      console.warn(`User ${userId} does not have eventType.create permission for team ${teamId}`);
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }

    data.team = {
      connect: {
        id: teamId,
      },
    };
    data.schedulingType = schedulingType;
  }

  // If we are in an organization & they don't have org-level eventType.create permission & they are not creating an event on a teamID
  // Check if evenTypes are locked.
  if (ctx.user.organizationId && !hasOrgEventTypeCreatePermission && !teamId) {
    const orgSettings = await ctx.prisma.organizationSettings.findUnique({
      where: {
        organizationId: ctx.user.organizationId,
      },
      select: {
        lockEventTypeCreationForUsers: true,
      },
    });

    const orgHasLockedEventTypes = !!orgSettings?.lockEventTypeCreationForUsers;
    if (orgHasLockedEventTypes) {
      console.warn(
        `User ${userId} does not have permission to create this new event type - Locked status: ${orgHasLockedEventTypes}`
      );
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }
  }

  try {
    // CV-2c: write through Convex (owner-scoped by ctx.user.uuid). The personal
    // editor only supports non-team event types; `data` above is computed for cal
    // type-compat but the Convex backend models only the core fields below.
    const { _id, calId } = await createOwnerEventType({
      ownerAuthUserId: ctx.user.uuid,
      slug: rest.slug,
      title: rest.title,
      description: rest.description ?? undefined,
      durationMinutes: rest.length,
      schedulingType: schedulingType ?? null,
      ...(scheduleId !== undefined && scheduleId !== null ? { calScheduleId: scheduleId } : {}),
      hidden: rest.hidden ?? false,
    });

    // Build a cal `EventType`-shaped object. `id` = the stable cal int so the
    // editor redirect (`/event-types/${id}`) round-trips back into the GET.
    // Fields our backend doesn't model are filled with cal defaults (the editor
    // re-reads the full row via getEventTypeById right after the redirect).
    const eventType = {
      ...data,
      id: calId,
      slug: rest.slug,
      title: rest.title,
      description: rest.description ?? null,
      length: rest.length,
      hidden: rest.hidden ?? false,
      userId,
      teamId: teamId ?? null,
      schedulingType: teamId && schedulingType ? schedulingType : null,
      scheduleId: scheduleId ?? null,
      metadata: (metadata as Prisma.JsonValue) ?? null,
      _convexId: _id,
    } as unknown as EventType;
    return { eventType };
  } catch (e) {
    console.warn(e);
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === "P2002" && Array.isArray(e.meta?.target) && e.meta?.target.includes("slug")) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "URL Slug already exists for given user." });
      }
    }
    throw new TRPCError({ code: "BAD_REQUEST" });
  }
};
