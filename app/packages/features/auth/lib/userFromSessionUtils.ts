import { ProfileRepository } from "@calcom/features/profile/repositories/ProfileRepository";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { WEBAPP_URL } from "@calcom/lib/constants";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import logger from "@calcom/lib/logger";
import { getOwnerSessionPrefs } from "@calcom/lib/server/calcomAdminAdapters";
import { safeStringify } from "@calcom/lib/safeStringify";
import prisma from "@calcom/prisma";
import { teamMetadataSchema, userMetadata } from "@calcom/prisma/zod-utils";
import type { GetServerSidePropsContext, NextApiRequest } from "next";
import type { Session } from "next-auth";

type Maybe<T> = T | null | undefined;

export type SessionContext = {
  req?: NextApiRequest | GetServerSidePropsContext["req"];
  locale?: string;
  session?: Session | null;
};

// CV-9 — build the cal session user WITHOUT prisma, from the CV-1 session + Convex
// prefs, returning the EXACT shape `findUnlockedUserForSession` →
// `enrichUserWithTheProfile` produce (so it can be cast to those inferred types in
// the success-path scope below WITHOUT altering `UserFromSession`/`TrpcSessionUser`,
// which would ripple across the whole AppRouter — the `types/` hazard). Only the
// fields the cal session pipeline + downstream `ctx.user.*` readers consume carry
// real values; the rest are cal-shaped defaults (the editor/SSR re-derive them).
async function buildSessionUserFromConvex(session: NonNullable<Session>) {
  const su = session.user;
  const prefs = await getOwnerSessionPrefs({ ownerAuthUserId: su.uuid });
  // Public booking handle + bio come from the Convex calcom row (onboarding-
  // editable), falling back to the dibslist identity when unset.
  const bookingUsername = prefs.username ?? su.username ?? null;
  const base = {
    id: su.id,
    uuid: su.uuid,
    username: bookingUsername,
    name: su.name ?? null,
    email: su.email ?? "",
    emailVerified: su.emailVerified ?? null,
    bio: prefs.bio ?? null,
    avatarUrl: su.avatarUrl ?? su.image ?? null,
    timeZone: prefs.timeZone ?? "Europe/London",
    weekStart: prefs.weekStart ?? "Sunday",
    defaultScheduleId: prefs.defaultScheduleCalId,
    bufferTime: 0,
    // Appearance prefs from the Convex calcom row (set via cal's me.updateProfile).
    // null = "system" theme — the cal theme providers treat null as system default.
    theme: prefs.theme ?? null,
    appTheme: prefs.appTheme ?? null,
    createdDate: new Date(),
    hideBranding: false,
    twoFactorEnabled: false,
    identityProvider: "CAL",
    identityProviderId: null,
    brandColor: null,
    darkBrandColor: null,
    movedToProfileId: null,
    allSelectedCalendars: [],
    userLevelSelectedCalendars: [],
    completedOnboarding: prefs.completedBookingOnboarding,
    destinationCalendar: null,
    locale: su.locale ?? null,
    timeFormat: prefs.timeFormat ?? 12,
    trialEndsAt: null,
    metadata: {},
    role: su.role ?? "USER",
    allowDynamicBooking: true,
    allowSEOIndexing: true,
    receiveMonthlyDigestEmail: false,
    requiresBookerEmailVerification: false,
    profiles: [],
    // Personal profile only — single-tenant fork has no org/team. Mirrors
    // `enrichUserWithTheProfile`'s null-profile fallback (a pure, no-DB projection).
    profile: ProfileRepository.buildPersonalProfileFromUser({
      user: { id: su.id, username: bookingUsername },
    }),
  };
  return base;
}

async function getUserFromSession(ctx: SessionContext, session: Maybe<Session>) {
  if (!session) {
    return null;
  }

  if (!session.user?.id) {
    return null;
  }

  const userRepo = new UserRepository(prisma);

  // CV-9 — ROOT BUG #2. The original `findUnlockedUserForSession` +
  // `enrichUserWithTheProfile` are prisma reads that THROW on the no-Postgres fork —
  // and `isAuthed` calls this on EVERY authed request, so it gated the entire authed
  // tRPC surface (the editor lifecycle 500'd before any handler ran; tsc can't see
  // it). We now build the user from the CV-1 session + Convex prefs and FALL BACK to
  // it whenever the prisma path throws (no Postgres) or returns null. The fallback is
  // cast to the prisma-inferred `user` type *in this scope* (NOT via `ReturnType<>`,
  // which collapses to `never` cross-package), so `UserFromSession` / `TrpcSessionUser`
  // keep their EXACT type and nothing downstream ripples. On a real Postgres
  // deployment the prisma path still runs unchanged.
  const upId = session.upId;

  // Resolve the enriched prisma user, or null when there's no Postgres row / the
  // prisma read throws (the no-Postgres fork). Inferring `user` from THIS expression
  // keeps the exact prisma `enrichUserWithTheProfile` return type (driven by
  // `userFromDb`), so `UserFromSession` is unchanged.
  const prismaUser = await (async () => {
    try {
      const userFromDb = await userRepo.findUnlockedUserForSession({ userId: session.user.id });
      if (!userFromDb) return null;
      return await userRepo.enrichUserWithTheProfile({ user: userFromDb, upId });
    } catch {
      // Prisma threw (no-Postgres fork) — fall through to the Convex-built user.
      return null;
    }
  })();

  // When prisma yielded nothing, synthesize the user from the CV-1 session + Convex
  // prefs, cast to the SAME inferred type (NOT via `ReturnType<>`, which collapses to
  // `never` cross-package), so nothing downstream ripples.
  const user =
    prismaUser ?? ((await buildSessionUserFromConvex(session)) as unknown as NonNullable<typeof prismaUser>);

  logger.debug(
    `getUserFromSession: resolved session user - ${ctx.req?.url}`,
    safeStringify({ id: user?.id, upId })
  );

  const { email, username, id, uuid } = user;
  if (!email || !id) {
    return null; // should we return null here?
  }

  const userMetaData = userMetadata.parse(user.metadata || {});
  const orgMetadata = teamMetadataSchema.parse(user.profile?.organization?.metadata || {});
  // This helps to prevent reaching the 4MB payload limit by avoiding base64 and instead passing the avatar url

  const locale = user?.locale ?? ctx.locale ?? "en";
  const { members = [], ..._organization } = user.profile?.organization || {};
  const isOrgAdmin = members.some((member: { role: string }) => ["OWNER", "ADMIN"].includes(member.role));

  if (isOrgAdmin) {
    logger.debug("User is an org admin", safeStringify({ userId: user.id }));
  } else {
    logger.debug("User is not an org admin", safeStringify({ userId: user.id }));
  }
  const organization = {
    ..._organization,
    id: user.profile?.organization?.id ?? null,
    isOrgAdmin,
    metadata: orgMetadata,
    requestedSlug: orgMetadata?.requestedSlug ?? null,
  };

  return {
    ...user,
    avatar: `${WEBAPP_URL}/${user.username}/avatar.png${organization.id ? `?orgId=${organization.id}` : ""}`,
    // TODO: OrgNewSchema - later -  We could consolidate the props in user.profile?.organization as organization is a profile thing now.
    organization,
    organizationId: organization.id,
    id,
    uuid,
    email,
    username,
    locale,
    defaultBookerLayouts: userMetaData?.defaultBookerLayouts || null,
    requiresBookerEmailVerification: user.requiresBookerEmailVerification,
  };
}

export type UserFromSession = Awaited<ReturnType<typeof getUserFromSession>>;

export const getSession = async (ctx: SessionContext) => {
  const { req } = ctx;
  const { getServerSession } = await import("@calcom/features/auth/lib/getServerSession");
  return req ? await getServerSession({ req }) : null;
};

export const getUserSession = async (ctx: SessionContext) => {
  /**
   * It is possible that the session and user have already been added to the context by a previous middleware
   * or when creating the context
   */
  const session = ctx.session || (await getSession(ctx));
  const user = session ? await getUserFromSession(ctx, session) : null;
  let foundProfile = null;
  // Check authorization for profile
  if (session?.profileId && user?.id) {
    foundProfile = await ProfileRepository.findByUserIdAndProfileId({
      userId: user.id,
      profileId: session.profileId,
    });
    if (!foundProfile) {
      logger.error(
        "Profile not found or not authorized",
        safeStringify({ profileId: session.profileId, userId: user?.id })
      );
      // TODO: Test that logout should happen automatically
      throw new ErrorWithCode(ErrorCode.Unauthorized, "Profile not found or not authorized");
    }
  }

  let sessionWithUpId = null;
  if (session) {
    let upId = session.upId;
    if (!upId) {
      upId = foundProfile?.upId ?? `usr-${user?.id}`;
    }

    if (!upId) {
      throw new ErrorWithCode(ErrorCode.InternalServerError, "No upId found for session");
    }
    sessionWithUpId = {
      ...session,
      upId,
    };
  }
  return { user, session: sessionWithUpId };
};
