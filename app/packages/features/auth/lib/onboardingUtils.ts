import dayjs from "@calcom/dayjs";
import { FeaturesRepository } from "@calcom/features/flags/features.repository";
import { MembershipRepository } from "@calcom/features/membership/repositories/MembershipRepository";
import { ProfileRepository } from "@calcom/features/profile/repositories/ProfileRepository";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { prisma } from "@calcom/prisma";

const ONBOARDING_INTRODUCED_AT = dayjs("September 1 2021").toISOString();

/**
 * Checks if a user needs onboarding on the server side.
 * Returns the onboarding path if redirect is needed, null otherwise.
 *
 * @param userId - The user ID to check
 * @param options - Optional configuration
 * @param options.checkEmailVerification - Whether to check if email verification is required
 * @param options.organizationId - Optional organizationId from session (to avoid extra query)
 */
export async function checkOnboardingRedirect(
  userId: number,
  options?: {
    checkEmailVerification?: boolean;
    organizationId?: number | null;
  }
): Promise<string | null> {
  // CV (booking-onboarding-flow-prd step 13): the no-Postgres fork has no cal `User`
  // table, so `UserRepository.findById` below THROWS — and the only caller
  // (/event-types page) awaits this with no try/catch, so it 500s the post-onboarding
  // landing for every authed owner. On the fork we return null (no redirect) because:
  //   1. The booking ROOT page (book.dibslist.app/) already gates onboarding via the
  //      Convex-sourced `session.user.completedOnboarding`, so this per-page re-gate is
  //      redundant for the normal flow.
  //   2. Re-gating here would ALSO loop: getServerSession caches the session for 60s, so
  //      an owner who JUST finished onboarding (UserProfile pushes straight to
  //      /event-types) would read a stale completedOnboarding=false and bounce back to
  //      /getting-started until the cache expired.
  // The original Prisma path is preserved unchanged for a real Postgres deploy.
  if (process.env.NEXT_PUBLIC_CONVEX_URL) {
    return null;
  }

  // Query user data needed for onboarding check using UserRepository
  const userRepository = new UserRepository(prisma);
  const user = await userRepository.findById({ id: userId });

  if (!user) {
    return null;
  }

  // Use provided organizationId or query it via ProfileRepository
  let organizationId: number | null;
  if (options?.organizationId !== undefined) {
    organizationId = options.organizationId;
  } else {
    const profile = await ProfileRepository.findFirstForUserId({ userId });
    organizationId = profile?.organizationId ?? null;
  }

  // Check if user should be shown onboarding
  const shouldShowOnboarding =
    !user.completedOnboarding && !organizationId && dayjs(user.createdDate).isAfter(ONBOARDING_INTRODUCED_AT);

  if (!shouldShowOnboarding) {
    return null;
  }

  // Check email verification if needed
  const featuresRepository = new FeaturesRepository(prisma);

  if (options?.checkEmailVerification) {
    const emailVerificationEnabled =
      await featuresRepository.checkIfFeatureIsEnabledGlobally("email-verification");

    if (!user.emailVerified && user.identityProvider === "CAL" && emailVerificationEnabled) {
      // User needs email verification, redirect to verification page
      return "/auth/verify-email";
    }
  }

  // Determine which onboarding path to use
  const onboardingV3Enabled = await featuresRepository.checkIfFeatureIsEnabledGlobally("onboarding-v3");

  // Check for any team membership (pending or accepted) to handle users who signed up via invite token
  // When users sign up with an invite token, the membership is auto-accepted
  const hasTeamMembership = await MembershipRepository.hasAnyTeamMembershipByUserId({ userId });

  if (hasTeamMembership && onboardingV3Enabled) {
    return "/onboarding/personal/settings";
  }

  return onboardingV3Enabled ? "/onboarding/getting-started" : "/getting-started";
}
