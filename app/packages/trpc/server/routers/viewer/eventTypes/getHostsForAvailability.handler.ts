import { EventTypeHostService } from "@calcom/features/host/services/EventTypeHostService";
import type { PaginatedAvailabilityHostsResponse } from "@calcom/features/host/services/IEventTypeHostService";
import type { PrismaClient } from "@calcom/prisma/client";

import type { TrpcSessionUser } from "../../../types";
import type { TGetHostsForAvailabilityInputSchema } from "./getHostsForAvailability.schema";

type GetHostsForAvailabilityInput = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
    prisma: PrismaClient;
  };
  input: TGetHostsForAvailabilityInputSchema;
};

export type { PaginatedAvailabilityHostsResponse as GetHostsForAvailabilityResponse };
export type { AvailabilityHost } from "@calcom/features/host/services/IEventTypeHostService";

export const getHostsForAvailabilityHandler = async ({
  ctx: _ctx,
  input: _input,
}: GetHostsForAvailabilityInput): Promise<PaginatedAvailabilityHostsResponse> => {
  // CV-9 — CLEANLY DISABLED. This powers the TEAM round-robin/per-host availability
  // assignment UI — a concept the single-owner / no-team Convex model does not have
  // (the collective co-host roster is managed by the editor's host picker →
  // `eventTypesHeavy.update` / `setOwnerEventTypeHostsByCalId`). The body used
  // `new EventTypeHostService(ctx.prisma).getHostsForAvailability` → prisma, which
  // THROWS on the no-Postgres fork. We return the empty paginated default BEFORE any
  // `ctx.prisma` access (the createEventPbacProcedure wrapper's ownership gate, now
  // Convex-backed, still runs first). No `ctx.prisma` touched.
  return { hosts: [], nextCursor: undefined, hasMore: false };
};
