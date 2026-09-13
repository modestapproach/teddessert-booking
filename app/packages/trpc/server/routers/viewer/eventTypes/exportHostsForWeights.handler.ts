import { EventTypeHostService } from "@calcom/features/host/services/EventTypeHostService";
import type { ExportWeightsResponse } from "@calcom/features/host/services/IEventTypeHostService";
import type { PrismaClient } from "@calcom/prisma/client";

import type { TrpcSessionUser } from "../../../types";
import type { TExportHostsForWeightsInputSchema } from "./exportHostsForWeights.schema";

type ExportHostsForWeightsInput = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
    prisma: PrismaClient;
  };
  input: TExportHostsForWeightsInputSchema;
};

export type { ExportWeightsResponse as ExportHostsForWeightsResponse };
export type { ExportedWeightMember } from "@calcom/features/host/services/IEventTypeHostService";

export const exportHostsForWeightsHandler = async ({
  ctx: _ctx,
  input: _input,
}: ExportHostsForWeightsInput): Promise<ExportWeightsResponse> => {
  // CV-9 — CLEANLY DISABLED (team round-robin weights export; no-team model). The
  // body used `new EventTypeHostService(ctx.prisma).exportHostsForWeights` → prisma,
  // which THROWS on the no-Postgres fork. Empty members list; no `ctx.prisma`.
  return { members: [] };
};
