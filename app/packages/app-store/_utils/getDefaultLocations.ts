import type { z } from "zod";

import { getUsersCredentialsIncludeServiceAccountKey } from "@calcom/app-store/delegationCredential";
import type { Prisma } from "@calcom/prisma/client";
import { userMetadata as userMetadataSchema, type eventTypeLocations } from "@calcom/prisma/zod-utils";

import { DailyLocationType } from "../constants";
import getApps from "../utils";
import getAppKeysFromSlug from "./getAppKeysFromSlug";

type EventTypeLocation = z.infer<typeof eventTypeLocations>[number];

type User = {
  id: number;
  email: string;
  metadata: Prisma.JsonValue;
};

export async function getDefaultLocations(user: User): Promise<EventTypeLocation[]> {
  // CV (booking-onboarding-flow-prd): both branches below hit Prisma —
  // `getUsersCredentialsIncludeServiceAccountKey` and `getAppKeysFromSlug` read the
  // app-store credential/key tables, which THROW on the no-Postgres fork. This runs
  // inside `eventTypesHeavy.create` (the onboarding Finish step seeds 3 default event
  // types) BEFORE that handler's try/catch, so it 500s the whole create — onboarding
  // completes but no event types are created (empty dashboard → nothing bookable).
  // The fork has no app-store credentials; default event types are created
  // location-less (a location can be added later). Return [] on the fork.
  if (process.env.NEXT_PUBLIC_CONVEX_URL) return [];

  const defaultConferencingData = userMetadataSchema.parse(user.metadata)?.defaultConferencingApp;

  if (defaultConferencingData && defaultConferencingData.appSlug !== "daily-video") {
    // We are not returning the credential, so we are fine with the service account key
    const credentials = await getUsersCredentialsIncludeServiceAccountKey(user);

    const foundApp = getApps(credentials, true).filter(
      (app) => app.slug === defaultConferencingData.appSlug
    )[0]; // There is only one possible install here so index [0] is the one we are looking for ;
    const locationType = foundApp?.locationOption?.value ?? DailyLocationType; // Default to Daily if no location type is found
    return [{ type: locationType, link: defaultConferencingData.appLink }];
  }

  const appKeys = await getAppKeysFromSlug("daily-video");

  if (typeof appKeys.api_key === "string") {
    return [{ type: DailyLocationType }];
  }

  return [];
}
