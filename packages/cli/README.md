# Agent access: admin MCP + `booking` CLI

Two doors into the same admin surface. Both authenticate with an **agent API
key** and never expose the Convex admin functions directly.

## The admin MCP endpoint

`POST https://effervescent-dinosaur-191.convex.site/admin/mcp`
(source: `packages/backend/convex/adminMcp.ts`, routed in `convex/http.ts`).

- Streamable HTTP, stateless, JSON responses only. Speaks both protocol eras:
  **2026-07-28** (no handshake; mirrored `MCP-Protocol-Version`, `Mcp-Method`,
  `Mcp-Name` headers are validated, `400 / -32020` on mismatch, `404 / -32601`
  for unknown methods, `405` for GET/DELETE) and **2025-03-26 … 2025-11-25**
  (`initialize` handshake, notifications → `202`, `Mcp-Session-Id` ignored).
  openclaw's client (`@modelcontextprotocol/sdk` 1.x) is in the second group;
  SDK 2.0 clients are in the first.
- Auth: `Authorization: Bearer <key>`. Keys live in the `apiKeys` table; the
  scope `admin:read` unlocks read tools, `admin:write` the mutating ones. The
  owner id always comes from the key, never from the agent's arguments.
- 24 tools: `list/get/create/update/delete/duplicate_event_type`,
  `list/get/create/update/delete/duplicate_schedule`,
  `set_weekly_availability`, `add/remove_date_override`,
  `list/cancel/reschedule_booking`, `list_connected_calendars`,
  `set_destination_calendar`, `set_calendar_conflict_flag`,
  `disconnect_calendar`, `get/update_profile`. Every mutating tool returns the
  resulting record. Tool input schemas are the source of truth (`tools/list`).

### Minting a key

```bash
cd packages/backend
CONVEX_DEPLOYMENT=prod:effervescent-dinosaur-191 pnpm exec convex run \
  scheduling/publicApi:_mintAgentKey \
  '{"authUserId":"owner","name":"openclaw-admin","scopes":["admin:read","admin:write"]}' --prod
# revoke later by last4:
#   … scheduling/publicApi:_revokeAgentKey '{"authUserId":"owner","last4":"xxxx"}' --prod
```

The secret is printed once. Store it as `BOOKING_API_KEY`.

### Registering in openclaw

```bash
openclaw mcp add booking \
  --url https://effervescent-dinosaur-191.convex.site/admin/mcp \
  --transport streamable-http \
  --header "Authorization=Bearer $BOOKING_API_KEY" \
  --connect-timeout 30
openclaw mcp doctor booking --probe
```

## The `booking` CLI

Thin client over the same endpoint (one POST per command, 2026-07-28 shape).
Needs Node 22+. From the repo: `pnpm install` links it, then `pnpm exec booking …`
or `node packages/cli/bin/booking.mjs …`.

Config: `BOOKING_MCP_URL` and `BOOKING_API_KEY` from the environment, else
from `./.env.agent`, else `~/.openclaw/credentials/booking.env`.

```bash
booking tools
booking event-types list
booking event-types create --slug intro --title "Intro chat" --duration-minutes 30
booking event-types update --cal-id 3 --location-text "Google Meet" --hidden false
booking availability set --cal-id 1 --days mon-fri --from 9:00 --to 17:00 --days sat --from 10am --to 1pm
booking availability block --cal-id 1 --date 2026-09-20
booking bookings list --status upcoming --limit 10
booking calendars list
booking call get_event_type '{"slug":"intro"}'     # any tool, raw JSON args
```

`booking --help` prints the full command list.
