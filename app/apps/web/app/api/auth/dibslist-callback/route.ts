import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ORIGIN = (process.env.NEXT_PUBLIC_WEBAPP_URL || "http://localhost:3000").replace(/\/$/, "");

// Legacy cross-domain callback from the dibslist era. Standalone auth is the
// owner password; anything landing here just goes to sign-in.
export async function GET() {
  return NextResponse.redirect(`${ORIGIN}/owner-login`, { status: 303 });
}
