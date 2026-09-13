import { serialize } from "cookie";
import type { NextApiRequest, NextApiResponse } from "next";
import { v4 as uuid } from "uuid";

import dayjs from "@calcom/dayjs";
import { PrismaSelectedSlotRepository } from "@calcom/features/selectedSlots/repositories/PrismaSelectedSlotRepository";
import { WEBAPP_URL } from "@calcom/lib/constants";
import { MINUTES_TO_BOOK } from "@calcom/lib/constants";
import type { PrismaClient } from "@calcom/prisma";
import { BookingStatus } from "@calcom/prisma/enums";

import { TRPCError } from "@trpc/server";

import type { TReserveSlotInputSchema } from "./reserveSlot.schema";

interface ReserveSlotOptions {
  ctx: {
    prisma: PrismaClient;
    req?: NextApiRequest | undefined;
    res?: NextApiResponse | undefined;
  };
  input: TReserveSlotInputSchema;
}
export const reserveSlotHandler = async ({ ctx, input: _input }: ReserveSlotOptions) => {
  const { req, res } = ctx;
  const uid = req?.cookies?.uid || uuid();

  // CV-9 — PUBLIC/anonymous path. CLEANLY DISABLED-as-no-op. The Booker calls this
  // to HOLD a slot when a visitor picks a time. The original body did
  // `prisma.eventType.findUnique` + (seated) `prisma.booking.findFirst` +
  // `PrismaSelectedSlotRepository`/`prisma.selectedSlots.upsert` — all of which
  // THROW on the no-Postgres fork, surfacing a 500 to the anonymous visitor. The
  // Convex booking backend has no transient slot-hold model (concurrency is handled
  // by the booking write path's race-guard re-check + idempotency, see
  // packages/backend/convex/scheduling), so we skip the hold entirely and just mint
  // + return the `uid` (the Booker tolerates a no-op reservation). NO `ctx.prisma`.
  // We need this cookie to be accessible from embeds where the booking flow is displayed within an iframe on a different origin.
  // For third‑party iframe contexts (embeds on other sites), browsers require SameSite=None and Secure to make the cookie available.
  // For local development on http://localhost we fall back to SameSite=Lax to avoid requiring https during development.
  const useSecureCookies = WEBAPP_URL.startsWith("https://");
  res?.setHeader(
    "Set-Cookie",
    serialize("uid", uid, {
      path: "/",
      sameSite: useSecureCookies ? "none" : "lax",
      secure: useSecureCookies,
    })
  );
  return {
    uid: uid,
  };
};
