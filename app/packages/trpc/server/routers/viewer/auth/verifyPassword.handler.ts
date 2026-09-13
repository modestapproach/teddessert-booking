import { verifyPassword } from "@calcom/features/auth/lib/verifyPassword";
import { prisma } from "@calcom/prisma";

import { TRPCError } from "@trpc/server";

import type { TrpcSessionUser } from "../../../types";
import type { TVerifyPasswordInputSchema } from "./verifyPassword.schema";

type VerifyPasswordOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TVerifyPasswordInputSchema;
};

export const verifyPasswordHandler = async ({ input, ctx }: VerifyPasswordOptions) => {
  // no-Postgres fork: `prisma.userPassword.findUnique` THROWS (no DB); auth lives in dibslist
  // Better Auth, not cal, so on the fork (`ctx.user.uuid` = the dibslist authUserId) N/A.
  if (ctx.user.uuid) {
    throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "Not available on this deployment" });
  }

  const userPassword = await prisma.userPassword.findUnique({
    where: {
      userId: ctx.user.id,
    },
  });

  if (!userPassword?.hash) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  }

  const passwordsMatch = await verifyPassword(input.passwordInput, userPassword.hash);

  if (!passwordsMatch) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  return;
};
