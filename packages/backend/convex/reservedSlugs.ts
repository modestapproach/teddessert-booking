// Slugs an event type may not use: paths the booking app itself routes
// (dashboard pages, api, auth, files). The proxy in app/apps/web maps
// book.teddessert.com/<slug> onto the owner's booking page for everything
// else, so an event named "settings" would be unreachable. Source of truth is
// RESERVED_SEGMENTS in app/packages/lib/ownerRouting.ts; its test asserts this
// copy stays identical.
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
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
  "router",
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
  "insights",
  "teams",
  "workflows",
]);

export function isReservedSlug(slug: string): boolean {
  const s = slug.trim().toLowerCase();
  return s.startsWith("_") || s.includes(".") || RESERVED_SLUGS.has(s);
}
