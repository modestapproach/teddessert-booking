/**
 * SINGLE-OWNER CLEAN URLS.
 *
 * This deployment has exactly one bookable person, so Cal.com's
 * `/<username>/…` namespace is noise in every link the owner hands out.
 * `proxy.ts` asks this module what to do with each request path:
 *
 *   /                  → rewrite  /<username>              profile: every public event
 *   /<slug>            → rewrite  /<username>/<slug>       one event's booking page
 *   /<slug>/embed      → rewrite  /<username>/<slug>/embed
 *   /<username>        → redirect /                        old links canonicalize
 *   /<username>/<slug> → redirect /<slug>
 *
 * The owner dashboard moved from `/` to `/dash`. Everything the app owns at
 * the top level (dashboard pages, api, auth, static files, Next internals)
 * passes through untouched. RESERVED_SEGMENTS is checked against the real
 * route tree by ownerRouting.test.ts, so an upgrade that adds a top-level
 * route fails the test instead of silently being rewritten into a booking
 * page. Locale-prefixed paths (/en/…) were never public URLs here and are
 * not supported as clean slugs.
 */
export type OwnerRoute =
  | { kind: "next" }
  | { kind: "rewrite"; pathname: string }
  | { kind: "redirect"; pathname: string };

export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set([
  // apps/web/app/** top-level route segments (route groups expanded)
  "api",
  "apps",
  "auth",
  "availability",
  "booking",
  "booking-successful",
  "cache",
  "d",
  "dash",
  "e2e",
  "enterprise",
  "event-types",
  "getting-started",
  "icons",
  "lottery",
  "maintenance",
  "members",
  "more",
  "onboarding",
  "owner-login",
  "pair",
  "payment",
  "refer",
  "reschedule",
  "settings",
  "signup",
  "upgrade",
  "video",
  // apps/web/pages/**
  "router",
  // paths that next.config.ts rewrites or redirects
  "bookings",
  "call",
  "cancel",
  "embed",
  "forms",
  "login",
  "org",
  "routing",
  "routing-forms",
  "success",
  "support",
  "team",
  // upstream Cal.com routes not present in this fork today; reserved so an
  // upgrade cannot collide with an event slug
  "insights",
  "teams",
  "workflows",
]);

// The proxy matcher: every page path except API routes, Next internals and
// files. Kept here so the test can exercise the same pattern.
export const OWNER_ROUTING_MATCHER = "/((?!api/|_next/|_trpc/|_proxy/|.*\\..*).*)";

// Cal.com enforces lowercase kebab-case on event slugs.
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isFile = (segment: string) => segment.includes(".");

export function resolveOwnerRoute(pathname: string, ownerUsername: string | undefined): OwnerRoute {
  const username = ownerUsername?.trim();
  if (!username) return { kind: "next" };
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return { kind: "rewrite", pathname: `/${username}` };
  const [first, ...rest] = segments;
  if (first.startsWith("_") || isFile(first) || RESERVED_SEGMENTS.has(first)) return { kind: "next" };
  if (first.toLowerCase() === username.toLowerCase()) {
    // /<username>/avatar.png is served by a next.config rewrite; leave files alone.
    if (rest.length && isFile(rest[rest.length - 1])) return { kind: "next" };
    return { kind: "redirect", pathname: rest.length ? `/${rest.join("/")}` : "/" };
  }
  if (!SLUG.test(first)) return { kind: "next" };
  return { kind: "rewrite", pathname: `/${username}/${segments.join("/")}` };
}
