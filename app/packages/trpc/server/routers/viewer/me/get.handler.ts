// CV-2c — `viewer.me.get` rewired off Prisma. `ctx.user` is already
// Convex-sourced (CV-1: getServerSession → calcomUserMap), so the real fields
// (id/email/name/username/timeZone/locale/weekStart/bio/avatar/defaultScheduleId)
// flow straight off it. The Prisma-only enrichment (ProfileRepository,
// UserRepository.enrichUserWithTheProfile, secondaryEmail, account,
// password) is DROPPED — dibslist users have no cal org/secondary-email/
// identity-provider concept. The gap fields are filled with cal-shaped defaults
// (documented in CONVEX-REWIRE-NOTES §CV-2c): single personal profile, no org,
// empty secondaryEmails, no second identity provider.
import { ProfileRepository } from "@calcom/features/profile/repositories/ProfileRepository";
import { getUserAvatarUrl } from "@calcom/lib/getAvatarUrl";
import { userMetadata } from "@calcom/prisma/zod-utils";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { Session } from "next-auth";
import type { TGetInputSchema } from "./get.schema";

type MeOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
    session: Session;
  };
  input: TGetInputSchema;
};

export const getHandler = async ({ ctx, input: _input }: MeOptions) => {
  const crypto = await import("node:crypto");

  const { user } = ctx;

  // No second identity provider for dibslist users (Better-Auth handles login).
  const identityProviderEmail = "";
  // No cal password concept — dibslist owns auth.
  const passwordAdded = false;

  const userMetadataPrased = userMetadata.parse(user.metadata);

  // Personal profile only — no cal organizations in the dibslist booking app.
  const profileData = {
    organizationId: null,
    organization: user.organization,
    username: user.profile?.username ?? user.username ?? null,
    // buildPersonalProfileFromUser is a PURE projection (no DB); safe to keep.
    profile: user.profile ?? ProfileRepository.buildPersonalProfileFromUser({ user }),
    profiles: [],
    organizationSettings: user?.profile?.organization?.organizationSettings,
  };

  // No cal teams in the dibslist booking app.
  const canUpdateTeams = false;
  // No secondary-email model.
  const secondaryEmails: { id: number; email: string; emailVerified: Date | null }[] = [];

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailMd5: crypto.createHash("md5").update(user.email).digest("hex"),
    emailVerified: user.emailVerified,
    bufferTime: user.bufferTime,
    locale: user.locale,
    timeFormat: user.timeFormat,
    timeZone: user.timeZone,
    avatar: getUserAvatarUrl(user),
    avatarUrl: user.avatarUrl,
    createdDate: user.createdDate,
    trialEndsAt: user.trialEndsAt,
    defaultScheduleId: user.defaultScheduleId,
    completedOnboarding: user.completedOnboarding,
    twoFactorEnabled: user.twoFactorEnabled,
    identityProvider: user.identityProvider,
    identityProviderEmail,
    brandColor: user.brandColor,
    darkBrandColor: user.darkBrandColor,
    bio: user.bio,
    weekStart: user.weekStart,
    theme: user.theme,
    appTheme: user.appTheme,
    hideBranding: user.hideBranding,
    metadata: user.metadata,
    defaultBookerLayouts: user.defaultBookerLayouts,
    allowDynamicBooking: user.allowDynamicBooking,
    allowSEOIndexing: user.allowSEOIndexing,
    receiveMonthlyDigestEmail: user.receiveMonthlyDigestEmail,
    requiresBookerEmailVerification: user.requiresBookerEmailVerification,
    ...profileData,
    secondaryEmails,
    isPremium: userMetadataPrased?.isPremium,
    ...(passwordAdded ? { passwordAdded } : {}),
    canUpdateTeams,
  };
};
