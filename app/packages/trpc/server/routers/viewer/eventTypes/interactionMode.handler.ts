import {
  getOwnerEventTypeByCalId,
  updateOwnerEventTypeByCalId,
} from "@calcom/lib/server/calcomAdminAdapters";
import { TRPCError } from "@trpc/server";

import type { TrpcSessionUser } from "../../../types";
import type {
  TGetInteractionModeSchema,
  TUpdateInteractionModeSchema,
} from "./interactionMode.schema";

// BOOKING-LOTTERY ("???" tab) — self-contained read/write for the event type's
// interaction mode, bypassing cal's FormValues/update pipeline entirely (the
// mode is a dibslist-Convex concept, not a cal field). Ownership is enforced
// upstream by createEventPbacProcedure (CV-9 Convex ownership middleware);
// `ctx.user.uuid` is the dibslist authUserId.

type Ctx = { user: NonNullable<TrpcSessionUser> & { uuid?: string } };

function requireUuid(ctx: Ctx): string {
  const uuid = ctx.user.uuid;
  if (!uuid) {
    // No Convex identity on the session — the fork always sets `uuid` for
    // logged-in users; treat absence as unauthorized rather than 500.
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return uuid;
}

export async function getInteractionModeHandler({
  ctx,
  input,
}: {
  ctx: Ctx;
  input: TGetInteractionModeSchema;
}): Promise<{
  interactionMode: "lottery" | "first_come" | "application" | "threshold" | "pair" | null;
  lotteryCloseLeadMinutes: number | null;
  thresholdMinAttendees: number | null;
  seatsPerSlot: number | null;
}> {
  const ownerAuthUserId = requireUuid(ctx);
  const row = await getOwnerEventTypeByCalId({
    ownerAuthUserId,
    calEventTypeId: input.id,
  });
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });
  const mode = (row as { interactionMode?: string }).interactionMode;
  const lead = (row as { lotteryCloseLeadMinutes?: number }).lotteryCloseLeadMinutes;
  const minA = (row as { thresholdMinAttendees?: number }).thresholdMinAttendees;
  const seats = (row as { seatsPerSlot?: number }).seatsPerSlot;
  const KNOWN = ["lottery", "first_come", "application", "threshold", "pair"] as const;
  return {
    interactionMode: (KNOWN as readonly string[]).includes(mode ?? "")
      ? (mode as (typeof KNOWN)[number])
      : null,
    lotteryCloseLeadMinutes: typeof lead === "number" ? lead : null,
    thresholdMinAttendees: typeof minA === "number" ? minA : null,
    seatsPerSlot: typeof seats === "number" ? seats : null,
  };
}

export async function updateInteractionModeHandler({
  ctx,
  input,
}: {
  ctx: Ctx;
  input: TUpdateInteractionModeSchema;
}): Promise<{ ok: true }> {
  const ownerAuthUserId = requireUuid(ctx);
  await updateOwnerEventTypeByCalId({
    ownerAuthUserId,
    calEventTypeId: input.id,
    interactionMode: input.interactionMode,
    ...(input.lotteryCloseLeadMinutes !== undefined
      ? { lotteryCloseLeadMinutes: input.lotteryCloseLeadMinutes }
      : {}),
    ...(input.thresholdMinAttendees !== undefined
      ? { thresholdMinAttendees: input.thresholdMinAttendees }
      : {}),
    ...(input.seatsPerSlot !== undefined ? { seatsPerSlot: input.seatsPerSlot } : {}),
  });
  return { ok: true };
}
