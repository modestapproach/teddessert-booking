# teddessert booking — `book.teddessert.com`

Self-hosted Cal.com-style booking for teddessert.com. **Zero runtime dependency
on dibslist**: own Convex deployment, own Google OAuth client, own auth, own
domain.

```
packages/scheduling-engine   pure availability / slot / ranking math (MIT, from cal.diy)
packages/backend             Convex backend  → https://effervescent-dinosaur-191.convex.cloud
app/                         Cal.com fork (real Cal.com UI, data layer on Convex) → book.teddessert.com
deploy/                      fallback: run the same container on any Linux box (compose + cloudflared + runbook)
.github/workflows            deploy-backend.yml (Convex)  ·  deploy-app.yml (Cloudflare Containers)  ·  build-image.yml (manual fallback image → GHCR)
```

## How it fits together

- **Public booking page** `https://book.teddessert.com/<OWNER_USERNAME>/<event-slug>` — no login.
  The Cal.com Booker reads event meta + slots and creates bookings through the
  Convex functions in `packages/backend/convex/scheduling/*`.
- **Owner dashboard** `https://book.teddessert.com/` — sign in at `/owner-login`
  with `OWNER_PASSWORD`. Event types, availability, connected calendars,
  bookings list — all Cal.com's real UI.
- **Google Calendar** — connect from the dashboard (Settings → Calendars or the
  getting-started flow). Busy blocks hide slots; bookings land on the calendar.
  The OAuth return leg is `https://effervescent-dinosaur-191.convex.site/calendar/oauth/callback`.

## Auth model (single owner)

There is one account. `app/packages/features/auth/lib/dibslistSession.ts`
resolves every request carrying the `owner_session` cookie (HMAC of
`OWNER_PASSWORD` under `NEXTAUTH_SECRET`) to the owner. The Convex side takes
the owner id explicitly on its server-to-server admin functions and treats any
authed call as the owner (`convex/_helpers/auth.ts`). The public API is
key-less. Feature flags default **ON** (a `featureFlags` row can still turn one
off).

## Agent access (MCP + CLI)

Agents administer the site through the **admin MCP** at
`https://effervescent-dinosaur-191.convex.site/admin/mcp`
(`packages/backend/convex/adminMcp.ts`): 24 tools over the same admin functions
the UI uses (event types, schedules, weekly availability, date overrides,
bookings, connected calendars, profile), gated by an agent API key with the
`admin:read` / `admin:write` scopes. It is stateless Streamable HTTP and accepts
both the 2026-07-28 protocol (no handshake, mirrored headers) and the
2025-era handshake clients such as openclaw. `packages/cli` ships a `booking`
CLI over the same endpoint. Key minting, openclaw registration and command
examples: [`packages/cli/README.md`](./packages/cli/README.md). The booker-side
MCP at `/book/mcp` (public, capability-token based) is unchanged.

## Deploy

### Convex backend (`packages/backend`)
```bash
pnpm install
CONVEX_DEPLOY_KEY=<prod key> pnpm --filter @teddessert/booking-backend deploy
```
CI does this on push to `packages/**` (repo secret `CONVEX_DEPLOY_KEY`).

Env on the Convex deployment (already set): `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `REFRESH_TOKEN_ENCRYPTION_KEY`,
`CALENDAR_OAUTH_STATE_SECRET`, `SITE_URL`, `BOOK_PUBLIC_URL`.
Optional: `EMAIL_API_KEY` + `EMAIL_FROM` (Brevo confirmations + .ics),
`TWILIO_*` (SMS), `TURNSTILE_SECRET_KEY`, `STRIPE_BOOKING_WEBHOOK_SECRET`.

### App (`app/`) — Cloudflare Containers

The Next.js frontend runs as a Docker container on Cloudflare, fronted by a
Worker that proxies to it (`app/src/index.ts`) and owns the route
`book.teddessert.com/*`. The data layer stays on Convex; the container is
stateless and disposable.

```
push to main (app/**) ──► GitHub Actions ──► wrangler deploy (builds the Dockerfile,
                                              pushes to CF's managed registry)
                                                          │
Internet ──► Worker (book.teddessert.com) ──► Container :3000 ──► Convex
```

- **Deploy** — `.github/workflows/deploy-app.yml`, on push to `main` touching
  `app/**` and on `workflow_dispatch`. It checks the eight repo secrets exist,
  frees runner disk (the cal build overruns the default ~14 GB), then
  `wrangler deploy` builds `app/Dockerfile` and syncs the runtime secrets into
  the Worker. Config is `app/wrangler.toml`.
- **Repo secrets it needs** (all eight, or the deploy stops at the preflight):

  | secret | value |
  | --- | --- |
  | `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | the account holding the `teddessert.com` zone |
  | `NEXTAUTH_SECRET` | random 32+ chars — `openssl rand -hex 32` |
  | `CALENDSO_ENCRYPTION_KEY` | random 32 chars — `openssl rand -hex 16` |
  | `OWNER_PASSWORD` | the dashboard password |
  | `OWNER_EMAIL` / `OWNER_NAME` / `OWNER_USERNAME` | e.g. `you@…` / `Ted Dessert` / `ted` |

  Fresh values are fine for the last six — nothing durable is encrypted with
  them. Bookings, availability and Google tokens live in Convex.

#### What it costs, and the one knob that decides

Cloudflare bills a container **only while it is awake**: $0.0000025 per
GiB-second of memory, plus a negligible amount for disk, and CPU on actual use.
Requests and bandwidth are rounding errors for a personal booking page. So the
bill is almost exactly *awake hours × instance memory*:

| instance | awake 24/7 | awake ~3 h/day | awake ~1 h/day |
| --- | --- | --- | --- |
| `standard-1` (4 GiB) — current | ~$28/mo | ~$3.4/mo | ~$1.1/mo |
| `standard-2` (6 GiB) — the old setting | ~$41/mo | ~$5.0/mo | ~$1.7/mo |

The knob is **`sleepAfter` in `app/src/index.ts`**, not the instance type. It was `"2h"`, which meant one morning visit kept 6 GiB warm
until lunchtime and any trickle of traffic never let it sleep — that is how
this reached ~$40/mo. It is now **`"15m"`**: long enough for a booking session
(browse slots → confirm), short enough that a quiet day costs cents.

**The trade-off is real**: the first visitor after a quiet spell waits ~10–20 s
while the container and Next boot. If a lost booking matters more than ~$25/mo,
raise `sleepAfter` (or go to a small always-on VPS — see the fallback below).

#### Build details that are load-bearing

- `outputFileTracingRoot` is a **top-level** `next.config.ts` key. Under
  `experimental` (where upstream cal.com has it) Next 16 silently ignores it,
  the trace root falls back to `apps/web`, and the standalone server ships
  without hoisted workspace dependencies.
- `yarn copy-app-store-static` runs before `next build` in the Dockerfile.
  Turbo's `build` task depends on it; a bare `next build` does not, and
  `app/api/social/og/image` imports the `svg-hashes.json` it generates.

#### Rejected: Cloudflare Workers (OpenNext)

Running the app *inside* a Worker via `@opennextjs/cloudflare` does not work
for this codebase and is not worth retrying. It builds only after seven
separate fixes (`--webpack` instead of Turbopack, `node:`-scheme stripping, a
sharp stub, dropping `runtime = "edge"`, `useWorkerdCondition: false`, a
`superagent-proxy` stub, the tracing-root fix above) — and the result is a
**167.7 MiB** `worker.js` against Cloudflare's **64 MiB** limit, 2.6× over and
already minified, plus a 37 MiB app-store asset over the 25 MiB per-file cap.
The upstream dibslist repo carries an OpenNext config too; it has never been
deployed and cannot build as committed.

#### Fallback: the same image anywhere

`.github/workflows/build-image.yml` (manual, `workflow_dispatch`) builds the
identical Dockerfile and pushes `ghcr.io/modestapproach/teddessert-booking`.
[`deploy/`](deploy/) has a compose file, cloudflared config and runbook to run
it on any amd64 Linux box behind a free Cloudflare Tunnel — ~$4–8/mo on a small
VPS, always warm, no cold starts. Use it if the sleep latency proves annoying,
or to pin and roll back to a specific `:<sha>`.

## First run

1. `https://book.teddessert.com/owner-login` → password → getting-started.
2. Connect Google Calendar (consent screen is in Testing mode: the Google
   account must be listed as a test user).
3. Set availability, create an event type (slug e.g. `chat`).
4. Share `https://book.teddessert.com/<OWNER_USERNAME>/chat` from teddessert.com.

## Tests

`pnpm test` — engine 51/51; backend 378/400. The 22 remaining backend
failures are lifted assertions that a flag with no row is OFF (this deployment
defaults ON — see `convex/_helpers/featureFlag.ts`) and 3 co-host tests that
looked up a dibslist user directory that no longer exists. Behaviour, not bugs.

## Lineage

Built from `dibslisthq/dibslist` (`apps/booking` + `packages/backend/convex/scheduling` +
`packages/scheduling-engine`) on 2026-09-13. The scheduling math and the UI are
Cal.com / cal.diy under MIT — keep the attribution notices.
