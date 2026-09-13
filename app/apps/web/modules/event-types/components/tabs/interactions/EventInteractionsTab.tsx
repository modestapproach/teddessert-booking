"use client";

// BOOKING-LOTTERY — the "???" tab (the repurposed Apps tab): home for the
// operator's odd event-interaction modes. Modes are mutually exclusive:
//
//   • Standard      — plain booking page (mode cleared).
//   • Slot lottery  — bookers enter a per-slot drawing; at close a winner is
//                     drawn automatically, booked, and everyone is emailed.
//   • First come, first served — claim-framed session: share the link, first
//                     person to claim a slot books it instantly. (The future
//                     pay-to-claim requirement attaches to this mode.)
//
// Self-contained persistence via viewer.eventTypes.{get,update}InteractionMode
// (CV-9 Convex pbac ownership) — deliberately OUTSIDE cal's FormValues
// pipeline, since interaction mode is a dibslist-Convex concept.

import { trpc } from "@calcom/trpc/react";
import { Button } from "@calcom/ui/components/button";
import { TextField } from "@calcom/ui/components/form";
import { showToast } from "@calcom/ui/components/toast";
import { Section } from "@calcom/ui/components/section";
import { useEffect, useState } from "react";

const DEFAULT_LEAD_MINUTES = 24 * 60;

type Mode = "none" | "lottery" | "first_come" | "application" | "threshold" | "pair";

const MODES: Array<{ value: Mode; title: string; description: string }> = [
  {
    value: "none",
    title: "Standard",
    description: "A plain booking page — pick a time, book it.",
  },
  {
    value: "lottery",
    title: "Slot lottery",
    description:
      "People don't book a time — they enter a drawing for it. When entries close, a winner is picked automatically, gets the slot, and every entrant is emailed the result.",
  },
  {
    value: "first_come",
    title: "First come, first served",
    description:
      "A claimable session — share the link and the first person to claim a time books it instantly. (A pay-to-claim requirement can be added to this mode later.)",
  },
  {
    value: "application",
    title: "Application",
    description:
      "People APPLY for a time with their answers to your booking questions. When applications close you get an email with every pitch and one-click pick links — your pick gets booked, the rest get a polite decline.",
  },
  {
    value: "threshold",
    title: "Group threshold",
    description:
      "A group session that only happens if enough people join. Below the minimum at the deadline, every booking auto-cancels and everyone is emailed; at or above, it's confirmed.",
  },
  {
    value: "pair",
    title: "Bring a friend",
    description:
      "Booking for two: the booker's spot is held while they forward a join link to their partner. It confirms when the partner joins, or releases after 24 hours.",
  },
];

// Modes whose rounds close ahead of the slot (shared lead-hours setting).
const LEAD_MODES: ReadonlySet<Mode> = new Set(["lottery", "application", "threshold"]);

export const EventInteractionsTab = ({ eventTypeId }: { eventTypeId: number }) => {
  const utils = trpc.useUtils();
  const query = trpc.viewer.eventTypes.getInteractionMode.useQuery(
    { id: eventTypeId },
    { enabled: Number.isFinite(eventTypeId) }
  );

  const [mode, setMode] = useState<Mode>("none");
  const [leadHours, setLeadHours] = useState(DEFAULT_LEAD_MINUTES / 60);
  const [minAttendees, setMinAttendees] = useState(3);
  const [seats, setSeats] = useState(6);
  const [dirty, setDirty] = useState(false);

  // Hydrate from the saved config (and on refetch while no unsaved edits).
  useEffect(() => {
    if (!query.data || dirty) return;
    setMode(query.data.interactionMode ?? "none");
    setLeadHours((query.data.lotteryCloseLeadMinutes ?? DEFAULT_LEAD_MINUTES) / 60);
    const d = query.data as {
      thresholdMinAttendees?: number | null;
      seatsPerSlot?: number | null;
    };
    if (typeof d.thresholdMinAttendees === "number") setMinAttendees(d.thresholdMinAttendees);
    if (typeof d.seatsPerSlot === "number") setSeats(d.seatsPerSlot);
  }, [query.data, dirty]);

  const updateMutation = trpc.viewer.eventTypes.updateInteractionMode.useMutation({
    onSuccess: () => {
      setDirty(false);
      utils.viewer.eventTypes.getInteractionMode.invalidate({ id: eventTypeId });
      showToast("Saved.", "success");
    },
    onError: (err) => {
      showToast(err.message || "Could not save.", "error");
    },
  });

  const save = () => {
    const leadMinutes = Math.max(1, Math.round(leadHours * 60));
    updateMutation.mutate({
      id: eventTypeId,
      interactionMode: mode,
      ...(LEAD_MODES.has(mode) ? { lotteryCloseLeadMinutes: leadMinutes } : {}),
      ...(mode === "threshold"
        ? {
            thresholdMinAttendees: Math.max(2, Math.round(minAttendees)),
            seatsPerSlot: Math.max(Math.round(seats), Math.max(2, Math.round(minAttendees))),
          }
        : {}),
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-emphasis text-base font-semibold">???</h2>
        <p className="text-subtle text-sm">
          Odd ways for people to interact with this event — turn the event into something other
          than a plain booking page. One mode at a time.
        </p>
      </div>

      {MODES.map((m) => (
        <Section key={m.value}>
          <Section.Header title={m.title} description={m.description}>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="radio"
                name="interaction-mode"
                checked={mode === m.value}
                onChange={() => {
                  setMode(m.value);
                  setDirty(true);
                }}
                data-testid={`mode-${m.value}`}
                className="h-4 w-4"
              />
              <span className="text-emphasis text-sm font-medium">
                {mode === m.value ? "Selected" : "Select"}
              </span>
            </label>
          </Section.Header>
          {LEAD_MODES.has(m.value) && mode === m.value ? (
            <Section.Content>
              <div className="max-w-xs space-y-3">
                <TextField
                  label={
                    m.value === "threshold"
                      ? "Go / no-go decision (hours before the time)"
                      : m.value === "application"
                        ? "Applications close (hours before the time)"
                        : "Entries close (hours before the time)"
                  }
                  type="number"
                  min={1}
                  step={1}
                  value={String(leadHours)}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) setLeadHours(v);
                    setDirty(true);
                  }}
                  data-testid="lottery-lead-hours"
                />
                {m.value === "threshold" ? (
                  <>
                    <TextField
                      label="Minimum people for it to happen"
                      type="number"
                      min={2}
                      step={1}
                      value={String(minAttendees)}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isFinite(v)) setMinAttendees(v);
                        setDirty(true);
                      }}
                      data-testid="threshold-min"
                    />
                    <TextField
                      label="Maximum spots per time"
                      type="number"
                      min={2}
                      step={1}
                      value={String(seats)}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isFinite(v)) setSeats(v);
                        setDirty(true);
                      }}
                      data-testid="threshold-seats"
                    />
                  </>
                ) : null}
                <p className="text-subtle mt-1 text-xs">
                  {m.value === "lottery"
                    ? "The drawing for each time runs automatically this many hours before it starts. Direct booking is disabled — winning is the only way to get the slot."
                    : m.value === "application"
                      ? "When applications close you'll get an email with every pitch and one-click pick links. Direct booking is disabled — your pick is the only way in."
                      : "At the deadline, the session confirms if enough people joined; otherwise every booking auto-cancels and everyone is emailed."}
                </p>
              </div>
            </Section.Content>
          ) : null}
        </Section>
      ))}

      <Button
        color="primary"
        onClick={save}
        loading={updateMutation.isPending}
        disabled={!dirty || query.isPending}
        data-testid="interactions-save">
        Save
      </Button>
    </div>
  );
};
