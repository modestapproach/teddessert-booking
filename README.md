# teddessert booking — `book.teddessert.com`

Self-hosted Cal.com-style booking for teddessert.com. **Zero runtime dependency
on dibslist**: own Convex deployment, own Google OAuth client, own auth, own
domain.

```
packages/scheduling-engine   pure availability / slot / ranking math (MIT, from cal.diy)
packages/backend             Convex backend  → https://effervescent-dinosaur-191.convex.cloud
app/                         Cal.com fork (real Cal.com UI, data layer on Convex) → book.teddessert.com
deploy/                      fallback: run the container on any Linux box (compose + cloudflared + runbook)
.github/workflows            deploy-backend.yml (Convex)  ·  deploy-worker.yml (Cloudflare Workers)  ·  build-image.yml (fallback image → GHCR)
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

### App (`app/`) — Cloudflare Workers via OpenNext

The Next.js frontend runs as a Cloudflare Worker, the same way dibslist runs
`book.dibslist.app`. No container and no box: per-request billing on the
Workers plan. (Cloudflare *Containers*, the previous setup, cost ~$30–50/mo to
keep a 6 GiB instance warm and is gone.)

```
push to main (app/**) ──► GitHub Actions: next build --webpack ──► opennextjs-cloudflare build ──► wrangler
                                                                                                      │
                                     Internet ──► book.teddessert.com (Worker Custom Domain) ◄────────┘
```

- **Deploy** — `.github/workflows/deploy-worker.yml`, on push to `main`
  touching `app/**` and on `workflow_dispatch`. Config is
  `app/apps/web/wrangler.toml`: Worker `teddessert-book`, `book.teddessert.com`
  as a Custom Domain (Cloudflare owns the DNS record and certificate — nothing
  to create by hand). After each deploy the workflow syncs the runtime secrets
  into the Worker and smokes `/owner-login`.
- **Repo secrets it needs:**

  | secret | value |
  | --- | --- |
  | `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | the account holding the `teddessert.com` zone; a token from the *Edit Cloudflare Workers* template plus DNS edit on the zone (the Custom Domain needs it — if the first deploy fails creating the domain, this is why) |
  | `NEXTAUTH_SECRET` | random 32+ chars |
  | `CALENDSO_ENCRYPTION_KEY` | random 32 chars |
  | `OWNER_PASSWORD` | the dashboard password |
  | `OWNER_EMAIL` / `OWNER_NAME` / `OWNER_USERNAME` | e.g. `you@…` / `Ted Dessert` / `ted` |

- **Build details that are load-bearing** (each one is a build that failed):
  - `next build --webpack`, not Turbopack (Next 16's default). The
    Workers-specific `IgnorePlugin`s for `sharp` and `deasync` live in
    `next.config.ts`'s `webpack()` hook, and Turbopack emits a hashed
    `sharp-<hash>` alias that OpenNext's esbuild cannot resolve.
  - `node:`-scheme imports that reach the client bundle
    (`packages/i18n/next-i18next.config.js`, `Booker.tsx`) are prefix-stripped
    in that same hook so Next's browser fallbacks resolve them; webpack rejects
    the scheme outright.
  - `@opennextjs/cloudflare` ≥ 1.20.3. Next 16's `proxy.ts` is
    Node-runtime-only, and older OpenNext refuses to bundle it.
  - `NEXT_PRIVATE_MINIMAL_MODE=1` at runtime (opennextjs-cloudflare#1232),
    inherited from dibslist's config.
  - `outputFileTracingRoot` is a **top-level** `next.config.ts` key. Under
    `experimental` (where upstream had it) Next 16 silently ignores it, the
    trace root falls back to `apps/web`, and hoisted workspace packages
    (`uncrypto` was the first) are missing from the server tree OpenNext
    copies. Same trap for the Docker standalone build.
  - `yarn copy-app-store-static` before `next build`. Turbo's `build` task
    depends on it; a raw `next build` (the workflow, the Dockerfile) does not,
    and `app/api/social/og/image` imports the `svg-hashes.json` it generates.
  - `sharp` is aliased to an empty module in the client-and-server webpack
    config rather than ignored: `IgnorePlugin` makes `require("sharp")` throw
    at load, and `/api/avatar/[uuid]` loads it at module level, which kills
    page-data collection. Consequence on Workers: that avatar route fails
    when called (sharp is native and cannot run there). It works in the
    container.
- **Limits to keep in mind** — 64 MiB uncompressed Worker size, 128 MB memory
  per isolate. The deploy workflow prints the bundle size on every run.

**Fallback: the container.** `.github/workflows/build-image.yml` still builds
`ghcr.io/modestapproach/teddessert-booking:latest` on the same trigger, and
[`deploy/`](deploy/) has a compose file, tunnel config and runbook to run it on
any amd64 Linux box behind a free Cloudflare Tunnel. Not the LattePanda: it
hosts things whose downtime hurts only the owner (Twenty, personal tooling). A
public booking page fails *silently* when a home link or the power blips —
nobody reports the booking they didn't make.

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
