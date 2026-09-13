import { createRouterCaller } from "app/_trpc/context";
import type { PageProps as ServerPageProps } from "app/_types";
import { _generateMetadata } from "app/_utils";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { APP_NAME } from "@calcom/lib/constants";
import prisma from "@calcom/prisma";
import { meRouter } from "@calcom/trpc/server/routers/viewer/me/_router";

import { buildLegacyRequest } from "@lib/buildLegacyCtx";

import Page from "~/getting-started/[[...step]]/onboarding-view";

export const generateMetadata = async ({ params }: ServerPageProps) => {
  const stepParam = (await params).step;
  const step = stepParam && Array.isArray(stepParam) ? stepParam.join("/") : "";
  return await _generateMetadata(
    (t) => `${APP_NAME} - ${t("getting_started")}`,
    () => "",
    true,
    undefined,
    `/getting-started${step ? `/${step}` : ""}`
  );
};

const ServerPage = async ({ params, searchParams }: ServerPageProps) => {
  const session = await getServerSession({ req: buildLegacyRequest(await headers(), await cookies()) });

  if (!session?.user?.id) {
    return redirect("/auth/login");
  }

  const userRepo = new UserRepository(prisma);
  const meCaller = await createRouterCaller(meRouter);

  // CV — the no-Postgres fork has no cal teams. `findUserTeams` is a direct Prisma
  // read with NO Convex fallback, so it THROWS here and 500s the onboarding page —
  // the exact route a freshly-authed dibslist user is redirected to. Guard it:
  // a null result is fine (no cal teams → no pending invites). `meCaller.get()` is
  // already rewired off Prisma (CV-2c: reads the Convex-sourced `ctx.user`), so it
  // stays as-is.
  const userTeams = await userRepo.findUserTeams({ id: session.user.id }).catch(() => null);
  const user = await meCaller.get();

  if (!user) {
    return redirect("/auth/login");
  }

  // Already-onboarded owners must not get stranded in the onboarding flow with no
  // exit (e.g. the Google Calendar OAuth callback lands them on
  // /getting-started/connected-calendar). Mirror stock cal.com: bounce a completed
  // owner straight to the dashboard.
  //
  // CRITICAL — read the flag from the FRESH `meCaller.get()` (Convex per-request),
  // NOT the 60s-cached `session.user.completedOnboarding`. The client-side
  // `useRedirectToOnboardingIfNeeded` (Shell.tsx) bounces dashboard→onboarding off
  // the same fresh `viewer.me.get`. If this guard used the cached session and the
  // two disagreed (cached-true vs fresh-false on a transient Convex blip), the two
  // redirects would ping-pong /event-types↔/getting-started. Sharing the fresh
  // source guarantees they always agree. The flag only flips false→true, so an
  // in-progress owner is never redirected away mid-flow.
  if (user.completedOnboarding) {
    redirect("/event-types");
  }

  return (
    <Page user={user} hasPendingInvites={!!userTeams?.teams.find((team) => team.accepted === false)} />
  );
};

export default ServerPage;
