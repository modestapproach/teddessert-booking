// CV-2a — public event-type meta now comes from Convex, not Prisma/Postgres.
//
// `EventRepository.getPublicEvent` is the SINGLE entry point the public Booker
// uses for event meta — it is called by both the tRPC `viewer.public.event`
// handler and the `[user]/[type]` SSR loader. We keep its signature + return
// shape (a cal `PublicEventType`-compatible object | null) so NO caller or React
// component changes, and swap its body to read from the dibslist Convex backend
// via the CV-2a adapter (`mapConvexEventToPublicEvent`).
//
// See packages/lib/server/calcomAdapters.ts for the Convex→cal mapping, the
// username↔owner-slug decision, and the documented field-gap defaults.

import { mapConvexEventToPublicEvent } from "@calcom/lib/server/calcomAdapters";

export type GetPublicEventInput = {
  username: string;
  eventSlug: string;
  isTeamEvent?: boolean;
  org: string | null;
  fromRedirectOfNonOrgLink: boolean;
};

export class EventRepository {
  /**
   * @param input  the cal public-event lookup args. `eventSlug` (the `[type]`
   *               URL segment) is our flat global Convex slug; `username` (the
   *               `[user]` segment) is display-only and does NOT scope the
   *               lookup (see calcomAdapters.ts header).
   * @param _userId the authed viewer's cal id (unused now — visibility gating is
   *               enforced inside Convex; kept for signature compatibility).
   */
  static async getPublicEvent(input: GetPublicEventInput, _userId?: number) {
    const event = await mapConvexEventToPublicEvent({
      username: input.username,
      eventSlug: input.eventSlug,
      fromRedirectOfNonOrgLink: input.fromRedirectOfNonOrgLink,
    });
    return event;
  }
}
