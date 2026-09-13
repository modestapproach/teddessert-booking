import { passwordResetRequest } from "@calcom/features/auth/lib/passwordResetRequest";
import prisma from "@calcom/prisma";
import { IdentityProvider } from "@calcom/prisma/enums";

import { TRPCError } from "@trpc/server";

import type { TrpcSessionUser } from "../../../types";

type CreateAccountPasswordOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
};

export const createAccountPasswordHandler = async ({ ctx }: CreateAccountPasswordOptions) => {
  const { user } = ctx;

  // no-Postgres fork: `prisma.user.findUnique` THROWS (no DB); auth lives in dibslist Better
  // Auth, not cal, so on the fork (`user.uuid` = the dibslist authUserId) this is N/A.
  if (user.uuid) {
    throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "Not available on this deployment" });
  }

  const isCal = user.identityProvider === IdentityProvider.CAL;
  if (isCal) {
    throw new TRPCError({ code: "FORBIDDEN", message: "cannot_create_account_password_cal_provider" });
  }

  const userWithPassword = await prisma.user.findUnique({
    where: {
      id: user.id,
    },
    select: {
      password: true,
    },
  });
  if (!isCal && userWithPassword?.password?.hash) {
    throw new TRPCError({ code: "FORBIDDEN", message: "cannot_create_account_password_already_existing" });
  }

  await passwordResetRequest(user);
};
