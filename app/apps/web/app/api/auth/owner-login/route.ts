import { NextResponse, type NextRequest } from "next/server";

import {
  OWNER_COOKIE,
  ownerSessionToken,
  passwordMatches,
} from "@calcom/features/auth/lib/dibslistSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ORIGIN = (process.env.NEXT_PUBLIC_WEBAPP_URL || "http://localhost:3000").replace(/\/$/, "");

function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/dash";
  return raw;
}

// POST /api/auth/owner-login — form fields: password, next.
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const password = String(form.get("password") ?? "");
  const next = safeNext(form.get("next") ? String(form.get("next")) : null);

  const token = ownerSessionToken();
  if (!token || !passwordMatches(password)) {
    return NextResponse.redirect(`${ORIGIN}/owner-login?error=1&next=${encodeURIComponent(next)}`, {
      status: 303,
    });
  }

  const res = NextResponse.redirect(`${ORIGIN}${next}`, { status: 303 });
  res.cookies.set(OWNER_COOKIE, token, {
    path: "/",
    httpOnly: true,
    secure: ORIGIN.startsWith("https://"),
    sameSite: "lax",
    maxAge: 30 * 24 * 3600,
  });
  return res;
}
