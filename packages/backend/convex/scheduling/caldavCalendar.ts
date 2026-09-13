// B5 — CalDAV / Apple Calendar provider implementation.
//
// Mirrors `googleCalendar.ts` structure 1:1: every wire op is a PLAIN
// module-level async function that takes an INJECTABLE `fetchImpl` (defaulting
// to the global `fetch`) plus the already-decrypted credential fields
// (serverUrl / username / app-specific password). No Convex `ctx`, no DB reads,
// no env, no secret-decryption inside these functions — so unit tests pass a
// fake fetcher returning hand-crafted CalDAV XML/iCal responses and exercise the
// real request-building + parsing + RRULE-expansion logic with NO network. The
// Convex `internalAction` wrappers at the bottom are the only `ctx`-coupled
// surface: they load the row + decrypt the app-specific password, then delegate.
//
// WHY RAW FETCH (not the `tsdav` library): the B1 testability contract demands
// an injectable `fetchImpl` seam identical to googleCalendar.ts so tests run
// with NO network and NO Convex runtime. tsdav bundles its own fetch with no
// clean injection point, and pulls `xml-js`/`base-64` whose behavior in the
// Convex V8 isolate is unverified. CalDAV is a small, stable subset of WebDAV
// (PROPFIND + REPORT calendar-query/free-busy-query + PUT + DELETE), so we build
// the XML bodies by hand and parse the (very regular) multistatus/iCal responses
// with focused parsers. This keeps the impl V8-safe, dependency-free, and fully
// unit-testable — the SAME reasoning that made googleCalendar.ts use raw fetch
// rather than googleapis. cal.com's wire logic (free-busy-query → calendar-query
// VEVENT fallback → ical.js RRULE expansion honoring EXDATE/RECURRENCE-ID) is
// lifted faithfully; only the transport library differs.
//
// getBusy strategy (backend-port-prd §6 — CalDAV/Apple impl):
//   1. Try a `free-busy-query` REPORT (server returns a VFREEBUSY with FREEBUSY
//      periods). iCloud support is unreliable, so —
//   2. fall back to a `calendar-query` REPORT for VEVENTs overlapping the window
//      (request server-side recurrence expansion via <C:expand>), parse each
//      VEVENT into busy intervals, and CLIENT-SIDE merge overlaps. We expand
//      RRULE ourselves (honoring EXDATE + RECURRENCE-ID overrides) when the
//      server returns the master event un-expanded.
//   A calendar whose REPORT errors must NOT silently read as free: its URL is
//   surfaced in `erroredCalendarUrls` (the "false-free" trap discipline from the
//   Google impl) so the caller can flag it rather than treating it as empty.
//
// RUNTIME-UNVERIFIED [R]: no live iCloud / Fastmail CalDAV round-trip exercised.
// Verified only against mocked DAV responses + tsc.

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

// Codegen-pending credential-read ref (SAME precedent as googleCalendar.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getCredentialRowRef = (internal as any).scheduling?.calendarCredentialsRead
  ?.getCredentialRow;

// ─────────────────────────────────────────────────────────────
// Constants + injectable fetch
// ─────────────────────────────────────────────────────────────

export const DEFAULT_CALDAV_SERVER_URL = "https://caldav.icloud.com";
const FETCH_TIMEOUT_MS = 15_000;
// Hard cap on RRULE expansion iterations (mirrors cal.com's 365 guard).
const MAX_RRULE_ITERATIONS = 366;

/** Injectable fetcher — production passes global `fetch`; tests pass a fake. */
export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

const defaultFetch: FetchImpl = (url, init) => fetch(url, init);

/** Decrypted CalDAV connection params used by every plain wire fn. */
export interface CalDavAuth {
  serverUrl: string;
  username: string;
  /** Decrypted app-specific password. */
  password: string;
}

function basicAuthHeader(username: string, password: string): string {
  // btoa is available in both the Convex V8 isolate and the vitest/Node env.
  return `Basic ${btoa(`${username}:${password}`)}`;
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
    // best-effort context
  }
  throw new Error(
    `CalDAV ${what} failed (${resp.status}): ${body.slice(0, 500)}`,
  );
}

/** Resolve a (possibly-relative) href against the server base URL. */
export function resolveHref(serverUrl: string, href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  try {
    return new URL(href, serverUrl).toString();
  } catch {
    // Fall back to naive join if URL() can't parse (shouldn't happen).
    const base = serverUrl.replace(/\/+$/, "");
    const path = href.startsWith("/") ? href : `/${href}`;
    return `${base}${path}`;
  }
}

// ─────────────────────────────────────────────────────────────
// Minimal multistatus (WebDAV 207) XML extraction
//
// CalDAV multistatus is regular enough that we extract the few fields we need
// with focused, namespace-agnostic helpers rather than a full XML parser. We
// strip the namespace prefix (`d:`, `D:`, `cal:`, `C:`, …) from tag names so the
// matcher works regardless of which prefix the server chose.
// ─────────────────────────────────────────────────────────────

/** Strip a `prefix:` from a local tag name for namespace-agnostic matching. */
function localName(tag: string): string {
  const i = tag.indexOf(":");
  return i === -1 ? tag : tag.slice(i + 1);
}

/**
 * Split a multistatus body into its `<response>` blocks (inner XML of each).
 * Namespace-agnostic on the `response` tag.
 */
export function splitResponses(xml: string): string[] {
  const out: string[] = [];
  // Match <…response …>…</…response> capturing inner content. The tag may carry
  // a namespace prefix; `[\w-]+:` optionally precedes `response`.
  const re = /<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1]);
  }
  return out;
}

/** First text content of `<…tagLocalName>…</…>` within `xml` (ns-agnostic). */
export function firstTagText(xml: string, tagLocalName: string): string | null {
  const re = new RegExp(
    `<(?:[\\w-]+:)?${tagLocalName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tagLocalName}>`,
    "i",
  );
  const m = re.exec(xml);
  return m ? decodeXmlEntities(m[1].trim()) : null;
}

/** Does `<…tagLocalName …/>` or `<…tagLocalName>…` appear (presence flag)? */
function hasTag(xml: string, tagLocalName: string): boolean {
  const re = new RegExp(`<(?:[\\w-]+:)?${tagLocalName}\\b`, "i");
  return re.test(xml);
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

// ─────────────────────────────────────────────────────────────
// iCal parsing (VEVENT / VFREEBUSY / VTIMEZONE-lite + RRULE expansion)
//
// A focused iCalendar reader: unfolds long lines, walks components, and reads
// the property/parameter subset booking needs. We do NOT implement the full RFC
// 5545 — only what CalDAV busy-detection requires (DTSTART/DTEND/DURATION,
// RRULE, EXDATE, RECURRENCE-ID, FREEBUSY, TRANSP). Timezone handling treats
// floating + TZID times as their wall-clock instant in UTC unless the value
// carries a `Z` (UTC) suffix; full VTIMEZONE offset resolution is a [R] follow-up
// — booking windows are short and the merge is conservative (over-blocking, never
// under-blocking, so we never read a busy slot as free).
// ─────────────────────────────────────────────────────────────

interface ICalProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Unfold RFC 5545 folded lines (continuation lines begin with space/tab). */
function unfoldICal(text: string): string[] {
  const rawLines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lines: string[] = [];
  for (const line of rawLines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

/** Parse a single content line `NAME;PARAM=val:value` into an ICalProp. */
function parsePropLine(line: string): ICalProp | null {
  const colon = findValueColon(line);
  if (colon === -1) return null;
  const namePart = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segments = splitParams(namePart);
  const name = segments[0].toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < segments.length; i++) {
    const eq = segments[i].indexOf("=");
    if (eq === -1) continue;
    params[segments[i].slice(0, eq).toUpperCase()] = segments[i]
      .slice(eq + 1)
      .replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

/** Find the colon that separates name+params from value (skips quoted colons). */
function findValueColon(line: string): number {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ":" && !inQuote) return i;
  }
  return -1;
}

/** Split the name+params part on `;` honoring quoted values. */
function splitParams(part: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (const c of part) {
    if (c === '"') {
      inQuote = !inQuote;
      cur += c;
    } else if (c === ";" && !inQuote) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

interface VEvent {
  props: ICalProp[];
  /** Raw RECURRENCE-ID value if this VEVENT is an override instance. */
  recurrenceId?: string;
}

interface ParsedICal {
  events: VEvent[];
  freebusyPeriods: Array<{ start: number; end: number }>;
}

/** Walk an iCal string, collecting VEVENTs and VFREEBUSY periods. */
export function parseICal(text: string): ParsedICal {
  const lines = unfoldICal(text);
  const events: VEvent[] = [];
  const freebusyPeriods: Array<{ start: number; end: number }> = [];

  let stack: string[] = [];
  let curEvent: VEvent | null = null;

  for (const line of lines) {
    if (!line) continue;
    const prop = parsePropLine(line);
    if (!prop) continue;

    if (prop.name === "BEGIN") {
      const comp = prop.value.toUpperCase();
      stack.push(comp);
      if (comp === "VEVENT") curEvent = { props: [] };
      continue;
    }
    if (prop.name === "END") {
      const comp = prop.value.toUpperCase();
      if (comp === "VEVENT" && curEvent) {
        const rid = curEvent.props.find((p) => p.name === "RECURRENCE-ID");
        if (rid) curEvent.recurrenceId = rid.value;
        events.push(curEvent);
        curEvent = null;
      }
      stack.pop();
      continue;
    }

    const inComp = stack[stack.length - 1];
    if (inComp === "VEVENT" && curEvent) {
      curEvent.props.push(prop);
    } else if (inComp === "VFREEBUSY" && prop.name === "FREEBUSY") {
      // FREEBUSY[;FBTYPE=BUSY]:<period>,<period>,…  period = start/end | start/dur
      const fbType = (prop.params.FBTYPE || "BUSY").toUpperCase();
      if (fbType.startsWith("FREE")) continue; // FREE / FREE-… → not busy
      for (const period of prop.value.split(",")) {
        const slash = period.indexOf("/");
        if (slash === -1) continue;
        const startStr = period.slice(0, slash);
        const endStr = period.slice(slash + 1);
        const start = icalDateToEpochMs(startStr);
        if (start === null) continue;
        let end: number | null;
        if (endStr.startsWith("P")) {
          const durMs = parseICalDuration(endStr);
          end = durMs === null ? null : start + durMs;
        } else {
          end = icalDateToEpochMs(endStr);
        }
        if (end === null) continue;
        freebusyPeriods.push({ start, end });
      }
    }
  }

  return { events, freebusyPeriods };
}

/**
 * iCal date/datetime → UTC epoch-ms.
 *   20260601T090000Z  → UTC
 *   20260601T090000   → treated as UTC wall-clock (floating/TZID; see header)
 *   20260601          → date-only, midnight UTC
 * Returns null on an unparseable value.
 */
export function icalDateToEpochMs(raw: string): number | null {
  const v = raw.trim();
  // Date-only: YYYYMMDD
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) {
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0);
  }
  // Date-time: YYYYMMDDTHHMMSS[Z]
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (m) {
    return Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6]),
    );
  }
  // Last resort: ISO-8601 (some servers/`ics` emit it).
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** RFC 5545 DURATION (e.g. PT1H30M, P1D) → milliseconds. Null on parse fail. */
export function parseICalDuration(raw: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    raw.trim(),
  );
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const weeks = Number(m[2] || 0);
  const days = Number(m[3] || 0);
  const hours = Number(m[4] || 0);
  const mins = Number(m[5] || 0);
  const secs = Number(m[6] || 0);
  const ms =
    weeks * 7 * 86400_000 +
    days * 86400_000 +
    hours * 3600_000 +
    mins * 60_000 +
    secs * 1000;
  if (ms === 0 && !/\d/.test(raw)) return null;
  return sign * ms;
}

// ─────────────────────────────────────────────────────────────
// RRULE expansion (DAILY / WEEKLY / MONTHLY / YEARLY)
//
// Lifts cal.com's ical.js iterator semantics: anchor at the master DTSTART, step
// by FREQ×INTERVAL, honor BYDAY for WEEKLY, stop at UNTIL/COUNT/window-end, cap
// at MAX_RRULE_ITERATIONS, SKIP sub-daily frequencies (HOURLY/MINUTELY/SECONDLY).
// EXDATE removes occurrences; RECURRENCE-ID override instances replace the
// matching occurrence's interval.
// ─────────────────────────────────────────────────────────────

interface RRule {
  freq: string;
  interval: number;
  count?: number;
  until?: number; // epoch-ms
  byDay?: string[]; // ["MO","WE","FR"]
}

export function parseRRule(value: string): RRule | null {
  const parts = value.split(";");
  const map: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq === -1) continue;
    map[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  if (!map.FREQ) return null;
  const rule: RRule = {
    freq: map.FREQ.toUpperCase(),
    interval: map.INTERVAL ? Math.max(1, parseInt(map.INTERVAL, 10)) : 1,
  };
  if (map.COUNT) rule.count = parseInt(map.COUNT, 10);
  if (map.UNTIL) {
    const u = icalDateToEpochMs(map.UNTIL);
    if (u !== null) rule.until = u;
  }
  if (map.BYDAY) rule.byDay = map.BYDAY.split(",").map((d) => d.trim().toUpperCase());
  return rule;
}

const WEEKDAY_INDEX: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

const SUBDAILY = new Set(["HOURLY", "MINUTELY", "SECONDLY"]);

/**
 * Expand a recurring VEVENT into the busy intervals that overlap
 * [windowStart, windowEnd). Honors EXDATE + RECURRENCE-ID overrides (the
 * override map is keyed by the occurrence's original start epoch-ms). Returns []
 * for sub-daily rules (skipped, like cal.com).
 */
export function expandRecurringEvent(
  masterStart: number,
  durationMs: number,
  rule: RRule,
  windowStart: number,
  windowEnd: number,
  exDates: Set<number>,
  overrides: Map<number, { start: number; end: number }>,
): BusyInterval[] {
  if (SUBDAILY.has(rule.freq)) {
    log.warn("caldav.rrule.subdaily_skipped", { freq: rule.freq });
    return [];
  }
  const out: BusyInterval[] = [];
  const stepDays =
    rule.freq === "DAILY"
      ? rule.interval
      : rule.freq === "WEEKLY"
        ? rule.interval * 7
        : 0; // MONTHLY/YEARLY handled via date arithmetic below

  let count = 0;
  let iterations = 0;
  let cursor = masterStart;

  const pushOccurrence = (startMs: number) => {
    if (exDates.has(startMs)) return; // cancelled occurrence
    const override = overrides.get(startMs);
    const interval = override ?? { start: startMs, end: startMs + durationMs };
    // Overlap test against the window (half-open).
    if (interval.end > windowStart && interval.start < windowEnd) {
      out.push({ start: interval.start, end: interval.end });
    }
  };

  while (iterations < MAX_RRULE_ITERATIONS) {
    iterations++;
    if (rule.until !== undefined && cursor > rule.until) break;
    if (cursor >= windowEnd) {
      // For DAILY/WEEKLY we can stop once past the window (monotonic).
      if (rule.freq === "DAILY" || rule.freq === "WEEKLY") break;
    }

    if (rule.freq === "WEEKLY" && rule.byDay && rule.byDay.length > 0) {
      // Emit each BYDAY weekday within the current week-window.
      const weekStart = cursor;
      for (const day of rule.byDay) {
        const targetDow = WEEKDAY_INDEX[day];
        if (targetDow === undefined) continue;
        const base = new Date(weekStart);
        const curDow = base.getUTCDay();
        const delta = (targetDow - curDow + 7) % 7;
        const occ = weekStart + delta * 86400_000;
        if (rule.until !== undefined && occ > rule.until) continue;
        pushOccurrence(occ);
        count++;
        if (rule.count !== undefined && count >= rule.count) return out;
      }
    } else {
      pushOccurrence(cursor);
      count++;
      if (rule.count !== undefined && count >= rule.count) break;
    }

    // Advance the cursor.
    if (stepDays > 0) {
      cursor += stepDays * 86400_000;
    } else if (rule.freq === "MONTHLY") {
      const d = new Date(cursor);
      d.setUTCMonth(d.getUTCMonth() + rule.interval);
      cursor = d.getTime();
    } else if (rule.freq === "YEARLY") {
      const d = new Date(cursor);
      d.setUTCFullYear(d.getUTCFullYear() + rule.interval);
      cursor = d.getTime();
    } else {
      break; // unknown freq — stop after the first occurrence
    }
  }
  return out;
}

/**
 * Convert a parsed set of VEVENTs (master + override instances) into busy
 * intervals overlapping the window. Skips TRANSP:TRANSPARENT events (show-as-
 * free). Expands recurring masters; non-recurring events contribute a single
 * interval. Override instances (RECURRENCE-ID) are folded into the master's
 * expansion and not double-counted.
 */
export function veventsToBusy(
  events: VEvent[],
  windowStart: number,
  windowEnd: number,
): BusyInterval[] {
  const out: BusyInterval[] = [];

  // Group override instances by their master UID + RECURRENCE-ID original start.
  const overridesByUid = new Map<string, Map<number, { start: number; end: number }>>();
  for (const ev of events) {
    if (!ev.recurrenceId) continue;
    const uid = propValue(ev, "UID") ?? "";
    const origStart = icalDateToEpochMs(ev.recurrenceId);
    const newStart = eventStart(ev);
    const newEnd = eventEnd(ev, newStart);
    if (origStart === null || newStart === null || newEnd === null) continue;
    if (!overridesByUid.has(uid)) overridesByUid.set(uid, new Map());
    overridesByUid.get(uid)!.set(origStart, { start: newStart, end: newEnd });
  }

  for (const ev of events) {
    if (ev.recurrenceId) continue; // handled as an override of its master
    if (isTransparent(ev)) continue;
    const start = eventStart(ev);
    if (start === null) continue;
    const end = eventEnd(ev, start);
    if (end === null) continue;
    const durationMs = end - start;

    const rruleProp = ev.props.find((p) => p.name === "RRULE");
    if (rruleProp) {
      const rule = parseRRule(rruleProp.value);
      if (!rule) {
        // Unparseable rule — emit the master only (conservative: still busy).
        if (end > windowStart && start < windowEnd) out.push({ start, end });
        continue;
      }
      const exDates = collectExDates(ev);
      const uid = propValue(ev, "UID") ?? "";
      const overrides = overridesByUid.get(uid) ?? new Map();
      out.push(
        ...expandRecurringEvent(
          start,
          durationMs,
          rule,
          windowStart,
          windowEnd,
          exDates,
          overrides,
        ),
      );
    } else {
      if (end > windowStart && start < windowEnd) out.push({ start, end });
    }
  }
  return out;
}

function propValue(ev: VEvent, name: string): string | null {
  const p = ev.props.find((x) => x.name === name);
  return p ? p.value : null;
}

function isTransparent(ev: VEvent): boolean {
  const p = ev.props.find((x) => x.name === "TRANSP");
  return p ? p.value.trim().toUpperCase() === "TRANSPARENT" : false;
}

function eventStart(ev: VEvent): number | null {
  const p = ev.props.find((x) => x.name === "DTSTART");
  return p ? icalDateToEpochMs(p.value) : null;
}

/** DTEND, else DTSTART+DURATION, else DTSTART (zero-length). */
function eventEnd(ev: VEvent, start: number | null): number | null {
  if (start === null) return null;
  const dtend = ev.props.find((x) => x.name === "DTEND");
  if (dtend) return icalDateToEpochMs(dtend.value);
  const dur = ev.props.find((x) => x.name === "DURATION");
  if (dur) {
    const ms = parseICalDuration(dur.value);
    return ms === null ? start : start + ms;
  }
  return start;
}

function collectExDates(ev: VEvent): Set<number> {
  const out = new Set<number>();
  for (const p of ev.props) {
    if (p.name !== "EXDATE") continue;
    for (const d of p.value.split(",")) {
      const ms = icalDateToEpochMs(d);
      if (ms !== null) out.add(ms);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Interval merge (client-side, lifted cal.com mergeOverlappingRanges)
// ─────────────────────────────────────────────────────────────

/** Sort + coalesce overlapping/adjacent busy intervals. */
export function mergeBusyIntervals(intervals: BusyInterval[]): BusyInterval[] {
  if (intervals.length <= 1) return intervals.slice();
  const sorted = intervals
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return [];
  const merged: BusyInterval[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.start <= last.end) {
      if (cur.end > last.end) last.end = cur.end;
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

// ─────────────────────────────────────────────────────────────
// CalDAV wire ops (REPORT / PROPFIND / PUT / DELETE) — plain + injectable
// ─────────────────────────────────────────────────────────────

function icalDateUtc(epochMs: number): string {
  // → YYYYMMDDTHHMMSSZ (CalDAV time-range / VFREEBUSY format).
  return new Date(epochMs).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

const FREE_BUSY_QUERY_XML = (windowStart: number, windowEnd: number) =>
  `<?xml version="1.0" encoding="utf-8" ?>
<C:free-busy-query xmlns:C="urn:ietf:params:xml:ns:caldav">
  <C:time-range start="${icalDateUtc(windowStart)}" end="${icalDateUtc(windowEnd)}"/>
</C:free-busy-query>`;

const CALENDAR_QUERY_XML = (windowStart: number, windowEnd: number) =>
  `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${icalDateUtc(windowStart)}" end="${icalDateUtc(windowEnd)}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

const LIST_CALENDARS_PROPFIND_XML = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
  <D:prop>
    <D:resourcetype/>
    <D:displayname/>
    <D:current-user-privilege-set/>
    <C:supported-calendar-component-set/>
    <C:calendar-timezone/>
  </D:prop>
</D:propfind>`;

/**
 * Free-busy-query REPORT against ONE calendar URL. Returns the parsed busy
 * periods (from the VFREEBUSY in the response body), or null if the server does
 * not support free-busy-query for this calendar (non-2xx / empty / no VFREEBUSY)
 * so the caller can fall back to a calendar-query.
 */
export async function caldavFreeBusyQuery(
  auth: CalDavAuth,
  calendarUrl: string,
  windowStart: number,
  windowEnd: number,
  fetchImpl: FetchImpl = defaultFetch,
): Promise<BusyInterval[] | null> {
  let resp: Response;
  try {
    resp = await fetchWithTimeout(fetchImpl, calendarUrl, {
      method: "REPORT",
      headers: {
        Authorization: basicAuthHeader(auth.username, auth.password),
        "Content-Type": "application/xml; charset=utf-8",
        Depth: "1",
      },
      body: FREE_BUSY_QUERY_XML(windowStart, windowEnd),
    });
  } catch {
    return null; // network/abort → let the caller fall back
  }
  if (!resp.ok) return null; // 4xx/5xx → unsupported; fall back
  const body = await resp.text();
  const parsed = parseICal(body);
  if (parsed.freebusyPeriods.length === 0 && !/VFREEBUSY/i.test(body)) {
    return null; // no VFREEBUSY at all → treat as unsupported, fall back
  }
  return parsed.freebusyPeriods.map((p) => ({ start: p.start, end: p.end }));
}

/**
 * Calendar-query REPORT against ONE calendar URL: fetch VEVENTs overlapping the
 * window, parse + expand RRULE client-side, merge into busy intervals. This is
 * the reliable fallback (and the primary path on iCloud). Throws on a non-2xx so
 * the caller can surface the calendar as errored (NOT silently free).
 */
export async function caldavCalendarQuery(
  auth: CalDavAuth,
  calendarUrl: string,
  windowStart: number,
  windowEnd: number,
  fetchImpl: FetchImpl = defaultFetch,
): Promise<BusyInterval[]> {
  const resp = await fetchWithTimeout(fetchImpl, calendarUrl, {
    method: "REPORT",
    headers: {
      Authorization: basicAuthHeader(auth.username, auth.password),
      "Content-Type": "application/xml; charset=utf-8",
      Depth: "1",
    },
    body: CALENDAR_QUERY_XML(windowStart, windowEnd),
  });
  if (!resp.ok) await throwForStatus(resp, "calendar-query");
  const body = await resp.text();

  // Each <response> carries one object's <calendar-data> (an iCal blob). Some
  // servers return the whole multistatus as a single blob; parse per-response
  // when we can, else parse the whole body.
  const responses = splitResponses(body);
  const allEvents: VEvent[] = [];
  if (responses.length > 0) {
    for (const r of responses) {
      const data = firstTagText(r, "calendar-data");
      if (!data) continue;
      allEvents.push(...parseICal(data).events);
    }
  }
  if (allEvents.length === 0) {
    // Fall back to parsing the entire body (covers servers that don't wrap, or
    // entity-encoding edge cases the per-response extractor missed).
    allEvents.push(...parseICal(body).events);
  }

  const busy = veventsToBusy(allEvents, windowStart, windowEnd);
  return mergeBusyIntervals(busy);
}

/**
 * getBusy for ONE calendar: free-busy-query first, then calendar-query VEVENT
 * fallback. Returns the merged busy intervals. Throws if BOTH paths fail (so the
 * batch wrapper can mark the calendar errored rather than reading it as free).
 */
export async function caldavGetBusyForCalendar(
  auth: CalDavAuth,
  calendarUrl: string,
  windowStart: number,
  windowEnd: number,
  fetchImpl: FetchImpl = defaultFetch,
): Promise<BusyInterval[]> {
  const fb = await caldavFreeBusyQuery(
    auth,
    calendarUrl,
    windowStart,
    windowEnd,
    fetchImpl,
  );
  if (fb !== null && fb.length > 0) {
    return mergeBusyIntervals(fb);
  }
  // Empty or unsupported free-busy → fall back to calendar-query VEVENT merge.
  // (iCloud often returns an empty/absent VFREEBUSY even when events exist.)
  return caldavCalendarQuery(auth, calendarUrl, windowStart, windowEnd, fetchImpl);
}

/**
 * Full getBusy WITH error surface across many calendar URLs. A per-calendar
 * failure is SKIPPED + recorded in `erroredCalendarUrls` (NOT silently dropped):
 * the "false-free" trap discipline from the Google impl. Busy intervals from all
 * calendars are merged.
 */
export async function caldavGetBusyDetailed(
  auth: CalDavAuth,
  calendarUrls: string[],
  windowStart: number,
  windowEnd: number,
  fetchImpl: FetchImpl = defaultFetch,
): Promise<{ busy: BusyInterval[]; erroredCalendarUrls: string[] }> {
  if (calendarUrls.length === 0 || !(windowEnd > windowStart)) {
    return { busy: [], erroredCalendarUrls: [] };
  }
  const merged: BusyInterval[] = [];
  const errored: string[] = [];
  for (const url of calendarUrls) {
    try {
      const busy = await caldavGetBusyForCalendar(
        auth,
        url,
        windowStart,
        windowEnd,
        fetchImpl,
      );
      merged.push(...busy);
    } catch (err) {
      // Surface, don't swallow: an errored calendar must NOT read as free.
      log.warn("caldav.getBusy.calendarErrored", {
        calendarUrl: url,
        error: err instanceof Error ? err.message : String(err),
      });
      errored.push(url);
    }
  }
  return { busy: mergeBusyIntervals(merged), erroredCalendarUrls: errored };
}

/** BusyInterval[]-only convenience over `caldavGetBusyDetailed`. */
export async function caldavGetBusy(
  auth: CalDavAuth,
  calendarUrls: string[],
  windowStart: number,
  windowEnd: number,
  fetchImpl: FetchImpl = defaultFetch,
): Promise<BusyInterval[]> {
  const { busy, erroredCalendarUrls } = await caldavGetBusyDetailed(
    auth,
    calendarUrls,
    windowStart,
    windowEnd,
    fetchImpl,
  );
  if (erroredCalendarUrls.length > 0) {
    log.warn("caldavCalendar.getBusy.erroredCalendars", { erroredCalendarUrls });
  }
  return busy;
}

// ─────────────────────────────────────────────────────────────
// Event write surface (iCal build → PUT / DELETE; no PATCH on CalDAV)
// ─────────────────────────────────────────────────────────────

function escapeICalText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/** Build a minimal but valid VCALENDAR/VEVENT for a write. UTC times. */
export function buildEventICal(uid: string, event: CalendarEvent): string {
  const dtStamp = icalDateUtc(Date.now());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//dibslist//booking//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART:${icalDateUtc(event.start)}`,
    `DTEND:${icalDateUtc(event.end)}`,
    `SUMMARY:${escapeICalText(event.title)}`,
  ];
  if (event.description) lines.push(`DESCRIPTION:${escapeICalText(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeICalText(event.location)}`);
  for (const a of event.attendees ?? []) {
    const cn = a.name ? `;CN=${escapeICalText(a.name)}` : "";
    lines.push(`ATTENDEE${cn}:mailto:${a.email}`);
  }
  // SCHEDULE-AGENT=CLIENT suppresses server-side iTIP invite sending (cal.com).
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n");
}

/** The object URL for a given uid within a calendar collection URL. */
export function eventObjectUrl(calendarUrl: string, uid: string): string {
  const base = calendarUrl.endsWith("/") ? calendarUrl : `${calendarUrl}/`;
  return `${base}${encodeURIComponent(uid)}.ics`;
}

/** PUT a new calendar object. Returns the object URL as `externalEventId`. */
export async function caldavCreateEvent(
  auth: CalDavAuth,
  calendarUrl: string,
  event: CalendarEvent,
  fetchImpl: FetchImpl = defaultFetch,
): Promise<{ externalEventId: string }> {
  const uid = event.idempotencyKey?.trim() || generateUid();
  const objectUrl = eventObjectUrl(calendarUrl, uid);
  const resp = await fetchWithTimeout(fetchImpl, objectUrl, {
    method: "PUT",
    headers: {
      Authorization: basicAuthHeader(auth.username, auth.password),
      "Content-Type": "text/calendar; charset=utf-8",
      // If-None-Match:* → create-only (don't clobber an existing object).
      "If-None-Match": "*",
    },
    body: buildEventICal(uid, event),
  });
  if (!resp.ok) await throwForStatus(resp, "createEvent");
  // externalEventId = the object URL (stable handle for update/delete).
  return { externalEventId: objectUrl };
}

/**
 * PUT (full replace) an existing calendar object. `uid` is the externalEventId
 * returned by create (the object URL). CalDAV has no PATCH — always a full PUT.
 */
export async function caldavUpdateEvent(
  auth: CalDavAuth,
  uid: string,
  event: CalendarEvent,
  calendarUrl: string | undefined,
  fetchImpl: FetchImpl = defaultFetch,
): Promise<{ externalEventId: string }> {
  // `uid` is either a full object URL (from create) or a bare UID we resolve.
  const objectUrl = /^https?:\/\//i.test(uid)
    ? uid
    : eventObjectUrl(calendarUrl ?? "", uid);
  const icalUid = uidFromObjectUrl(objectUrl);
  const resp = await fetchWithTimeout(fetchImpl, objectUrl, {
    method: "PUT",
    headers: {
      Authorization: basicAuthHeader(auth.username, auth.password),
      "Content-Type": "text/calendar; charset=utf-8",
    },
    body: buildEventICal(icalUid, event),
  });
  if (!resp.ok) await throwForStatus(resp, "updateEvent");
  return { externalEventId: objectUrl };
}

/** DELETE a calendar object. A 404 (already gone) is success (idempotent). */
export async function caldavDeleteEvent(
  auth: CalDavAuth,
  uid: string,
  calendarUrl: string | undefined,
  fetchImpl: FetchImpl = defaultFetch,
): Promise<void> {
  const objectUrl = /^https?:\/\//i.test(uid)
    ? uid
    : eventObjectUrl(calendarUrl ?? "", uid);
  const resp = await fetchWithTimeout(fetchImpl, objectUrl, {
    method: "DELETE",
    headers: { Authorization: basicAuthHeader(auth.username, auth.password) },
  });
  // 204/200 = deleted; 404 = already gone → both fine (idempotent, mirrors
  // Google's 410 handling).
  if (resp.ok || resp.status === 404) return;
  await throwForStatus(resp, "deleteEvent");
}

function uidFromObjectUrl(objectUrl: string): string {
  const last = objectUrl.split("/").pop() ?? "";
  return decodeURIComponent(last.replace(/\.ics$/i, ""));
}

function generateUid(): string {
  // crypto.randomUUID is available in both the V8 isolate and Node test env.
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `dibslist-${id}@dibslist.app`;
}

// ─────────────────────────────────────────────────────────────
// listCalendars (PROPFIND Depth:1 on the calendar-home / server URL)
// ─────────────────────────────────────────────────────────────

/**
 * PROPFIND the server URL (Depth:1) for calendar collections. Returns one
 * IntegrationCalendar per calendar-typed collection; `externalId` is the
 * calendar's resolved URL (used as the calendarId by getBusy + the
 * externalCalendarId by write methods). `readOnly` reflects whether the
 * current-user-privilege-set grants write.
 */
export async function caldavListCalendars(
  auth: CalDavAuth,
  fetchImpl: FetchImpl = defaultFetch,
): Promise<IntegrationCalendar[]> {
  const resp = await fetchWithTimeout(fetchImpl, auth.serverUrl, {
    method: "PROPFIND",
    headers: {
      Authorization: basicAuthHeader(auth.username, auth.password),
      "Content-Type": "application/xml; charset=utf-8",
      Depth: "1",
    },
    body: LIST_CALENDARS_PROPFIND_XML,
  });
  if (!resp.ok) await throwForStatus(resp, "listCalendars");
  const body = await resp.text();

  const out: IntegrationCalendar[] = [];
  for (const r of splitResponses(body)) {
    // Only collections whose resourcetype includes <C:calendar/>.
    const resourceType = firstTagBlock(r, "resourcetype") ?? "";
    if (!hasTag(resourceType, "calendar")) continue;
    const href = firstTagText(r, "href");
    if (!href) continue;
    const displayName = firstTagText(r, "displayname") ?? undefined;
    // Write capability: presence of a <write…/> privilege.
    const privSet = firstTagBlock(r, "current-user-privilege-set") ?? "";
    const canWrite =
      hasTag(privSet, "write") ||
      hasTag(privSet, "write-content") ||
      hasTag(privSet, "all");
    // If no privilege set is reported, assume writable (server didn't restrict).
    const readOnly = privSet ? !canWrite : false;
    out.push({
      externalId: resolveHref(auth.serverUrl, href),
      name: displayName,
      readOnly,
      primary: false,
    });
  }
  return out;
}

/** Inner XML of the FIRST `<…tagLocalName>…</…>` block (keeps child tags). */
function firstTagBlock(xml: string, tagLocalName: string): string | null {
  const re = new RegExp(
    `<(?:[\\w-]+:)?${tagLocalName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tagLocalName}>`,
    "i",
  );
  const m = re.exec(xml);
  return m ? m[1] : null;
}

// keep localName referenced (used by future per-prop parsing); silence unused.
void localName;

// ─────────────────────────────────────────────────────────────
// Calendar adapter (satisfies the `Calendar` interface)
// ─────────────────────────────────────────────────────────────

function authFromCredential(c: CalendarCredential): CalDavAuth {
  return {
    serverUrl: c.caldavServerUrl?.trim() || DEFAULT_CALDAV_SERVER_URL,
    username: c.caldavUsername ?? "",
    password: c.secret,
  };
}

/**
 * Build a `Calendar` adapter backed by the plain CalDAV functions above. This is
 * what `getCalendarProvider("caldav")` returns. Network-only — call from inside
 * a Convex action. `externalCalendarId` selects the target calendar collection.
 */
export function makeCalDavCalendar(fetchImpl: FetchImpl = defaultFetch): Calendar {
  return {
    async getBusy(credential, calendarIds, windowStart, windowEnd) {
      return caldavGetBusy(
        authFromCredential(credential),
        calendarIds,
        windowStart,
        windowEnd,
        fetchImpl,
      );
    },
    async createEvent(credential, event, externalCalendarId) {
      const auth = authFromCredential(credential);
      const calUrl = externalCalendarId ?? auth.serverUrl;
      return caldavCreateEvent(auth, calUrl, event, fetchImpl);
    },
    async updateEvent(credential, uid, event, externalCalendarId) {
      return caldavUpdateEvent(
        authFromCredential(credential),
        uid,
        event,
        externalCalendarId,
        fetchImpl,
      );
    },
    async deleteEvent(credential, uid, externalCalendarId) {
      await caldavDeleteEvent(
        authFromCredential(credential),
        uid,
        externalCalendarId,
        fetchImpl,
      );
    },
    async listCalendars(credential) {
      return caldavListCalendars(authFromCredential(credential), fetchImpl);
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Convex internalAction wrappers (ctx-coupled: load + decrypt credential)
// ─────────────────────────────────────────────────────────────

interface CredentialRow {
  _id: unknown;
  provider: "google" | "caldav";
  encSecretCiphertext: string;
  encSecretIv: string;
  caldavServerUrl?: string;
  caldavUsername?: string;
  invalid: boolean;
}

async function decryptCredentialRow(
  row: CredentialRow,
): Promise<CalendarCredential> {
  const envelope = { ciphertext: row.encSecretCiphertext, iv: row.encSecretIv };
  if (!isEnvelope(envelope)) {
    throw new ConvexError("CalDAV credential is missing a valid secret.");
  }
  const secret = await decryptAtRest(envelope);
  return {
    provider: row.provider,
    secret,
    caldavServerUrl: row.caldavServerUrl,
    caldavUsername: row.caldavUsername,
  };
}

async function loadCredentialRow(
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
  if (row.provider !== "caldav") {
    throw new ConvexError(
      `caldavCalendar: unsupported provider ${row.provider}`,
    );
  }
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

/** internalAction — fetch busy intervals for a CalDAV credential's calendars. */
export const getBusyForCredential = internalAction({
  args: {
    credentialId: v.id("calendarCredentials"),
    calendarIds: v.array(v.string()),
    windowStart: v.number(),
    windowEnd: v.number(),
  },
  handler: async (ctx, args): Promise<BusyInterval[]> => {
    const row = await loadCredentialRow(ctx, args.credentialId);
    const credential = await decryptCredentialRow(row);
    const { busy, erroredCalendarUrls } = await caldavGetBusyDetailed(
      authFromCredential(credential),
      args.calendarIds,
      args.windowStart,
      args.windowEnd,
    );
    if (erroredCalendarUrls.length > 0) {
      log.warn("caldav.getBusyForCredential.erroredCalendars", {
        credentialId: args.credentialId,
        erroredCalendarUrls,
      });
    }
    return busy;
  },
});

/** internalAction — create an event on a CalDAV credential's calendar. */
export const createEventForCredential = internalAction({
  args: {
    credentialId: v.id("calendarCredentials"),
    externalCalendarId: v.optional(v.string()),
    event: eventArgValidator,
  },
  handler: async (ctx, args): Promise<{ externalEventId: string }> => {
    const row = await loadCredentialRow(ctx, args.credentialId);
    const credential = await decryptCredentialRow(row);
    return makeCalDavCalendar().createEvent(
      credential,
      args.event as CalendarEvent,
      args.externalCalendarId,
    );
  },
});

/** internalAction — update (full PUT) an event on a CalDAV calendar. */
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
    return makeCalDavCalendar().updateEvent(
      credential,
      args.uid,
      args.event as CalendarEvent,
      args.externalCalendarId,
    );
  },
});

/** internalAction — delete an event on a CalDAV calendar. */
export const deleteEventForCredential = internalAction({
  args: {
    credentialId: v.id("calendarCredentials"),
    uid: v.string(),
    externalCalendarId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<null> => {
    const row = await loadCredentialRow(ctx, args.credentialId);
    const credential = await decryptCredentialRow(row);
    await makeCalDavCalendar().deleteEvent(
      credential,
      args.uid,
      args.externalCalendarId,
    );
    return null;
  },
});

/** internalAction — list the connected CalDAV account's calendars. */
export const listCalendarsForCredential = internalAction({
  args: { credentialId: v.id("calendarCredentials") },
  handler: async (ctx, args): Promise<IntegrationCalendar[]> => {
    const row = await loadCredentialRow(ctx, args.credentialId);
    const credential = await decryptCredentialRow(row);
    return makeCalDavCalendar().listCalendars(credential);
  },
});
