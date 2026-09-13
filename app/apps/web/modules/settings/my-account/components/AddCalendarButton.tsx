"use client";

import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { Button } from "@calcom/ui/components/button";

const AddCalendarButton = () => {
  const { t } = useLocale();
  // no-Postgres fork: cal's App Store (`/apps/categories/calendar`) is Prisma- +
  // app-registry-based and CRASHES server-side on the fork. Start the owner's
  // Google Calendar connect directly via the Convex-backed flow (the same
  // `startGoogleConnect` mutation onboarding's ConnectCalendars uses) instead of
  // linking into the dead App Store. The Postgres path keeps the original link.
  const startGoogleConnect = trpc.viewer.calendars.startGoogleConnect.useMutation({
    onSuccess: (data) => {
      if (data?.authorizeUrl) window.location.href = data.authorizeUrl;
    },
  });

  if (process.env.NEXT_PUBLIC_CONVEX_URL) {
    return (
      <Button
        color="secondary"
        StartIcon="plus"
        loading={startGoogleConnect.isPending}
        onClick={() => startGoogleConnect.mutate()}>
        {t("add_calendar")}
      </Button>
    );
  }

  return (
    <Button color="secondary" StartIcon="plus" href="/apps/categories/calendar">
      {t("add_calendar")}
    </Button>
  );
};

export default AddCalendarButton;
