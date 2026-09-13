# teddessert booking — `book.teddessert.com`

Self-hosted Cal.com-style booking for teddessert.com. **Zero runtime dependency
on dibslist**: own Convex deployment, own Google OAuth client, own auth, own
domain.

```
packages/scheduling-engine   pure availability / slot / ranking math (MIT, from cal.diy)
packages/backend             Convex backend  → https://effervescent-dinosaur-191.convex.cloud
app/                         Cal.com fork (real Cal.com UI, data layer on Convex) → book.teddessert.com
.github/workflows            deploy-backend.yml (Convex)  ·  deploy-app.yml (Cloudflare Containers)
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

### App (`app/`, Cloudflare Workers + Containers)
CI does this on push to `app/**`. Repo secrets it needs:

| secret | value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | the CF account that holds the `teddessert.com` zone |
| `NEXTAUTH_SECRET` | random 32+ chars |
| `CALENDSO_ENCRYPTION_KEY` | random 32 chars |
| `OWNER_PASSWORD` | the dashboard password |
| `OWNER_EMAIL` / `OWNER_NAME` / `OWNER_USERNAME` | e.g. `you@…` / `Ted Dessert` / `ted` |

The worker forwards those secrets into the container (`app/src/index.ts`).
Route: `book.teddessert.com/*` (`app/wrangler.toml`). Docker is required at
deploy time (GitHub's ubuntu runner has it).

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
