// CV-1 — client `useSession()` endpoint, dibslist-backed.
//
// next-auth's React client (`SessionProvider` / `useSession` / `getSession`)
// fetches `GET /api/auth/session` to hydrate the client session. The catch-all
// `[...nextauth].ts` would normally serve this from next-auth's own JWT, but the
// dibslist rewire derives the session from the Better-Auth cookie instead. A
// static route file (`session.ts`) takes precedence over the catch-all dynamic
// route in the same directory, so this handler intercepts the session fetch.
//
// Returns the cal `Session` shape (same as `getServerSession`) when authenticated,
// or an empty object `{}` when not — which is exactly what the next-auth client
// treats as "unauthenticated" (it checks for `session.user`).

import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "@calcom/features/auth/lib/getServerSession";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Never cache an auth response.
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).end();
    return;
  }

  try {
    const session = await getServerSession({ req });
    // next-auth client treats a body without `user` as unauthenticated.
    if (!session || !session.user?.id) {
      res.status(200).json({});
      return;
    }
    res.status(200).json(session);
  } catch {
    // Fail closed — report unauthenticated rather than 500 so the client UI
    // routes the user to login instead of erroring.
    res.status(200).json({});
  }
}
