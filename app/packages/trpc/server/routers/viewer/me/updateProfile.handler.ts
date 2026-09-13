// CV-8 — me.updateProfile rewired: BOOKING-PREFS subset → Convex; IDENTITY → no-op.
//
// WHY THIS FILE WAS REWRITTEN
// ───────────────────────────
// The original cal handler was ~360 lines of Prisma: `prisma.user.update` (the
// main write) plus secondaryEmail / travelSchedule / teams / schedule-timezone
// fan-out, premium-username/Stripe checks, avatar upload, and email-change
// verification. On the no-Postgres fork it THREW on the first Prisma statement
// (FeaturesRepository / secondaryEmail.findUnique / user.update), so every
// settings SAVE was dead.
//
// dibslist split: the IDENTITY fields (name / email / username / bio / avatarUrl)
// are owned by **Better Auth** (the dibslist account is the source of truth — the
// booking app never edits them). The BOOKING PREFS (timeZone / timeFormat /
// weekStart / locale) belong to the booking surface and are persisted to Convex
// (the `calcomUserMap` row, via the owner-admin prefs adapter). So this handler:
//   - persists ONLY the prefs subset to Convex (best-effort; never throws), and
//   - CLEANLY IGNORES every identity / out-of-scope field (name/email/username/
//     bio/avatar/secondaryEmails/travelSchedules/premium-username/Stripe/
//     completedOnboarding-team-propagation/email-verification) — they are
//     destructured out and never reach a write. NOTHING here touches ctx.prisma.
//
// The cal React settings form, the tRPC client, and the zod input/output schema
// are UNTOUCHED. The return shape is preserved EXACTLY (echo input + email +
// avatarUrl + hasEmailBeenChanged + sendEmailVerification) so the form's onSuccess
// + the SSR profile reload keep working. Since email/avatar are Better-Auth-owned
// and never change here, `hasEmailBeenChanged`/`sendEmailVerification` are always
// false and `email`/`avatarUrl` echo the input.
//
// The booker-layout metadata validation (validateBookerLayouts) + the metadata
// allow-list clean (cleanMetadataAllowedUpdateKeys) are PURE (no DB) and KEPT, so
// a bad layout still returns the same BAD_REQUEST the cal form expects.

import logger from "@calcom/lib/logger";
import { getTranslation } from "@calcom/i18n/server";
import { validateBookerLayouts } from "@calcom/lib/validateBookerLayouts";
import { userMetadata as userMetadataSchema } from "@calcom/prisma/zod-utils";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { updateOwnerBookingPrefs } from "@calcom/lib/server/calcomAdminAdapters";
import { clearSessionCacheForUser } from "@calcom/features/auth/lib/getServerSession";
import { TRPCError } from "@trpc/server";
import type { GetServerSidePropsContext, NextApiResponse } from "next";
import { type TUpdateProfileInputSchema, updateUserMetadataAllowedKeys } from "./updateProfile.schema";

type UpdateProfileOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
    res?: NextApiResponse | GetServerSidePropsContext["res"];
  };
  input: TUpdateProfileInputSchema;
};

export const updateProfileHandler = async ({ ctx, input }: UpdateProfileOptions) => {
  const { user } = ctx;
  const locale = input.locale || user.locale;

  // Pure (no DB): reject a malformed booker-layout the same way cal did, so the
  // form keeps its exact validation behaviour.
  const layoutError = validateBookerLayouts(input?.metadata?.defaultBookerLayouts || null);
  if (layoutError) {
    const t = await getTranslation(locale, "common");
    throw new TRPCError({ code: "BAD_REQUEST", message: t(layoutError) });
  }

  // Persist the BOOKING-PREFS subset to Convex (best-effort — the adapter swallows
  // a transport error so a settings save can't 500). The getting-started flow ALSO
  // writes a few profile/identity fields here: the Step-1 public booking handle
  // (username), the Step-5 bio, and the Finish flag (completedOnboarding) that
  // marks the owner done so the root stops routing them through onboarding.
  // name/email/avatar stay Better-Auth-owned and are still ignored.
  const ownerAuthUserId = ctx.user.uuid;
  await updateOwnerBookingPrefs({
    ownerAuthUserId,
    ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
    ...(input.weekStart !== undefined ? { weekStart: input.weekStart } : {}),
    ...(input.timeFormat !== undefined ? { timeFormat: input.timeFormat } : {}),
    ...(input.locale !== undefined ? { locale: input.locale } : {}),
    ...(input.username !== undefined ? { bookingUsername: input.username } : {}),
    ...(input.bio !== undefined ? { bio: input.bio } : {}),
    ...(input.completedOnboarding !== undefined
      ? { completedBookingOnboarding: input.completedOnboarding }
      : {}),
    // Appearance settings: persist the booking-page theme + dashboard appTheme so
    // the choice survives a reload (the session re-reads these into ctx.user).
    ...(input.theme !== undefined ? { theme: input.theme } : {}),
    ...(input.appTheme !== undefined ? { appTheme: input.appTheme } : {}),
    // cal's tz-change side effect: when the timezone changes, propagate it to the
    // owner's default schedule (the Convex core no-ops if there is no default).
    ...(input.timeZone !== undefined && input.timeZone !== user.timeZone
      ? { propagateTimeZoneToDefaultSchedule: true }
      : {}),
  });

  // Bust the 60s getServerSession cache for this owner when a session-reflected
  // field changed, so the new value is visible on the VERY NEXT request rather than
  // up to a minute later. This matters most for `completedOnboarding`: the Finish
  // step flips it true, and without this the cached-false session could bounce the
  // owner back into onboarding on their next navigation.
  if (input.completedOnboarding !== undefined || input.username !== undefined) {
    clearSessionCacheForUser(ownerAuthUserId);
  }

  // Preserve the metadata allow-list clean (pure) for any reader of the echoed
  // metadata, even though we don't persist the full metadata blob to Convex.
  const cleanedMetadata = handleUserMetadata({ ctx, input });

  // Return the EXACT cal shape the form's onSuccess + the SSR reload expect.
  // email/avatarUrl are Better-Auth-owned + unchanged here, so we echo the input
  // (or the session value) and report no email change / no verification needed.
  return {
    ...input,
    metadata: cleanedMetadata,
    email: input.email ?? user.email,
    avatarUrl: input.avatarUrl ?? user.avatarUrl ?? null,
    hasEmailBeenChanged: false,
    sendEmailVerification: false,
  };
};

const cleanMetadataAllowedUpdateKeys = (metadata: TUpdateProfileInputSchema["metadata"]) => {
  if (!metadata) {
    return {};
  }
  const cleanedMetadata = updateUserMetadataAllowedKeys.safeParse(metadata);
  if (!cleanedMetadata.success) {
    logger.error("Error cleaning metadata", cleanedMetadata.error);
    return {};
  }

  return cleanedMetadata.data;
};

const handleUserMetadata = ({ ctx, input }: UpdateProfileOptions) => {
  const { user } = ctx;
  const cleanMetadata = cleanMetadataAllowedUpdateKeys(input.metadata);
  const userMetadata = userMetadataSchema.parse(user.metadata);
  // Required so we don't override and delete saved values
  return { ...userMetadata, ...cleanMetadata };
};
