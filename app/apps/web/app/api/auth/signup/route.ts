import { defaultResponderForAppDir } from "app/api/defaultResponderForAppDir";
import { NextResponse, type NextRequest } from "next/server";

import { getDibslistLoginUrl } from "@calcom/features/auth/lib/dibslistSession";

// Single-owner deployment: there is no signup. The owner signs in with the
// configured password.
async function handler(_req: NextRequest) {
  return NextResponse.json(
    {
      message: "This booking site has a single owner account. Sign in with the owner password.",
      loginUrl: getDibslistLoginUrl(),
    },
    { status: 410 }
  );
}

export const POST = defaultResponderForAppDir(handler);
