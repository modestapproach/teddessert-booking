import { getConnectedApps } from "@calcom/app-store/_utils/getConnectedApps";
import { prisma } from "@calcom/prisma";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";

import type { TIntegrationsInputSchema } from "./integrations.schema";

type IntegrationsOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TIntegrationsInputSchema;
};

export const integrationsHandler = async ({ ctx, input }: IntegrationsOptions) => {
  const user = ctx.user;
  try {
    return await getConnectedApps({ user, input, prisma });
  } catch {
    // CV — no-Postgres fork: no Credential/App tables, so getConnectedApps throws
    // and 500s the onboarding connect-calendar/video steps. No apps are connected
    // on the fork yet; return the empty shape so those steps render cleanly (and
    // stay skippable). Real calendar/video integration is a separate feature.
    return { items: [] };
  }
};
