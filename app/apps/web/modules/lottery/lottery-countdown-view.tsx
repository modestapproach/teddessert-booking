"use client";

// BOOKING-LOTTERY — the public countdown view for one slot's drawing.
//
// Polls the Convex public endpoint (GET
// `${NEXT_PUBLIC_CONVEX_SITE_URL}/book/api/lottery/{id}`, IP-rate-limited,
// PII-free DTO) every POLL_MS and ticks a local 1s countdown to `closesAt`.
// States: open (countdown + entrant count) → drawn ("winner notified — check
// your email") / cancelled / expired. Unknown id or dark flags → "drawing not
// found". No auth, no SSR — every entrant shares this page from their
// "you're in" email.

import { useCallback, useEffect, useRef, useState } from "react";

const POLL_MS = 15_000;

interface LotteryDto {
  lotteryId: string;
  eventSlug: string;
  eventTitle: string;
  durationMinutes: number;
  slotStart: number;
  slotEnd: number;
  closesAt: number;
  status: "open" | "drawn" | "cancelled" | "expired" | "awaiting_pick";
  entrantCount: number;
  drawnAt: number | null;
  resolution?: "random" | "owner_pick" | "threshold";
  minAttendees?: number | null;
}

function convexSiteUrl(): string | null {
  const direct = process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
  if (direct) return direct.replace(/\/$/, "");
  // Derive from the cloud URL when only that is configured.
  const cloud = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (cloud) return cloud.replace(/\/$/, "").replace(".convex.cloud", ".convex.site");
  return null;
}

function pad(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(2, "0");
}

function formatRemaining(ms: number): { days: number; hh: string; mm: string; ss: string } {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  return { days, hh: pad(hours), mm: pad(minutes), ss: pad(seconds) };
}

function formatWhen(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return new Date(ms).toUTCString();
  }
}

export const LotteryCountdownView = ({ lotteryId }: { lotteryId: string }) => {
  const [dto, setDto] = useState<LotteryDto | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const base = convexSiteUrl();
    if (!base) {
      setNotFound(true);
      return;
    }
    try {
      const res = await fetch(`${base}/book/api/lottery/${encodeURIComponent(lotteryId)}`);
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) return; // transient (rate limit etc.) — keep last state
      const body = (await res.json()) as LotteryDto;
      setDto(body);
      setNotFound(false);
    } catch {
      // network blip — keep last state, next poll retries
    }
  }, [lotteryId]);

  useEffect(() => {
    load();
    pollRef.current = setInterval(load, POLL_MS);
    const tick = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      clearInterval(tick);
    };
  }, [load]);

  // Once the countdown crosses zero while "open", poll faster briefly so the
  // page flips to the result without waiting a full interval.
  useEffect(() => {
    if (dto?.status === "open" && dto.closesAt <= nowMs) {
      const t = setTimeout(load, 3_000);
      return () => clearTimeout(t);
    }
  }, [dto, nowMs, load]);

  if (notFound) {
    return (
      <Shell>
        <h1 className="text-emphasis text-2xl font-semibold">Drawing not found</h1>
        <p className="text-subtle mt-2">
          This drawing doesn&apos;t exist or is no longer available.
        </p>
      </Shell>
    );
  }

  if (!dto) {
    return (
      <Shell>
        <p className="text-subtle animate-pulse">Loading the drawing…</p>
      </Shell>
    );
  }

  const remaining = formatRemaining(dto.closesAt - nowMs);
  const closed = dto.closesAt <= nowMs;
  const resolution = dto.resolution ?? "random";
  const noun =
    resolution === "owner_pick"
      ? "Applications for"
      : resolution === "threshold"
        ? "Group session"
        : "Drawing for";

  return (
    <Shell>
      <p className="text-subtle text-sm uppercase tracking-wide">{noun}</p>
      <h1 className="text-emphasis mt-1 text-2xl font-semibold">{dto.eventTitle}</h1>
      <p className="text-default mt-1">{formatWhen(dto.slotStart)}</p>

      {dto.status === "open" && !closed && (
        <>
          <div className="mt-8 flex items-end justify-center gap-3 font-mono" data-testid="countdown">
            {dto.closesAt - nowMs >= 86_400_000 && (
              <TimeCell value={String(remaining.days)} label={remaining.days === 1 ? "day" : "days"} />
            )}
            <TimeCell value={remaining.hh} label="hrs" />
            <Colon />
            <TimeCell value={remaining.mm} label="min" />
            <Colon />
            <TimeCell value={remaining.ss} label="sec" />
          </div>
          <p className="text-subtle mt-6">
            {resolution === "owner_pick"
              ? `${dto.entrantCount} ${dto.entrantCount === 1 ? "application" : "applications"} so far. When the timer ends, the host reviews every pitch and picks one — everyone gets an email with the result.`
              : resolution === "threshold"
                ? `${dto.entrantCount} of ${dto.minAttendees ?? "?"} needed have joined. If the minimum is reached when the timer ends, the session is confirmed; otherwise everyone is released and emailed.`
                : `${dto.entrantCount === 1 ? "1 person is" : `${dto.entrantCount} people are`} in the drawing. The winner is picked automatically when the timer ends — everyone gets an email with the result.`}
          </p>
        </>
      )}

      {dto.status === "open" && closed && (
        <p className="text-default mt-8 animate-pulse text-lg" data-testid="drawing-now">
          {resolution === "threshold" ? "Time's up — checking the headcount…" : "Time's up — resolving…"}
        </p>
      )}

      {dto.status === "awaiting_pick" && (
        <div className="mt-8" data-testid="awaiting-pick">
          <p className="text-emphasis text-lg font-medium">Applications are closed 📨</p>
          <p className="text-subtle mt-2">
            The host is reviewing {dto.entrantCount}{" "}
            {dto.entrantCount === 1 ? "application" : "applications"} and picking one. You&apos;ll
            get an email either way.
          </p>
        </div>
      )}

      {dto.status === "drawn" && (
        <div className="mt-8" data-testid="drawn">
          {resolution === "threshold" ? (
            <>
              <p className="text-emphasis text-lg font-medium">It&apos;s happening! 🎉</p>
              <p className="text-subtle mt-2">
                The session reached its minimum with {dto.entrantCount} joined — everyone has been
                emailed a confirmation.
              </p>
            </>
          ) : resolution === "owner_pick" ? (
            <>
              <p className="text-emphasis text-lg font-medium">A pick has been made 🎉</p>
              <p className="text-subtle mt-2">
                The host chose one of {dto.entrantCount}{" "}
                {dto.entrantCount === 1 ? "application" : "applications"} and everyone was
                notified by email. If it&apos;s you, your booking confirmation is in your inbox.
              </p>
            </>
          ) : (
            <>
              <p className="text-emphasis text-lg font-medium">The drawing has ended 🎉</p>
              <p className="text-subtle mt-2">
                A winner was selected from {dto.entrantCount}{" "}
                {dto.entrantCount === 1 ? "entry" : "entries"} and notified by email. If
                it&apos;s you, your booking confirmation is in your inbox.
              </p>
            </>
          )}
        </div>
      )}

      {(dto.status === "cancelled" || dto.status === "expired") && (
        <div className="mt-8" data-testid="cancelled">
          <p className="text-emphasis text-lg font-medium">
            {resolution === "threshold" ? "Didn't reach the minimum" : "This drawing was cancelled"}
          </p>
          <p className="text-subtle mt-2">
            {resolution === "threshold"
              ? "Not enough people joined by the deadline, so the session was cancelled and every booking released. Everyone has been emailed."
              : "The time is no longer available. Everyone who entered has been emailed — no action is needed."}
          </p>
        </div>
      )}
    </Shell>
  );
};

const Shell = ({ children }: { children: React.ReactNode }) => (
  <main className="flex min-h-screen items-center justify-center px-4">
    <div className="border-subtle bg-default w-full max-w-lg rounded-xl border p-8 text-center shadow-sm">
      {children}
    </div>
  </main>
);

const TimeCell = ({ value, label }: { value: string; label: string }) => (
  <div className="flex flex-col items-center">
    <span className="text-emphasis text-5xl font-bold tabular-nums">{value}</span>
    <span className="text-subtle mt-1 text-xs uppercase">{label}</span>
  </div>
);

const Colon = () => <span className="text-subtle pb-5 text-4xl font-bold">:</span>;

export default LotteryCountdownView;
