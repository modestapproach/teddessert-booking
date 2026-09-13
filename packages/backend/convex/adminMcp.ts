// ─── Admin MCP (owner-side Model Context Protocol over a Convex httpAction) ────
//
// A STATELESS Streamable-HTTP MCP server that lets an agent (openclaw, Claude
// Code, ...) administer the booking site: event types, schedules and weekly
// availability, date overrides, bookings, connected calendars, and the owner
// profile. It is the owner-side sibling of the booker-side `/book/mcp` server
// in scheduling/publicApi.ts and follows the same shape: every tool routes to
// the SAME admin functions the Cal.com UI calls (scheduling/calcomAdmin.ts,
// scheduling/bookingAdmin.ts, scheduling/calcomUsers.ts), so the MCP ships with
// the deployment at `<deployment>.convex.site/admin/mcp` and there is no second
// data path to keep in sync.
//
// AUTH BOUNDARY. The admin functions are ordinary public Convex functions that
// take `ownerAuthUserId` as an argument (see _helpers/auth.ts: single owner,
// no user table). This endpoint is therefore the only place that authenticates
// an agent: every tool requires `Authorization: Bearer <key>` where the key is
// a row in `apiKeys` (minted with scheduling/publicApi:_mintAgentKey) carrying
// the scope `admin:read` (queries) or `admin:write` (mutations). The owner id
// is taken from the key, never from the agent's arguments.
//
// PROTOCOL ERAS. Two client generations exist and both are accepted:
//   * 2026-07-28 ("MCP 2.0"): no initialize handshake, no sessions; every POST
//     carries `MCP-Protocol-Version`, `Mcp-Method` and (for tools/call)
//     `Mcp-Name` headers mirrored from the body, which the server MUST
//     validate (400 / -32020 HeaderMismatch on mismatch). Unknown method →
//     404 / -32601. GET/DELETE → 405.
//   * 2025-03-26 … 2025-11-25 (e.g. openclaw's @modelcontextprotocol/sdk 1.x
//     client): initialize handshake, notifications answered with 202,
//     `Mcp-Session-Id` ignored (we never mint one). Responses are always a
//     single JSON object — no SSE, no server-initiated messages.
import { ConvexError } from "convex/values";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { corsHeaders } from "./extensionAuth";
import { sha256Hex as hashApiKey } from "./_helpers/apiSecrets";
import { getOrMintRequestId, withRequestId } from "./_helpers/requestId";
import { log } from "./_helpers/log";

export const ADMIN_MCP_PROTOCOL_VERSION = "2026-07-28";
const SUPPORTED_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER_INFO = { name: "teddessert-booking-admin", version: "1.0.0" };
const INSTRUCTIONS =
  "Owner-side admin tools for the teddessert booking site (Cal.com fork on Convex). " +
  "Read tools need the admin:read scope, write tools admin:write. Times are millisecond epoch " +
  "timestamps; weekly availability windows are minutes from midnight in the schedule's time zone " +
  "(days: 0=Sunday … 6=Saturday). Event types and schedules can be addressed by their Convex `id` " +
  "or by the Cal.com integer id (`calEventTypeId` / `calScheduleId`) shown in the UI. Every mutating " +
  "tool returns the resulting record so you can verify the change. Nothing here contacts bookers.";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any>;

interface AdminTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  scope: "admin:read" | "admin:write";
  call: (ctx: Ctx, args: Args, owner: string) => Promise<unknown>;
}

// ─── JSON-schema fragments shared by several tools ────────────────────────────

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const int = (description: string) => ({ type: "integer", description });
const bool = (description: string) => ({ type: "boolean", description });

const EVENT_TYPE_REF = {
  id: str("Convex id of the event type (from list_event_types)."),
  calEventTypeId: int("Cal.com integer id of the event type (shown in the UI URL). Use this or `id`."),
};
const SCHEDULE_REF = {
  scheduleId: str("Convex id of the schedule (from list_schedules)."),
  calScheduleId: int("Cal.com integer id of the schedule. Use this or `scheduleId`."),
};
const SCHEDULING_TYPE = {
  type: "string",
  enum: ["collective", "round_robin", "managed"],
  description: "Cal.com scheduling type. Single-owner sites use `collective`.",
};
const WINDOW = {
  type: "object",
  properties: {
    days: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 }, description: "Weekdays this window applies to: 0=Sunday … 6=Saturday." },
    startMinute: int("Start of the window in minutes after midnight (schedule time zone). 540 = 09:00."),
    endMinute: int("End of the window in minutes after midnight, exclusive. 1020 = 17:00."),
  },
  required: ["days", "startMinute", "endMinute"],
};
const EVENT_TYPE_FIELDS = {
  slug: str("URL slug, e.g. `intro` → book.teddessert.com/ted/intro. Lowercase, hyphens."),
  title: str("Display title."),
  description: str("Description shown to bookers (markdown ok)."),
  durationMinutes: int("Meeting length in minutes."),
  schedulingType: SCHEDULING_TYPE,
  scheduleId: str("Convex id of the schedule that provides availability (defaults to the owner's default schedule)."),
  calScheduleId: int("Cal.com integer id of the schedule; alternative to `scheduleId`."),
  slotIntervalMinutes: int("Slot start interval in minutes (default: the duration)."),
  minimumBookingNoticeMinutes: int("Minimum notice before a slot can be booked, in minutes."),
  bufferBeforeMinutes: int("Buffer before each booking, minutes."),
  bufferAfterMinutes: int("Buffer after each booking, minutes."),
  bookingWindowDays: int("How many days into the future bookers may book."),
  dailyBookingLimit: int("Max bookings per day for this event type."),
  requireEmailVerification: bool("Require bookers to verify their email."),
  hidden: bool("Hide from the public profile page (direct link still works)."),
  locationText: str("Where the meeting happens (e.g. 'Google Meet', a phone number, an address)."),
  active: bool("Inactive event types cannot be booked."),
};

// ─── Convex function references ───────────────────────────────────────────────
// Typed `api`/`internal` come from codegen; the `any` hop matches the sibling
// publicApi.ts convention so a stale _generated never blocks typecheck.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const calAdmin = (api as any).scheduling.calcomAdmin;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bookingAdmin = (api as any).scheduling.bookingAdmin;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const calUsers = (api as any).scheduling.calcomUsers;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const publicRefs = (internal as any).scheduling.publicApi;

// Copies only the args the Convex validator accepts, dropping undefined, so an
// agent that passes extra keys gets a clean validator error instead of a crash.
function pick(args: Args, keys: string[]): Args {
  const out: Args = {};
  for (const k of keys) if (args[k] !== undefined) out[k] = args[k];
  return out;
}

async function getEventType(ctx: Ctx, owner: string, args: Args) {
  if (args.slug && !args.id && !args.calEventTypeId) {
    return ctx.runQuery(calAdmin.adminGetEventTypeBySlug, { ownerAuthUserId: owner, slug: args.slug });
  }
  return ctx.runQuery(calAdmin.adminGetEventType, { ownerAuthUserId: owner, ...pick(args, ["id", "calEventTypeId"]) });
}

async function getSchedule(ctx: Ctx, owner: string, args: Args) {
  return ctx.runQuery(calAdmin.adminGetSchedule, {
    ownerAuthUserId: owner,
    ...(args.scheduleId ? { id: args.scheduleId } : {}),
    ...pick(args, ["calScheduleId"]),
  });
}

// ─── Tool catalog ─────────────────────────────────────────────────────────────

export const ADMIN_MCP_TOOLS: AdminTool[] = [
  // Event types ---------------------------------------------------------------
  {
    name: "list_event_types",
    description: "List the owner's event types (bookable meeting kinds) with slug, duration, schedule, hidden/active flags and Cal.com ids.",
    inputSchema: { type: "object", properties: { activeOnly: bool("Only return active event types.") } },
    scope: "admin:read",
    call: (ctx, args, owner) => ctx.runQuery(calAdmin.adminListEventTypes, { ownerAuthUserId: owner, ...pick(args, ["activeOnly"]) }),
  },
  {
    name: "get_event_type",
    description: "Fetch one event type by Convex id, Cal.com integer id, or slug.",
    inputSchema: { type: "object", properties: { ...EVENT_TYPE_REF, slug: str("Slug, e.g. `intro`.") } },
    scope: "admin:read",
    call: (ctx, args, owner) => getEventType(ctx, owner, args),
  },
  {
    name: "create_event_type",
    description: "Create a new event type. Required: slug, title, durationMinutes. Sensible defaults: collective, 120 min notice, no buffers, visible, active. Returns the created record.",
    inputSchema: { type: "object", properties: EVENT_TYPE_FIELDS, required: ["slug", "title", "durationMinutes"] },
    scope: "admin:write",
    call: async (ctx, args, owner) => {
      const input = {
        ownerAuthUserId: owner,
        schedulingType: "collective",
        minimumBookingNoticeMinutes: 120,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        requireEmailVerification: false,
        hidden: false,
        active: true,
        ...pick(args, Object.keys(EVENT_TYPE_FIELDS)),
      };
      await ctx.runMutation(calAdmin.adminCreateEventType, input);
      return ctx.runQuery(calAdmin.adminGetEventTypeBySlug, { ownerAuthUserId: owner, slug: args.slug });
    },
  },
  {
    name: "update_event_type",
    description: "Update fields on an event type (only the fields you pass change). Address it by `id` or `calEventTypeId`. Returns the updated record.",
    inputSchema: {
      type: "object",
      properties: {
        ...EVENT_TYPE_REF,
        ...EVENT_TYPE_FIELDS,
        seatsPerSlot: int("Seats per slot for group events."),
        interactionMode: { type: "string", enum: ["lottery", "first_come", "application", "threshold", "pair", "none"], description: "Booking interaction mode (advanced)." },
        lotteryCloseLeadMinutes: int("Lottery mode: close entries this many minutes before the slot."),
        thresholdMinAttendees: int("Threshold mode: minimum attendees for the slot to go ahead."),
      },
    },
    scope: "admin:write",
    call: async (ctx, args, owner) => {
      const keys = ["id", "calEventTypeId", ...Object.keys(EVENT_TYPE_FIELDS), "seatsPerSlot", "interactionMode", "lotteryCloseLeadMinutes", "thresholdMinAttendees"];
      await ctx.runMutation(calAdmin.adminUpdateEventType, { ownerAuthUserId: owner, ...pick(args, keys) });
      return getEventType(ctx, owner, args);
    },
  },
  {
    name: "delete_event_type",
    description: "Retire an event type (soft delete: it becomes inactive and unbookable; existing bookings are kept). Address by `id` or `calEventTypeId`.",
    inputSchema: { type: "object", properties: EVENT_TYPE_REF },
    scope: "admin:write",
    call: async (ctx, args, owner) => {
      await ctx.runMutation(calAdmin.adminDeleteEventType, { ownerAuthUserId: owner, ...pick(args, ["id", "calEventTypeId"]) });
      return getEventType(ctx, owner, args);
    },
  },
  {
    name: "duplicate_event_type",
    description: "Copy an existing event type under a new slug and title (optionally new description/duration). Returns the new record.",
    inputSchema: {
      type: "object",
      properties: { ...EVENT_TYPE_REF, slug: str("Slug for the copy."), title: str("Title for the copy."), description: str("Optional new description."), durationMinutes: int("Optional new duration.") },
      required: ["slug", "title"],
    },
    scope: "admin:write",
    call: async (ctx, args, owner) => {
      await ctx.runMutation(calAdmin.adminDuplicateEventType, { ownerAuthUserId: owner, ...pick(args, ["id", "calEventTypeId", "slug", "title", "description", "durationMinutes"]) });
      return ctx.runQuery(calAdmin.adminGetEventTypeBySlug, { ownerAuthUserId: owner, slug: args.slug });
    },
  },

  // Schedules & availability ------------------------------------------------
  {
    name: "list_schedules",
    description: "List availability schedules (name, time zone, default flag, Cal.com id).",
    inputSchema: { type: "object", properties: {} },
    scope: "admin:read",
    call: (ctx, _args, owner) => ctx.runQuery(calAdmin.adminListSchedules, { ownerAuthUserId: owner }),
  },
  {
    name: "get_schedule",
    description: "Fetch one schedule with its weekly availability windows and date overrides.",
    inputSchema: { type: "object", properties: SCHEDULE_REF },
    scope: "admin:read",
    call: (ctx, args, owner) => getSchedule(ctx, owner, args),
  },
  {
    name: "create_schedule",
    description: "Create an availability schedule. Set weekly hours afterwards with set_weekly_availability. Returns the created schedule.",
    inputSchema: {
      type: "object",
      properties: { name: str("Schedule name, e.g. 'Working hours'."), timeZone: str("IANA time zone, e.g. America/Los_Angeles."), isDefault: bool("Make this the default schedule for new event types.") },
      required: ["name", "timeZone"],
    },
    scope: "admin:write",
    call: async (ctx, args, owner) => {
      const created = await ctx.runMutation(calAdmin.adminCreateSchedule, { ownerAuthUserId: owner, isDefault: false, ...pick(args, ["name", "timeZone", "isDefault"]) });
      const calScheduleId = typeof created === "number" ? created : created?.calId ?? created?.calScheduleId;
      return calScheduleId != null ? getSchedule(ctx, owner, { calScheduleId }) : created;
    },
  },
  {
    name: "update_schedule",
    description: "Rename a schedule, change its time zone, or make it the default. Returns the updated schedule.",
    inputSchema: { type: "object", properties: { ...SCHEDULE_REF, name: str("New name."), timeZone: str("New IANA time zone."), isDefault: bool("Make default.") } },
    scope: "admin:write",
    call: async (ctx, args, owner) => {
      await ctx.runMutation(calAdmin.adminUpdateSchedule, { ownerAuthUserId: owner, ...(args.scheduleId ? { id: args.scheduleId } : {}), ...pick(args, ["calScheduleId", "name", "timeZone", "isDefault"]) });
      return getSchedule(ctx, owner, args);
    },
  },
  {
    name: "delete_schedule",
    description: "Delete a schedule. Fails if it is the default or still used by an event type; reassign first.",
    inputSchema: { type: "object", properties: SCHEDULE_REF },
    scope: "admin:write",
    call: async (ctx, args, owner) => {
      await ctx.runMutation(calAdmin.adminDeleteSchedule, { ownerAuthUserId: owner, ...(args.scheduleId ? { id: args.scheduleId } : {}), ...pick(args, ["calScheduleId"]) });
      return { deleted: true, ...pick(args, ["scheduleId", "calScheduleId"]) };
    },
  },
  {
    name: "duplicate_schedule",
    description: "Copy a schedule including its weekly windows. Returns the list of schedules afterwards.",
    inputSchema: { type: "object", properties: SCHEDULE_REF },
    scope: "admin:write",
    call: async (ctx, args, owner) => {
      await ctx.runMutation(calAdmin.adminDuplicateSchedule, { ownerAuthUserId: owner, ...(args.scheduleId ? { id: args.scheduleId } : {}), ...pick(args, ["calScheduleId"]) });
      return ctx.runQuery(calAdmin.adminListSchedules, { ownerAuthUserId: owner });
    },
  },
  {
    name: "set_weekly_availability",
    description: "Replace a schedule's weekly availability with the given windows (minutes from midnight in the schedule's time zone). Example: Mon–Fri 9–5 = [{days:[1,2,3,4,5], startMinute:540, endMinute:1020}]. Returns the schedule.",
    inputSchema: { type: "object", properties: { ...SCHEDULE_REF, windows: { type: "array", items: WINDOW, description: "Complete set of weekly windows; anything not listed becomes unavailable." } }, required: ["windows"] },
    scope: "admin:write",
    call: async (ctx, args, owner) => {
      await ctx.runMutation(calAdmin.adminSetAvailability, { ownerAuthUserId: owner, ...pick(args, ["scheduleId", "calScheduleId", "windows"]) });
      return getSchedule(ctx, owner, args);
    },
  },
  {
    name: "add_date_override",
    description: "Override one date on a schedule: pass startMinute/endMinute for custom hours that day, or omit both to block the whole day. dateUtc is the UTC midnight timestamp (ms) of the date. Returns the schedule.",
    inputSchema: { type: "object", properties: { ...SCHEDULE_REF, dateUtc: num("UTC midnight of the date, ms since epoch (e.g. Date.UTC(2026, 8, 20))."), startMinute: int("Custom start, minutes from midnight; omit to block the day."), endMinute: int("Custom end, minutes from midnight.") }, required: ["dateUtc"] },
    scope: "admin:write",
    call: async (ctx, args, owner) => {
      await ctx.runMutation(calAdmin.adminAddDateOverride, { ownerAuthUserId: owner, ...pick(args, ["scheduleId", "calScheduleId", "dateUtc", "startMinute", "endMinute"]) });
      return getSchedule(ctx, owner, args);
    },
  },
  {
    name: "remove_date_override",
    description: "Remove a date override by its id (see get_schedule).",
    inputSchema: { type: "object", properties: { id: str("Convex id of the date override.") }, required: ["id"] },
    scope: "admin:write",
    call: async (ctx, args, owner) => {
      await ctx.runMutation(calAdmin.adminRemoveDateOverride, { ownerAuthUserId: owner, id: args.id });
      return { removed: true, id: args.id };
    },
  },

  // Bookings ------------------------------------------------------------------
  {
    name: "list_bookings",
    description: "List bookings by status (upcoming | past | cancelled | unconfirmed | recurring) and optional time range. Paginated: pass `cursor` from a previous result to continue.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["upcoming", "past", "cancelled", "unconfirmed", "recurring"], description: "Defaults to upcoming." },
        after: num("Only bookings starting after this ms timestamp."),
        before: num("Only bookings starting before this ms timestamp."),
        limit: int("Page size (default 25, max 100)."),
        cursor: str("Continuation cursor from the previous page."),
      },
    },
    scope: "admin:read",
    call: (ctx, args, owner) =>
      ctx.runQuery(bookingAdmin.listBookings, {
        ownerAuthUserId: owner,
        status: args.status ?? "upcoming",
        ...pick(args, ["after", "before"]),
        paginationOpts: { numItems: Math.min(Math.max(Number(args.limit) || 25, 1), 100), cursor: args.cursor ?? null },
      }),
  },
  {
    name: "cancel_booking",
    description: "Cancel a booking as the owner (attendees are notified by the normal cancellation flow). Returns the mutation result.",
    inputSchema: { type: "object", properties: { bookingId: str("Convex id of the booking (from list_bookings)."), reason: str("Optional reason shown to the attendee.") }, required: ["bookingId"] },
    scope: "admin:write",
    call: (ctx, args, owner) => ctx.runMutation(bookingAdmin.adminCancelBooking, { ownerAuthUserId: owner, ...pick(args, ["bookingId", "reason"]) }),
  },
  {
    name: "reschedule_booking",
    description: "Move a booking to a new start/end (ms timestamps) for the same attendee. Returns the new booking.",
    inputSchema: {
      type: "object",
      properties: {
        oldBookingId: str("Convex id of the booking being moved."),
        newStartTime: num("New start, ms since epoch."),
        newEndTime: num("New end, ms since epoch."),
        newBookerTimeZone: str("Attendee's IANA time zone."),
        attendee: { type: "object", properties: { name: str("Attendee name."), email: str("Attendee email."), timeZone: str("Attendee IANA time zone."), notes: str("Optional notes.") }, required: ["name", "email", "timeZone"] },
        idempotencyKey: str("Optional; supply the same key on retries to avoid double moves."),
      },
      required: ["oldBookingId", "newStartTime", "newEndTime", "newBookerTimeZone", "attendee"],
    },
    scope: "admin:write",
    call: (ctx, args, owner) =>
      ctx.runMutation(bookingAdmin.adminRescheduleBooking, {
        ownerAuthUserId: owner,
        idempotencyKey: args.idempotencyKey ?? `admin-mcp-${crypto.randomUUID()}`,
        ...pick(args, ["oldBookingId", "newStartTime", "newEndTime", "newBookerTimeZone", "attendee"]),
      }),
  },

  // Calendars -----------------------------------------------------------------
  {
    name: "list_connected_calendars",
    description: "List connected calendar accounts and their calendars, with conflict-check flags and the destination calendar.",
    inputSchema: { type: "object", properties: {} },
    scope: "admin:read",
    call: (ctx, _args, owner) => ctx.runQuery(calAdmin.adminListConnectedCalendars, { ownerAuthUserId: owner }),
  },
  {
    name: "set_destination_calendar",
    description: "Choose which calendar new bookings are written to.",
    inputSchema: { type: "object", properties: { provider: { type: "string", enum: ["google", "caldav"], description: "Calendar provider." }, externalCalendarId: str("Provider calendar id (from list_connected_calendars).") }, required: ["externalCalendarId"] },
    scope: "admin:write",
    call: async (ctx, args, owner) => {
      await ctx.runMutation(calAdmin.adminSetDestinationCalendar, { ownerAuthUserId: owner, ...pick(args, ["provider", "externalCalendarId"]) });
      return ctx.runQuery(calAdmin.adminListConnectedCalendars, { ownerAuthUserId: owner });
    },
  },
  {
    name: "set_calendar_conflict_flag",
    description: "Turn conflict checking on or off for one calendar (whether its events block availability).",
    inputSchema: { type: "object", properties: { credentialId: str("Convex id of the calendar credential."), calCredentialId: int("Cal.com integer credential id; alternative to credentialId."), externalCalendarId: str("Provider calendar id."), checkForConflicts: bool("true = busy events on this calendar block slots.") }, required: ["externalCalendarId", "checkForConflicts"] },
    scope: "admin:write",
    call: async (ctx, args, owner) => {
      await ctx.runMutation(calAdmin.adminSetCalendarConflictFlag, { ownerAuthUserId: owner, ...pick(args, ["credentialId", "calCredentialId", "externalCalendarId", "checkForConflicts"]) });
      return ctx.runQuery(calAdmin.adminListConnectedCalendars, { ownerAuthUserId: owner });
    },
  },
  {
    name: "disconnect_calendar",
    description: "Disconnect a calendar account. Destructive: the owner must reconnect through the UI to undo.",
    inputSchema: { type: "object", properties: { credentialId: str("Convex id of the calendar credential."), calCredentialId: int("Cal.com integer credential id; alternative to credentialId.") } },
    scope: "admin:write",
    call: async (ctx, args, owner) => {
      await ctx.runMutation(calAdmin.adminDisconnectCalendar, { ownerAuthUserId: owner, ...pick(args, ["credentialId", "calCredentialId"]) });
      return ctx.runQuery(calAdmin.adminListConnectedCalendars, { ownerAuthUserId: owner });
    },
  },

  // Profile -------------------------------------------------------------------
  {
    name: "get_profile",
    description: "Owner profile: name, booking username (the /ted in URLs), time zone, week start, time format, locale, default schedule.",
    inputSchema: { type: "object", properties: {} },
    scope: "admin:read",
    call: (ctx, _args, owner) => ctx.runQuery(calUsers.getCalcomUserByAuthUserId, { authUserId: owner }),
  },
  {
    name: "update_profile",
    description: "Update owner preferences (only the fields you pass change). Returns the profile.",
    inputSchema: {
      type: "object",
      properties: {
        timeZone: str("IANA time zone."),
        weekStart: str("Week start day name, e.g. Monday."),
        timeFormat: int("12 or 24."),
        locale: str("Locale, e.g. en."),
        calDefaultScheduleId: int("Cal.com integer id of the schedule to use as default."),
        propagateTimeZoneToDefaultSchedule: bool("Also apply the new time zone to the default schedule."),
        bookingUsername: str("Username segment of booking URLs."),
        bio: str("Short bio shown on the profile page."),
      },
    },
    scope: "admin:write",
    call: async (ctx, args, owner) => {
      await ctx.runMutation(calAdmin.adminUpdateCalcomUserPrefs, {
        ownerAuthUserId: owner,
        ...pick(args, ["timeZone", "weekStart", "timeFormat", "locale", "calDefaultScheduleId", "propagateTimeZoneToDefaultSchedule", "bookingUsername", "bio"]),
      });
      return ctx.runQuery(calUsers.getCalcomUserByAuthUserId, { authUserId: owner });
    },
  },
];

// ─── JSON-RPC plumbing ───────────────────────────────────────────────────────

type Headers = Record<string, string>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RpcId = any;

function rpc(id: RpcId, payload: Record<string, unknown>, cors: Headers, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...payload }), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}
const rpcResult = (id: RpcId, result: unknown, cors: Headers) => rpc(id, { result }, cors);
const rpcError = (id: RpcId, code: number, message: string, cors: Headers, status = 200, data?: unknown) =>
  rpc(id, { error: { code, message, ...(data === undefined ? {} : { data }) } }, cors, status);

const HEADER_MISMATCH = -32020;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const UNSUPPORTED_VERSION_DATA = { supported: SUPPORTED_PROTOCOL_VERSIONS };

// `Mcp-Name` / `Mcp-Param-*` may arrive Base64-wrapped when the value is not
// header-safe ASCII (spec: Value Encoding).
function decodeHeaderValue(v: string): string {
  const m = v.match(/^=\?base64\?(.*)\?=$/);
  if (!m) return v;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)));
  } catch {
    return v;
  }
}

async function resolveOwner(
  ctx: Ctx,
  req: Request,
  scope: string,
): Promise<{ ok: true; owner: string } | { ok: false; reason: "missing" | "invalid" | "scope" }> {
  const authz = req.headers.get("authorization") ?? "";
  const m = authz.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, reason: "missing" };
  const tokenHash = await hashApiKey(m[1].trim());
  const res = await ctx.runQuery(publicRefs._authBookingKey, { tokenHash, requiredScope: scope });
  return res.ok ? { ok: true, owner: res.authUserId as string } : { ok: false, reason: res.reason };
}

function toolListing() {
  return ADMIN_MCP_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { readOnlyHint: t.scope === "admin:read", destructiveHint: t.name === "disconnect_calendar" || t.name === "cancel_booking" || t.name === "delete_schedule" },
  }));
}

function errorMessage(e: unknown): string {
  if (e instanceof ConvexError) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = e.data as any;
    return typeof data === "string" ? data : (data?.message ?? "Request could not be completed.");
  }
  return e instanceof Error ? e.message : "Request could not be completed.";
}

// POST /admin/mcp — the MCP endpoint. GET/DELETE are 405 (no sessions, no
// server-initiated stream); OPTIONS answers CORS preflight.
export const adminMcpHandler = httpAction(async (ctx, req) => {
  const requestId = getOrMintRequestId(req);
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return withRequestId(new Response(null, { status: 204, headers: cors }), requestId);
  if (req.method !== "POST") {
    return withRequestId(new Response("Method Not Allowed", { status: 405, headers: { ...cors, allow: "POST, OPTIONS" } }), requestId);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let msg: any;
  try {
    msg = await req.json();
  } catch {
    return withRequestId(rpcError(null, -32700, "Parse error", cors, 400), requestId);
  }
  if (Array.isArray(msg)) {
    return withRequestId(rpcError(null, -32600, "Batch requests are not supported", cors, 400), requestId);
  }
  const id: RpcId = msg?.id ?? null;
  const method: unknown = msg?.method;
  const params = msg?.params ?? {};

  // Era detection: the header is REQUIRED from 2025-06-18 on; older clients
  // (2025-03-26) omit it and are treated as such. A 2026-07-28 client also
  // mirrors method/name into headers, which we must validate against the body.
  const headerVersion = req.headers.get("mcp-protocol-version");
  const version = headerVersion ?? "2025-03-26";
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    return withRequestId(rpcError(id, INVALID_PARAMS, `Unsupported protocol version ${version}`, cors, 400, UNSUPPORTED_VERSION_DATA), requestId);
  }
  const modern = version === ADMIN_MCP_PROTOCOL_VERSION;
  if (modern) {
    const bodyVersion = params?._meta?.["io.modelcontextprotocol/protocolVersion"];
    if (bodyVersion !== undefined && bodyVersion !== version) {
      return withRequestId(rpcError(id, HEADER_MISMATCH, `Header mismatch: MCP-Protocol-Version '${version}' does not match body value '${bodyVersion}'`, cors, 400), requestId);
    }
    const headerMethod = req.headers.get("mcp-method");
    if (headerMethod === null || headerMethod !== method) {
      return withRequestId(rpcError(id, HEADER_MISMATCH, `Header mismatch: Mcp-Method '${headerMethod ?? ""}' does not match body method '${String(method)}'`, cors, 400), requestId);
    }
    if (method === "tools/call") {
      const headerName = req.headers.get("mcp-name");
      const decoded = headerName === null ? null : decodeHeaderValue(headerName);
      if (decoded === null || decoded !== params?.name) {
        return withRequestId(rpcError(id, HEADER_MISMATCH, `Header mismatch: Mcp-Name '${headerName ?? ""}' does not match body value '${String(params?.name)}'`, cors, 400), requestId);
      }
    }
  }

  // Legacy notifications (e.g. notifications/initialized) are accepted with 202.
  if (msg?.id === undefined && typeof method === "string") {
    return withRequestId(new Response(null, { status: 202, headers: cors }), requestId);
  }

  try {
    switch (method) {
      case "initialize": {
        // Legacy handshake. A modern client never sends it, but answering keeps
        // 2025-era SDKs (openclaw's @modelcontextprotocol/sdk 1.x) working.
        const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-03-26";
        const negotiated = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : "2025-06-18";
        return withRequestId(
          rpcResult(id, { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS }, cors),
          requestId,
        );
      }
      case "ping":
        return withRequestId(rpcResult(id, {}, cors), requestId);
      case "tools/list":
        return withRequestId(rpcResult(id, { tools: toolListing() }, cors), requestId);
      case "tools/call": {
        const name = params?.name;
        const tool = ADMIN_MCP_TOOLS.find((t) => t.name === name);
        if (!tool) return withRequestId(rpcError(id, INVALID_PARAMS, `Unknown tool: ${String(name)}`, cors), requestId);
        const auth = await resolveOwner(ctx, req, tool.scope);
        if (!auth.ok) {
          const text =
            auth.reason === "scope"
              ? `This API key is missing the required scope "${tool.scope}".`
              : `Authentication required: pass an API key as "Authorization: Bearer <key>" with the "${tool.scope}" scope.`;
          log.warn("admin-mcp auth failed", { requestId, tool: tool.name, reason: auth.reason });
          return withRequestId(rpcResult(id, { content: [{ type: "text", text }], isError: true }, cors), requestId);
        }
        try {
          const result = await tool.call(ctx, params?.arguments ?? {}, auth.owner);
          return withRequestId(
            rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }], structuredContent: result ?? undefined }, cors),
            requestId,
          );
        } catch (e) {
          // MCP convention: a tool failure is a result with isError:true so the
          // model reads and reacts, not a JSON-RPC protocol error.
          return withRequestId(rpcResult(id, { content: [{ type: "text", text: `Error: ${errorMessage(e)}` }], isError: true }, cors), requestId);
        }
      }
      default:
        return withRequestId(rpcError(id, METHOD_NOT_FOUND, `Method not found: ${String(method)}`, cors, modern ? 404 : 200), requestId);
    }
  } catch (e) {
    return withRequestId(rpcError(id, -32603, e instanceof Error ? e.message : "Internal error", cors, 500), requestId);
  }
});
