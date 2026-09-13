import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import { useLocale } from "@calcom/lib/hooks/useLocale";
import { userMetadata } from "@calcom/prisma/zod-utils";
import { trpc } from "@calcom/trpc/react";
import type { RouterOutputs } from "@calcom/trpc/react";
import classNames from "@calcom/ui/classNames";
import { Button } from "@calcom/ui/components/button";
import { List } from "@calcom/ui/components/list";

import { AppConnectionItem } from "../components/AppConnectionItem";
import { StepConnectionLoader } from "../components/StepConnectionLoader";

interface ConnectedAppStepProps {
  nextStep: () => void;
  isPageLoading: boolean;
  user: RouterOutputs["viewer"]["me"]["get"];
}

const ConnectedVideoStepInner = ({
  setAnyInstalledVideoApps,
  setNoVideoAppsAvailable,
  user,
}: {
  setAnyInstalledVideoApps: Dispatch<SetStateAction<boolean>>;
  setNoVideoAppsAvailable: Dispatch<SetStateAction<boolean>>;
  user: RouterOutputs["viewer"]["me"]["get"];
}) => {
  const { data: queryConnectedVideoApps, isPending } = trpc.viewer.apps.integrations.useQuery({
    variant: "conferencing",
    onlyInstalled: false,

    /**
     * Both props together sort by most popular first, then by installed first.
     * So, installed apps are always shown at the top, followed by remaining apps sorted by descending popularity.
     *
     * This is done because there could be not so popular app already installed by the admin(e.g. through Delegation Credential)
     * and we want to show it at the top so that user can set it as default if he wants to.
     */
    sortByMostPopular: true,
    sortByInstalledFirst: true,
  });

  const allItems = queryConnectedVideoApps?.items ?? [];
  // daily-video is installed by default and hidden below, so it doesn't count.
  const visibleApps = allItems.filter((item) => item.slug !== "daily-video");
  const hasAnyInstalledVideoApps = allItems.some((item) => item.userCredentialIds.length > 0);

  useEffect(() => {
    setAnyInstalledVideoApps(Boolean(hasAnyInstalledVideoApps));
  }, [hasAnyInstalledVideoApps, setAnyInstalledVideoApps]);

  // CV (booking-onboarding-flow-prd step 8): same dead-end as the calendar step — with
  // no conferencing apps to connect the Next button would stay disabled forever. Surface
  // "nothing to connect" so the owner can continue (a sane default video is set later).
  useEffect(() => {
    if (!isPending) setNoVideoAppsAvailable(visibleApps.length === 0);
  }, [isPending, visibleApps.length, setNoVideoAppsAvailable]);

  if (isPending) {
    return <StepConnectionLoader />;
  }

  const result = userMetadata.safeParse(user.metadata);
  if (!result.success) {
    return <StepConnectionLoader />;
  }
  const { data: metadata } = result;
  const defaultConferencingApp = metadata?.defaultConferencingApp?.appSlug;
  if (visibleApps.length === 0) {
    return (
      <p className="text-subtle text-sm">
        Video apps aren’t available to connect yet — you can add one later from settings.
      </p>
    );
  }
  return (
    <List className="bg-default  border-subtle divide-subtle scroll-bar mx-1 max-h-[45vh] divide-y overflow-y-scroll! rounded-md border p-0 sm:mx-0">
      {visibleApps.map((item) => {
          return (
            <li key={item.name}>
              {item.name && item.logo && (
                <AppConnectionItem
                  type={item.type}
                  title={item.name}
                  isDefault={item.slug === defaultConferencingApp}
                  description={item.description}
                  dependencyData={item.dependencyData}
                  logo={item.logo}
                  slug={item.slug}
                  installed={item.userCredentialIds.length > 0}
                  defaultInstall={!defaultConferencingApp && item.appData?.location?.linkType === "dynamic"}
                />
              )}
            </li>
          );
        })}
    </List>
  );
};

const ConnectedVideoStep = (props: ConnectedAppStepProps) => {
  const { nextStep, isPageLoading, user } = props;
  const { t } = useLocale();
  const [hasAnyInstalledVideoApps, setAnyInstalledVideoApps] = useState(false);
  const [noVideoAppsAvailable, setNoVideoAppsAvailable] = useState(false);
  // Allow continuing when an app is installed OR there's nothing to connect (fork).
  const canContinue = hasAnyInstalledVideoApps || noVideoAppsAvailable;
  return (
    <>
      <ConnectedVideoStepInner
        setAnyInstalledVideoApps={setAnyInstalledVideoApps}
        setNoVideoAppsAvailable={setNoVideoAppsAvailable}
        user={user}
      />
      <Button
        EndIcon="arrow-right"
        data-testid="save-video-button"
        className={classNames(
          "text-inverted border-inverted bg-inverted mt-8 flex w-full flex-row justify-center rounded-md border p-2 text-center text-sm",
          !canContinue ? "cursor-not-allowed opacity-20" : ""
        )}
        disabled={!canContinue}
        loading={isPageLoading}
        onClick={() => nextStep()}>
        {t("set_availability")}
      </Button>
    </>
  );
};

export { ConnectedVideoStep };
