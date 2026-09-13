import { checkRateLimitAndThrowError } from "@calcom/lib/checkRateLimitAndThrowError";
import getIP from "@calcom/lib/getIP";
import { enterLotteryViaConvex } from "@calcom/lib/server/convexLotteryAdapter";
import { defaultResponder } from "@calcom/lib/server/defaultResponder";
import { piiHasher } from "@calcom/lib/server/PiiHasher";
import type { TraceContext } from "@calcom/lib/tracing";
import type { NextApiRequest } from "next";

// BOOKING-LOTTERY — enter the drawing for a specific slot of a lottery-mode
// event type. Mirrors /api/book/event (same rate-limit budget); the Convex
// mutation enforces the booking_enabled + booking_lottery_enabled flags, slot
// validation, and one-entry-per-email dedupe. Returns
// { lotteryEntry: true, lotteryId, closesAt, entrantCount, alreadyEntered } —
// the Booker client redirects to /lottery/{lotteryId}.
async function handler(req: NextApiRequest & { traceContext: TraceContext }) {
  const userIp = getIP(req);

  await checkRateLimitAndThrowError({
    rateLimitingType: "core",
    identifier: `enterLottery:${piiHasher.hash(userIp)}`,
  });

  return enterLotteryViaConvex(req.body);
}

export default defaultResponder(handler, "/api/lottery/enter");
