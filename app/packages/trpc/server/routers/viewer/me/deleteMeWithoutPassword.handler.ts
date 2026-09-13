import { deleteStripeCustomer } from "@calcom/app-store/stripepayment/lib/customer";
import { ErrorCode } from "@calcom/features/auth/lib/ErrorCode";
import { prisma } from "@calcom/prisma";
import { IdentityProvider } from "@calcom/prisma/enums";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";

import { TRPCError } from "@trpc/server";

type DeleteMeWithoutPasswordOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
};

export const deleteMeWithoutPasswordHandler = async ({ ctx }: DeleteMeWithoutPasswordOptions) => {
  // no-Postgres fork: `prisma.user.findUnique`/delete THROW (no DB); account lifecycle lives
  // in dibslist auth, so on the fork (`ctx.user.uuid` = the dibslist authUserId) this is N/A.
  if (ctx.user.uuid) {
    throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "Not available on this deployment" });
  }

  const user = await prisma.user.findUnique({
    where: {
      email: ctx.user.email.toLowerCase(),
    },
  });
  if (!user) {
    throw new Error(ErrorCode.UserNotFound);
  }

  if (user.identityProvider === IdentityProvider.CAL) {
    throw new Error(ErrorCode.SocialIdentityProviderRequired);
  }

  if (user.twoFactorEnabled) {
    throw new Error(ErrorCode.SocialIdentityProviderRequired);
  }

  // Remove me from Stripe
  await deleteStripeCustomer(user).catch(console.warn);

  // Remove my account
  await prisma.user.delete({
    where: {
      id: ctx.user.id,
    },
  });

  return;
};
