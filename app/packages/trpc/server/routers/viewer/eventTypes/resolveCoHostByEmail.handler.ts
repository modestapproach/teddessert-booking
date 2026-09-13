import { resolveCoHostByEmail } from "@calcom/lib/server/calcomAdminAdapters";

import type { TrpcSessionUser } from "../../../types";
import type { TResolveCoHostByEmailInputSchema } from "./resolveCoHostByEmail.schema";

type ResolveCoHostByEmailOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TResolveCoHostByEmailInputSchema;
};

// CV-7 — back the event-type editor's "add co-host by email" picker. dibslist has
// no team concept; the owner adds a co-host by typing their dibslist email. We
// route through the owner-scoped Convex s2s resolver (getConvex(), trusting the
// authUserId the fork already carries on the validated session as `user.uuid`).
export const resolveCoHostByEmailHandler = async ({ ctx, input }: ResolveCoHostByEmailOptions) => {
  return resolveCoHostByEmail({
    ownerAuthUserId: ctx.user.uuid,
    email: input.email,
  });
};
