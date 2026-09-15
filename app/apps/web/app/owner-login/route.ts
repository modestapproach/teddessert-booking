import { NextResponse, type NextRequest } from "next/server";

import {
  allowedAccessEmails,
  verifyAccessAssertion,
} from "@calcom/features/auth/lib/cloudflareAccess";
import { OWNER_COOKIE, ownerSessionToken } from "@calcom/features/auth/lib/dibslistSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/dash";
  return raw;
}

// GET /owner-login — sits behind a Cloudflare Access application scoped to
// this exact path (Google login, owner emails only). By the time a request
// reaches here Access has already authenticated it, so this just verifies
// the signed identity Access attached and mints the app's own owner cookie.
// No form, no password: visiting this URL while signed out of Google bounces
// through Access's login first, then lands back here already verified.
export async function GET(req: NextRequest) {
  const next = safeNext(req.nextUrl.searchParams.get("next"));
  const email = await verifyAccessAssertion(req.headers.get("cf-access-jwt-assertion"));
  const token = ownerSessionToken();

  if (!email || !allowedAccessEmails().includes(email) || !token) {
    return new NextResponse("Access denied: not an authorized owner account.", { status: 403 });
  }

  const res = NextResponse.redirect(new URL(next, req.nextUrl));
  res.cookies.set(OWNER_COOKIE, token, {
    path: "/",
    httpOnly: true,
    secure: req.nextUrl.protocol === "https:",
    sameSite: "lax",
    maxAge: 30 * 24 * 3600,
  });
  return res;
}
