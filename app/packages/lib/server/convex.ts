import { ConvexHttpClient } from "convex/browser";

/**
 * Server-side Convex client for the dibslist data-layer rewire.
 *
 * cal.com's data layer is being migrated off Postgres/Prisma onto dibslist's
 * Convex backend (the live `jovial-meadowlark-781` "meadowlark" deployment).
 * tRPC resolvers reach Convex through `ctx.convex` (see
 * `packages/trpc/server/createContext.ts`), which is sourced from `getConvex()`.
 *
 * The unauthenticated client holds no open connection, so a single module-level
 * instance is reused across requests (mirrors how `@calcom/prisma` lazily inits its
 * singleton `PrismaClient`). An authenticated call gets its OWN client because
 * `setAuth` mutates client state and a shared client would race across concurrent
 * requests.
 *
 * Env:
 * - `NEXT_PUBLIC_CONVEX_URL`  — required, the Convex deployment URL (meadowlark).
 * - `CONVEX_DEPLOY_KEY`       — NOTE: `ConvexHttpClient`'s public API only exposes
 *                               `setAuth(jwt)` (an OpenID identity token); there is no
 *                               public `setAdminAuth` (the original recipe was wrong).
 *                               A Convex *deploy key* is not a JWT, so this helper does
 *                               NOT consume it. Server-to-server admin access against
 *                               meadowlark should instead use a Convex function that
 *                               trusts a shared secret, or mint a service JWT and pass it
 *                               via `getConvex(jwt)`. See CONVEX-REWIRE-NOTES.md.
 *
 * @param authToken Optional OpenID/JWT identity token applied via `setAuth`, so the
 *                  Convex function sees `ctx.auth`. Pass the end-user's token from the
 *                  tRPC session when a resolver should act as that user.
 */
function convexUrl(): string {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is not set");
  }
  return url;
}

// Unauthenticated singleton, reused across requests. `ConvexHttpClient` holds no open
// connection, so sharing it for anonymous/public calls is safe (mirrors @calcom/prisma).
let anonClient: ConvexHttpClient | undefined;

export function getConvex(authToken?: string): ConvexHttpClient {
  if (!authToken) {
    if (!anonClient) {
      anonClient = new ConvexHttpClient(convexUrl());
    }
    return anonClient;
  }

  // A per-call identity token mutates client auth, so an authed call gets its OWN
  // client to avoid a data race with concurrent requests sharing one mutable client.
  // `setAuth` accepts a JWT identity token only (NOT a Convex deploy key).
  const authed = new ConvexHttpClient(convexUrl());
  authed.setAuth(authToken);
  return authed;
}
