import type { TFunction } from "i18next";

import { enrichUserWithDelegationConferencingCredentialsWithoutOrgId } from "@calcom/app-store/delegationCredential";
import { defaultVideoAppCategories } from "@calcom/app-store/utils";
import { buildNonDelegationCredentials } from "@calcom/lib/delegationCredential";
import { prisma } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import { AppCategories } from "@calcom/prisma/enums";
import { credentialForCalendarServiceSelect } from "@calcom/prisma/selects/credential";

import getEnabledAppsFromCredentials from "./_utils/getEnabledAppsFromCredentials";
import { defaultLocations } from "./locations";

// CV-10 — the cal-shaped location-options groups built PURELY from `defaultLocations`,
// with NO prisma read. `getLocationGroupedOptions` (below) unconditionally hits
// `prisma.user.findUnique` + `prisma.credential.findMany` to enrich the groups with
// the owner's installed video apps — which THROWS on the no-Postgres fork. On the
// fork (the `ownerAuthUserId` signal at the `getEventTypeById` call site) we have no
// cal credential/app-store graph (calendar connections are modeled separately via the
// CV-5 connectedCalendars surface), so the conferencing-app enrichment is empty anyway.
// This returns the SAME shape `getLocationGroupedOptions` produces — `{ label, options }[]`
// with the translated default locations — minus the credential-derived video-app options.
// Mirrors the trailing `defaultLocations.forEach` + translate block below, so the editor's
// location dropdown shows the in-person / custom / phone / link defaults. The returned
// array is freshly built (mutable) so the MANAGED `.splice` at the call site is safe.
export function defaultLocationGroupedOptions(t: TFunction) {
  const apps: Record<
    string,
    {
      label: string;
      value: string;
      disabled?: boolean;
      icon?: string;
      slug?: string;
      credentialId?: number;
      supportsCustomLabel?: boolean;
    }[]
  > = {};

  defaultLocations.forEach((l) => {
    const category = l.category;
    const option = {
      label: l.label,
      value: l.type,
      icon: l.iconUrl,
      supportsCustomLabel: l.supportsCustomLabel,
    };
    if (apps[category]) {
      apps[category] = [...apps[category], option];
    } else {
      apps[category] = [option];
    }
  });

  const locations = [];
  for (const category in apps) {
    locations.push({
      label: t(category),
      options: apps[category].map((l) => ({
        ...l,
        label: t(l.label),
      })),
    });
  }
  return locations;
}

export async function getLocationGroupedOptions(
  userOrTeamId: { userId: number } | { teamId: number },
  t: TFunction
) {
  const apps: Record<
    string,
    {
      label: string;
      value: string;
      disabled?: boolean;
      icon?: string;
      slug?: string;
      credentialId?: number;
      supportsCustomLabel?: boolean;
    }[]
  > = {};

  // don't default to {}, when you do TS no longer determines the right types.
  let idToSearchObject: Prisma.CredentialWhereInput;
  let user = null;
  if ("teamId" in userOrTeamId) {
    const teamId = userOrTeamId.teamId;
    // See if the team event belongs to an org
    const org = await prisma.team.findFirst({
      where: {
        children: {
          some: {
            id: teamId,
          },
        },
      },
    });

    if (org) {
      idToSearchObject = {
        teamId: {
          in: [teamId, org.id],
        },
      };
    } else {
      idToSearchObject = { teamId };
    }
  } else {
    idToSearchObject = { userId: userOrTeamId.userId };
    user = await prisma.user.findUnique({
      where: {
        id: userOrTeamId.userId,
      },
    });
  }

  const nonDelegationCredentials = await prisma.credential.findMany({
    where: {
      ...idToSearchObject,
      app: {
        categories: {
          hasSome: defaultVideoAppCategories,
        },
      },
    },
    select: {
      ...credentialForCalendarServiceSelect,
      team: {
        select: {
          name: true,
        },
      },
    },
  });

  let credentials;
  if (user) {
    // We only add delegationCredentials if the request for location options is for a user because DelegationCredential Credential is applicable to Users only.
    const { credentials: allCredentials } = await enrichUserWithDelegationConferencingCredentialsWithoutOrgId(
      {
        user: {
          ...user,
          credentials: nonDelegationCredentials,
        },
      }
    );
    credentials = allCredentials;
  } else {
    // TODO: We can avoid calling buildNonDelegationCredentials here by moving the above prisma query to the repository and doing it there
    credentials = buildNonDelegationCredentials(nonDelegationCredentials);
  }

  const integrations = await getEnabledAppsFromCredentials(credentials, { filterOnCredentials: true });

  integrations.forEach((app) => {
    // All apps that are labeled as a locationOption are video apps.
    if (app.locationOption) {
      // All apps that are labeled as a locationOption are video apps. Extract the secondary category if available
      let groupByCategory =
        app.categories.length >= 2
          ? app.categories.find((groupByCategory) => !defaultVideoAppCategories.includes(groupByCategory))
          : app.categories[0] || app.category;
      if (!groupByCategory) groupByCategory = AppCategories.conferencing;

      for (const { teamName } of app.credentials.map((credential) => ({
        teamName: credential.team?.name,
      }))) {
        const label = `${app.locationOption.label} ${teamName ? `(${teamName})` : ""}`;
        const option = {
          ...app.locationOption,
          label,
          icon: app.logo,
          slug: app.slug,
          ...(app.credential
            ? { credentialId: app.credential.id, teamName: app.credential.team?.name ?? null }
            : {}),
        };
        if (apps[groupByCategory]) {
          const existingOption = apps[groupByCategory].find((o) => o.value === option.value);
          if (!existingOption) {
            apps[groupByCategory] = [...apps[groupByCategory], option];
          }
        } else {
          apps[groupByCategory] = [option];
        }
      }
    }
  });

  defaultLocations.forEach((l) => {
    const category = l.category;
    if (apps[category]) {
      apps[category] = [
        ...apps[category],
        {
          label: l.label,
          value: l.type,
          icon: l.iconUrl,
          supportsCustomLabel: l.supportsCustomLabel,
        },
      ];
    } else {
      apps[category] = [
        {
          label: l.label,
          value: l.type,
          icon: l.iconUrl,
          supportsCustomLabel: l.supportsCustomLabel,
        },
      ];
    }
  });
  const locations = [];

  // Translating labels and pushing into array
  for (const category in apps) {
    const tmp = {
      label: t(category),
      options: apps[category].map((l) => ({
        ...l,
        label: t(l.label),
      })),
    };

    locations.push(tmp);
  }

  return locations;
}
