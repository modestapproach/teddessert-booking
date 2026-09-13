// HTTP-API-AUDIT-iter57 M3 — request correlation header.
//
// Stamp every HTTP response with `x-request-id` so a client-side error
// (PostHog `$exception`, browser devtools, extension log) can be joined
// back to the Convex function log line that produced it. Without this,
// the only correlation is timestamp + handler name, which is fragile
// under concurrent load and useless for low-frequency tail errors.
//
// Inbound trust: if a caller sends an `X-Request-Id` we honor it (lets
// the extension SW mint one client-side, log it locally, AND have the
// same id surface in Convex logs). Bound to a conservative charset +
// length so a hostile caller can't inject log-line breakers or unbounded
// strings into our structured logs.
//
// Mint path: Convex's V8 runtime exposes `crypto.getRandomValues` but
// not `crypto.randomUUID` reliably across versions. We avoid the
// portability question by using `Date.now()` + `Math.random()` packed
// into base36 — sufficient entropy for correlation (not for security),
// matches the `req_<base36>` shape used by Stripe / Linear / Vercel.

const INBOUND_RE = /^[a-zA-Z0-9_-]{8,64}$/;

export function getOrMintRequestId(req: Request): string {
  const inbound = req.headers.get("x-request-id") ?? req.headers.get("X-Request-Id");
  if (inbound && INBOUND_RE.test(inbound)) {
    return inbound;
  }
  // 8 chars of base36 random + base36 timestamp = ~13-14 char id total
  // after the `req_` prefix. Collision probability is negligible for
  // correlation use (we're not using this as a primary key).
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `req_${ts}_${rand}`;
}

// Stamp the request-id on a Response. Returns the same Response object
// so call sites can chain (`return withRequestId(jsonResponse(...), id)`).
// `Response.headers` is mutable in the Convex V8 runtime even though some
// Fetch-spec impls freeze it after construction — we exercise this in
// every wrapped handler.
export function withRequestId<T extends Response>(response: T, requestId: string): T {
  response.headers.set("x-request-id", requestId);
  return response;
}
