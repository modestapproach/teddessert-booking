import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { OWNER_ROUTING_MATCHER, RESERVED_SEGMENTS, resolveOwnerRoute } from "./ownerRouting";

const here = dirname(fileURLToPath(import.meta.url));

describe("resolveOwnerRoute", () => {
  const cases: [path: string, expected: ReturnType<typeof resolveOwnerRoute>][] = [
    ["/", { kind: "rewrite", pathname: "/ted" }],
    ["/30", { kind: "rewrite", pathname: "/ted/30" }],
    ["/meet-with-ted", { kind: "rewrite", pathname: "/ted/meet-with-ted" }],
    ["/30/embed", { kind: "rewrite", pathname: "/ted/30/embed" }],
    ["/30/", { kind: "rewrite", pathname: "/ted/30" }],
    // old-style links canonicalize
    ["/ted", { kind: "redirect", pathname: "/" }],
    ["/ted/", { kind: "redirect", pathname: "/" }],
    ["/ted/30", { kind: "redirect", pathname: "/30" }],
    ["/Ted/30", { kind: "redirect", pathname: "/30" }],
    ["/ted/30/embed", { kind: "redirect", pathname: "/30/embed" }],
    // the owner's avatar is a next.config rewrite, not a booking page
    ["/ted/avatar.png", { kind: "next" }],
    // the app's own surface passes through
    ["/dash", { kind: "next" }],
    ["/owner-login", { kind: "next" }],
    ["/event-types", { kind: "next" }],
    ["/bookings/upcoming", { kind: "next" }],
    ["/getting-started", { kind: "next" }],
    ["/settings/my-account/profile", { kind: "next" }],
    ["/booking/abc123", { kind: "next" }],
    ["/reschedule/abc123", { kind: "next" }],
    ["/api/health", { kind: "next" }],
    ["/_next/static/chunk.js", { kind: "next" }],
    ["/favicon.ico", { kind: "next" }],
    ["/robots.txt", { kind: "next" }],
    // not a slug shape → not ours
    ["/Meet", { kind: "next" }],
    ["/some_thing", { kind: "next" }],
  ];
  it.each(cases)("%s", (path, expected) => {
    expect(resolveOwnerRoute(path, "ted")).toEqual(expected);
  });

  it("does nothing without an owner username", () => {
    expect(resolveOwnerRoute("/", undefined)).toEqual({ kind: "next" });
    expect(resolveOwnerRoute("/30", "")).toEqual({ kind: "next" });
  });

  it("preserves the configured username casing in rewrite targets", () => {
    expect(resolveOwnerRoute("/30", "Ted")).toEqual({ kind: "rewrite", pathname: "/Ted/30" });
  });
});

describe("RESERVED_SEGMENTS matches the route tree", () => {
  // Every non-dynamic top-level segment under app/ and pages/ must be
  // reserved, otherwise a request for it would be rewritten into a booking
  // page. Dynamic segments ([user]) are the booking pages themselves.
  const topLevelSegments = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = entry.name;
      if (name.startsWith("[") || name.startsWith("_") || name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (name.startsWith("(") && name.endsWith(")")) out.push(...topLevelSegments(join(dir, name)));
        else out.push(name);
      }
    }
    return out;
  };

  it("covers apps/web/app", () => {
    const missing = topLevelSegments(join(here, "..", "app")).filter((s) => !RESERVED_SEGMENTS.has(s));
    expect(missing).toEqual([]);
  });

  it("covers apps/web/pages", () => {
    const missing = topLevelSegments(join(here, "..", "pages")).filter((s) => !RESERVED_SEGMENTS.has(s));
    expect(missing).toEqual([]);
  });
});

describe("OWNER_ROUTING_MATCHER", () => {
  // Next compiles the matcher with path-to-regexp; the custom group is a plain
  // regex, so an equivalent RegExp is enough to check what it selects.
  const re = new RegExp(`^${OWNER_ROUTING_MATCHER.replace(/^\//, "\\/")}$`);
  it.each(["/", "/30", "/ted", "/ted/30", "/30/embed", "/dash", "/owner-login"])("matches %s", (p) => {
    expect(re.test(p)).toBe(true);
  });
  it.each(["/api/health", "/_next/static/x.js", "/_trpc/viewer", "/favicon.ico", "/ted/avatar.png"])(
    "skips %s",
    (p) => {
      expect(re.test(p)).toBe(false);
    }
  );
});
