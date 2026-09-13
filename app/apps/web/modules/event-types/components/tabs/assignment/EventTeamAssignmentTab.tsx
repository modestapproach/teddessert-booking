"use client";

// CV-7 — CO-HOST ASSIGNMENT TAB (the "both founders free" headline).
//
// dibslist has NO team concept. cal.com's real EE EventTeamAssignmentTab was
// deeply team/org-coupled (RR segments, weights, membership rows, org context)
// and its source was stripped during the fork's EE-code removal. Rather than
// resurrect that machinery, this is a MINIMAL native control built from cal's
// own @calcom/ui primitives that drives the SAME react-hook-form fields the
// CV-6 Save reads (`hosts[]`, `schedulingType`):
//
//   1. The owner flips the event type to COLLECTIVE (a co-host invite implies it).
//   2. They add co-hosts by typing a dibslist EMAIL. We resolve it via
//      `viewer.eventTypes.resolveCoHostByEmail` → a cal USER int (only for people
//      who have signed into booking; "needs sign-in" / "not found" states are
//      surfaced and NOT added).
//   3. Each added co-host is written into the form `hosts[]` (isFixed:true for
//      COLLECTIVE). The CV-6 Save (eventTypesHeavy.update → setEventTypeHosts)
//      persists them; read-back drives the collective availability intersection.
//
// The component is mounted by EventTypeWebWrapper's `team` tab slot. It reads the
// existing roster off the form (the GET hydrates `hosts[]` with cal ints already)
// and shows it; emails that resolve to an already-listed host are de-duped.

import { useMemo, useState } from "react";
import { useFormContext } from "react-hook-form";

import type { FormValues } from "@calcom/features/eventtypes/lib/types";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { SchedulingType } from "@calcom/prisma/enums";
import { trpc } from "@calcom/trpc/react";
import classNames from "@calcom/ui/classNames";
import { Avatar } from "@calcom/ui/components/avatar";
import { Badge } from "@calcom/ui/components/badge";
import { Button } from "@calcom/ui/components/button";
import { EmailField } from "@calcom/ui/components/form";
import { SettingsToggle } from "@calcom/ui/components/form";
import { Icon } from "@calcom/ui/components/icon";
import { showToast } from "@calcom/ui/components/toast";

// Mirrors cal's per-tab custom-classNames contract so the platform wrapper's
// `eventAssignmentTab?: EventTeamAssignmentTabCustomClassNames` type resolves.
export type EventTeamAssignmentTabCustomClassNames = {
  container?: string;
  schedulingTypeToggle?: string;
  addCoHostRow?: string;
  coHostList?: string;
};

// A resolved, assignable co-host the owner has added (we keep display info
// alongside the cal int so the list renders without a second lookup).
type AddedCoHost = {
  calUserId: number;
  name: string | null;
  email: string | null;
  avatar: string | null;
};

type Props = {
  // EventTypeWebWrapper passes these; dibslist has no team/org so they are unused
  // here (kept for prop-shape compatibility with the wrapper's call site).
  orgId?: number | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  teamMembers?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  team?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eventType?: any;
  customClassNames?: EventTeamAssignmentTabCustomClassNames;
};

const EventTeamAssignmentTab = ({ customClassNames }: Props) => {
  const { t } = useLocale();
  const formMethods = useFormContext<FormValues>();
  const utils = trpc.useUtils();

  const [email, setEmail] = useState("");
  const [isResolving, setIsResolving] = useState(false);

  const schedulingType = formMethods.watch("schedulingType");
  const hosts = formMethods.watch("hosts") ?? [];
  const isCollective = schedulingType === SchedulingType.COLLECTIVE;

  // The roster, as cal ints, derived from the form. We don't have display names
  // for hosts hydrated by the initial GET, so fall back to the int as a label.
  const coHosts: AddedCoHost[] = useMemo(
    () =>
      hosts.map((h) => ({
        calUserId: h.userId,
        name: null,
        email: null,
        avatar: null,
      })),
    [hosts]
  );

  // Local display cache: email-added co-hosts carry name/avatar so the list is
  // friendly; GET-hydrated hosts (no display info) show the int.
  const [display, setDisplay] = useState<Record<number, AddedCoHost>>({});

  const writeHosts = (next: AddedCoHost[]) => {
    formMethods.setValue(
      "hosts",
      next.map((h) => ({
        userId: h.calUserId,
        isFixed: true, // COLLECTIVE ⇒ every host is fixed (the Convex core also forces this)
        priority: 2,
        weight: 100,
        scheduleId: null,
        groupId: null,
      })),
      { shouldDirty: true }
    );
  };

  const ensureCollective = () => {
    if (schedulingType !== SchedulingType.COLLECTIVE) {
      formMethods.setValue("schedulingType", SchedulingType.COLLECTIVE, { shouldDirty: true });
    }
  };

  const onToggleCollective = (checked: boolean) => {
    formMethods.setValue(
      "schedulingType",
      checked ? SchedulingType.COLLECTIVE : null,
      { shouldDirty: true }
    );
  };

  const handleAdd = async () => {
    const trimmed = email.trim();
    if (!trimmed) return;
    setIsResolving(true);
    try {
      const res = await utils.viewer.eventTypes.resolveCoHostByEmail.fetch({ email: trimmed });
      if (res.status === "self") {
        showToast(t("you_are_already_the_host"), "error");
        return;
      }
      if (res.status === "not_found") {
        showToast(t("no_dibslist_account_for_email"), "error");
        return;
      }
      if (res.status === "needs_signin" || res.calUserId === null) {
        showToast(t("co_host_needs_to_sign_in_to_booking"), "warning");
        return;
      }
      // Assignable. De-dupe against the current roster.
      if (coHosts.some((h) => h.calUserId === res.calUserId)) {
        showToast(t("co_host_already_added"), "error");
        return;
      }
      const added: AddedCoHost = {
        calUserId: res.calUserId,
        name: res.name,
        email: res.email,
        avatar: res.avatar,
      };
      setDisplay((d) => ({ ...d, [res.calUserId as number]: added }));
      ensureCollective();
      writeHosts([...coHosts.map((h) => display[h.calUserId] ?? h), added]);
      setEmail("");
    } catch {
      showToast(t("something_went_wrong"), "error");
    } finally {
      setIsResolving(false);
    }
  };

  const handleRemove = (calUserId: number) => {
    const next = coHosts.filter((h) => h.calUserId !== calUserId).map((h) => display[h.calUserId] ?? h);
    writeHosts(next);
    setDisplay((d) => {
      const { [calUserId]: _removed, ...rest } = d;
      return rest;
    });
  };

  return (
    <div className={classNames("flex flex-col gap-6", customClassNames?.container)}>
      <SettingsToggle
        toggleSwitchAtTheEnd
        title={t("collective")}
        description={t("collective_description")}
        checked={isCollective}
        onCheckedChange={onToggleCollective}
        switchContainerClassName={customClassNames?.schedulingTypeToggle}
      />

      {isCollective ? (
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-emphasis text-sm font-medium">{t("fixed_hosts")}</p>
            <p className="text-subtle text-sm">{t("add_co_hosts_by_email_description")}</p>
          </div>

          <div className={classNames("flex items-end gap-2", customClassNames?.addCoHostRow)}>
            <div className="flex-1">
              <EmailField
                name="add-co-host-email"
                label={t("email")}
                placeholder={t("enter_email")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleAdd();
                  }
                }}
              />
            </div>
            <Button
              type="button"
              color="secondary"
              loading={isResolving}
              disabled={isResolving || email.trim().length === 0}
              onClick={() => void handleAdd()}>
              {t("add")}
            </Button>
          </div>

          <ul
            className={classNames(
              "divide-subtle border-subtle divide-y rounded-md border",
              coHosts.length === 0 && "hidden",
              customClassNames?.coHostList
            )}>
            {coHosts.map((host) => {
              const info = display[host.calUserId] ?? host;
              const label = info.name || info.email || `#${host.calUserId}`;
              return (
                <li key={host.calUserId} className="flex items-center px-3 py-2">
                  <Avatar size="sm" imageSrc={info.avatar ?? undefined} alt={label} />
                  <div className="ms-3 flex flex-col">
                    <span className="text-emphasis text-sm font-medium">{label}</span>
                    {info.email && info.name ? (
                      <span className="text-subtle text-xs">{info.email}</span>
                    ) : null}
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <Badge variant="green">{t("fixed_hosts")}</Badge>
                    <button
                      type="button"
                      aria-label={t("remove")}
                      onClick={() => handleRemove(host.calUserId)}>
                      <Icon name="x" className="text-subtle hover:text-emphasis h-4 w-4" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
};

export default EventTeamAssignmentTab;
