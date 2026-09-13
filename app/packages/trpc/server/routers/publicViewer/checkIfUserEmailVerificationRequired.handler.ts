import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { extractBaseEmail } from "@calcom/lib/extract-base-email";
import logger from "@calcom/lib/logger";
import { prisma } from "@calcom/prisma";

import type { TUserEmailVerificationRequiredSchema } from "./checkIfUserEmailVerificationRequired.schema";

const log = logger.getSubLogger({ prefix: ["checkIfUserEmailVerificationRequired"] });

export const userWithEmailHandler = async ({ input }: { input: TUserEmailVerificationRequiredSchema }) => {
  return checkEmailVerificationRequired(input);
};

export const checkEmailVerificationRequired = async ({
  userSessionEmail,
  email,
}: {
  userSessionEmail?: string;
  email: string;
}) => {
  const baseEmail = extractBaseEmail(email);

  const blacklistedGuestEmails = process.env.BLACKLISTED_GUEST_EMAILS
    ? process.env.BLACKLISTED_GUEST_EMAILS.split(",")
    : [];

  const blacklistedEmail = blacklistedGuestEmails.find(
    (guestEmail: string) => guestEmail.toLowerCase() === baseEmail.toLowerCase()
  );

  if (!!blacklistedEmail && blacklistedEmail !== userSessionEmail) {
    log.warn(`blacklistedEmail: ${blacklistedEmail}`);
    return true;
  }

  // no-Postgres fork: `UserRepository(prisma).findManyByEmailsWithEmailVerificationSettings`
  // reads `prisma.user` → THROWS. This is a publicViewer handler (no ctx.user/uuid) fired on the
  // PUBLIC booking form the moment a booker types their email, so gate on the env signal. The fork
  // does not model per-booker email verification → default to NOT required. Postgres path intact.
  if (process.env.NEXT_PUBLIC_CONVEX_URL) {
    return false;
  }

  const userRepo = new UserRepository(prisma);
  const users = await userRepo.findManyByEmailsWithEmailVerificationSettings({ emails: [baseEmail] });
  const user = users[0];

  if (user?.requiresBookerEmailVerification && baseEmail.toLowerCase() !== userSessionEmail?.toLowerCase()) {
    log.warn(`user email requiring verification: ${baseEmail}`);
    return true;
  }

  return false;
};

export default userWithEmailHandler;
