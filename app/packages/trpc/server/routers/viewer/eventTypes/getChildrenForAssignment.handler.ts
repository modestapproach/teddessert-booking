import { EventTypeHostService } from "@calcom/features/host/services/EventTypeHostService";
import type { PaginatedAssignmentChildrenResponse } from "@calcom/features/host/services/IEventTypeHostService";
import type { PrismaClient } from "@calcom/prisma/client";

import type { TrpcSessionUser } from "../../../types";
import type { TGetChildrenForAssignmentInputSchema } from "./getChildrenForAssignment.schema";

type GetChildrenForAssignmentInput = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
    prisma: PrismaClient;
  };
  input: TGetChildrenForAssignmentInputSchema;
};

export type { PaginatedAssignmentChildrenResponse as GetChildrenForAssignmentResponse };
export type { AssignmentChild } from "@calcom/features/host/services/IEventTypeHostService";

export const getChildrenForAssignmentHandler = async ({
  ctx: _ctx,
  input: _input,
}: GetChildrenForAssignmentInput): Promise<PaginatedAssignmentChildrenResponse> => {
  // CV-9 — CLEANLY DISABLED (managed-event children assignment UI; no-team model).
  // The body used `new EventTypeHostService(ctx.prisma).getChildrenForAssignment` →
  // prisma, which THROWS on the no-Postgres fork. Empty paginated default; no
  // `ctx.prisma`.
  return { children: [], nextCursor: undefined, hasMore: false };
};
