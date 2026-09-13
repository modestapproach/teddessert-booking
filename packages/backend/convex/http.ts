// HTTP surface of the standalone booking backend:
//   /book/api/*                public, key-less booking API (RFC 9457 errors)
//   /book/mcp                  MCP endpoint exposing the booker verbs
//   /calendar/oauth/callback   Google Calendar OAuth return leg
//   /stripe/booking/webhook    optional paid-booking webhook
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { log } from "./_helpers/log";
import { getOrMintRequestId, withRequestId } from "./_helpers/requestId";
import { verifyState as verifyCalendarState } from "./scheduling/googleOAuth";
import {
  bookEventTypeHandler,
  bookSlotsHandler,
  bookCreateHandler,
  bookRescheduleHandler,
  bookCancelHandler,
  bookResyncHandler,
  bookMcpHandler,
  bookRequestCodeHandler,
  bookPollHandler,
  bookPollVoteHandler,
  bookCheckoutHandler,
  bookLotteryEnterHandler,
  bookLotteryStatusHandler,
  bookApplicationPickHandler,
  bookPairStatusHandler,
  bookPairJoinHandler,
} from "./scheduling/publicApi";
import { handleBookingStripeWebhook } from "./scheduling/payments";
import { adminMcpHandler } from "./adminMcp";

const http = httpRouter();

http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => new Response("ok", { status: 200 })),
});

http.route({ path: "/stripe/booking/webhook", method: "POST", handler: handleBookingStripeWebhook });

http.route({ pathPrefix: "/book/api/event-type/", method: "GET", handler: bookEventTypeHandler });
http.route({ pathPrefix: "/book/api/event-type/", method: "OPTIONS", handler: bookEventTypeHandler });
http.route({ pathPrefix: "/book/api/slots/", method: "GET", handler: bookSlotsHandler });
http.route({ pathPrefix: "/book/api/slots/", method: "OPTIONS", handler: bookSlotsHandler });
http.route({ path: "/book/api/booking", method: "POST", handler: bookCreateHandler });
http.route({ path: "/book/api/booking", method: "OPTIONS", handler: bookCreateHandler });
http.route({ path: "/book/api/checkout", method: "POST", handler: bookCheckoutHandler });
http.route({ path: "/book/api/checkout", method: "OPTIONS", handler: bookCheckoutHandler });
http.route({ path: "/book/api/lottery/enter", method: "POST", handler: bookLotteryEnterHandler });
http.route({ path: "/book/api/lottery/enter", method: "OPTIONS", handler: bookLotteryEnterHandler });
http.route({ pathPrefix: "/book/api/lottery/", method: "GET", handler: bookLotteryStatusHandler });
http.route({ pathPrefix: "/book/api/lottery/", method: "OPTIONS", handler: bookLotteryStatusHandler });
http.route({ path: "/book/api/application/pick", method: "GET", handler: bookApplicationPickHandler });
http.route({ path: "/book/api/pair/join", method: "POST", handler: bookPairJoinHandler });
http.route({ path: "/book/api/pair/join", method: "OPTIONS", handler: bookPairJoinHandler });
http.route({ pathPrefix: "/book/api/pair/", method: "GET", handler: bookPairStatusHandler });
http.route({ pathPrefix: "/book/api/pair/", method: "OPTIONS", handler: bookPairStatusHandler });
http.route({ path: "/book/api/reschedule", method: "POST", handler: bookRescheduleHandler });
http.route({ path: "/book/api/reschedule", method: "OPTIONS", handler: bookRescheduleHandler });
http.route({ path: "/book/api/cancel", method: "POST", handler: bookCancelHandler });
http.route({ path: "/book/api/cancel", method: "OPTIONS", handler: bookCancelHandler });
http.route({ path: "/book/api/resync", method: "POST", handler: bookResyncHandler });
http.route({ path: "/book/api/resync", method: "OPTIONS", handler: bookResyncHandler });
http.route({ path: "/book/api/request-code", method: "POST", handler: bookRequestCodeHandler });
http.route({ path: "/book/api/request-code", method: "OPTIONS", handler: bookRequestCodeHandler });
http.route({ pathPrefix: "/book/api/poll/", method: "GET", handler: bookPollHandler });
http.route({ pathPrefix: "/book/api/poll/", method: "OPTIONS", handler: bookPollHandler });
http.route({ pathPrefix: "/book/api/poll/", method: "POST", handler: bookPollVoteHandler });
http.route({ path: "/book/mcp", method: "POST", handler: bookMcpHandler });
http.route({ path: "/book/mcp", method: "GET", handler: bookMcpHandler });
http.route({ path: "/book/mcp", method: "OPTIONS", handler: bookMcpHandler });
// Owner-side admin MCP (event types, schedules, bookings, calendars, profile).
http.route({ path: "/admin/mcp", method: "POST", handler: adminMcpHandler });
http.route({ path: "/admin/mcp", method: "GET", handler: adminMcpHandler });
http.route({ path: "/admin/mcp", method: "DELETE", handler: adminMcpHandler });
http.route({ path: "/admin/mcp", method: "OPTIONS", handler: adminMcpHandler });

// Google Calendar OAuth return leg. The consent URL is minted by
// scheduling/calendarOauth.adminStartCalendarConnect (called by the web app);
// Google lands here with `code` + our signed `state`, we exchange + persist,
// then bounce back to the web app's connected-calendar step.
const calendarOauthCallbackHandler = httpAction(async (ctx, req) => {
  const requestId = getOrMintRequestId(req);
  const webBase = (process.env.BOOK_PUBLIC_URL || process.env.SITE_URL || "").replace(/\/$/, "");
  const redirectTo = (outcome: "connected" | "error") =>
    outcome === "connected"
      ? `${webBase}/getting-started/connected-calendar?connected=google`
      : `${webBase}/getting-started/connected-calendar?calendar=error`;

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return withRequestId(new Response("Missing code or state.", { status: 400 }), requestId);
  }
  const verified = await verifyCalendarState(state);
  if (!verified.ok) {
    log.warn("calendar.oauth.callback.bad_state", { requestId, reason: verified.reason });
    return withRequestId(
      new Response(`Invalid or expired OAuth state (${verified.reason}).`, { status: 400 }),
      requestId,
    );
  }
  try {
    await ctx.runAction(internal.scheduling.calendarOauth.completeCalendarConnect, {
      authUserId: verified.authUserId,
      code,
    });
    return withRequestId(
      new Response(null, { status: 302, headers: { location: redirectTo("connected") } }),
      requestId,
    );
  } catch (err) {
    log.error("calendar.oauth.callback.exchange_failed", err, { requestId });
    return withRequestId(
      new Response(null, { status: 302, headers: { location: redirectTo("error") } }),
      requestId,
    );
  }
});
http.route({ path: "/calendar/oauth/callback", method: "GET", handler: calendarOauthCallbackHandler });

export default http;
