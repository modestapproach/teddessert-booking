import { NextResponse } from "next/server";

import { OWNER_COOKIE } from "@calcom/features/auth/lib/dibslistSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ORIGIN = (process.env.NEXT_PUBLIC_WEBAPP_URL || "http://localhost:3000").replace(/\/$/, "");

// Clears the owner session cookie and lands on the sign-in page.
export async function GET() {
  const res = NextResponse.redirect(`${ORIGIN}/owner-login`, { status: 303 });
  res.cookies.set(OWNER_COOKIE, "", {
    path: "/",
    maxAge: 0,
    httpOnly: true,
    secure: ORIGIN.startsWith("https://"),
    sameSite: "lax",
  });
  return res;
}
