# teddessert booking — `book.teddessert.com`

Self-hosted Cal.com-style booking for teddessert.com. **Zero runtime dependency
on dibslist**: own Convex deployment, own Google OAuth client, own auth, own
domain.

```
packages/scheduling-engine   pure availability / slot / ranking math (MIT, from cal.diy)
packages/backend             Convex backend  → https://effervescent-dinosaur-191.convex.cloud
app/                         Cal.com fork (real Cal.com UI, data layer on Convex) → book.teddessert.com
deploy/                      what runs on the LattePanda (compose + cloudflared + runbook)
.github/workflows            deploy-backend.yml (Convex)  ·  build-image.yml (Docker image → GHCR)
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

### App (`app/`) — GHCR image, run on a LattePanda

The app is no longer on Cloudflare Containers (keeping a 6 GiB container warm
ran ~$30–50/mo). It is a plain Docker image built in CI and run on a LattePanda
3 Delta at home, published through a Cloudflare Tunnel.

```
push to main (app/**) ──► GitHub Actions build ──► ghcr.io/modestapproach/teddessert-booking:latest
                                                              │
                                    LattePanda: docker compose pull && up -d
                                                              │
Internet ──► Cloudflare edge ──► cloudflared ──► 127.0.0.1:3000 ──► container
```

- **Build** — `.github/workflows/build-image.yml`, on push to `main` touching
  `app/**` and on `workflow_dispatch`. It pushes `:latest` and `:<sha>` to GHCR
  using the built-in `GITHUB_TOKEN` (`packages: write`); **no repo secrets are
  needed for the app build any more**. The Panda never builds — too little disk
  and RAM. Both sides are amd64, so this is a single-arch build.
- **Run** — everything the Panda needs is in [`deploy/`](deploy/):
  `docker-compose.yml` (pull `:latest`, `restart: unless-stopped`, bind
  `127.0.0.1:3000` only), `.env.example` (copy to `deploy/.env`, gitignored),
  `cloudflared-config.yml`, and [`deploy/README.md`](deploy/README.md) — the
  copy-pasteable first-boot runbook (Docker install, moving Docker's data-root
  to an external SSD so the 64 GB eMMC survives, tunnel setup, systemd,
  verification).
- **Runtime env** lives in `deploy/.env` on the box, not in repo secrets:
  `NEXTAUTH_SECRET`, `CALENDSO_ENCRYPTION_KEY`, `OWNER_PASSWORD`,
  `OWNER_EMAIL` / `OWNER_NAME` / `OWNER_USERNAME`, the three `NEXT_PUBLIC_*`
  URLs and `SKIP_DB_MIGRATIONS=1`. The `NEXT_PUBLIC_*` values are also baked at
  build time by `app/Dockerfile`'s defaults — CI does not override them.
- **Update** — `cd deploy && docker compose pull && docker compose up -d`.

`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` are no longer used by CI; the
only Cloudflare thing left is the tunnel's DNS record on the `teddessert.com`
zone, created once with `cloudflared tunnel route dns`.

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
