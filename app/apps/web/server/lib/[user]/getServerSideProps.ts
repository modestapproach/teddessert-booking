import { encode } from "node:querystring";
import { getUsernameList } from "@calcom/features/eventtypes/lib/defaultEvents";
import { getEventTypesPublic } from "@calcom/features/eventtypes/lib/getEventTypesPublic";
import { getBrandingForUser } from "@calcom/features/profile/lib/getBranding";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { DEFAULT_DARK_BRAND_COLOR, DEFAULT_LIGHT_BRAND_COLOR } from "@calcom/lib/constants";
import { getUserAvatarUrl } from "@calcom/lib/getAvatarUrl";
import logger from "@calcom/lib/logger";
import { markdownToSafeHTML } from "@calcom/lib/markdownToSafeHTML";
import { safeStringify } from "@calcom/lib/safeStringify";
import { stripMarkdown } from "@calcom/lib/stripMarkdown";
import { prisma } from "@calcom/prisma";
import type { EventType, User } from "@calcom/prisma/client";
import { RedirectType } from "@calcom/prisma/enums";
import type { EventTypeMetaDataSchema } from "@calcom/prisma/zod-utils";
import type { UserProfile } from "@calcom/types/UserProfile";
import { handleOrgRedirect } from "@lib/handleOrgRedirect";
import type { EmbedProps } from "app/WithEmbedSSR";
import type { GetServerSideProps } from "next";
import type { z } from "zod";

const log = logger.getSubLogger({ prefix: ["[[pages/[user]]]"] });
type UserPageProps = {
  profile: {
    name: string;
    image: string;
    theme: string | null;
    brandColor: string;
    darkBrandColor: string;
    organization: {
      requestedSlug: string | null;
      slug: string | null;
      id: number | null;
      brandColor: string | null;
      darkBrandColor: string | null;
      theme: string | null;
    } | null;
    allowSEOIndexing: boolean;
    username: string | null;
  };
  users: (Pick<User, "name" | "username" | "bio" | "verified" | "avatarUrl"> & {
    profile: UserProfile;
  })[];
  themeBasis: string | null;
  markdownStrippedBio: string;
  safeBio: string;
  entity: {
    logoUrl?: string | null;
    considerUnpublished: boolean;
    orgSlug?: string | null;
    name?: string | null;
    teamSlug?: string | null;
  };
  eventTypes: ({
    descriptionAsSafeHTML: string;
    metadata: z.infer<typeof EventTypeMetaDataSchema>;
  } & Pick<
    EventType,
    | "id"
    | "title"
    | "slug"
    | "length"
    | "hidden"
    | "lockTimeZoneToggleOnBookingPage"
    | "lockedTimeZone"
    | "requiresConfirmation"
    | "canSendCalVideoTranscriptionEmails"
    | "requiresBookerEmailVerification"
    | "price"
    | "currency"
    | "recurringEvent"
    | "seatsPerTimeSlot"
    | "schedulingType"
  >)[];
  isOrgSEOIndexable: boolean | undefined;
} & EmbedProps;

export const getServerSideProps: GetServerSideProps<UserPageProps> = async (context) => {
  const currentOrgDomain = null;
  const isValidOrgDomain = false;
  const usernameList = getUsernameList(context.query.user as string);
  const isARedirectFromNonOrgLink = context.query.orgRedirection === "true";
  const dataFetchStart = Date.now();

  const redirect = await handleOrgRedirect({
    slugs: usernameList,
    redirectType: RedirectType.User,
    eventTypeSlug: null,
    context,
    currentOrgDomain: isValidOrgDomain ? currentOrgDomain : null,
  });

  if (redirect) {
    return redirect;
  }

  const usersInOrgContext = await getUsersInOrgContext(
    usernameList,
    isValidOrgDomain ? currentOrgDomain : null
  );

  const isDynamicGroup = usersInOrgContext.length > 1;
  log.debug(safeStringify({ usersInOrgContext, isValidOrgDomain, currentOrgDomain, isDynamicGroup }));

  if (isDynamicGroup) {
    const destinationUrl = encodeURI(`/${usernameList.join("+")}/dynamic`);

    // EXAMPLE - context.params: { orgSlug: 'acme', user: 'member0+owner1' }
    // EXAMPLE - context.query: { redirect: 'undefined', orgRedirection: 'undefined', user: 'member0+owner1' }
    const originalQueryString = new URLSearchParams(context.query as Record<string, string>).toString();
    const destinationWithQuery = `${destinationUrl}?${originalQueryString}`;
    log.debug(`Dynamic group detected, redirecting to ${destinationUrl}`);
    return {
      redirect: {
        permanent: false,
        destination: destinationWithQuery,
      },
    } as const;
  }

  const isNonOrgUser = (user: { profile: UserProfile }) => {
    return !user.profile?.organization;
  };

  const isThereAnyNonOrgUser = usersInOrgContext.some(isNonOrgUser);

  if (!usersInOrgContext.length || (!isValidOrgDomain && !isThereAnyNonOrgUser)) {
    return {
      notFound: true,
    } as const;
  }

  const [user] = usersInOrgContext; //to be used when dealing with single user, not dynamic group

  const branding = getBrandingForUser({ user });

  const profile = {
    name: user.name || user.username || "",
    image: getUserAvatarUrl({
      avatarUrl: user.avatarUrl,
    }),
    theme: branding.theme,
    brandColor: branding.brandColor ?? DEFAULT_LIGHT_BRAND_COLOR,
    avatarUrl: user.avatarUrl,
    darkBrandColor: branding.darkBrandColor ?? DEFAULT_DARK_BRAND_COLOR,
    allowSEOIndexing: user.allowSEOIndexing ?? true,
    username: user.username,
    organization: user.profile.organization
      ? {
          requestedSlug: null,
          slug: user.profile.organization.slug,
          id: user.profile.organization.id,
          brandColor: user.profile.organization.brandColor,
          darkBrandColor: user.profile.organization.darkBrandColor,
          theme: user.profile.organization.theme,
        }
      : null,
  };

  const dataFetchEnd = Date.now();
  if (context.query.log === "1") {
    context.res.setHeader("X-Data-Fetch-Time", `${dataFetchEnd - dataFetchStart}ms`);
  }

  const eventTypes = await getEventTypesPublic(user.id);

  // if profile only has one public event-type, redirect to it
  if (eventTypes.length === 1 && context.query.redirect !== "false") {
    // Redirect but don't change the URL
    const urlDestination = `/${user.profile.username}/${eventTypes[0].slug}`;
    const { query } = context;
    const urlQuery = new URLSearchParams(encode(query));

    return {
      redirect: {
        permanent: false,
        destination: `${encodeURI(urlDestination)}?${urlQuery}`,
      },
    };
  }

  const safeBio = markdownToSafeHTML(user.bio) || "";

  const markdownStrippedBio = stripMarkdown(user?.bio || "");
  const org = usersInOrgContext[0].profile.organization;

  return {
    props: {
      users: usersInOrgContext.map((user) => ({
        name: user.name,
        username: user.username,
        bio: user.bio,
        avatarUrl: user.avatarUrl,
        verified: user.verified,
        profile: user.profile,
      })),
      entity: {
        ...(org?.logoUrl ? { logoUrl: org?.logoUrl } : {}),
        considerUnpublished: !isARedirectFromNonOrgLink && org?.slug === null,
        orgSlug: currentOrgDomain,
        name: org?.name ?? null,
      },
      eventTypes,
      safeBio,
      profile,
      // Dynamic group has no theme preference right now. It uses system theme.
      themeBasis: user.username,
      markdownStrippedBio,
      isOrgSEOIndexable: org?.organizationSettings?.allowSEOIndexing ?? false,
    },
  };
};

// CV-10 — the no-Postgres-fork signal for ANONYMOUS public paths. Authed handlers use
// `ctx.user.uuid`; the public Booker SSR has no session, so we key off the fork's required
// `NEXT_PUBLIC_CONVEX_URL` env (always set on book.dibslist.app; absent on a real Postgres
// cal.com deploy). Used ONLY to skip prisma user-resolution that 500s on the fork.
const IS_CONVEX_FORK = !!process.env.NEXT_PUBLIC_CONVEX_URL;

// CV-10 — one synthesized cal-shaped user for the no-Postgres fork's public Booker SSR.
// Only the fields the `/[user]/[type]` page reads are populated (the rest are cal-shaped
// defaults the Booker re-derives client-side or ignores). `profile` is the pure personal
// profile (no org/team). Cast to the rich `findUsersByUsername` element type — the cast
// only narrows the consumed subset (display-only on our backend; see §CV-2a).
type ForkPublicUser = Awaited<ReturnType<UserRepository["findUsersByUsername"]>>[number];
function buildPublicForkUser(username: string): ForkPublicUser {
  return {
    id: 0,
    username,
    // The single owner's display name (forwarded into the container alongside
    // OWNER_USERNAME); anything else stays username-as-name.
    name: (username.toLowerCase() === process.env.OWNER_USERNAME?.trim().toLowerCase() && process.env.OWNER_NAME?.trim()) || username,
    bio: null,
    avatarUrl: null,
    verified: false,
    hideBranding: false,
    allowSEOIndexing: true,
    brandColor: null,
    darkBrandColor: null,
    theme: null,
    metadata: {},
    organizationId: null,
    profile: {
      id: null,
      upId: `usr-0`,
      username,
      organizationId: null,
      organization: null,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

export async function getUsersInOrgContext(usernameList: string[], orgSlug: string | null) {
  // CV-10: backs the PUBLIC Booker `/[user]/[type]` SSR (`getUserPageProps:235`). The
  // `UserRepository.findUsersByUsername` raw `prisma.user.findMany` THROWS on the no-Postgres
  // fork → 500s the booking page BEFORE the (CV-2a) Convex `EventRepository.getPublicEvent`
  // existence check runs. On the fork we synthesize ONE minimal cal-shaped user per requested
  // username (the `[user]` segment is display-only on our backend — the Convex public read
  // keys off the `[type]` slug alone; see CONVEX-REWIRE-NOTES §CV-2a). The synthesized user
  // carries only the fields the Booker page reads (username/name/profile/allowSEOIndexing/
  // hideBranding/branding nulls); event existence + real meta come from the Convex read. The
  // original prisma path is LEFT INTACT for a real Postgres deploy.
  if (IS_CONVEX_FORK) {
    return usernameList.map((username) =>
      buildPublicForkUser(username)
    ) as Awaited<ReturnType<UserRepository["findUsersByUsername"]>>;
  }

  const userRepo = new UserRepository(prisma);

  const usersInOrgContext = await userRepo.findUsersByUsername({
    usernameList,
    orgSlug,
  });

  if (usersInOrgContext.length) {
    return usersInOrgContext;
  }

  // note(Lauris): platform members (people who run platform) are part of platform organization while
  // the platform organization does not have a domain. In this case there is no org domain but also platform member
  // "User.organization" is not null so "UserRepository.findUsersByUsername" returns empty array and we do this as a last resort
  // call to find platform member.
  return await userRepo.findPlatformMembersByUsernames({
    usernameList,
  });
}
