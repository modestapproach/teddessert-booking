// B1 — calendar-service abstraction (provider seam).
//
// This module defines the single seam that makes Google, CalDAV, and (later)
// Outlook identical downstream of the availability engine + booking sync. It is
// pure types + a dispatch function — NO network I/O, NO Convex `ctx`. The
// concrete provider implementations live in sibling modules
// (`googleCalendar.ts`; CalDAV in B5) and are the things that actually `fetch`.
//
// Design notes (from availability-engine-prd §1.2 + backend-port-prd §6):
//   - `BusyInterval` is an OPAQUE UTC epoch-ms pair. FreeBusy / getSchedule
//     return ONLY busy windows — no titles, no attendees — for privacy. Never
//     widen this shape to carry event metadata.
//   - `CalendarCredential` is the decrypted, in-action view of a
//     `calendarCredentials` row: the provider discriminant + the already-
//     decrypted secret (Google refresh token / CalDAV password) + the CalDAV
//     server/username when relevant. Decryption happens in the calling action
//     (`googleCalendar.ts`' internalActions) via `_helpers/cryptoEnvelope`; the
//     provider methods never touch the encrypted envelope or the DB.
//   - The provider methods are described here as the interface a provider
//     fulfills; the Google provider exposes plain async functions (injectable
//     `fetchImpl`) for unit-testability rather than a class, but it satisfies
//     this same contract.

// ─────────────────────────────────────────────────────────────
// Core value types
// ─────────────────────────────────────────────────────────────

/**
 * An opaque busy window. Both bounds are UTC epoch-ms. Busy-only: NO titles,
 * NO attendees, NO calendar id — privacy by design (FreeBusy/getSchedule only
 * ever return this shape). Equivalent to cal.diy's `EventBusyDate` alias.
 */
export interface BusyInterval {
  start: number; // UTC epoch-ms
  end: number; // UTC epoch-ms
}

/** cal.diy alias: a busy interval returned by getFreeBusy. */
export type EventBusyDate = BusyInterval;

/** An attendee on a write (createEvent/updateEvent). Includes the candidate. */
export interface CalendarEventAttendee {
  email: string;
  name?: string;
  /** RSVP / participation status, where the provider supports it. */
  responseStatus?: "needsAction" | "accepted" | "declined" | "tentative";
  optional?: boolean;
}

/**
 * Input to createEvent / updateEvent. Carries the minimum a provider needs to
 * materialize a calendar event: title, start/end (UTC epoch-ms), attendees
 * (including the candidate), an optional location snapshot, and an optional
 * stable id for provider-side idempotency/dedupe (availability-engine-prd §5
 * item 5). Provider impls map this onto their native event resource.
 */
export interface CalendarEvent {
  title: string;
  description?: string;
  /** Location snapshot (text). Maps to Google's `location`. */
  location?: string;
  start: number; // UTC epoch-ms
  end: number; // UTC epoch-ms
  /** IANA tz the start/end should be presented in (default UTC). */
  timeZone?: string;
  attendees?: CalendarEventAttendee[];
  /**
   * Stable, idempotency-safe id for provider-side dedupe. For Google this is
   * the request `id` on the event resource (lowercase base32hex, 5–1024 chars).
   * Optional: omit to let the provider assign one.
   */
  idempotencyKey?: string;
}

/** Listing entry from listCalendars — cal.diy's `IntegrationCalendar`. */
export interface IntegrationCalendar {
  /** Provider calendar id (Google calendarId / CalDAV calendar URL). */
  externalId: string;
  name?: string;
  primary?: boolean;
  /** Whether the connected account can write events to this calendar. */
  readOnly?: boolean;
  timeZone?: string;
}

/**
 * The decrypted, in-action view of a `calendarCredentials` row. The encrypted
 * envelope (`encSecretCiphertext`/`encSecretIv`) has ALREADY been decrypted by
 * the caller via `decryptAtRest`; `secret` is the plaintext (Google OAuth
 * refresh token / CalDAV app password). Providers never see the ciphertext.
 */
export interface CalendarCredential {
  provider: "google" | "caldav";
  /** Decrypted secret: Google refresh token OR CalDAV app password. */
  secret: string;
  /** CalDAV-only: the server base URL. */
  caldavServerUrl?: string;
  /** CalDAV-only: the username. */
  caldavUsername?: string;
}

// ─────────────────────────────────────────────────────────────
// Provider interfaces
// ─────────────────────────────────────────────────────────────

/** A UTC epoch-ms half-open window. */
export interface BusyWindow {
  from: number; // UTC epoch-ms
  to: number; // UTC epoch-ms
}

/**
 * The availability-engine seam (availability-engine-prd §1.2). The single
 * method `getBusy` is what the availability projection fans out over; making
 * Google / CalDAV / Outlook identical downstream. Runs ONLY inside a Convex
 * action (network I/O). The credential is already-decrypted (see
 * `CalendarCredential`).
 */
export interface BusyProvider {
  getBusy(
    credential: CalendarCredential,
    calendarIds: string[],
    windowStart: number, // UTC epoch-ms
    windowEnd: number, // UTC epoch-ms
  ): Promise<BusyInterval[]>;
}

/**
 * The full calendar provider contract (backend-port-prd §6 — cal.diy's
 * `Calendar` interface). Extends the busy seam with the write/list surface used
 * by booking sync. All methods are network I/O → live inside Convex actions.
 *
 * `externalCalendarId` selects the target calendar; when omitted, write methods
 * fall back to the credential's destination calendar (the `isDestination` row
 * in `selectedCalendars`), resolved by the calling action.
 */
export interface Calendar extends BusyProvider {
  createEvent(
    credential: CalendarCredential,
    event: CalendarEvent,
    externalCalendarId?: string,
  ): Promise<{ externalEventId: string }>;

  updateEvent(
    credential: CalendarCredential,
    uid: string,
    event: CalendarEvent,
    externalCalendarId?: string,
  ): Promise<{ externalEventId: string }>;

  deleteEvent(
    credential: CalendarCredential,
    uid: string,
    externalCalendarId?: string,
  ): Promise<void>;

  listCalendars(credential: CalendarCredential): Promise<IntegrationCalendar[]>;
}

// Re-export the cal.diy alias name (`CalendarService`) for callers that prefer
// the spec's name. Same contract as `Calendar`.
export type CalendarService = Calendar;

// ─────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────

import { makeGoogleCalendar } from "./googleCalendar";
import { makeCalDavCalendar } from "./caldavCalendar";

/**
 * Resolve the provider implementation for a given credential provider.
 *
 * Returns the provider's `Calendar` adapter — a thin object wired to the
 * provider's plain (testable) network functions. The Google adapter mints an
 * access token from the credential's refresh token internally; the CalDAV
 * adapter (B5) builds Basic-auth CalDAV requests from the decrypted app-specific
 * password. Both unit-tested cores take an injectable fetcher directly.
 *
 * The imports of `googleCalendar`/`caldavCalendar` form one-directional cycles
 * (each imports ONLY the `import type` surface back from this module), so they
 * are safe: the `make*` factories are invoked at call time, never at module
 * load.
 */
export function getCalendarProvider(provider: "google" | "caldav"): Calendar {
  if (provider === "google") {
    return makeGoogleCalendar();
  }
  if (provider === "caldav") {
    return makeCalDavCalendar();
  }
  // Exhaustiveness guard.
  throw new Error(`Unknown calendar provider: ${String(provider)}`);
}
