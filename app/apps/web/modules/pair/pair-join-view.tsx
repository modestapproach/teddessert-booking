"use client";

// WAVE-2 PAIR — the partner-join page. The booker forwarded this link; the
// partner sees the held slot's context (GET
// `${NEXT_PUBLIC_CONVEX_SITE_URL}/book/api/pair/{token}`, PII-light) and
// commits with name + email (POST `/book/api/pair/join`), flipping the pending
// hold into a confirmed two-person booking. No auth, no SSR.

import { useCallback, useEffect, useState } from "react";

interface PairDto {
  status: "pending" | "accepted" | "gone";
  eventTitle: string;
  slotStart: number;
  slotEnd: number;
  bookerName: string;
  deadline: number | null;
}

function convexSiteUrl(): string | null {
  const direct = process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
  if (direct) return direct.replace(/\/$/, "");
  const cloud = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (cloud) return cloud.replace(/\/$/, "").replace(".convex.cloud", ".convex.site");
  return null;
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

export const PairJoinView = ({ token }: { token: string }) => {
  const [dto, setDto] = useState<PairDto | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const base = convexSiteUrl();
    if (!base) {
      setNotFound(true);
      return;
    }
    try {
      const res = await fetch(`${base}/book/api/pair/${encodeURIComponent(token)}`);
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) return;
      setDto((await res.json()) as PairDto);
      setNotFound(false);
    } catch {
      /* transient — leave the last state */
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    const base = convexSiteUrl();
    if (!base || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${base}/book/api/pair/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          name,
          email,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      if (res.ok) {
        setJoined(true);
        return;
      }
      const body = (await res.json().catch(() => null)) as { detail?: string } | null;
      setError(
        res.status === 410
          ? "This hold has expired — the spot was released."
          : res.status === 409
            ? "Someone already joined this booking."
            : (body?.detail ?? "Could not join — try again."),
      );
    } catch {
      setError("Network hiccup — try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (notFound) {
    return (
      <Shell>
        <h1 className="text-emphasis text-2xl font-semibold">Link not found</h1>
        <p className="text-subtle mt-2">This invite doesn&apos;t exist or is no longer available.</p>
      </Shell>
    );
  }

  if (!dto) {
    return (
      <Shell>
        <p className="text-subtle animate-pulse">Loading the invite…</p>
      </Shell>
    );
  }

  if (joined || dto.status === "accepted") {
    return (
      <Shell>
        <h1 className="text-emphasis text-2xl font-semibold">You&apos;re both in 🎉</h1>
        <p className="text-default mt-2">
          <strong>{dto.eventTitle}</strong>
          <br />
          {formatWhen(dto.slotStart)}
        </p>
        <p className="text-subtle mt-3">
          {joined
            ? "The booking is confirmed for the two of you — check your email."
            : "This booking already has its partner."}
        </p>
      </Shell>
    );
  }

  if (dto.status === "gone") {
    return (
      <Shell>
        <h1 className="text-emphasis text-2xl font-semibold">This hold expired</h1>
        <p className="text-subtle mt-2">
          Nobody joined in time, so the spot was released. Ask {dto.bookerName} to book again.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <p className="text-subtle text-sm uppercase tracking-wide">You&apos;re invited</p>
      <h1 className="text-emphasis mt-1 text-2xl font-semibold">{dto.eventTitle}</h1>
      <p className="text-default mt-1">{formatWhen(dto.slotStart)}</p>
      <p className="text-subtle mt-3">
        <strong>{dto.bookerName}</strong> booked this for two — it&apos;s confirmed the moment you
        join.
        {dto.deadline ? ` The hold expires ${formatWhen(dto.deadline)}.` : ""}
      </p>
      <form onSubmit={join} className="mx-auto mt-6 max-w-xs space-y-3 text-left">
        <label className="block">
          <span className="text-emphasis text-sm font-medium">Your name</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="border-subtle bg-default mt-1 w-full rounded-md border px-3 py-2"
            data-testid="pair-name"
          />
        </label>
        <label className="block">
          <span className="text-emphasis text-sm font-medium">Your email</span>
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="border-subtle bg-default mt-1 w-full rounded-md border px-3 py-2"
            data-testid="pair-email"
          />
        </label>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <button
          type="submit"
          disabled={submitting}
          className="bg-brand-default text-brand mt-2 w-full rounded-md px-4 py-2 font-medium disabled:opacity-60"
          data-testid="pair-join">
          {submitting ? "Joining…" : "Join this booking"}
        </button>
      </form>
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

export default PairJoinView;
