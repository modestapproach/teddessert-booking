import { EventTypeHostService } from "@calcom/features/host/services/EventTypeHostService";
import type { PaginatedAssignmentHostsResponse } from "@calcom/features/host/services/IEventTypeHostService";
import type { PrismaClient } from "@calcom/prisma/client";

import type { TrpcSessionUser } from "../../../types";
import type { TGetHostsForAssignmentInputSchema } from "./getHostsForAssignment.schema";

type GetHostsForAssignmentInput = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
    prisma: PrismaClient;
  };
  input: TGetHostsForAssignmentInputSchema;
};

export type { PaginatedAssignmentHostsResponse as GetHostsForAssignmentResponse };
export type { AssignmentHost } from "@calcom/features/host/services/IEventTypeHostService";

export const getHostsForAssignmentHandler = async ({
  ctx: _ctx,
  input: _input,
}: GetHostsForAssignmentInput): Promise<PaginatedAssignmentHostsResponse> => {
  // CV-9 — CLEANLY DISABLED (team host-assignment UI; no-team model). The body used
  // `new EventTypeHostService(ctx.prisma).getHostsForAssignment` → prisma, which
  // THROWS on the no-Postgres fork. Empty paginated default; no `ctx.prisma`.
  return { hosts: [], nextCursor: undefined, hasMore: false };
};
