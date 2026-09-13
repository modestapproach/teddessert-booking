// B1 — Google Calendar provider implementation.
//
// TESTABILITY CONTRACT (mirrors `_helpers/googleOidc.ts`): every HTTP call is a
// PLAIN module-level async function that takes an INJECTABLE `fetchImpl`
// (defaulting to the global `fetch`) plus an already-minted access `token`. No
// Convex `ctx`, no DB reads, no env, no token minting inside these functions —
// so unit tests pass a fake fetcher and a fake token and exercise the real
// request-building + response-parsing logic with NO network. The Convex
// `internalAction` wrappers at the bottom are the only `ctx`-coupled surface:
// they load + decrypt the credential, mint an access token, then delegate.
//
// Endpoints (Google Calendar API v3):
//   freeBusy:    POST   /freeBusy
//   create:      POST   /calendars/{calendarId}/events
//   update:      PATCH  /calendars/{calendarId}/events/{eventId}
//   delete:      DELETE /calendars/{calendarId}/events/{eventId}
//   list:        GET    /users/me/calendarList
//
// Spec highlights (availability-engine-prd §1.2/§5, backend-port-prd §6):
//   - getBusy batches calendarIds in chunks of ≤50 (Google's per-call cap) and
//     chunks the time window to ≤90 days per call. Per-calendar `errors[]` are
//     inspected and that calendar is SKIPPED — one bad/inaccessible calendar id
//     must NOT fail the whole batch (the "false-free" trap is on the read side,
//     not here; here we surface what we can).
//   - busy intervals come back as ISO-8601 strings → converted to UTC epoch-ms.
//   - createEvent passes a stable request `id` for Google-side dedupe.
//
// TODO(B2): token refresh-on-401 + proactive refresh + setting
// `calendarCredentials.invalid = true` on a hard refresh failure. The action
// wrappers below mint a token once and do not yet retry on a 401; the plain
// fns simply throw on non-2xx so the wrapper can map the failure.

import { ConvexError, v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { decryptAtRest, isEnvelope } from "../_helpers/cryptoEnvelope";
import { log } from "../_helpers/log";
import type {
  BusyInterval,
  Calendar,
  CalendarCredential,
  CalendarEvent,
  IntegrationCalendar,
} from "./calendarService";

// The committed `_generated/api` is stale (codegen is operator-gated and the
// entire `scheduling/*` subtree — including `calendarCredentialsRead` — is not
// yet materialized on the typed `internal`). Reference the credential-read
// query through an `as any` hop, the SAME precedent as `scheduling/booking.ts`'
// `(internal as any).scheduling.booking.*` and `crons.ts`' gmailPush refs. The
// runtime path internal.scheduling.calendarCredentialsRead.getCredentialRow is
// correct; a deploy regenerates the types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getCredentialRowRef = (internal as any).scheduling?.calendarCredentialsRead
  ?.getCredentialRow;

// B2 — mark a credential invalid after a hard refresh failure (revoked grant).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const markCredentialInvalidRef = (internal as any).scheduling?.calendarOauth
  ?.markCredentialInvalid;

/**
 * Heuristic: is this error a Google auth failure (401)? The plain fns throw
 * `Google Calendar <what> failed (401): …`; the token-mint path throws
 * `Google Calendar token refresh failed (4xx): …`. A 401 (expired/invalid
 * access token) is retryable with a fresh access token; a token-refresh failure
 * (refresh token revoked) is not. We match the `(4NN)` status that the plain
 * fns embed in their message.
 */
function isGoogleAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /failed \(401\)/.test(msg);
}

function isTokenRefreshError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /token refresh failed \((400|401|403)\)/.test(msg);
}

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const GCAL_BASE = "https://www.googleapis.com/calendar/v3";
const FREEBUSY_URL = `${GCAL_BASE}/freeBusy`;
const CALENDAR_LIST_URL = `${GCAL_BASE}/users/me/calendarList`;
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Google's freeBusy endpoint accepts at most 50 calendar items per call.
const MAX_FREEBUSY_CALENDARS = 50;
// Google's freeBusy window cap is ~90 days per call.
const MAX_FREEBUSY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Injectable fetcher. Production passes the global `fetch`; tests pass a fake
 * that returns a hand-crafted `Response`-like object. Matches the standard
 * `fetch` signature so the real `fetch` is assignable with no adapter.
 */
export type FetchImpl = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

const defaultFetch: FetchImpl = (url, init) => fetch(url, init);

// ─────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────

/** Split an array into chunks of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be > 0");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Split [from,to) into sub-windows no longer than `maxMs`. */
export function chunkWindow(
  from: number,
  to: number,
  maxMs: number,
): Array<{ from: number; to: number }> {
  if (!(to > from)) return [];
  const out: Array<{ from: number; to: number }> = [];
  let cursor = from;
  while (cursor < to) {
    const next = Math.min(cursor + maxMs, to);
    out.push({ from: cursor, to: next });
    cursor = next;
  }
  return out;
}

/** ISO-8601 string → UTC epoch-ms. Returns null on an unparseable value. */
function isoToEpochMs(iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

async function fetchWithTimeout(
  fetchImpl: FetchImpl,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function throwForStatus(resp: Response, what: string): Promise<never> {
  let body = "";
  try {
    body = await resp.text();
  } catch {
    // ignore — body is best-effort context
  }
  throw new Error(
    `Google Calendar ${what} failed (${resp.status}): ${body.slice(0, 500)}`,
  );
}

// ─────────────────────────────────────────────────────────────
// freeBusy — the busy seam
// ─────────────────────────────────────────────────────────────

/** Shape of the freeBusy response we read. */
interface FreeBusyResponse {
  calendars?: Record<
    string,
    {
      busy?: Array<{ start?: string; end?: string }>;
      errors?: Array<{ domain?: string; reason?: string }>;
    }
  >;
}

/**
 * One freeBusy POST for a single (≤50 ids, ≤90d) chunk. Parses
 * `calendars[id].busy[]` into `BusyInterval[]`, SKIPPING any calendar that
 * returns `errors[]` (a bad/inaccessible id must not fail the chunk). Returns
 * both the merged busy intervals and the ids that errored (for caller logging).
 */
export async function googleFreeBusyChunk(
  token: string,
  calendarIds: string[],
  windowStart: number,
  windowEnd: number,
  fetchImpl: FetchImpl = defaultFetch,
): Promise<{ busy: BusyInterval[]; erroredCalendarIds: string[] }> {
  const body = {
    timeMin: new Date(windowStart).toISOString(),
    timeMax: new Date(windowEnd).toISOString(),
    items: calendarIds.map((id) => ({ id })),
  };

  const resp = await fetchWithTimeout(fetchImpl, FREEBUSY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) await throwForStatus(resp, "freeBusy");

  const json = (await resp.json()) as FreeBusyResponse;
  const calendars = json.calendars ?? {};

  const busy: BusyInterval[] = [];
  const erroredCalendarIds: string[] = [];

  for (const [calId, cal] of Object.entries(calendars)) {
    // Inspect per-calendar errors FIRST — skip this calendar but keep the rest.
    if (cal && Array.isArray(cal.errors) && cal.errors.length > 0) {
      erroredCalendarIds.push(calId);
      continue;
    }
    const intervals = cal?.busy ?? [];
    for (const slot of intervals) {
      const start = isoToEpochMs(slot?.start);
      const end = isoToEpochMs(slot?.end);
      if (start === null || end === null) continue; // skip malformed slot
      busy.push({ start, end });
    }
  }

  return { busy, erroredCalendarIds };
}

/**
 * Full getBusy WITH error surface: batch `calendarIds` in chunks of ≤50 and the
 * time window in chunks of ≤90 days, fan out one freeBusy POST per (id-chunk ×
 * window-chunk), and merge all busy intervals. Per-calendar errors are skipped
 * (not thrown) but — unlike the old `googleGetBusy` — they are NO LONGER
 * silently discarded: the deduped set of errored calendar ids is returned so
 * the caller (the action wrapper) can decide whether to flag the credential.
 *
 * NOTE: chunks run sequentially here for deterministic ordering + gentle quota
 * behavior; the merge is order-independent so a parallel variant is a drop-in
 * later if needed.
 */
export async function googleGetBusyDetailed(
  token: string,
  calendarIds: string[],
  windowStart: number,
  windowEnd: number,
  fetchImpl: FetchImpl = defaultFetch,
): Promise<{ busy: BusyInterval[]; erroredCalendarIds: string[] }> {
  if (calendarIds.length === 0 || !(windowEnd > windowStart)) {
    return { busy: [], erroredCalendarIds: [] };
  }

  const idChunks = chunk(calendarIds, MAX_FREEBUSY_CALENDARS);
  const windows = chunkWindow(windowStart, windowEnd, MAX_FREEBUSY_WINDOW_MS);

  const merged: BusyInterval[] = [];
  const errored = new Set<string>();
  for (const ids of idChunks) {
    for (const w of windows) {
      const { busy, erroredCalendarIds } = await googleFreeBusyChunk(
        token,
        ids,
        w.from,
        w.to,
        fetchImpl,
      );
      merged.push(...busy);
      for (const id of erroredCalendarIds) errored.add(id);
    }
  }
  return { busy: merged, erroredCalendarIds: [...errored] };
}

/**
 * `BusyInterval[]`-only convenience over `googleGetBusyDetailed`, preserving the
 * original B1 signature for the `Calendar` adapter + existing callers. The
 * per-calendar errored ids are no longer dropped on the floor: they're logged
 * here (so an inaccessible calendar surfaces in the Convex logs) before being
 * collapsed to just the busy intervals. The richer `googleGetBusyDetailed` is
 * what the action wrapper uses when it needs to act on the errored set.
 */
export async function googleGetBusy(
  token: string,
  calendarIds: string[],
  windowStart: number,
  windowEnd: number,
  fetchImpl: FetchImpl = defaultFetch,
): Promise<BusyInterval[]> {
  const { busy, erroredCalendarIds } = await googleGetBusyDetailed(
    token,
    calendarIds,
    windowStart,
    windowEnd,
    fetchImpl,
  );
  if (erroredCalendarIds.length > 0) {
    log.warn("googleCalendar.getBusy.erroredCalendars", {
      erroredCalendarIds,
    });
  }
  return busy;
}

// ─────────────────────────────────────────────────────────────
// Event write surface
// ─────────────────────────────────────────────────────────────

/** Map a `CalendarEvent` onto a Google Calendar Event resource. */
function toGoogleEventResource(event: CalendarEvent): Record<string, unknown> {
  const tz = event.timeZone ?? "UTC";
  const resource: Record<string, unknown> = {
    summary: event.title,
    start: { dateTime: new Date(event.start).toISOString(), timeZone: tz },
    end: { dateTime: new Date(event.end).toISOString(), timeZone: tz },
  };
  if (event.description !== undefined) resource.description = event.description;
  if (event.location !== undefined) resource.location = event.location;
  if (event.attendees && event.attendees.length > 0) {
    resource.attendees = event.attendees.map((a) => {
      const at: Record<string, unknown> = { email: a.email };
      if (a.name !== undefined) at.displayName = a.name;
      if (a.responseStatus !== undefined) at.responseStatus = a.responseStatus;
      if (a.optional !== undefined) at.optional = a.optional;
      return at;
    });
  }
  // Stable request id for Google-side dedupe (availability-engine-prd §5 #5).
  if (event.idempotencyKey) resource.id = event.idempotencyKey;
  return resource;
}

function eventsUrl(calendarId: string): string {
  return `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events`;
}

function eventUrl(calendarId: string, eventId: string): string {
  return `${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}`;
}

/** POST a new event. Returns the created event id as `externalEventId`. */
export async function googleCreateEvent(
  token: string,
  calendarId: string,
  event: CalendarEvent,
  fetchImpl: FetchImpl = defaultFetch,
): Promise<{ externalEventId: string }> {
  const resp = await fetchWithTimeout(fetchImpl, eventsUrl(calendarId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(toGoogleEventResource(event)),
  });
  if (!resp.ok) await throwForStatus(resp, "createEvent");
  const json = (await resp.json()) as { id?: string };
  if (!json.id) {
    throw new Error("Google Calendar createEvent returned no event id");
  }
  return { externalEventId: json.id };
}

/** PATCH an existing event. Returns the event id as `externalEventId`. */
export async function googleUpdateEvent(
  token: string,
  calendarId: string,
  eventId: string,
  event: CalendarEvent,
  fetchImpl: FetchImpl = defaultFetch,
): Promise<{ externalEventId: string }> {
  // Don't re-send the stable request `id` on PATCH (immutable post-create).
  const resource = toGoogleEventResource(event);
  delete (resource as { id?: unknown }).id;
  const resp = await fetchWithTimeout(fetchImpl, eventUrl(calendarId, eventId), {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(resource),
  });
  if (!resp.ok) await throwForStatus(resp, "updateEvent");
  const json = (await resp.json()) as { id?: string };
  return { externalEventId: json.id ?? eventId };
}

/** DELETE an event. A 410 (already gone) is treated as success (idempotent). */
export async function googleDeleteEvent(
  token: string,
  calendarId: string,
  eventId: string,
  fetchImpl: FetchImpl = defaultFetch,
): Promise<void> {
  const resp = await fetchWithTimeout(fetchImpl, eventUrl(calendarId, eventId), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  // 204 = deleted; 410 = already gone → both fine for a delete.
  if (resp.ok || resp.status === 410) return;
  await throwForStatus(resp, "deleteEvent");
}

// ─────────────────────────────────────────────────────────────
// listCalendars
// ─────────────────────────────────────────────────────────────

interface GoogleCalendarListResponse {
  items?: Array<{
    id?: string;
    summary?: string;
    primary?: boolean;
    accessRole?: string; // "owner" | "writer" | "reader" | "freeBusyReader"
    timeZone?: string;
  }>;
}

/** GET the connected account's calendar list → IntegrationCalendar[]. */
export async function googleListCalendars(
  token: string,
  fetchImpl: FetchImpl = defaultFetch,
): Promise<IntegrationCalendar[]> {
  const resp = await fetchWithTimeout(fetchImpl, CALENDAR_LIST_URL, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) await throwForStatus(resp, "listCalendars");
  const json = (await resp.json()) as GoogleCalendarListResponse;
  const items = json.items ?? [];
  return items
    .filter((it): it is { id: string } & typeof it => typeof it.id === "string")
    .map((it) => ({
      externalId: it.id,
      name: it.summary,
      primary: it.primary === true,
      // owner/writer can write; reader/freeBusyReader cannot.
      readOnly: !(it.accessRole === "owner" || it.accessRole === "writer"),
      timeZone: it.timeZone,
    }));
}

// ─────────────────────────────────────────────────────────────
// Access token minting (refresh-token → access-token exchange)
// ─────────────────────────────────────────────────────────────

/**
 * Exchange a Google OAuth refresh token for a short-lived access token. Plain +
 * injectable for tests. Reads the OAuth client creds from env (same as
 * `gmail.ts` `getGoogleAccessToken`).
 *
 * TODO(B2): proactive refresh + caching of the access token; on a hard failure
 * the action wrapper sets `calendarCredentials.invalid = true`.
 */
export async function googleMintAccessToken(
  refreshToken: string,
  fetchImpl: FetchImpl = defaultFetch,
): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new ConvexError(
      "Google OAuth environment variables are not fully configured.",
    );
  }
  const resp = await fetchWithTimeout(fetchImpl, TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!resp.ok) await throwForStatus(resp, "token refresh");
  const data = (await resp.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new ConvexError("Google did not return an access token.");
  }
  return data.access_token;
}

// ─────────────────────────────────────────────────────────────
// Calendar adapter (satisfies the `Calendar` interface)
// ─────────────────────────────────────────────────────────────

/**
 * Build a `Calendar` adapter backed by the plain Google functions above. Each
 * method mints an access token from the credential's refresh token, then calls
 * the matching plain function. This is what `getCalendarProvider("google")`
 * returns. Network-only — call from inside a Convex action.
 *
 * `externalCalendarId` is required for the write/delete methods at this layer;
 * the destination-calendar fallback (the `isDestination` row) is resolved by
 * the calling action before constructing the `CalendarEvent`, so by the time we
 * are here the target id is known. We default to `"primary"` if still absent.
 */
export function makeGoogleCalendar(fetchImpl: FetchImpl = defaultFetch): Calendar {
  const tokenFor = (c: CalendarCredential) =>
    googleMintAccessToken(c.secret, fetchImpl);
  return {
    async getBusy(credential, calendarIds, windowStart, windowEnd) {
      const token = await tokenFor(credential);
      return googleGetBusy(token, calendarIds, windowStart, windowEnd, fetchImpl);
    },
    async createEvent(credential, event, externalCalendarId) {
      const token = await tokenFor(credential);
      return googleCreateEvent(
        token,
        externalCalendarId ?? "primary",
        event,
        fetchImpl,
      );
    },
    async updateEvent(credential, uid, event, externalCalendarId) {
      const token = await tokenFor(credential);
      return googleUpdateEvent(
        token,
        externalCalendarId ?? "primary",
        uid,
        event,
        fetchImpl,
      );
    },
    async deleteEvent(credential, uid, externalCalendarId) {
      const token = await tokenFor(credential);
      return googleDeleteEvent(
        token,
        externalCalendarId ?? "primary",
        uid,
        fetchImpl,
      );
    },
    async listCalendars(credential) {
      const token = await tokenFor(credential);
      return googleListCalendars(token, fetchImpl);
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Convex internalAction wrappers (ctx-coupled: load + decrypt credential)
// ─────────────────────────────────────────────────────────────

/**
 * Load + decrypt a `calendarCredentials` row into a `CalendarCredential`. Runs
 * inside an action via `ctx.runQuery`-loaded row (passed in). Throws if the
 * envelope is missing/invalid.
 */
async function decryptCredentialRow(row: {
  provider: "google" | "caldav";
  encSecretCiphertext: string;
  encSecretIv: string;
  caldavServerUrl?: string;
  caldavUsername?: string;
}): Promise<CalendarCredential> {
  const envelope = { ciphertext: row.encSecretCiphertext, iv: row.encSecretIv };
  if (!isEnvelope(envelope)) {
    throw new ConvexError("Calendar credential is missing a valid secret.");
  }
  const secret = await decryptAtRest(envelope);
  return {
    provider: row.provider,
    secret,
    caldavServerUrl: row.caldavServerUrl,
    caldavUsername: row.caldavUsername,
  };
}

/** The encrypted-envelope row shape `getCredentialRow` returns. */
interface CredentialRow {
  _id: unknown;
  provider: "google" | "caldav";
  encSecretCiphertext: string;
  encSecretIv: string;
  caldavServerUrl?: string;
  caldavUsername?: string;
  invalid: boolean;
}

/**
 * Load a credential row through the (codegen-pending) `as any` ref. Centralizes
 * the single untyped hop so the four action handlers stay typed. Throws if the
 * read query isn't registered yet (pre-deploy safety) or the row is missing.
 */
async function loadCredentialRow(
  // `ctx` is the action ctx; typed loose for the codegen-pending `as any` ref
  // hop (the SAME `type Ctx = any` convention used across scheduling/*).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  credentialId: unknown,
): Promise<CredentialRow> {
  if (!getCredentialRowRef) {
    throw new ConvexError(
      "calendarCredentialsRead.getCredentialRow is not registered (deploy pending).",
    );
  }
  const row = (await ctx.runQuery(getCredentialRowRef, {
    credentialId,
  })) as CredentialRow | null;
  if (!row) throw new ConvexError("Calendar credential not found.");
  return row;
}

const eventArgValidator = v.object({
  title: v.string(),
  description: v.optional(v.string()),
  location: v.optional(v.string()),
  start: v.number(),
  end: v.number(),
  timeZone: v.optional(v.string()),
  attendees: v.optional(
    v.array(
      v.object({
        email: v.string(),
        name: v.optional(v.string()),
        responseStatus: v.optional(
          v.union(
            v.literal("needsAction"),
            v.literal("accepted"),
            v.literal("declined"),
            v.literal("tentative"),
          ),
        ),
        optional: v.optional(v.boolean()),
      }),
    ),
  ),
  idempotencyKey: v.optional(v.string()),
});

/**
 * Flag a credential `invalid=true` after a hard refresh failure. Best-effort:
 * if the mark-invalid mutation isn't registered yet (codegen pending) we log
 * rather than masking the original error. Centralizes the single untyped hop.
 */
async function markCredentialInvalid(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  credentialId: unknown,
): Promise<void> {
  if (!markCredentialInvalidRef) {
    log.warn("googleCalendar.markInvalid.unregistered", { credentialId });
    return;
  }
  try {
    await ctx.runMutation(markCredentialInvalidRef, { credentialId });
  } catch (err) {
    log.error("googleCalendar.markInvalid.failed", err, { credentialId });
  }
}

/**
 * B2 — run a network op that needs a Google access token, retrying ONCE on a
 * 401 with a freshly-minted token. If minting the token itself fails (refresh
 * token revoked) we flag the credential `invalid=true` and rethrow so the
 * caller surfaces the failure (and the user is re-prompted to reconnect).
 */
export async function withGoogleToken<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  credentialId: unknown,
  credential: CalendarCredential,
  run: (token: string) => Promise<T>,
  fetchImpl: FetchImpl = defaultFetch,
): Promise<T> {
  let token: string;
  try {
    token = await googleMintAccessToken(credential.secret, fetchImpl);
  } catch (err) {
    if (isTokenRefreshError(err)) {
      await markCredentialInvalid(ctx, credentialId);
    }
    throw err;
  }

  try {
    return await run(token);
  } catch (err) {
    if (!isGoogleAuthError(err)) throw err;
    // 401 on the API call → access token likely stale. Mint a fresh one once.
    let fresh: string;
    try {
      fresh = await googleMintAccessToken(credential.secret, fetchImpl);
    } catch (refreshErr) {
      if (isTokenRefreshError(refreshErr)) {
        await markCredentialInvalid(ctx, credentialId);
      }
      throw refreshErr;
    }
    return await run(fresh);
  }
}

/**
 * internalAction — fetch busy intervals for a credential's calendars. Loads +
 * decrypts the credential, mints a token (refresh-on-401), calls
 * `googleGetBusyDetailed`. The caller (refreshFreebusy, B-later) upserts the
 * result into `freebusyCache`. Per-calendar errored ids are logged here; a
 * persistent auth failure flips `calendarCredentials.invalid=true`.
 */
export const getBusyForCredential = internalAction({
  args: {
    credentialId: v.id("calendarCredentials"),
    calendarIds: v.array(v.string()),
    windowStart: v.number(),
    windowEnd: v.number(),
  },
  handler: async (ctx, args): Promise<BusyInterval[]> => {
    const row = await loadCredentialRow(ctx, args.credentialId);
    if (row.provider !== "google") {
      throw new ConvexError(
        `getBusyForCredential: unsupported provider ${row.provider}`,
      );
    }
    const credential = await decryptCredentialRow(row);
    const { busy, erroredCalendarIds } = await withGoogleToken(
      ctx,
      args.credentialId,
      credential,
      (token) =>
        googleGetBusyDetailed(
          token,
          args.calendarIds,
          args.windowStart,
          args.windowEnd,
        ),
    );
    if (erroredCalendarIds.length > 0) {
      // B1 carry-forward: surface the inaccessible calendars instead of silently
      // dropping them. TODO(B-later): if the SAME id keeps erroring across
      // sweeps, mark that specific selectedCalendars row invalid / re-prompt.
      log.warn("getBusyForCredential.erroredCalendars", {
        credentialId: args.credentialId,
        erroredCalendarIds,
      });
    }
    return busy;
  },
});

/** internalAction — create an event on a credential's calendar. */
export const createEventForCredential = internalAction({
  args: {
    credentialId: v.id("calendarCredentials"),
    externalCalendarId: v.optional(v.string()),
    event: eventArgValidator,
  },
  handler: async (ctx, args): Promise<{ externalEventId: string }> => {
    const row = await loadCredentialRow(ctx, args.credentialId);
    const credential = await decryptCredentialRow(row);
    const provider = makeGoogleCalendar();
    return provider.createEvent(
      credential,
      args.event as CalendarEvent,
      args.externalCalendarId,
    );
  },
});

/** internalAction — update an event on a credential's calendar. */
export const updateEventForCredential = internalAction({
  args: {
    credentialId: v.id("calendarCredentials"),
    uid: v.string(),
    externalCalendarId: v.optional(v.string()),
    event: eventArgValidator,
  },
  handler: async (ctx, args): Promise<{ externalEventId: string }> => {
    const row = await loadCredentialRow(ctx, args.credentialId);
    const credential = await decryptCredentialRow(row);
    const provider = makeGoogleCalendar();
    return provider.updateEvent(
      credential,
      args.uid,
      args.event as CalendarEvent,
      args.externalCalendarId,
    );
  },
});

/** internalAction — delete an event on a credential's calendar. */
export const deleteEventForCredential = internalAction({
  args: {
    credentialId: v.id("calendarCredentials"),
    uid: v.string(),
    externalCalendarId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<null> => {
    const row = await loadCredentialRow(ctx, args.credentialId);
    const credential = await decryptCredentialRow(row);
    const provider = makeGoogleCalendar();
    await provider.deleteEvent(credential, args.uid, args.externalCalendarId);
    return null;
  },
});

/** internalAction — list the connected account's calendars (refresh-on-401). */
export const listCalendarsForCredential = internalAction({
  args: { credentialId: v.id("calendarCredentials") },
  handler: async (ctx, args): Promise<IntegrationCalendar[]> => {
    const row = await loadCredentialRow(ctx, args.credentialId);
    const credential = await decryptCredentialRow(row);
    return withGoogleToken(ctx, args.credentialId, credential, (token) =>
      googleListCalendars(token),
    );
  },
});
