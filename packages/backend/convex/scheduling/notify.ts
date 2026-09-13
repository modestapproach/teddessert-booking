// SCHEDULING D1 — the REAL channel-pluggable booking notification action
// (PRD §6.3). Replaces the A7 no-op `sendNotification` stub in booking.ts; the
// registration here keeps the `internal.scheduling.notify.sendNotification` ref
// AND booking.ts re-exports it so the existing `scheduleBookingSideEffects`
// scheduler call (which resolves `internal.scheduling.booking.sendNotification`)
// stays valid without touching the mutation body.
//
// WHAT THIS FILE OWNS
//   - `sendNotificationHandler` — the action body. Loads the booking + attendees
//     (via the sync.ts read seam), renders the body per `event` kind, and
//     dispatches across THREE channels:
//       1. email  — Brevo `/v3/smtp/email` (gated on EMAIL_API_KEY) with the F1
//          `.ics` builder base64-attached. No SDK — plain injectable `fetch`.
//       2. sms    — Twilio `Messages.json` (gated on TWILIO_*). Basic auth, a
//          short cancel/reschedule link in the body (no attachment).
//       3. in_app — always: insert a `notifications` row via the
//          `internal.notifications._create` authoring entry point.
//   - `sendBrevoEmail` / `sendTwilioSms` — plain injectable-fetch fns
//     (`(payload, fetchImpl?) => Promise<{ skipped: boolean }>`). An unset key
//     logs at warn + returns `{ skipped: true }` (same degradation pattern as
//     the apiV1.ts email gate). Unit-testable with a mocked fetch.
//
// CODEGEN-PENDING REFS: the booking tables + this brand-new scheduling/notify
// module aren't on the stale `_generated` `internal` yet, so cross-module refs
// (`getBookingSyncContext`, `notifications._create`) go through the SAME
// `(internal as any).…?.…` nil-guard hop used in booking.ts / sync.ts. The
// runtime paths are correct; a deploy regenerates the types.
// [R] runtime-unverified: live Brevo/Twilio delivery needs EMAIL_API_KEY /
// TWILIO_* set + a deploy. Verified here with convex-test (mocked fetch).

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { log } from "../_helpers/log";
import { buildIcs } from "./publicApi";
import { getBookingSyncContextHandler } from "./sync";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

// The booking lifecycle events the scheduler hands us (booking.ts) plus the
// reminder kinds the A8 sweep hands us (scheduling/reminders.ts). Both flow
// through the SAME action so there is one delivery code path.
export type NotifyEvent =
  | "BOOKING_CREATED"
  | "BOOKING_CANCELLED"
  | "BOOKING_RESCHEDULED"
  | "confirmation"
  | "reminder_24h"
  | "reconfirm"
  | "no_show";

// ─────────────────────────────────────────────────────────────
// Codegen-pending refs
// ─────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
const syncRefs = (internal as any).scheduling?.sync;
const notifRef = (internal as any).notifications?._create;
// Self-ref for the N6 email retry (re-dispatch pinned to channel:"email"). Same
// codegen-pending hop as the others.
const notifySelfRef = (internal as any).scheduling?.notify?.sendNotification;
/* eslint-enable @typescript-eslint/no-explicit-any */

// N6 — booker confirmation email is high-value; a transient Brevo failure (5xx /
// network) gets a BOUNDED retry (mirrors the sync.ts calendar retry). Bounded so
// a persistent failure (e.g. bad sender domain) can't loop forever.
const MAX_EMAIL_TRIES = 3;
function emailBackoffMs(tries: number): number {
  // 30s, 2m, then capped — same shape as the calendar backoff.
  return [30_000, 120_000, 300_000][Math.min(tries - 1, 2)] ?? 300_000;
}

// ─────────────────────────────────────────────────────────────
// base64 — runtime-portable (Convex action runtime has no Buffer guarantee;
// btoa handles latin1, which .ics + ASCII bodies are). Falls back to Buffer if
// btoa is somehow absent.
// ─────────────────────────────────────────────────────────────

function toBase64(s: string): string {
  if (typeof btoa === "function") {
    // btoa wants a binary string; .ics is ASCII so the 1:1 mapping is safe.
    return btoa(unescape(encodeURIComponent(s)));
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const B = (globalThis as any).Buffer;
  if (B) return B.from(s, "utf-8").toString("base64");
  throw new Error("no base64 encoder available");
}

// ─────────────────────────────────────────────────────────────
// Channel 1 — Brevo email (injectable fetch; gated on EMAIL_API_KEY)
// ─────────────────────────────────────────────────────────────

export interface BrevoEmailPayload {
  toEmail: string;
  toName: string;
  subject: string;
  htmlContent: string;
  icsString?: string; // base64-attached as invite.ics when present
  // Sender display name — defaults to "DibsList Booking" (back-compat for the
  // booking emails). Non-booking senders (e.g. the magic-link login) pass their
  // own, e.g. "DibsList".
  senderName?: string;
}

export async function sendBrevoEmail(
  payload: BrevoEmailPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<{ skipped: boolean }> {
  const apiKey = process.env.EMAIL_API_KEY;
  if (!apiKey) {
    // Unset key → log + skip (no-op). Same degradation as apiV1.ts's gate.
    log.warn("notify.email.skipped_no_key", { to: payload.toEmail });
    return { skipped: true };
  }
  const fromEmail = process.env.EMAIL_FROM ?? "bookings@dibslist.app";
  const body: Record<string, unknown> = {
    sender: { name: payload.senderName ?? "DibsList Booking", email: fromEmail },
    to: [{ email: payload.toEmail, name: payload.toName }],
    subject: payload.subject,
    htmlContent: payload.htmlContent,
  };
  if (payload.icsString) {
    body.attachment = [
      { name: "invite.ics", content: toBase64(payload.icsString) },
    ];
  }
  const res = await fetchImpl("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Brevo ${res.status}`);
  }
  return { skipped: false };
}

// ─────────────────────────────────────────────────────────────
// Channel 2 — Twilio SMS (injectable fetch; gated on TWILIO_*)
// ─────────────────────────────────────────────────────────────

export interface TwilioSmsPayload {
  to: string; // attendee phone
  body: string;
}

export async function sendTwilioSms(
  payload: TwilioSmsPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<{ skipped: boolean }> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!accountSid || !authToken || !from) {
    log.warn("notify.sms.skipped_no_creds", { to: payload.to });
    return { skipped: true };
  }
  const creds = toBase64(`${accountSid}:${authToken}`);
  const res = await fetchImpl(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${creds}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        From: from,
        To: payload.to,
        Body: payload.body,
      }).toString(),
    },
  );
  if (!res.ok) {
    throw new Error(`Twilio ${res.status}`);
  }
  return { skipped: false };
}

// ─────────────────────────────────────────────────────────────
// Body rendering — per-event copy (PRD §6.2/§6.3)
// ─────────────────────────────────────────────────────────────

function fmtWhen(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(ms));
  } catch {
    // Bad/unknown tz → fall back to a UTC ISO render rather than throwing.
    return new Date(ms).toISOString();
  }
}

interface RenderedCopy {
  subject: string;
  html: string;
  sms: string;
}

function renderCopy(
  event: NotifyEvent,
  eventTitle: string,
  whenStr: string,
): RenderedCopy {
  switch (event) {
    case "BOOKING_CANCELLED":
      return {
        subject: `Booking cancelled: ${eventTitle}`,
        html: `<p>Your booking for <strong>${eventTitle}</strong> (${whenStr}) has been cancelled.</p>`,
        sms: `Your booking for ${eventTitle} at ${whenStr} was cancelled.`,
      };
    case "BOOKING_RESCHEDULED":
      return {
        subject: `Booking rescheduled: ${eventTitle}`,
        html: `<p>Your booking for <strong>${eventTitle}</strong> has been rescheduled to ${whenStr}.</p>`,
        sms: `Your booking for ${eventTitle} is rescheduled to ${whenStr}.`,
      };
    case "reminder_24h":
    case "reconfirm":
      return {
        subject: `Reminder: ${eventTitle} ${whenStr}`,
        html: `<p>Reminder: your booking for <strong>${eventTitle}</strong> is coming up at ${whenStr}.</p>`,
        sms: `Reminder: ${eventTitle} at ${whenStr}.`,
      };
    case "no_show":
      return {
        subject: `Missed: ${eventTitle}`,
        html: `<p>We marked your booking for <strong>${eventTitle}</strong> (${whenStr}) as a no-show.</p>`,
        sms: `Your booking for ${eventTitle} at ${whenStr} was marked a no-show.`,
      };
    // BOOKING_CREATED + confirmation share the confirmation copy.
    default:
      return {
        subject: `Booking confirmation: ${eventTitle}`,
        html: `<p>Your booking for <strong>${eventTitle}</strong> is confirmed for ${whenStr}.</p>`,
        sms: `Your booking for ${eventTitle} at ${whenStr} is confirmed.`,
      };
  }
}

// ─────────────────────────────────────────────────────────────
// sendNotification — the action body
// ─────────────────────────────────────────────────────────────

export async function sendNotificationHandler(
  ctx: Ctx,
  args: {
    bookingId: Id<"bookings">;
    event: string;
    // Optional explicit channel: when the reminder sweep dispatches a row it
    // can pin a single channel. Absent (the booking.ts lifecycle path) → the
    // default fan-out (email→booker + in_app→organizer).
    channel?: "email" | "sms" | "in_app";
    // N6: retry counter for the bounded email re-dispatch (absent on the first
    // lifecycle send; incremented by each scheduled retry).
    tries?: number;
    // Injectable for unit tests; defaults to the global fetch in prod.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetchImpl?: typeof fetch;
  },
): Promise<{ delivered: string[] }> {
  const event = args.event as NotifyEvent;
  const fetchImpl = args.fetchImpl ?? fetch;

  // Load the booking + attendees via the sync read seam (DB reads in a query,
  // not inline in the action). Pre-codegen the ref may be undefined → call the
  // bare handler directly (works under the FakeDb test ctx + a real deploy
  // resolves the ref).
  const sctx = syncRefs?.getBookingSyncContext
    ? await ctx.runQuery(syncRefs.getBookingSyncContext, {
        bookingId: args.bookingId,
      })
    : await getBookingSyncContextHandler(ctx, { bookingId: args.bookingId });
  if (!sctx) return { delivered: [] };

  const booking = sctx.booking;
  const eventTitle: string = sctx.eventTitle;
  const booker = sctx.attendees.find(
    (a: { role: string; email?: string; name?: string; phone?: string }) =>
      a.role === "booker",
  );
  const whenStr = fmtWhen(booking.startTime, booking.timeZone);
  const copy = renderCopy(event, eventTitle, whenStr);
  const delivered: string[] = [];

  // Channels to run. An explicit `channel` pins one; otherwise the default
  // lifecycle fan-out is email→booker + in_app→organizer.
  const channels: Array<"email" | "sms" | "in_app"> = args.channel
    ? [args.channel]
    : ["email", "in_app"];

  // ── email → booker ──────────────────────────────────────────
  if (channels.includes("email") && booker?.email) {
    // Only attach a fresh .ics for a live (created/confirmation/reschedule)
    // booking — not for a cancellation.
    const withIcs =
      event !== "BOOKING_CANCELLED" && event !== "no_show";
    const icsString = withIcs
      ? buildIcs({
          uid: `${booking._id}@dibslist.app`,
          title: eventTitle,
          startMs: booking.startTime,
          endMs: booking.endTime,
          location: booking.locationText ?? null,
          description: booking.bookerNotes ?? null,
        })
      : undefined;
    try {
      const r = await sendBrevoEmail(
        {
          toEmail: booker.email,
          toName: booker.name,
          subject: copy.subject,
          htmlContent: copy.html,
          icsString,
        },
        fetchImpl,
      );
      if (!r.skipped) delivered.push("email");
    } catch (err) {
      // N6 — bounded retry. A thrown error here is a real send failure (non-2xx
      // Brevo / network), NOT the unset-key skip (which returns {skipped} and
      // never throws). Schedule a backed-off re-dispatch pinned to email until
      // the cap, then give up with a distinct alert log for operator monitoring.
      const tries = (args.tries ?? 0) + 1;
      if (tries < MAX_EMAIL_TRIES && notifySelfRef && ctx.scheduler) {
        log.warn("notify.email.retry_scheduled", {
          bookingId: booking._id,
          event,
          tries,
        });
        await ctx.scheduler.runAfter(emailBackoffMs(tries), notifySelfRef, {
          bookingId: args.bookingId,
          event: args.event,
          channel: "email",
          tries,
        });
      } else {
        log.error("notify.email.failed_giving_up", err, {
          bookingId: booking._id,
          event,
          tries,
        });
      }
    }
  }

  // ── sms → booker (only when an explicit sms channel is pinned; the booker
  //    attendee row has no phone in the A7 schema, so a reminders row that
  //    pins sms supplies it via the row's recipient — until then this is a
  //    no-op gated on TWILIO_* too). ─────────────────────────────
  if (channels.includes("sms")) {
    // The SMS body is built but only sent when TWILIO_* AND a booker phone are
    // present. The A7 bookingAttendees schema has no phone column yet (the sync
    // read seam passes `phone` through when present), so this path naturally
    // no-ops until the deploy-auth attendee schema lands a phone.
    const phone = booker?.phone ?? "";
    if (phone) {
      try {
        const r = await sendTwilioSms({ to: phone, body: copy.sms }, fetchImpl);
        if (!r.skipped) delivered.push("sms");
      } catch (err) {
        log.error("notify.sms.failed", err, {
          bookingId: booking._id,
          event,
        });
      }
    }
  }

  // ── in_app → organizer (ALWAYS, no external gate) ───────────
  if (channels.includes("in_app")) {
    const inAppCopy = inAppOrganizerCopy(event, eventTitle, whenStr, booker?.name);
    if (inAppCopy) {
      try {
        if (notifRef) {
          await ctx.runMutation(notifRef, {
            authUserId: booking.ownerAuthUserId,
            kind: "booking_received",
            title: inAppCopy.title,
            body: inAppCopy.body,
            href: `/book/settings?booking=${booking._id}`,
          });
          delivered.push("in_app");
        } else {
          log.warn("notify.in_app.unregistered", { bookingId: booking._id });
        }
      } catch (err) {
        log.error("notify.in_app.failed", err, {
          bookingId: booking._id,
          event,
        });
      }
    }
  }

  return { delivered };
}

// The organizer-facing in-app copy. Returns null for events that shouldn't
// notify the organizer in-app (none today — every lifecycle event surfaces).
function inAppOrganizerCopy(
  event: NotifyEvent,
  eventTitle: string,
  whenStr: string,
  bookerName?: string,
): { title: string; body: string } | null {
  const who = bookerName ?? "Someone";
  switch (event) {
    case "BOOKING_CANCELLED":
      return {
        title: `Booking cancelled: ${eventTitle}`,
        body: `${who} cancelled their ${whenStr} booking.`,
      };
    case "BOOKING_RESCHEDULED":
      return {
        title: `Booking rescheduled: ${eventTitle}`,
        body: `${who} rescheduled to ${whenStr}.`,
      };
    case "reminder_24h":
    case "reconfirm":
    case "no_show":
      // Reminders/no-shows are candidate-facing; don't double-notify the
      // organizer's bell for these.
      return null;
    default:
      return {
        title: `New booking: ${eventTitle}`,
        body: `${who} booked ${whenStr}.`,
      };
  }
}

export const sendNotification = internalAction({
  args: {
    bookingId: v.id("bookings"),
    event: v.string(),
    channel: v.optional(
      v.union(v.literal("email"), v.literal("sms"), v.literal("in_app")),
    ),
    tries: v.optional(v.number()),
  },
  handler: sendNotificationHandler,
});
