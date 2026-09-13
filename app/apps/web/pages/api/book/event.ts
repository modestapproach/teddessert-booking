import process from "node:process";
import { BotDetectionService } from "@calcom/features/bot-detection";
import { EventTypeRepository } from "@calcom/features/eventtypes/repositories/eventTypeRepository";
import { FeaturesRepository } from "@calcom/features/flags/features.repository";
import { checkRateLimitAndThrowError } from "@calcom/lib/checkRateLimitAndThrowError";
import getIP from "@calcom/lib/getIP";
import { checkCfTurnstileToken } from "@calcom/lib/server/checkCfTurnstileToken";
import {
  createBookingViaConvex,
  rescheduleBookingViaConvex,
} from "@calcom/lib/server/convexBookingAdapter";
import { defaultResponder } from "@calcom/lib/server/defaultResponder";
import { piiHasher } from "@calcom/lib/server/PiiHasher";
import type { TraceContext } from "@calcom/lib/tracing";
import { prisma } from "@calcom/prisma";
import { CreationSource } from "@calcom/prisma/enums";
import type { NextApiRequest } from "next";

// CV-3 — booking-create rewire. This route used to call cal's
// `RegularBookingService.createBooking` (Postgres/Prisma + cal's `handleNewBooking`
// flow). It now routes the create to the dibslist Convex backend via
// `createBookingViaConvex` (→ `scheduling/publicApi:createBookingPublic`), which
// owns the IN/OUT adapters + error mapping. cal's RegularBookingService /
// handleNewBooking is intentionally SKIPPED on this path.
//
// The cal-side request guards below (Turnstile, bot detection, core rate-limit)
// are PRESERVED — they're this route's own front-door protections and run before
// we touch Convex. The Convex mutation additionally enforces the booking_enabled
// flag gate, idempotency, the authoritative slot-conflict re-check, and the E4
// per-event-type anti-abuse gates. Side effects (Google Calendar write,
// confirmation email + .ics, in-app organizer notification, signed
// `booking.created` webhook, reminder rows) are scheduled atomically inside the
// Convex mutation post-deploy. See CONVEX-REWIRE-NOTES.md (CV-3).
async function handler(req: NextApiRequest & { userId?: number; traceContext: TraceContext }) {
  const userIp = getIP(req);

  if (process.env.NEXT_PUBLIC_CLOUDFLARE_USE_TURNSTILE_IN_BOOKER === "1") {
    await checkCfTurnstileToken({
      token: req.body["cfToken"] as string,
      remoteIp: userIp,
    });
  }

  // Check for bot detection using feature flag
  const featuresRepository = new FeaturesRepository(prisma);
  const eventTypeRepository = new EventTypeRepository(prisma);
  const botDetectionService = new BotDetectionService(featuresRepository, eventTypeRepository);

  await botDetectionService.checkBotDetection({
    eventTypeId: req.body.eventTypeId,
    headers: req.headers,
  });

  await checkRateLimitAndThrowError({
    rateLimitingType: "core",
    identifier: `createBooking:${piiHasher.hash(userIp)}`,
  });

  /* To mimic API behavior and comply with types */
  req.body = {
    ...req.body,
    creationSource: CreationSource.WEBAPP,
  };

  // CV-3: route the create to dibslist Convex (IN adapter → createBookingPublic →
  // OUT adapter → cal BookingResponse). Convex errors are mapped to the cal
  // HttpError the Booker renders (e.g. slot_unavailable → no_available_users_found).
  // CV-3b: a Booker submit carrying `rescheduleUid` is a RESCHEDULE — route it to
  // the Convex reschedule door (token-guarded httpAction) instead of create, so the
  // old booking is cancelled + its calendar event moved rather than double-booked.
  const booking = req.body?.rescheduleUid
    ? await rescheduleBookingViaConvex(req.body)
    : await createBookingViaConvex(req.body);

  return booking;
}

export default defaultResponder(handler, "/api/book/event");
