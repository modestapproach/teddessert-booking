import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { getDibslistLoginUrl } from "@calcom/features/auth/lib/dibslistSession";

import { buildLegacyRequest } from "@lib/buildLegacyCtx";

// /dash: the owner's dashboard entry. Unauthenticated visitors go to the owner
// sign-in. The public booking pages live at / and /<event-slug> (see
// lib/ownerRouting.ts) and never touch this route.
const DashPage = async () => {
  const session = await getServerSession({ req: buildLegacyRequest(await headers(), await cookies()) });

  if (!session?.user?.id) {
    redirect(getDibslistLoginUrl("/dash"));
  }

  // First run → the getting-started flow (connect calendar, availability, …).
  // completedOnboarding is sourced from Convex (calcomUserMap).
  if (!session.user.completedOnboarding) {
    redirect("/getting-started");
  }

  redirect("/event-types");
};

export default DashPage;
