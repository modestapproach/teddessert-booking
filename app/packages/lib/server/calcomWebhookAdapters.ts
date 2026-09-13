// BOOKING WEBHOOKS — OWNER-ADMIN Convex↔cal adapters (server-side, owner-scoped).
//
// Companion to calcomAdminAdapters.ts. The cal event-type Webhooks tab + the
// user-level webhook settings page write/read `Webhook` rows; on the no-Postgres
// fork those prisma calls throw. These adapters route the fork's webhook trpc
// handlers to the Convex `webhooks:owner*` fns, which take an explicit
// `ownerAuthUserId` (the trusted dibslist authUserId the fork carries on
// `session.user.uuid`) and are reachable via the unauthenticated `getConvex()`
// client — same server-to-server trust model as the calcomAdmin adapters.
//
// The Convex fns return the cal `Webhook` shape directly (decrypted secret for the
// owner), so the trpc handlers map straight through.

import { getConvex } from "@calcom/lib/server/convex";
import { makeFunctionReference } from "convex/server";

// The cal `Webhook` shape the Convex owner fns return.
export interface CalWebhookShape {
  id: string;
  subscriberUrl: string;
  eventTriggers: string[];
  active: boolean;
  payloadTemplate: string | null;
  secret: string | null;
  eventTypeId: number | null;
  teamId: number | null;
  appId: string | null;
  time: number | null;
  timeUnit: string | null;
  platform: boolean;
}

const ownerListWebhooksRef = makeFunctionReference<"query">(
  "webhooks:ownerListWebhooks"
);
const ownerGetWebhookRef = makeFunctionReference<"query">(
  "webhooks:ownerGetWebhook"
);
const ownerCreateWebhookRef = makeFunctionReference<"mutation">(
  "webhooks:ownerCreateWebhook"
);
const ownerUpdateWebhookRef = makeFunctionReference<"mutation">(
  "webhooks:ownerUpdateWebhook"
);
const ownerDeleteWebhookRef = makeFunctionReference<"mutation">(
  "webhooks:ownerDeleteWebhook"
);
const ownerTestWebhookRef = makeFunctionReference<"mutation">(
  "webhooks:ownerTestWebhook"
);

/** s2s — the owner's webhooks, optionally scoped to one cal event type. */
export async function listOwnerWebhooks(args: {
  ownerAuthUserId: string;
  eventTypeCalId?: number;
}): Promise<CalWebhookShape[]> {
  return (await getConvex().query(ownerListWebhooksRef, {
    ownerAuthUserId: args.ownerAuthUserId,
    ...(args.eventTypeCalId !== undefined
      ? { eventTypeCalId: args.eventTypeCalId }
      : {}),
  })) as CalWebhookShape[];
}

/** s2s — a single owner-scoped webhook (null if not found / not owned). */
export async function getOwnerWebhook(args: {
  ownerAuthUserId: string;
  id: string;
}): Promise<CalWebhookShape | null> {
  return (await getConvex().query(ownerGetWebhookRef, {
    ownerAuthUserId: args.ownerAuthUserId,
    id: args.id,
  })) as CalWebhookShape | null;
}

export async function createOwnerWebhook(args: {
  ownerAuthUserId: string;
  subscriberUrl: string;
  eventTriggers: string[];
  active: boolean;
  payloadTemplate?: string | null;
  secret?: string | null;
  eventTypeCalId?: number;
}): Promise<CalWebhookShape> {
  return (await getConvex().mutation(ownerCreateWebhookRef, {
    ownerAuthUserId: args.ownerAuthUserId,
    subscriberUrl: args.subscriberUrl,
    eventTriggers: args.eventTriggers,
    active: args.active,
    payloadTemplate: args.payloadTemplate ?? null,
    secret: args.secret ?? null,
    ...(args.eventTypeCalId !== undefined
      ? { eventTypeCalId: args.eventTypeCalId }
      : {}),
  })) as CalWebhookShape;
}

export async function updateOwnerWebhook(args: {
  ownerAuthUserId: string;
  id: string;
  subscriberUrl?: string;
  eventTriggers?: string[];
  active?: boolean;
  payloadTemplate?: string | null;
  secret?: string | null;
}): Promise<CalWebhookShape> {
  return (await getConvex().mutation(ownerUpdateWebhookRef, {
    ownerAuthUserId: args.ownerAuthUserId,
    id: args.id,
    ...(args.subscriberUrl !== undefined
      ? { subscriberUrl: args.subscriberUrl }
      : {}),
    ...(args.eventTriggers !== undefined
      ? { eventTriggers: args.eventTriggers }
      : {}),
    ...(args.active !== undefined ? { active: args.active } : {}),
    ...(args.payloadTemplate !== undefined
      ? { payloadTemplate: args.payloadTemplate }
      : {}),
    ...(args.secret !== undefined ? { secret: args.secret } : {}),
  })) as CalWebhookShape;
}

export async function deleteOwnerWebhook(args: {
  ownerAuthUserId: string;
  id: string;
}): Promise<{ ok: boolean; id: string }> {
  return (await getConvex().mutation(ownerDeleteWebhookRef, {
    ownerAuthUserId: args.ownerAuthUserId,
    id: args.id,
  })) as { ok: boolean; id: string };
}

export async function testOwnerWebhook(args: {
  ownerAuthUserId: string;
  id: string;
}): Promise<{ ok: boolean }> {
  return (await getConvex().mutation(ownerTestWebhookRef, {
    ownerAuthUserId: args.ownerAuthUserId,
    id: args.id,
  })) as { ok: boolean };
}
