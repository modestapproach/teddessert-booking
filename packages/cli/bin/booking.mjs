#!/usr/bin/env node
// `booking` — CLI over the admin MCP endpoint (convex/adminMcp.ts).
//
// It speaks the 2026-07-28 Streamable HTTP shape (one POST per call, mirrored
// Mcp-Method / Mcp-Name headers, no handshake) so the CLI doubles as a live
// conformance check of the server. Every subcommand is a thin wrapper over
// one MCP tool; `booking call <tool> [json]` reaches anything else.
//
// Config: BOOKING_MCP_URL and BOOKING_API_KEY from the environment or from
// the first of ./.env.agent, ~/.openclaw/credentials/booking.env.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const PROTOCOL_VERSION = "2026-07-28";

function loadEnv() {
  const env = { ...process.env };
  for (const file of [resolve(".env.agent"), resolve(homedir(), ".openclaw/credentials/booking.env")]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2];
    }
    break;
  }
  return env;
}

const ENV = loadEnv();
const URL_ = ENV.BOOKING_MCP_URL;
const KEY = ENV.BOOKING_API_KEY;

async function rpc(method, params = {}, { name } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
    "mcp-method": method,
  };
  if (name) headers["mcp-name"] = name;
  if (KEY) headers.authorization = `Bearer ${KEY}`;
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method,
    params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION, "io.modelcontextprotocol/clientInfo": { name: "booking-cli", version: "0.1.0" } } },
  };
  const res = await fetch(URL_, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (json.error) throw new Error(`${json.error.message} (code ${json.error.code}${json.error.data ? ", " + JSON.stringify(json.error.data) : ""})`);
  return json.result;
}

async function callTool(name, args) {
  const result = await rpc("tools/call", { name, arguments: args }, { name });
  const text = result.content?.map((c) => c.text ?? "").join("\n") ?? "";
  if (result.isError) throw new Error(text);
  return result.structuredContent ?? safeParse(text);
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ─── argument helpers ────────────────────────────────────────────────────────

// `--key value` / `--key=value` / `--flag` → object; values that parse as JSON
// (numbers, booleans, arrays, objects) are decoded so `--days [1,2]` works.
function parseFlags(argv) {
  const out = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      rest.push(a);
      continue;
    }
    let [key, val] = a.slice(2).split(/=(.*)/s);
    if (val === undefined) {
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) val = argv[++i];
      else val = "true";
    }
    out[camel(key)] = decode(val);
  }
  return { flags: out, rest };
}
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
function decode(v) {
  if (/^(true|false|null|-?\d+(\.\d+)?|\[.*\]|\{.*\})$/s.test(v)) {
    try {
      return JSON.parse(v);
    } catch {
      /* keep string */
    }
  }
  return v;
}

// "9:00" / "9am" / "17:30" → minutes from midnight.
function toMinutes(s) {
  if (typeof s === "number") return s;
  const m = String(s).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) throw new Error(`Bad time "${s}"; use 9:00, 9am, 17:30`);
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return h * 60 + min;
}
const DAY = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
// "mon-fri", "mon,wed,fri", "weekdays", "1,2,3"
function toDays(s) {
  if (Array.isArray(s)) return s;
  const t = String(s).toLowerCase();
  if (t === "weekdays") return [1, 2, 3, 4, 5];
  if (t === "weekend") return [0, 6];
  const range = t.match(/^([a-z]{3})-([a-z]{3})$/);
  if (range) {
    const a = DAY[range[1]], b = DAY[range[2]];
    const days = [];
    for (let d = a; ; d = (d + 1) % 7) {
      days.push(d);
      if (d === b) break;
    }
    return days;
  }
  return t.split(",").map((x) => (x in DAY ? DAY[x] : Number(x)));
}
function refArgs(flags) {
  const out = {};
  if (flags.id !== undefined) out.id = String(flags.id);
  if (flags.calId !== undefined) out.calEventTypeId = Number(flags.calId);
  if (flags.slug !== undefined) out.slug = flags.slug;
  return out;
}
function scheduleRef(flags) {
  const out = {};
  if (flags.id !== undefined) out.scheduleId = String(flags.id);
  if (flags.calId !== undefined) out.calScheduleId = Number(flags.calId);
  return out;
}

// ─── commands ────────────────────────────────────────────────────────────────

const COMMANDS = {
  "tools": async () => (await rpc("tools/list")).tools.map((t) => `${t.name.padEnd(28)} ${t.description.split(". ")[0]}`).join("\n"),
  "call": async (rest, flags) => callTool(rest[0], rest[1] ? JSON.parse(rest[1]) : flags),

  "event-types list": (_r, f) => callTool("list_event_types", f.activeOnly ? { activeOnly: true } : {}),
  "event-types get": (_r, f) => callTool("get_event_type", refArgs(f)),
  "event-types create": (_r, f) => callTool("create_event_type", f),
  "event-types update": (_r, f) => callTool("update_event_type", { ...refArgs(f), ...omit(f, ["id", "calId", "slug"]), ...(f.slug && (f.id || f.calId) ? { slug: f.slug } : {}) }),
  "event-types delete": (_r, f) => callTool("delete_event_type", refArgs(f)),
  "event-types duplicate": (_r, f) => callTool("duplicate_event_type", { ...refArgs({ id: f.id, calId: f.calId }), slug: f.slug, title: f.title, description: f.description, durationMinutes: f.durationMinutes }),

  "schedules list": () => callTool("list_schedules", {}),
  "schedules get": (_r, f) => callTool("get_schedule", scheduleRef(f)),
  "schedules create": (_r, f) => callTool("create_schedule", { name: f.name, timeZone: f.timeZone ?? f.tz, isDefault: f.default ?? f.isDefault }),
  "schedules update": (_r, f) => callTool("update_schedule", { ...scheduleRef(f), ...pick(f, ["name", "timeZone", "isDefault"]) }),
  "schedules delete": (_r, f) => callTool("delete_schedule", scheduleRef(f)),
  // booking availability set --cal-id 1 --days mon-fri --from 9:00 --to 17:00 [--days sat --from 10am --to 1pm ...]
  "availability set": (rest, f, raw) => {
    const windows = [];
    let cur = null;
    for (let i = 0; i < raw.length; i++) {
      const a = raw[i];
      if (a === "--days") { cur = { days: toDays(raw[++i]) }; windows.push(cur); }
      else if (a === "--from" && cur) cur.startMinute = toMinutes(raw[++i]);
      else if (a === "--to" && cur) cur.endMinute = toMinutes(raw[++i]);
    }
    if (f.windows) windows.push(...f.windows);
    if (!windows.length) throw new Error("give at least one --days <mon-fri> --from <9:00> --to <17:00>");
    return callTool("set_weekly_availability", { ...scheduleRef(f), windows });
  },
  // booking availability block --cal-id 1 --date 2026-09-20 [--from 13:00 --to 17:00]
  "availability block": (_r, f) => {
    const dateUtc = Date.UTC(...String(f.date).split("-").map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))));
    const args = { ...scheduleRef(f), dateUtc };
    if (f.from !== undefined) args.startMinute = toMinutes(f.from);
    if (f.to !== undefined) args.endMinute = toMinutes(f.to);
    return callTool("add_date_override", args);
  },
  "availability unblock": (_r, f) => callTool("remove_date_override", { id: String(f.id) }),

  "bookings list": (_r, f) => callTool("list_bookings", { status: f.status ?? "upcoming", ...pick(f, ["after", "before", "limit", "cursor"]) }),
  "bookings cancel": (_r, f) => callTool("cancel_booking", { bookingId: String(f.id), ...pick(f, ["reason"]) }),
  "bookings reschedule": (_r, f) => callTool("reschedule_booking", { oldBookingId: String(f.id), newStartTime: ms(f.start), newEndTime: ms(f.end), newBookerTimeZone: f.tz ?? f.newBookerTimeZone, attendee: { name: f.name, email: f.email, timeZone: f.attendeeTz ?? f.tz, ...(f.notes ? { notes: f.notes } : {}) }, ...pick(f, ["idempotencyKey"]) }),

  "calendars list": () => callTool("list_connected_calendars", {}),
  "calendars destination": (_r, f) => callTool("set_destination_calendar", { externalCalendarId: f.calendar, ...pick(f, ["provider"]) }),
  "calendars conflicts": (_r, f) => callTool("set_calendar_conflict_flag", { externalCalendarId: f.calendar, checkForConflicts: f.check !== false, ...pick(f, ["credentialId", "calCredentialId"]) }),
  "calendars disconnect": (_r, f) => callTool("disconnect_calendar", pick(f, ["credentialId", "calCredentialId"])),

  "profile get": () => callTool("get_profile", {}),
  "profile update": (_r, f) => callTool("update_profile", f),
};

function pick(o, keys) {
  const out = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}
function omit(o, keys) {
  const out = { ...o };
  for (const k of keys) delete out[k];
  return out;
}
const ms = (v) => (typeof v === "number" ? v : Date.parse(v));

const USAGE = `booking — admin CLI for book.teddessert.com (talks to the admin MCP)

  booking tools                                   list MCP tools
  booking call <tool> ['{"json":"args"}' | --flags]

  booking event-types list [--active-only]
  booking event-types get --slug intro | --cal-id 3 | --id <convexId>
  booking event-types create --slug intro --title "Intro chat" --duration-minutes 30 [--hidden true ...]
  booking event-types update --cal-id 3 --duration-minutes 20 --location-text "Google Meet"
  booking event-types delete --cal-id 3
  booking event-types duplicate --cal-id 3 --slug intro-45 --title "Intro (45 min)"

  booking schedules list | get --cal-id 1 | create --name "Working hours" --tz America/Los_Angeles [--default true]
  booking availability set --cal-id 1 --days mon-fri --from 9:00 --to 17:00 [--days sat --from 10am --to 1pm]
  booking availability block --cal-id 1 --date 2026-09-20 [--from 13:00 --to 17:00]
  booking availability unblock --id <dateOverrideId>

  booking bookings list [--status upcoming|past|cancelled|unconfirmed] [--limit 25] [--cursor ...]
  booking bookings cancel --id <bookingId> [--reason "..."]
  booking bookings reschedule --id <bookingId> --start 2026-09-20T17:00:00Z --end 2026-09-20T17:30:00Z --tz America/Los_Angeles --name "Ada" --email ada@example.com

  booking calendars list | destination --calendar <externalId> [--provider google] | conflicts --calendar <id> --check true|false | disconnect --cal-credential-id 1
  booking profile get | update --time-zone America/Los_Angeles --bio "..."

Env: BOOKING_MCP_URL, BOOKING_API_KEY (or ./.env.agent, ~/.openclaw/credentials/booking.env)`;

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    console.log(USAGE);
    return;
  }
  if (!URL_ || !KEY) throw new Error("BOOKING_MCP_URL and BOOKING_API_KEY are required (env, ./.env.agent or ~/.openclaw/credentials/booking.env)");
  const two = argv.slice(0, 2).join(" ");
  const cmd = COMMANDS[two] ? two : COMMANDS[argv[0]] ? argv[0] : null;
  if (!cmd) throw new Error(`Unknown command "${argv.slice(0, 2).join(" ")}". Run booking --help.`);
  const raw = argv.slice(cmd.split(" ").length);
  const { flags, rest } = parseFlags(raw);
  const result = await COMMANDS[cmd](rest, flags, raw);
  console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
