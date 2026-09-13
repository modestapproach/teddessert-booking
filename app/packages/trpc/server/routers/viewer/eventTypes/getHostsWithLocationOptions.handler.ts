import { appStoreMetadata } from "@calcom/app-store/appStoreMetaData";
import { enrichUsersWithDelegationCredentials } from "@calcom/app-store/delegationCredential";
import { EventTypeRepository } from "@calcom/features/eventtypes/repositories/eventTypeRepository";
import { HostRepository } from "@calcom/features/host/repositories/HostRepository";
import type { PrismaClient, Prisma } from "@calcom/prisma/client";
import { userMetadata } from "@calcom/prisma/zod-utils";

import { TRPCError } from "@trpc/server";

import type { TrpcSessionUser } from "../../../types";
import type { TGetHostsWithLocationOptionsInputSchema } from "./getHostsWithLocationOptions.schema";

type GetHostsWithLocationOptionsInput = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
    prisma: PrismaClient;
  };
  input: TGetHostsWithLocationOptionsInputSchema;
};

type HostFromRepository = Awaited<
  ReturnType<HostRepository["findHostsWithLocationOptionsPaginated"]>
>["items"][number];

type EnrichedCredential = {
  id: number;
  appId: string | null;
  type: string;
};

export type HostWithLocationOptions = {
  userId: number;
  name: string | null;
  email: string;
  avatarUrl: string | null;
  defaultConferencingApp: {
    appSlug?: string;
    appLink?: string;
  } | null;
  location: {
    id: string;
    type: string;
    credentialId: number | null;
    link: string | null;
    address: string | null;
    phoneNumber: string | null;
  } | null;
  installedApps: {
    appId: string | null;
    credentialId: number;
    type: string;
    locationOption?: {
      value: string;
      label: string;
      icon?: string;
    };
  }[];
};

export type GetHostsWithLocationOptionsResponse = {
  hosts: HostWithLocationOptions[];
  nextCursor: number | undefined;
  hasMore: boolean;
};

export function transformHostsToResponse(
  hosts: HostFromRepository[],
  enrichedUsers: { credentials: EnrichedCredential[] }[]
): HostWithLocationOptions[] {
  const appMetadataBySlug = new Map(Object.values(appStoreMetadata).map((app) => [app.slug, app]));

  return hosts.map((host, index) => ({
    userId: host.userId,
    name: host.user.name,
    email: host.user.email,
    avatarUrl: host.user.avatarUrl,
    defaultConferencingApp: userMetadata.safeParse(host.user.metadata).data?.defaultConferencingApp ?? null,
    location: host.location,
    installedApps: enrichedUsers[index].credentials.map((cred) => {
      const appMeta = cred.appId ? appMetadataBySlug.get(cred.appId) : null;
      const locationData = appMeta?.appData?.location;

      return {
        appId: cred.appId,
        credentialId: cred.id,
        type: cred.type,
        locationOption: locationData
          ? {
              value: locationData.type,
              label: locationData.label || appMeta?.name || cred.appId || "",
              icon: appMeta?.logo,
            }
          : undefined,
      };
    }),
  }));
}

export const getHostsWithLocationOptionsHandler = async ({
  ctx: _ctx,
  input: _input,
}: GetHostsWithLocationOptionsInput): Promise<GetHostsWithLocationOptionsResponse> => {
  // CV-9 — CLEANLY DISABLED (team per-host location-options UI; no-team model). The
  // body used `new EventTypeRepository(ctx.prisma).findByIdWithTeamId` +
  // `new HostRepository(ctx.prisma).findHostsWithLocationOptionsPaginated` → prisma,
  // which THROWS on the no-Postgres fork. Empty paginated default; no `ctx.prisma`.
  return { hosts: [], nextCursor: undefined, hasMore: false };
};
