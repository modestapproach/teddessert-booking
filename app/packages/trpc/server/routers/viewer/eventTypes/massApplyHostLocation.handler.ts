import { appStoreMetadata } from "@calcom/app-store/appStoreMetaData";
import { EventTypeRepository } from "@calcom/features/eventtypes/repositories/eventTypeRepository";
import { HostRepository } from "@calcom/features/host/repositories/HostRepository";
import { HostLocationRepository } from "@calcom/features/host/repositories/HostLocationRepository";
import type { PrismaClient } from "@calcom/prisma";
import { TRPCError } from "@trpc/server";

import type { TrpcSessionUser } from "../../../types";
import type { TMassApplyHostLocationInputSchema } from "./massApplyHostLocation.schema";

type MassApplyHostLocationInput = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
    prisma: PrismaClient;
  };
  input: TMassApplyHostLocationInputSchema;
};

type MassApplyHostLocationResponse = {
  success: boolean;
  updatedCount: number;
};

const findCredentialIdForLocationType = (
  locationType: string,
  credentials: { id: number; type: string; appId: string | null }[]
): number | null => {
  const appMeta = Object.values(appStoreMetadata).find(
    (app) => app.appData?.location?.type === locationType
  );
  if (!appMeta) return null;

  const matchingCredential = credentials.find(
    (cred) => cred.type === appMeta.type || cred.appId === appMeta.slug
  );
  return matchingCredential?.id ?? null;
};

export const massApplyHostLocationHandler = async ({
  ctx: _ctx,
  input: _input,
}: MassApplyHostLocationInput): Promise<MassApplyHostLocationResponse> => {
  // CV-9 — CLEANLY DISABLED (team mass-apply-per-host-location UI; no-team model).
  // The body used `new EventTypeRepository(ctx.prisma).findByIdWithTeamId` +
  // `new HostRepository(ctx.prisma).findHostsWithConferencingCredentials` +
  // `new HostLocationRepository(ctx.prisma).upsertMany` → prisma, which THROWS on
  // the no-Postgres fork. Typed no-op success; no `ctx.prisma`.
  return { success: true, updatedCount: 0 };
};
