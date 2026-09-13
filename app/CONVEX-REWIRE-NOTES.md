# Convex rewire notes (dibslist-booking)

This fork of cal.com is being rewired off Postgres/Prisma onto dibslist's Convex
backend (live `jovial-meadowlark-781` "meadowlark"). This file tracks the build status,
the env needed, and the exact tRPC injection point for the data-layer rewire.

## Strategy: keep Prisma for TYPES, drop Postgres for DATA

cal.com's entire codebase is typed against Prisma model types (`@calcom/prisma/client`).
Ripping Prisma out wholesale would break thousands of type references at once. Instead:

- **Prisma stays as a type generator.** `prisma generate` reads `packages/prisma/schema.prisma`
  and emits the TS client. It does **not** open a DB connection, so a syntactically valid
  but unreachable `DATABASE_URL` is enough. No Postgres server runs anywhere.
- `SKIP_DB_MIGRATIONS=1` (plus the auto-migration guard also skipping when the DB is
  unreachable) keeps `@calcom/prisma#build` from attempting `prisma migrate deploy`.
- Resolvers get migrated incrementally to read/write through Convex via `ctx.convex`.

## Required env (types-only / no-DB build)

Committed-safe placeholders live in `.env` (gitignored). Recipe:

```dotenv
# prisma generate schema parsing only — NO real DB contacted
DATABASE_URL="postgresql://user:password@localhost:5432/calendso"
DATABASE_DIRECT_URL="postgresql://user:password@localhost:5432/calendso"
SKIP_DB_MIGRATIONS=1

# hard-required by apps/web/next.config.ts (throws if absent)
NEXTAUTH_SECRET=placeholder_secret_32_chars_minimum
CALENDSO_ENCRYPTION_KEY=placeholder_encryption_key_32chars

# presence satisfies NEXT_PUBLIC_WEBAPP_URL AND auto-derives NEXTAUTH_URL
NEXT_PUBLIC_WEBAPP_URL=https://book.dibslist.app

# Convex target (set when wiring resolvers)
NEXT_PUBLIC_CONVEX_URL=        # meadowlark URL, e.g. https://jovial-meadowlark-781.convex.cloud
CONVEX_DEPLOY_KEY=             # optional admin/deploy key → setAdminAuth
```

`next.config.ts` hard-throws on missing `NEXTAUTH_SECRET`, `CALENDSO_ENCRYPTION_KEY`,
and `NEXTAUTH_URL` (the last auto-derives from `NEXT_PUBLIC_WEBAPP_URL`). `EMAIL_FROM`
only `console.warn`s.

## Build command sequence

Run from this directory (Yarn 4 is pinned via `.yarnrc.yml` `yarnPath`; corepack
self-activates it — from the dibslist monorepo root corepack would redirect to pnpm, so
always run from inside `dibslist-booking/`):

```sh
HUSKY=0 yarn install                       # node-modules linker, no PnP
yarn prisma generate                       # warms the generated client (cheap pre-flight)
yarn turbo run build --filter=@calcom/web... # full web dep graph; triggers prisma post-install
```

`turbo run build --filter=@calcom/web...` already triggers `@calcom/prisma#post-install`
(= `prisma generate && prisma format`) before `@calcom/web#build`, so the explicit
`yarn prisma generate` is just a CI-style pre-flight warm.

## tRPC context injection point (DONE — wired)

`packages/trpc/server/createContext.ts`:

1. `InnerContext` now carries `convex: ConvexHttpClient`.
2. `createContextInner` calls `getConvex()` and returns it alongside `prisma`.

Every procedure and SSR helper receives `InnerContext`, so they all get `ctx.convex` for
free. No change to the outer `createContext`/`TRPCContext`. CV-1/CV-2 resolvers call
`ctx.convex.query(...)` / `ctx.convex.mutation(...)`.

## Server-side Convex client helper (DONE)

`packages/lib/server/convex.ts` exports `getConvex()` — a lazy module-level
`ConvexHttpClient` singleton (mirrors `@calcom/prisma`'s singleton pattern) pointed at
`NEXT_PUBLIC_CONVEX_URL`, applying `CONVEX_DEPLOY_KEY` via `setAdminAuth` when present.
`convex@1.38.0` added to `packages/lib/package.json` and `packages/trpc/package.json`.

## BUILD STATUS — VERIFIED CLEAN (2026-06-02, local macOS arm64)

The full types-only / no-Postgres build **succeeds end to end on this machine.**

| Step | Result |
|---|---|
| `HUSKY=0 yarn install` | **EXIT 0** — "Done with warnings in 1m 39s". 3588 packages. The only output is benign Yarn peer-dependency warnings (YN0002/YN0060/YN0086). |
| Native deps (link/build-scripts) | **all built, no gyp errors** — `sharp@0.33.5/0.34.5` used the prebuilt arm64 binary (`@img/sharp-darwin-arm64`), `deasync@0.1.31` linked fine, plus `sqlite3`, `@swc/core`, `esbuild`, `protobufjs`, `@prisma/engines`. (cmake/nasm/pkg-config are NOT installed here, but were not needed because sharp used its prebuild.) |
| `yarn prisma generate` | **EXIT 0** — generated Prisma Client 6.16.1 + Zod types + Kysely types + enum generator from the schema, with the dummy `DATABASE_URL`. No DB connection opened. |
| `@calcom/prisma#build` | **skipped migrations cleanly** — logged `SKIP_DB_MIGRATIONS set, skipping migrations`. |
| `yarn turbo run build --filter=@calcom/web...` | **EXIT 0 — Tasks: 13 successful, 13 total.** Next.js 16.2.3 (Turbopack): `✓ Compiled successfully in 27.8s` → `Finished TypeScript in 33.6s` (full type-check, NOT skipped — `next.config.ts` has no `ignoreBuildErrors`) → `✓ Generating static pages (88/88)`. `.next/BUILD_ID` produced. |

`next.config.ts` accepted the placeholder env (`NEXTAUTH_SECRET`, `CALENDSO_ENCRYPTION_KEY`,
auto-derived `NEXTAUTH_URL` from `NEXT_PUBLIC_WEBAPP_URL`) and did NOT throw. The only
build warning is the predicted `EMAIL_FROM ... not set` console.warn.

### One real fix during bring-up

The original recipe assumed `ConvexHttpClient.setAdminAuth(deployKey)` exists. It does
NOT — `convex@1.38.0`'s public API is `setAuth(jwt)` / `clearAuth()` only (`adminAuth` is
private with no public setter). The first build failed with:

```
../lib/server/convex.ts(37,12): error TS2339: Property 'setAdminAuth' does not exist on type 'ConvexHttpClient'.
```

`packages/lib/server/convex.ts` was corrected to use `setAuth(jwt)` for per-user identity
tokens (and to mint a dedicated client per authed call to avoid a cross-request data race).
Deploy-key / admin server-to-server access is intentionally NOT wired through the HTTP
client — do it via a Convex function that trusts a shared secret, or a minted service JWT.

### Feasibility verdict

- **The loop CAN keep building cal.com locally on this machine.** Install + generate +
  full web build all pass. Total node_modules ~3.4 GB, `.next` ~0.49 GB.
- **Disk is the only real constraint.** Started at ~13 GiB free; bottomed near ~2.9 GiB
  during the install build-scripts phase. Clearing `.yarn/cache` (`yarn cache clean --all`,
  safe with the node-modules linker) after install recovered headroom to ~5 GiB for the
  build. Keep ≥4-5 GiB free before a from-scratch reinstall.
- **CI parity:** this mirrors `.github/workflows/production-build-without-database.yml`.
  CI just needs the env block above; no Postgres service container is required.

---

## CV-1 — Auth rewire: dibslist Better-Auth → cal `Session` (DONE, runtime-unverified)

cal's own login/signup are **disabled**. The booking app (`book.dibslist.app`) no
longer authenticates against the cal Postgres `User` table or next-auth credentials.
It trusts the **dibslist Better-Auth session cookie** issued by the main app.

### The flow

```
Browser at book.dibslist.app
  │  (carries the dibslist cookie: better-auth.session_token,
  │   set Domain=.dibslist.app so it reaches the book.* subdomain)
  ▼
getServerSession({ req })                    packages/features/auth/lib/getServerSession.ts
  1. Read the raw Cookie header off the request.
  2. validateDibslistSession(cookieHeader)   packages/features/auth/lib/dibslistSession.ts
        └─ server-to-server fetch:
           GET {DIBSLIST_AUTH_BASE_URL}/api/auth/get-session
           Cookie: <forwarded verbatim>
           → Better Auth (proxied by the dibslist backend's convex/http.ts
             authComponent.registerRoutes pathPrefix "/api/auth/") looks up the
             signed session in the Convex DB and returns { session, user } or
             HTTP 200 `null`. No Origin header (server-to-server) ⇒ bypasses the
             trustedOrigins CORS gate, so book.dibslist.app need NOT be added there.
           → FAIL CLOSED: any non-OK / parse error / null body ⇒ unauthenticated.
  3. getConvex().mutation("scheduling/calcomUsers:resolveOrCreateCalcomUser", {
        authUserId: user.id, email, name, avatarUrl?, username?
     })  → { calId: <stable integer>, _id, created }
        └─ upsert in the dibslist Convex `calcomUserMap` table; calId is minted from
           the monotonic `calcomSeq` counter and is STABLE for the account lifetime.
  4. Build + return the cal `Session` shape:
        - user.id        = calId            (INTEGER — cal's Prisma-Int contract)
        - user.uuid      = dibslist authUserId (string)
        - role           = "USER", org = undefined, profile = UserAsPersonalProfile
        - 60s LRU cache keyed by the better-auth.session_token value.
```

`getUserSession` / `isAuthed` / `ensureSession` / the tRPC `createContext` session are
**unchanged** — they all consume the `Session` this returns, and the shape matches
cal's `next-auth.d.ts` augmentation exactly.

### Client session (`useSession()`)

`apps/web/pages/api/auth/session.ts` (a static route that takes precedence over the
`[...nextauth].ts` catch-all in the same dir) calls `getServerSession` and returns the
cal `Session` JSON (or `{}` when unauthenticated, which the next-auth client treats as
signed-out). So `SessionProvider` / `useSession()` hydrate from the dibslist cookie.

### Login / signup disabled → redirect to dibslist

- `apps/web/server/lib/auth/login/getServerSideProps.tsx` — an unauthenticated visitor
  is redirected to `getDibslistLoginUrl(next)` (`https://dibslist.app/?next=<book URL>`).
  Authenticated visitors still bounce to their `callbackUrl` / `/`. (Prisma + the
  first-admin `/auth/setup` path were removed.)
- `apps/web/app/api/auth/signup/route.ts` — hard-returns **410 Gone** + the dibslist
  signup URL; the prisma/stripe-coupled handlers are no longer imported.

### Required env (booking app)

```dotenv
# Where the dibslist Better-Auth get-session endpoint lives (the Convex .site host).
# If unset, derived from NEXT_PUBLIC_CONVEX_URL by swapping .convex.cloud → .convex.site.
DIBSLIST_AUTH_BASE_URL=https://jovial-meadowlark-781.convex.site

# Convex client target for resolveOrCreateCalcomUser (already in the env block above).
NEXT_PUBLIC_CONVEX_URL=https://jovial-meadowlark-781.convex.cloud

# Where to bounce unauthenticated visitors to sign in. Default https://dibslist.app/
DIBSLIST_LOGIN_URL=https://dibslist.app/
```

**No shared secret is needed for validation** — the get-session proxy is authenticated
purely by the forwarded user cookie. The `resolveOrCreateCalcomUser` mutation is called
unauthenticated-to-Convex (it is server-to-server identity infra; it carries no
`requireAuthUserId` and no `booking_enabled` gate so the map resolves even while the
public booking surface is dark).

### Convex backend side (dibslist repo, packages/backend/convex)

- `schema.ts` — added `calcomUserMap` (authUserId→stable calId + profile snapshot;
  indexes `by_authUserId`, `by_calId`) and `calcomSeq` (monotonic counter).
- `scheduling/calcomUsers.ts` — `resolveOrCreateCalcomUser` (mutation) +
  `getCalcomUserByAuthUserId` / `getCalcomUserByCalId` / `getCalcomUserByEmail` (queries).
- Drift guards: `calcomUserMap` ∈ `_clear.ts` TABLES_TO_WIPE + cascaded in
  `userDeletion.ts` (PII); `calcomSeq` ∈ TABLES_KEPT (never decrements, no cascade).
- ⚠ The new tables require an operator `convex dev --once` push (codegen is PUSH-TO-PROD
  on meadowlark) before the mutation is callable at runtime.

### Runtime status: [R] — needs deploy + a live cross-domain session

This is wired and type-clean but **runtime-unverified**: it needs (a) the Convex backend
deployed (so `scheduling/calcomUsers:resolveOrCreateCalcomUser` exists), (b) the env above
set on the booking app, and (c) a real dibslist Better-Auth session cookie present on
`.dibslist.app` while hitting `book.dibslist.app`. Unit tests cover the Session shape +
fail-closed paths (getServerSession.test.ts) and the Convex map (calcomUsers.test.ts).

---

## CV-2a — Public Booker event meta + slots from Convex (DONE, runtime-unverified)

The public Booker (`/[user]/[type]`) now sources its event meta + available slots from
the dibslist Convex backend instead of Prisma/Postgres.

### Injection points (resolver bodies + SSR loader only — UI/types/client untouched)

- **`packages/lib/server/calcomAdapters.ts` (NEW)** — the Convex↔cal mapping layer:
  - `mapConvexEventToPublicEvent(...)` — builds cal's `PublicEventType`-shaped object.
  - `toGetAvailableSlotsArgs` / `toCalSchedule` / `getCalScheduleFromConvex` — the slot
    IN/OUT adapters.
  - Convex fns addressed by path via `makeFunctionReference` (no `_generated` in the
    fork), same precedent as CV-1's getServerSession.
- **`EventRepository.getPublicEvent`** — body swapped to call `mapConvexEventToPublicEvent`.
  This is the SINGLE entry point for both `viewer.public.event` (via `event.handler.ts`,
  unchanged) and the SSR loader, so neither the tRPC client nor any React component changed.
- **`getSchedule.handler.ts`** — body swapped to call `getCalScheduleFromConvex` instead of
  the Prisma-backed `getAvailableSlotsService()` DI graph.
- **`apps/web/.../[user]/[type]/getServerSideProps.ts`** — `Props.eventData` retyped against
  `EventRepository.getPublicEvent` (its return shape is now the adapter's); `orgBannerUrl`
  hard-set null (no org-banner in our backend).

### Backend reads used

- `scheduling/availableSlots:getAvailableSlots` — PUBLIC, key-less, NOT flag-gated `query`.
  The authoritative anonymous reader: validates existence/active + returns duration + slots.
- `scheduling/eventTypes:getEventTypeBySlug` — OWNER-SCOPED `query` (null for anonymous);
  called best-effort to enrich title/description/location when the OWNER previews their page.

### username ↔ owner-slug decision

cal's URL `/[user]/[type]`: we resolve the backend by the `[type]` segment ONLY (= our flat,
globally-unique Convex `slug`). The `[user]` segment is display-only (profile/theme) and does
NOT scope the lookup — our backend has no public owner-handle (`getEventTypeBySlug` keys on
`slug` alone; the row carries only the internal `ownerAuthUserId`).

### Field-gap defaults (we DEFAULT, not source)

`locations` (from `locationText` or default daily), `bookingFields` (system-only, no custom
fields), host `profile`/`subsetOfUsers` name+avatar (placeholder + `[user]` segment),
`price`/`currency` (0/"usd"), recurring/period/instant/team/org (cal defaults), `id` (0 —
public path keys off slug). Rich meta (real title/desc/host avatars) for anonymous viewers
needs the public-safe DTO endpoint (`/book/api/event-type/{slug}`), which is flag-gated
(`booking_enabled`, DEFAULT-OFF) and returns a field-stripped shape — deferred.

### Build status — TYPE-CLEAN (2026-06-02, local macOS arm64)

| Gate | Result |
|---|---|
| `tsc -p packages/trpc/tsconfig.json --noEmit` | **EXIT 0, 0 errors** (covers event handler → EventRepository → adapter, + slots handler). |
| `tsc -p apps/web/tsconfig.json --noEmit` | **EXIT 0, 0 errors** (covers the SSR loader + the whole Booker consumption chain). |

(`packages/features` standalone tsc has ~89 PRE-EXISTING errors from missing-`.d.ts`/dayjs-plugin
declaration noise unrelated to this change — NOT a clean gate; the trpc + web projects are.)

### Runtime status: [R] — needs deploy + a live request

Type-clean but **runtime-unverified**: needs (a) the Convex backend deployed so
`scheduling/availableSlots:getAvailableSlots` + `scheduling/eventTypes:getEventTypeBySlug`
exist, (b) `NEXT_PUBLIC_CONVEX_URL` set, and (c) a live GET on `/[user]/[type]` against a
real published event type with hosts + a schedule.

## CV-2b — Anonymous public-meta fix + owner-admin → Convex (DONE, runtime-unverified)

Two things: (1) close the CV-2a anonymous-meta gap, and (2) start the owner-admin
read/write rewire onto Convex.

### (1) Anonymous public-meta fix — the real fix for CV-2a's placeholder problem

CV-2a's `mapConvexEventToPublicEvent` could only enrich title/description/host meta when
the VIEWER OWNED the row (the owner-scoped `getEventTypeBySlug` returns null for anyone
else). So anonymous Booker pages showed the slug as the title and a placeholder avatar.

Backend (dibslist repo): added a PUBLIC (registered, no-auth) Convex `query`
**`scheduling/publicApi:getPublicEventTypeBySlug`** — same public-safe projection as the
existing internal `_publicEventType` (delegates to `getPublicEventTypeImpl`), but reachable
by the fork's anonymous `ConvexHttpClient`. Returns the public-safe DTO (title, description,
durationMinutes, location, requireLogin, hosts[{displayName, avatarUrl}]) or `null` for a
missing/inactive event type (no enumeration oracle). NOT gated on `booking_enabled` (the
flag gates the public HTTP SURFACE; this is reached only server-to-server by the trusted
SSR loader). NEVER returns ownerAuthUserId/scheduleId/schedulingType/buffers/limits/flags.

Fork: `packages/lib/server/calcomAdapters.ts` — `mapConvexEventToPublicEvent` now does a
SINGLE public read of `getPublicEventTypeBySlug` (replacing the wasted getAvailableSlots
existence-probe + the always-null owner-scoped read), and populates
`profile.name`/`profile.image`/`subsetOfUsers[0].name`/`.avatarUrl` from the DTO's real
host meta. The owner-scoped `getEventTypeBySlug` read is RETAINED but only runs when an
`authToken` is supplied (owner preview), purely to recover the few owner-only fields the
public DTO omits (`schedulingType`, `requireEmailVerification`, `seatsPerSlot`).
`EventRepository.getPublicEvent` is unchanged (delegates to the adapter). Anonymous
visitors now get real title/description/host name+avatar.

### (2) Owner-admin → Convex

Backend (dibslist repo): the owner-admin handlers in `scheduling/eventTypes.ts` +
`scheduling/schedules.ts` were refactored to split **auth** from **logic** — each handler
now calls a post-auth `*Core(ctx, ownerId, args)` fn. A NEW server-to-server module
**`scheduling/calcomAdmin.ts`** exposes registered `query`/`mutation` fns
(`adminListEventTypes`, `adminGetEventType`, `adminGetEventTypeBySlug`,
`adminCreateEventType`, `adminUpdateEventType`, `adminCreateSchedule`,
`adminUpdateSchedule`, `adminListSchedules`, `adminGetSchedule`, `adminSetAvailability`,
`adminAddDateOverride`, `adminRemoveDateOverride`) that take an EXPLICIT `ownerAuthUserId`
arg (the trusted dibslist authUserId the fork carries on `session.user.uuid`) and delegate
to those cores. This mirrors the established `resolveOrCreateCalcomUser` server-to-server
precedent — no Convex identity JWT is needed (the fork validates the Better-Auth cookie
itself, then passes the authUserId). Ownership is still enforced inside the cores and
WRITES still hit the DEFAULT-OFF `booking_enabled` gate.

Fork: `packages/lib/server/calcomAdminAdapters.ts` (new) + the rewired
`viewer.eventTypes.list` handler (`.../eventTypes/list.handler.ts`). `list` now reads the
owner's event types from `adminListEventTypes` (scoped by `ctx.user.uuid`) and maps each
Convex row → cal's `{id, title, description, length, schedulingType, slug, hidden,
metadata}` item shape (return shape unchanged; consumers + components untouched).

### The id-bijection BLOCKER (why only `list` is rewired so far)

cal keys event types / schedules by a Prisma INTEGER id; Convex uses opaque STRING `_id`s.
For users this was solved by the persistent `calcomUserMap` int↔string map. There is **no
equivalent map for event types / schedules**. So any resolver whose numeric id is
ROUND-TRIPPED back into a Convex write cannot be cleanly rewired — we can't recover the
Convex `_id` from a fabricated int. That covers the whole EDITOR flow:
`viewer.eventTypes.get/create/update/delete`, `viewer.availability.schedule.get/list/
create/update` + `setAvailability`/overrides, and the `/availability/[id]` +
`/event-types/[id]` routes that feed ids back to mutations.

- **`viewer.eventTypes.list` IS rewired** — its consumers (onboarding default-seed, profile
  step) use the id for DISPLAY only and never feed it back to a write, so a stable
  display-only int derived from the Convex `_id` (`convexIdToCalInt`, FNV-1a → positive
  31-bit) is safe.
- **Everything else stays on Prisma for now**, awaiting the follow-up: add
  `eventTypeIdMap`/`scheduleIdMap` tables (mirroring `calcomUserMap`) so the editor's
  numeric ids round-trip to Convex writes — OR migrate the cal routes to string ids (which
  would touch components, out of CV-2b scope). The s2s `calcomAdmin` write fns
  (`adminCreateEventType`, `adminSetAvailability`, …) are already in place for when that map
  lands; the fork resolvers just can't address them by int id yet.

### viewer.me / connectedCalendars — NOT rewired (documented reason)

`viewer.me.get` enriches off the Prisma-sourced `ctx.user` (itself produced by
`getUserSession` → `UserRepository.findUnlockedUserForSession`) plus `secondaryEmail` /
`account` / profile repos. Rewiring it means migrating the `ctx.user` SOURCE off Prisma —
which cascades through every authed resolver, far beyond CV-2b. Left on Prisma.
`viewer.calendars.connectedCalendars` depends on the cal credential/app-store graph that our
`calendarOauth`/`listConnectedCalendars` Convex fns model differently (shape mismatch +
`isDestination` not user-settable, RECON gaps #3–#5); a faithful map is its own milestone.

### Defaults supplied for cal fields our backend lacks (eventTypes.list)

- `metadata` → `null` (no per-event metadata JSON blob in our `eventTypes` row).
- `schedulingType` → mapped lowercase→cal enum (`COLLECTIVE`/`ROUND_ROBIN`/`MANAGED`), or
  `null` when absent.
- `id` → display-only FNV-1a int of the Convex `_id` (see id-bijection blocker above).

### Build status — TYPE-CLEAN (2026-06-02, local macOS arm64)

| Gate | Result |
|---|---|
| dibslist `tsc -p convex/tsconfig.json` | **EXIT 0** |
| dibslist `vitest publicApi + eventTypes + schedules + calcomAdmin` | **64 passed** (incl. 4 CV-2b public-query + 7 s2s admin) |
| fork `tsc -p packages/trpc/tsconfig.json --noEmit` | **EXIT 0, 0 errors** |
| fork `tsc -p apps/web/tsconfig.json --noEmit` | **EXIT 0, 0 errors** |

### Runtime status: [R] — needs deploy + a live request

Type-clean but **runtime-unverified**: needs the backend deployed so
`scheduling/publicApi:getPublicEventTypeBySlug` + `scheduling/calcomAdmin:*` exist, then
(a) a live GET on `/[user]/[type]` to confirm anonymous real-meta, and (b) a signed-in load
of the event-types list page to confirm `viewer.eventTypes.list` returns the owner's Convex
event types.

## CV-2c — int↔string id map + the FULL owner-admin editor rewire (DONE, runtime-unverified)

Closes the CV-2b id-bijection blocker and rewires the entire EDITOR + AVAILABILITY +
`me.get` + `connectedCalendars` read/write flow onto Convex.

### (1) The id map (dibslist backend, `packages/backend/convex`)

cal keys event types / schedules by a Prisma INTEGER id that is ROUND-TRIPPED (a GET
returns the int; the editor feeds the SAME int back into update/delete). Convex uses
opaque STRING `_id`s. CV-2c adds the persistent bijection, mirroring CV-1's
`calcomUserMap`/`calcomSeq`:

- `schema.ts`: `eventTypeIdSeq` / `scheduleIdSeq` (single-row monotonic counters, KEPT on
  wipe — never decrement) + `eventTypeIdMap` / `scheduleIdMap` (`convexId` ↔ `calId` +
  denormed `ownerAuthUserId`; indexes `by_convexId`, `by_calId`, `by_owner`).
- `scheduling/calcomIdMaps.ts` (NEW): `resolveEventTypeCalId` / `resolveScheduleCalId`
  (mutations — atomic read-bump-write of the seq inside one mutation, exactly like
  `resolveOrCreateCalcomUser`) + `getEventTypeByCalId` / `getScheduleByCalId` (reverse) +
  `get*CalIdByConvexId`. Each fn's logic is also exported as a bare `*Impl` for the
  FakeDb-harness tests.
- Drift guards: maps ∈ `_clear.ts` TABLES_TO_WIPE + cascaded in `userDeletion.ts` (by_owner)
  + listed in `userDeletion.drift.test.ts` ADDITIONAL_USER_KEYED_TABLES; seqs ∈ TABLES_KEPT
  (no PII, must never decrement).
- `scheduling/calcomAdmin.ts`: every read/create now ENRICHES rows with the stable `calId`
  (minting on first sight) — create returns `{ _id, calId }`. Every mutation that takes an
  id now accepts EITHER the Convex string `id` OR the round-tripped cal int
  (`calEventTypeId` / `calScheduleId`), resolving the int → Convex `_id` server-side. NEW
  `adminDeleteEventType` (soft-delete = `active:false`, matching cal's "delete from list")
  and NEW `adminListConnectedCalendars` (s2s wrapper over the extracted
  `listConnectedCalendarsCore` in calendarOauth.ts).
- Tests: `calcomIdMaps.test.ts` (bijection round-trip, idempotence, stability/monotonicity,
  no-reuse-after-delete, independent counters) + new round-trip + connected-calendars cases
  in `calcomAdmin.test.ts`.

### (2) Fork resolver/repo/loader rewires (cal components + tRPC client + types UNTOUCHED)

`packages/lib/server/calcomAdminAdapters.ts` (extended): the id-map fn refs + round-trip
helpers (`getOwnerEventTypeByCalId`, `createOwnerEventType`, `updateOwnerEventTypeByCalId`,
`deleteOwnerEventTypeByCalId`, `listOwnerSchedules`, `getOwnerScheduleByCalId`,
`createOwnerSchedule`, `updateOwnerScheduleByCalId`, `setOwnerAvailabilityByCalId`,
`addOwnerDateOverrideByCalId`) + cal-shape mappers (`toCalAvailabilityRows`,
`getDetailedScheduleFromConvex`, `updateScheduleFromConvex`,
`mapConvexConnectedCalendars`, `listOwnerConnectedCalendars`). All keyed on the PERSISTENT
`calId` (not the FNV-1a display hash, which is retained only for the legacy
`eventTypes.list`).

Rewired bodies (resolver/repo/loader only):

- **Event types** — `viewer.eventTypes.get` (→ `getEventTypeById` gained an
  `ownerAuthUserId` param; `getRawEventType` resolves calId→Convex row via
  `adminGetEventType` and OVERLAYS the core fields onto the raw row, synthesizing a default
  base in the no-Postgres fork), `eventTypesHeavy.create` (→ `adminCreateEventType`,
  returns a cal-`EventType`-cast object whose `id` = the new `calId` so the
  `/event-types/${id}` redirect round-trips), `eventTypesHeavy.update`
  (handler path — `id: eventType.id` is the round-tripped calId → `adminUpdateEventType`
  by `calEventTypeId`), `eventTypes.delete` (→ `adminDeleteEventType`). The
  `/event-types/[type]` SSR loader auto-rewires (it routes through the tRPC `get` caller).
- **Availability / schedules** — `availability.schedule.get` (→
  `getDetailedScheduleFromConvex`, reproduces `findDetailedScheduleById`'s projection via
  cal's own atom transforms), `availability.list` (→ `listOwnerSchedules`),
  `availability.schedule.create` (→ `createOwnerSchedule` + `setOwnerAvailability`,
  returns `schedule.id` = new `calId`), `availability.schedule.update` (handler path —
  splits the input into weekly windows + date overrides, writes via
  `updateScheduleFromConvex`; `setAvailability` + add-date-override are folded into this
  one save path, matching cal's `ScheduleService.update`). The `/availability/[schedule]`
  SSR loader auto-rewires (routes through the tRPC `schedule.get` caller).
- **`viewer.me.get`** — dropped the Prisma hits (ProfileRepository,
  `enrichUserWithTheProfile`, `secondaryEmail`, `account`, password). `ctx.user` is already
  Convex-sourced (CV-1), so the real fields flow off it; gaps default (see table below).
- **`viewer.calendars.connectedCalendars`** — reads `adminListConnectedCalendars` and maps
  the Convex `selectedCalendars` shape → cal's CalendarManager wire shape.

### Shape mappings + defaults (documented)

**Editor event type (get/create):** `id`=stable `calId`; `title`/`slug`/`description`/`length`
(=durationMinutes)/`hidden` from Convex; `schedulingType` lowercase↔cal enum (default
COLLECTIVE→`collective`); `scheduleId` round-trips as `calScheduleId`. DEFAULTS (our backend
doesn't model): `metadata`→null, buffers/notice → 0/0/120 on create, plus the whole rich
Prisma-only surface (locations/customInputs/recurring/periods/team/hosts/children/webhooks)
synthesized from a cal default base in `buildDefaultRawEventType` (the editor re-derives most
client-side after the redirect).

**Availability `schedule.get`:** `id`=`calId`, `name`/`timeZone` from Convex,
`workingHours`/`availability`/`dateOverrides` derived by cal's atom transforms from
`toCalAvailabilityRows` (Convex minute-windows → Prisma-`Availability`-shaped UTC Dates;
override `dateUtc`→`date`; relational ids `{id,userId,eventTypeId,scheduleId}` are placeholder
0/null — never read by the editor). DEFAULTS: `isManaged`/`readOnly`→false (no teams),
`isDefault` from the schedule's own flag, `isLastSchedule` from the count.

**`schedule.update` response:** `schedule.{id,userId,name,timeZone}` + `availability` (atom) +
`isDefault`/`prevDefaultId`/`currentDefaultId` (off the cal user's `defaultScheduleId`; our
backend owns the default FLAG on the schedule row, not a `user.defaultScheduleId`).

**`me.get`:** real off `ctx.user` — `id`(=calId)/`email`/`name`/`username`/`timeZone`/`locale`/
`weekStart`/`bio`/`avatar`/`defaultScheduleId`/`completedOnboarding`. DEFAULTS:
`identityProviderEmail`=""/`passwordAdded`=false (Better-Auth owns login), `secondaryEmails`=[],
`canUpdateTeams`=false, single personal `profile` (no org), `organizationId`=null.

**`connectedCalendars`:** `integration.{slug,name,logo,type,title}` synthesized from
`provider` (google→google-calendar, caldav→caldav-calendar); `credentialId`=FNV-1a int of the
Convex `_id` (DISPLAY only); per-calendar `externalId`←externalCalendarId,
`name`←displayName, `isSelected`←checkForConflicts, `primary`←isDestination;
`destinationCalendar` = first `isDestination` row. DEFAULTS: `readOnly`=false,
`delegationCredentialId`=null, `cacheUpdatedAt`=null; an `invalid` credential → `error:{message}`
+ empty calendars.

### Int↔string round-trip — VERIFIED by tests

`calcomIdMaps.test.ts` + the new `calcomAdmin.test.ts` cases prove the bijection holds for the
**create → edit → save** flow: create mints `calId`; a GET by `calEventTypeId`/`calScheduleId`
returns the SAME underlying Convex `_id`; an update/setAvailability by that int patches the
same row; the counter is monotonic + never reused.

### Build status — TYPE-CLEAN (2026-06-02, local macOS arm64)

| Gate | Result |
|---|---|
| dibslist `tsc -p convex/tsconfig.json` | **EXIT 0** |
| dibslist `vitest scheduling/` | **258 passed** (19 files; incl. 11 id-map + new round-trip + connected-cal) |
| fork `tsc -p packages/trpc/tsconfig.json --noEmit` | **EXIT 0, 0 errors** |
| fork `tsc -p apps/web/tsconfig.json --noEmit` | **EXIT 0, 0 errors** |

(PRE-EXISTING, UNRELATED: `convex/_clear.test.ts` + `convex/userDeletion.drift.test.ts` each
have ONE failing case for `apiIdempotencyKeys`/`apiSpendLog`/`mobileDevices` — schema tables
from the dev-API + mobile initiatives that predate this branch and were never added to the
`_clear.ts` allowlists. CV-2c's new tables ARE covered; these 3 are tracked separately.)

### DEFERRED (honest)

- **Calendar conflict-toggle / set-destination / disconnect MUTATIONS.** The
  connectedCalendars READ is rewired, but the toggle (`POST/DELETE /api/availability/calendar`),
  destination dropdown (`setDestinationCalendar` handler), and disconnect
  (`viewer.credentials.delete`) still hit Prisma. Convex has `setCalendarConflictFlag` but no
  `setDestinationCalendar` / `disconnectCalendar` mutation yet, and `credentialId` is a STRING
  Convex `_id` while the cal mutations expect the integer — the FNV-1a display int does NOT
  round-trip for a write. Wiring these needs (a) new Convex mutations and (b) a credential
  int↔string map (or switching those cal call-sites to the string id). Out of CV-2c scope.
- **`availability.schedule.delete`** — left on Prisma (no `deleteSchedule` Convex fn; the
  reassign-default cascade is non-trivial). Not in the CV-2c task list.
- **`getEventTypeById` rich Prisma-only surface** — the editor's advanced tabs
  (locations/limits/recurring/team/hosts/webhooks/calVideo) render off the synthesized default
  base, not real Convex data (our backend doesn't model them). The CORE round-trip
  (id/title/slug/description/length/hidden/schedule) is real.
- **`getScheduleByEventTypeSlug`** — its slug→scheduleId lookup is still Prisma; it forwards to
  the Convex-backed `schedule.get`, so the `scheduleId` it passes is treated as a calId at
  runtime. Not in the CV-2c list; type-clean only.

### Runtime status: [R] — needs deploy + a live editor session

Type-clean + unit-tested but **runtime-unverified**: needs (a) the backend deployed so
`scheduling/calcomIdMaps:*` + the new/changed `scheduling/calcomAdmin:*` fns exist, (b)
`NEXT_PUBLIC_CONVEX_URL` set, and (c) a signed-in editor session to confirm the live
create→edit→save round-trip + the availability editor + `me.get` + the connected-calendars
list render against real Convex data.

---

## CV-3 — booking CREATE rewire (cal Booker → Convex `createBookingPublic`)

**Goal:** route the cal Booker's candidate booking-create off cal's
`RegularBookingService.createBooking` (Postgres/Prisma + `handleNewBooking`) onto the dibslist
Convex backend, returning a cal `BookingResponse` complete enough for the Booker success flow.
cal's `handleNewBooking` / `RegularBookingService` is SKIPPED on this path.

### What changed

**dibslist backend (`packages/backend/convex/scheduling/publicApi.ts`):**
- NEW public mutation **`createBookingPublic`** (registered `mutation`, reachable via
  `getConvex().mutation(...)`). `createBooking` (scheduling/booking.ts) + `_createBooking` are
  both `internalMutation` by design, so this is the public client door. It wraps the existing
  `createBookingImpl` → `createBookingHandler`, so it KEEPS: the DEFAULT-OFF `booking_enabled`
  flag gate (dark before launch), idempotency dedupe, the authoritative write-time slot-conflict
  re-check (`slot_unavailable`), and the E4 email-verification + single-use-link gates. It does
  NOT carry the httpAction's IP-rate-limit + Turnstile — those stay in `bookCreateHandler`; this
  mutation is reached ONLY server-to-server by the trusted cal route (same trust model as
  `getPublicEventTypeBySlug`), and the cal route runs its own bot-detection + core rate-limit first.
- `CreateBookingConfirmation` (and `createBookingImpl`'s return) EXTENDED with public-safe echo
  fields so the cal OUT adapter builds a complete `BookingResponse` from ONE round-trip:
  `eventTitle`, `eventLocation`, `start`, `end`, `bookerName`, `bookerEmail`, `bookerTimeZone`,
  `notes`. (The existing httpAction return is backward-compatible — additive only.)
- New convex-test block in `publicApi.test.ts` ("createBookingPublic — CV-3 …"): asserts the
  enriched confirmation, that the flag gate STILL refuses when off (`booking_disabled`),
  idempotency on a repeat key, and `slot_unavailable` on a conflicting second create.

**cal fork:**
- NEW `packages/lib/server/convexBookingAdapter.ts` — the IN/OUT adapters + error mapping +
  `createBookingViaConvex()` (the top-level IN → `createBookingPublic` → OUT).
- `apps/web/pages/api/book/event.ts` — the create call now `createBookingViaConvex(req.body)`
  instead of `getRegularBookingService().createBooking(...)`. The cal-side guards (Turnstile,
  bot detection, core rate-limit) are PRESERVED upstream; the unused `getServerSession` import +
  `session` lookup were dropped (the candidate path is anonymous).

### IN adapter (cal body → Convex `createBookingPublic` body)

`mapCalBookingBodyToConvexCreate(body)`:
- `slug` ← `body.eventTypeSlug` (the mapper sets `eventTypeSlug: event.slug`)
- `start`/`end` ← `Date.parse(body.start)` / `Date.parse(body.end)` (ISO → epoch-ms)
- `name` ← `body.responses.name` flattened (string OR `{firstName,lastName}`), fallback `body.name`
- `email` ← `body.responses.email` (fallback `body.email`)
- `notes` ← `body.responses.notes` (fallback `body.notes`)
- `timeZone` ← `body.timeZone` (default `"UTC"`)
- `verificationCode` ← `body.verificationCode` (E4 pass-through)
- `idempotencyKey` ← `cal:{slug}:{startMs}:{email}` (a retried identical POST dedupes server-side)
- `holderToken` ← `""` (cal's hold model differs; createBooking tolerates an empty hold — the
  write-time conflict re-check is authoritative)
- Missing slug/start/end/name/email → `HttpError(400)` (clean 400 to the Booker).

### OUT adapter (Convex confirmation → cal `BookingResponse`) — the mapping

`mapConvexConfirmationToBookingResponse(confirmation, { eventTypeId })` returns (cast
`as unknown as BookingResponse` — the Prisma-derived type is far wider than the consumed fields;
the `/booking/{uid}` success page re-fetches fresh DB data, so only these fields ride the wire):

```
id: 0,                                  // success page keys off uid, not id
uid: String(confirmation.bookingId),
title: confirmation.eventTitle,
startTime: new Date(confirmation.start),   // Date; defaultResponder serializes → ISO string
endTime: new Date(confirmation.end),
status: confirmation.status === "accepted" ? "ACCEPTED" : "PENDING",  // cal enum is uppercase
location: confirmation.eventLocation,
description: confirmation.notes,
responses: { name: bookerName, email: bookerEmail, ...(notes ? { notes } : {}) },
metadata: null,
attendees: [{ id: 0, email: bookerEmail, name: bookerName, timeZone: bookerTimeZone,
              locale: null, phoneNumber: null, bookingId: null, noShow: false }],
user: { id: 0, name: eventTitle, email: null, timeZone: bookerTimeZone, username: null },
userId: null, userUuid: null, userPrimaryEmail: null,
eventTypeId,                            // from body.eventTypeId
paid: false,
paymentRequired: false,                 // → success page, never the payment redirect
cancellationReason: null, rescheduled: false, fromReschedule: null,
recurringEventId: null, isRecurring: false,
iCalUID: `${uid}@dibslist.app`, iCalSequence: 0,
oneTimePassword: null, smsReminderNumber: null,
scheduledJobs: [], references: [], payment: [],
isDryRun: false,                        // dry-run gate → false (real booking)
seatReferenceUid: undefined,
videoCallUrl: undefined,
previousBooking: null,
// (no paymentUid → no Stripe redirect; no isShortCircuitedBooking → normal success path)
```

**Success-flow coverage — every field the Booker reads is present:**
- `useBookings.onSuccess`: `uid`, `id`, `title`, `startTime`, `endTime`, `eventTypeId`,
  `status` (→ compared to `BookingStatus.PENDING`), `videoCallUrl`, `paymentRequired`,
  `isRecurring`, `paymentUid` (ABSENT → no payment redirect), `seatReferenceUid`,
  `userPrimaryEmail` + `user.email`/`user.timeZone`, `attendees[0]`, `isDryRun` (false),
  `isShortCircuitedBooking` (absent → normal path), `location`. ✔
- `bookingSuccessRedirect` (`SuccessRedirectBookingType`): `uid`, `title`, `description`,
  `startTime`, `endTime`, `location`, `attendees`, `user`, `responses`. ✔

### Error mapping (Convex kind → cal HttpError the Booker renders)

`mapConvexBookingError(err)`:
- `slot_unavailable` → **`HttpError(409, ErrorCode.NoAvailableUsersFound)`** — the canonical
  "slot no longer available / no host free" error the Booker already shows on conflict.
- `booking_too_soon` / `outside_booking_window` / `invalid_duration` → `400 BookingTimeOutOfBounds`
- `event_type_not_found` / `event_type_inactive` → `404 EventTypeNotFound`
- `booking_disabled` → `404 NotFound` (dark launch — whole surface off)
- `email_verification_required` → `400 InvalidVerificationCode`
- `invalid_request` → `400` (message passthrough, fallback `RequestBodyInvalid`)
- else → `500 InternalServerError`
- A `HttpError` already thrown by the IN adapter (bad body) passes through unchanged.

### Side-effects confirmation (post-deploy)

The Convex `createBookingPublic` → `createBookingImpl` → `createBookingHandler` schedules, INSIDE
the same ACID mutation (Step 8 `scheduleBookingSideEffects` + Step 7b reminder rows), assuming
`booking_enabled` ON and (for calendar/email) the host has a connected Google credential +
`EMAIL_API_KEY` set:
- **Google Calendar write** per connected host (`syncToCalendars`, real, with backoff retry +
  organizer reconnect notice on failure). A host with NO connected Google credential is silently
  skipped — the booking still commits and the cal success screen still shows.
- **Confirmation email + `.ics`** to the booker via Brevo (`sendNotification`; requires
  `EMAIL_API_KEY`, else skipped with a warn). The `.ics` is also returned in the confirmation.
- **In-app "New booking" notification** to the organizer (always, post-codegen).
- **Signed `booking.created` webhook** to any registered endpoints (real dev-API HMAC infra;
  the `internal.webhooks._emitEvent` ref is NOT behind the codegen nil-guard, so it fires
  regardless of `booking_enabled` once an owner has endpoints).
- **Reminder rows** (confirmation now + 24h-before) for the A8 sweep, inserted atomically.

These are the side effects the cal success screen assumes. Two structural caveats carried over
from the F1 build: (1) the calendar sync + email scheduler calls sit behind a codegen-pending
nil-guard, so they fire only AFTER a deploy that regenerates `_generated/api.d.ts` (the webhook
call is not behind that guard); (2) SMS is a no-op until the deploy-auth schema adds `phone` to
`bookingAttendees`.

### Build status — TYPE-CLEAN (2026-06-02, local macOS arm64)

| Gate | Result |
|---|---|
| dibslist `tsc -p convex/tsconfig.json` | **EXIT 0, 0 errors** |
| dibslist `vitest scheduling/` | **262 passed** (19 files; +4 new CV-3 `createBookingPublic` cases) |
| dibslist `vitest scheduling/publicApi.test.ts scheduling/booking.test.ts` | **45 passed** |
| fork `tsc -p packages/trpc/tsconfig.json --noEmit` | **EXIT 0, 0 errors** (baseline-clean) |
| fork `tsc -p apps/web/tsconfig.json --noEmit` | **EXIT 0, 0 errors** (baseline-clean) |

### Runtime status: [R] — needs deploy + a live Booker session

Type-clean + unit-tested but **runtime-unverified**. To go live needs: (a) the backend deployed
so `scheduling/publicApi:createBookingPublic` exists + `_generated` is regenerated (un-gating the
calendar/email side-effect nil-guard), (b) the `booking_enabled` flag flipped ON (else every
create returns `booking_disabled` → the route 404s), (c) `NEXT_PUBLIC_CONVEX_URL` set on the
fork, and (d) a live Booker submit to confirm the end-to-end create → `/booking/{uid}` success
screen + the Google Calendar write + confirmation email + webhook. The httpAction
(`POST /book/api/booking`) remains the path for any raw browser/public booking client.

---

## CV-4 — bookings DASHBOARD rewire (cal `/bookings` list + host actions → Convex)

**Goal:** route the cal owner's `/bookings` list (`viewer.bookings.get`) + the two host
actions that have a Convex equivalent (**cancel**, **requestReschedule**) off cal's
Postgres/Prisma + Kysely union query onto the dibslist Convex backend, returning rows
complete enough for the cal list row (`BookingItemProps`) + detail sheet.

### What changed

**dibslist backend (`packages/backend/convex/scheduling/bookingAdmin.ts`, NEW):**
- **`listBookings`** (registered `query`, reached via `getConvex().query(...)`) +
  `listBookingsCore` (bare fn for tests). Owner-scoped by an EXPLICIT `ownerAuthUserId`
  arg (the trusted dibslist authUserId; mirrors the `calcomAdmin` s2s trust model — NO
  Convex identity). Scans the `by_owner_startTime` index bounded by `[after, before]` on
  `startTime`, post-filters by the cal status TAB in JS (`bookingMatchesStatus`), then
  `.paginate(paginationOpts)`. Each surviving row joins its `bookingAttendees` (by_booking
  index) + a minimal `eventType` snapshot (`{_id, slug, title, durationMinutes,
  locationText, schedulingType}`). NOT flag-gated (a read is harmless dark; only shown to a
  signed-in owner).
- **`adminCancelBooking`** + **`adminRescheduleBooking`** (registered `mutation` s2s
  wrappers — mirror `createBookingPublic`'s "public door over an internalMutation handler"
  pattern). `cancelBooking` / `rescheduleBooking` (scheduling/booking.ts) are
  `internalMutation` (F1 httpAction gate); these wrappers (1) re-check
  `booking.ownerAuthUserId === ownerAuthUserId` → `booking_not_found` on mismatch, then (2)
  delegate to `cancelBookingHandler` / `rescheduleBookingHandler`. The DEFAULT-OFF
  `booking_enabled` flag gate + the status-transition guards live INSIDE those handlers and
  still hold. `adminRescheduleBooking.holderToken` is optional (owner holds no
  `bookingHolds` row — the conflict re-check is authoritative).
- Tests (`bookingAdmin.test.ts`, NEW, 20 cases): `bookingMatchesStatus` tab projection;
  `listBookingsCore` attendee/event-type join, each status tab (upcoming/past/cancelled/
  unconfirmed/recurring-empty), time window, owner-scoping, multi-page pagination
  (cursor+isDone); `adminCancelBooking` happy/ownership-guard/flag-gate; `adminReschedule
  Booking` happy reslot (old→rescheduled, new accepted) / ownership-guard. Harness =
  FakeDb + a `.paginate()` shim (cursor = offset-as-string).
- **Additive + drift-safe:** NO schema change — reuses existing `bookings` /
  `bookingAttendees` tables + the existing `by_owner_startTime` / `by_booking` indexes. No
  new tables, so no `_clear.ts` / `userDeletion.ts` cascade entries needed.

**cal fork:**
- **`packages/lib/server/convexBookingsListAdapter.ts` (NEW)** — the IN/OUT adapters:
  `listBookingsViaConvex` (cal `get` filters → `listBookings` → cal `{bookings, recurringInfo,
  totalCount, nextCursor}`), `cancelBookingViaConvex` (→ `adminCancelBooking`),
  `requestRescheduleViaConvex` (→ `adminCancelBooking`, status-change only). Convex fns
  addressed by path via `makeFunctionReference` (no `_generated` in the fork).
- **`viewer.bookings.get` (`.../bookings/get.handler.ts`)** — `getHandler` body swapped to
  `listBookingsViaConvex({ ownerAuthUserId: ctx.user.uuid, ... })`. The Prisma/Kysely
  `getAllUserBookings`/`getBookings` union query is retained in-file for types/reference but
  SKIPPED. Return shape unchanged → the tRPC client + React `/bookings` page untouched.
- **`viewer.bookings.requestReschedule` (`requestReschedule.handler.ts`)** — body swapped
  to `requestRescheduleViaConvex` (STATUS change only). The whole Prisma-coupled flow
  (BookingRepository, calendar/video teardown, reschedule-link email, BOOKING_CANCELLED
  webhook) is dropped. Convex `booking_not_found`/`cannot_cancel_status`/`booking_disabled`
  → `FORBIDDEN`/`BAD_REQUEST`/`NOT_FOUND` tRPC errors.
- **`/api/cancel` (`apps/web/app/api/cancel/route.ts`)** — `handleCancelBooking` swapped to
  `cancelBookingViaConvex({ ownerAuthUserId: session.user.uuid, bookingUid })`. The CSRF +
  core rate-limit + uid-only guards are PRESERVED. Now requires a signed-in owner (returns
  401 otherwise); the anonymous booker-cancel-by-token path stays on the booking httpAction
  (`bookCancelHandler`).

### List/detail shape mapping (Convex row → cal booking row)

`mapConvexRowToCalBooking(row)` — every field the list row (`BookingItemProps`) + detail
sheet consume that maps onto our data, with safe defaults for the Prisma-only surface:
- `uid` = `String(booking._id)` (CV-3 contract); `id` = display-only FNV-1a int of `_id`
  (the list + detail sheet key off `uid`, never the int).
- `startTime`/`endTime` → `new Date(epochMs).toISOString()` (cal's handler did `toISOString()`).
- `status` → cal `BookingStatus` (accepted→ACCEPTED, pending→PENDING, cancelled→CANCELLED,
  **rescheduled→CANCELLED** — cal lumps rescheduled-away bookings in its CANCELLED tab).
- `title` ← eventType snapshot title; `location` ← `locationText`; `description`/`responses.notes`
  ← `bookerNotes`; `responses.{name,email}` ← the booker attendee.
- `attendees[]` ← booker+guest `bookingAttendees` rows (`{id(FNV),name,email,timeZone,phoneNumber:
  null,noShow:false,locale:null,user:null}`); host rows are NOT surfaced as attendees.
- `eventType` ← snapshot (`id`(FNV)/`slug`/`title`/`length`(=durationMinutes)/`schedulingType`
  lowercase→cal enum); rich Prisma-only fields DEFAULT (`price`0/`currency`"usd"/`metadata`{}/
  `bookingFields`null/`seats*`null/`team`null/`hosts`[]/`disableCancelling`false/…).
- `fromReschedule` ← `String(rescheduledFromBookingId)`; `rescheduled` ← booking is terminal
  rescheduled-away.
- DEFAULTED (Prisma-only, our backend lacks): `user`(host)=null, `userPrimaryEmail`=null,
  `recurringEventId`=null, `paid`=false, `references`/`payment`/`seatsReferences`/
  `assignmentReasonSortedByCreatedAt`=[], `report`=null, `cancelledBy`/`rescheduledBy`/
  `rescheduler`/`cancellationReason`/`rejectionReason`=null, `customInputs`/`metadata`=null,
  `isRecorded`=false. The detail sheet's separate `getBookingDetails` query (previousBooking /
  rescheduledToBooking / tracking) is NOT rewired — left on its current path.

### Status-tab + pagination mapping

- cal tabs → our 4-state model (`bookingMatchesStatus`, mirrors cal's `addStatusesQueryFilters`):
  `upcoming` = live(accepted|pending) ∧ endTime≥now; `past` = live ∧ endTime≤now; `cancelled`
  = cancelled|rescheduled; `unconfirmed` = pending ∧ endTime≥now; **`recurring` = always empty**
  (no recurring model — the fork short-circuits to an empty page).
- **Pagination shim:** cal pages by offset (`skip`) / cursor-as-offset; Convex pages by an
  opaque cursor. The adapter maps `skip` ↔ the Convex cursor (our backend's `.paginate()`
  cursor; the test FakeDb defines it AS offset-as-string), requests `take` items, and rebuilds
  `nextCursor = String(skip + page.length)` when `!isDone`. `totalCount` is best-effort (no full
  COUNT): exact `skip+page.length` on the last page, else a `+1` sentinel so the infinite query
  keeps paging.
- **Known caveat (carried from the backend):** status post-filter runs AFTER `.paginate()`, so a
  page may be SMALLER than `take` when many scanned rows are on a different tab. Acceptable at
  pilot scale; a `by_owner_status_startTime` composite index is the O(page) follow-up. The fork
  relies on `nextCursor`/`isDone`, not exact page size, so short pages are tolerated.

### Host actions — Convex vs DEFERRED

| Cal host action | Convex op | Status |
|---|---|---|
| `cancel` (`/api/cancel`) | `adminCancelBooking` | **ON Convex** (owner-scoped; CSRF+rate-limit kept; requires signed-in owner) |
| `requestReschedule` (tRPC) | `adminCancelBooking` (status change only) | **ON Convex (partial)** — STATUS change routed; attendee reschedule-link EMAIL/token flow + old-slot calendar/video teardown have NO Convex equivalent → **DEFERRED** |
| `rescheduleBooking` (direct host reslot) | `adminRescheduleBooking` (backend built) | Backend wrapper EXISTS + tested; not wired to a fork resolver (cal's direct host reslot goes through the public Booker reschedule flow, separate path) |
| `confirm` (accept/reject pending) | — | **DEFERRED** (no requiresConfirmation model) |
| `editLocation` | — | **DEFERRED** (no post-create location-update + calendar-sync op) |
| `markNoShow` | — | **DEFERRED** (no `noShow`/`noShowHost` fields) |
| `addGuests` | — | **DEFERRED** (no post-create add-guest op) |

The four fully-deferred actions (`confirm`, `editLocation`, `markNoShow`, `addGuests`) keep
their CURRENT cal/Prisma resolver path UNCHANGED.

### Build status — TYPE-CLEAN + TESTED (2026-06-02, local macOS arm64)

| Gate | Result |
|---|---|
| dibslist `tsc -p convex/tsconfig.json` | **EXIT 0, 0 errors** (baseline-clean) |
| dibslist `vitest scheduling/bookingAdmin.test.ts` | **20 passed** (new file) |
| dibslist `vitest scheduling/` | **282 passed** (20 files; was 262 — +20 new CV-4) |
| fork `tsc -p packages/trpc/tsconfig.json --noEmit` | **EXIT 0, 0 errors** (baseline-clean) |
| fork `tsc -p apps/web/tsconfig.json --noEmit` | **EXIT 0, 0 errors** (baseline-clean) |

### Runtime status: [R] — needs deploy + a live owner session

Type-clean + unit-tested but **runtime-unverified**. To go live needs: (a) the backend deployed
so `scheduling/bookingAdmin:listBookings` / `adminCancelBooking` / `adminRescheduleBooking`
exist, (b) the `booking_enabled` flag flipped ON (cancel/reschedule WRITES return
`booking_disabled` while dark; `listBookings` reads fine either way), (c) `NEXT_PUBLIC_CONVEX_URL`
set on the fork, and (d) a signed-in owner with real Convex bookings to confirm the live
`/bookings` list (each tab) + the detail sheet + an owner cancel + a host requestReschedule
against real data.

---

## CV-5 — calendar disconnect / set-destination / conflict-toggle + schedule.delete → Convex

**Goal:** close the four deferred calendar/schedule WRITE paths CV-2c left on Prisma (they
THROW at runtime — no Postgres). Route them onto Convex via the established
`getConvex()` + `makeFunctionReference` + s2s owner-admin pattern (ownership re-checked inside
each Convex core). The cal frontend, the tRPC client, and the zod input/output schemas are
UNTOUCHED — only resolver/route/repo bodies + the adapter layer changed, plus additive Convex fns.

### The credential id problem — SOLVED with a credentialIdMap (paths 1 & 3)

cal's `connectedCalendars` read hands the UI a NUMERIC `credentialId`, and two write paths round
that int back: DISCONNECT (`viewer.credentials.delete` → `{ id }`, the bare int) and CONFLICT-
TOGGLE (`/api/availability/calendar` POST/DELETE → `{ credentialId }`). CV-2c's read used the
DISPLAY-ONLY `convexIdToCalInt` (FNV-1a), which is NOT reversible — so a write keyed by the int
could not recover the Convex `_id`. **NEW Convex `calendarCredentialIdMap` + `calendarCredentialIdSeq`**
(mirroring `eventTypeIdMap`/`scheduleIdMap` VERBATIM) mint a STABLE, reversible int per
`calendarCredentials._id`. The connectedCalendars READ now mints/fetches that int
(`adminResolveCredentialCalIds`, a mutation — the list query can't write) and feeds it into
`mapConvexConnectedCalendars(creds, calIdByConvexId)`, so the UI's `credentialId` round-trips.

- SET-DESTINATION (path 2) keys on `integration` + `externalId` STRINGS (no credential int) → **no map needed**.
- SCHEDULE-DELETE (path 4) keys on the schedule int → **reuses the EXISTING `scheduleIdMap`** (no new map).

### Convex backend (UNCOMMITTED — matches CV-1..CV-4 scope)

`packages/backend/convex/` (additive; new tables drift-guarded; behind DEFAULT-OFF `booking_enabled`):
- **`schema.ts`** — NEW `calendarCredentialIdSeq` (single-row counter, KEPT) + `calendarCredentialIdMap`
  (per-owner map; `by_convexId`/`by_calId`/`by_owner`). Registered in `_clear.ts` (map→`TABLES_TO_WIPE`,
  seq→`TABLES_KEPT`), cascaded in `userDeletion.ts purgeUserData` (by_owner), allowlisted in
  `userDeletion.drift.test.ts` (`ADDITIONAL_USER_KEYED_TABLES`). The pre-existing drift failures
  (`apiIdempotencyKeys`/`apiSpendLog`/`mobileDevices`, unrelated dev-API/mobile tables) are unchanged —
  CV-5 adds ZERO new drift failures.
- **`scheduling/calcomIdMaps.ts`** — `resolveCalendarCredentialCalId(Impl)` + `getCalendarCredentialByCalId(Impl)`
  + `getCalendarCredentialCalIdByConvexId(Impl)` (identical generic helpers; same monotonic-never-reuse semantics).
- **`scheduling/calendarOauth.ts`** — `setDestinationCalendarCore` + owner mutation `setDestinationCalendar`
  (flip `isDestination`, clear prior destination — single-destination-per-owner invariant);
  `disconnectCalendarCore` + owner mutation `disconnectCalendar` (delete credential + cascade
  `selectedCalendars` by_credential + `freebusyCache` by_credential); `setCalendarConflictFlagCore`
  (the existing `setCalendarConflictFlag` mutation body factored out for s2s reuse — identical ownership recheck).
- **`scheduling/schedules.ts`** — `deleteScheduleCore` + owner mutation `deleteSchedule`: owner-gate →
  REFUSE the last schedule → if deleting the default, promote the OLDEST remaining schedule to default →
  reassign pinned `eventTypes.scheduleId` / `eventTypeHosts.scheduleId` onto the new default → cascade
  `availability` + `dateOverrides` → delete the row. (Default is the `isDefault` flag, not a separate
  `user.defaultScheduleId`.) The `scheduleIdMap` row is left — calIds never reuse.
- **`scheduling/calcomAdmin.ts`** — s2s wrappers (explicit `ownerAuthUserId`): `adminDeleteSchedule`
  (int OR string id), `adminResolveCredentialCalIds`, `adminSetCalendarConflictFlag` (int→_id),
  `adminSetDestinationCalendar` (provider+externalId), `adminDisconnectCalendar` (int→_id).
- **Tests:** `scheduling/calcomIdMaps.test.ts` (+5 credential-map cases: mint/idempotent/bijection
  round-trip/never-reuse/independent-counters) + NEW `scheduling/cv5CalendarSchedule.test.ts` (18 cases:
  each mutation happy-path, OWNERSHIP rejection, the int→_id round-trip via the s2s wrapper, a stale-int
  resolves-to-Not-found, and the schedule-delete guards — refuse-last / promote-default / cascade /
  reassign-pinned-event-type). **23 new tests; scheduling suite 290 passed (20 files, was 267/19).**

### Fork (COMMITTED)

- **`packages/lib/server/calcomAdminAdapters.ts`** — fn-refs + adapters for the 5 new s2s mutations:
  `resolveOwnerCredentialCalIds` (calId-by-_id map), `setOwnerCalendarConflictFlagByCalId`,
  `setOwnerDestinationCalendar`, `disconnectOwnerCalendarByCalId`, `deleteOwnerScheduleByCalId`, +
  `calIntegrationToProvider` (cal `integration` type → our google/caldav). `mapConvexConnectedCalendars`
  now takes an optional `calIdByConvexId` and uses the PERSISTENT int (falls back to FNV-1a only if absent).
- **`.../calendars/connectedCalendars.handler.ts`** — mints the calId map and feeds it to the mapper.
- **`apps/web/app/api/availability/calendar/route.ts`** (conflict-toggle) — `authMiddleware` now resolves
  `session.user.uuid` (NO Prisma); POST→`checkForConflicts:true`, DELETE→`false`. zod schema UNTOUCHED.
- **`.../calendars/setDestinationCalendar.handler.ts`** (set-destination) — Convex, keyed by integration+externalId.
- **`.../credentials/deleteCredential.handler.ts`** (disconnect) — Convex disconnect by the cal int.
- **`.../availability/schedule/delete.handler.ts`** (schedule.delete) — Convex; maps ConvexError →
  cal's TRPCError contract (`UNAUTHORIZED` / `BAD_REQUEST`).

### Semantic gaps / deliberate no-ops (documented)

- **Conflict-toggle DELETE semantics:** cal's DELETE REMOVES the selected row; our model KEEPS the
  enumerated row and sets `checkForConflicts=false` (re-appears as "not conflict-checked", not gone).
  Acceptable — re-enabling is one POST; the row never has to be re-enumerated.
- **eventTypeId / bookingId-scoped destination:** NO Convex model (destination is USER-LEVEL only). The
  internal `eventTypes/heavy/update` call into `setDestinationCalendarHandler` (eventType-scoped) is a NO-OP.
- **`teamId` on disconnect:** team/org-only (dead in our single-user model) — ignored.
- **Legacy `GET /api/availability/calendar`:** unused by the app (the connectedCalendars tRPC read drives
  the UI); kept for any external caller but returns `[]` (no longer hits a provider).
- **`viewer.credentials.delete` scope:** in dibslist the only connected credentials are CALENDARS (no
  Stripe/Zoom/etc. app installs — disabled per PRD), so routing every `credentials.delete` to the calendar
  disconnect is correct for the in-scope surface.

### Other category-(A) throwing write paths from the sweep — LEFT on Prisma (out of CV-5 scope, documented)

These were flagged by the reachable-`ctx.prisma` sweep but are NOT among CV-5's four targets. They stay
on Prisma (and throw at runtime while dark) because each depends on a cal feature our Convex backend does
not model. Listed so no throwing path is silently undocumented; each is a future CV-x:
- **`eventTypesHeavy.update`** — ✅ **REWIRED in CV-6** (see §CV-6 below). The editor Save now routes the
  IN-SCOPE fields + co-host roster to Convex; OUT-OF-SCOPE fields are documented no-ops. *(The CV-2c note
  that claimed the editor update routes to Convex was WRONG up to CV-5 — the handler was still 100% Prisma
  and threw on the first `findUniqueOrThrow`; CV-6 makes that claim TRUE.)* **`eventTypesHeavy.duplicate`**
  remains on Prisma (no Convex clone op) — still a future CV-x.
- **`availability.schedule.duplicate`** — schedule clone (no Convex clone op).
- **`availability.schedule.bulkUpdateToDefaultAvailability`** — `eventType.updateMany` to repoint many
  event types at the default schedule (no batch Convex op).
- **`me.updateProfile`** — profile/settings save (`FeaturesRepository` + `user.update` + secondaryEmail +
  travelSchedule). `me.get` is rewired; the SAVE is not (Better Auth owns the dibslist profile lifecycle).
- **`calendars.setDestinationReminder`** — custom calendar reminder (no Convex reminder-on-destination field).
- **`slots.reserveSlot` / `slots.removeSelectedSlotMark`** — Booker slot HOLD/release. **CV-6 evaluated +
  DELIBERATELY LEFT ON PRISMA** (see §CV-6 "Part B — SKIPPED" below). Although `reserveSlot`'s Prisma body
  DOES throw without Postgres, the fork fires it **fire-and-forget** (`.mutate()`, no `await`, no `onError`,
  the create path never reads `slotReservationId`) — the throw is swallowed and booking is unaffected. It is
  NOT a fatal/blocking throw, so per the CV-6 task's skip-if-swallowed rule it was NOT rewired. `bookingHolds`
  + `claimHold`/`releaseHold` exist in Convex if a future CV-x wants the optimistic lock back.
- **`bookings.confirm` / `addGuests` / `editLocation`** — host actions CV-4 explicitly deferred (no
  requiresConfirmation / add-guest / post-create-location-update + calendar-sync model).

### Build status — TYPE-CLEAN + TESTED (2026-06-02, local macOS arm64)

| Gate | Result |
|---|---|
| dibslist `tsc -p convex/tsconfig.json` | **EXIT 0, 0 errors** |
| dibslist `vitest scheduling/cv5CalendarSchedule.test.ts` | **18 passed** (new file) |
| dibslist `vitest scheduling/` | **290 passed** (20 files; was 267/19 — +23 CV-5) |
| dibslist drift (`_clear.test.ts` + `userDeletion.drift.test.ts`) | **unchanged from baseline** — same 2 pre-existing failures (`apiIdempotencyKeys`/`apiSpendLog`/`mobileDevices`, unrelated dev-API/mobile tables); CV-5's new tables add ZERO new failures |
| fork `tsc -p packages/trpc/tsconfig.json --noEmit` | **EXIT 0, 0 errors** |
| fork `tsc -p apps/web/tsconfig.json --noEmit` | **EXIT 0, 0 errors** |

(NOTE: `convex/scheduling/schema.test.ts` reports a vitest "1 error" — its forks worker can't start because
`@edge-runtime/vm` is absent in the monorepo. PRE-EXISTING + environment-only; it does not affect the 290
passing tests and is unrelated to CV-5.)

### Runtime status: [R] — needs deploy + a live owner session

Type-clean + unit-tested but **runtime-unverified**. To go live needs: (a) the backend deployed so
`scheduling/calcomIdMaps:resolveCalendarCredentialCalId` + the new `scheduling/calcomAdmin:adminDeleteSchedule` /
`adminResolveCredentialCalIds` / `adminSetCalendarConflictFlag` / `adminSetDestinationCalendar` /
`adminDisconnectCalendar` + `scheduling/calendarOauth:setDestinationCalendar` / `disconnectCalendar` fns
exist (run `convex dev --once` to register — NOT `codegen`); (b) the `booking_enabled` flag ON (all four
WRITES return `booking_disabled` while dark); (c) `NEXT_PUBLIC_CONVEX_URL` set on the fork; and (d) a
signed-in owner with a real connected Google/CalDAV calendar to confirm the live conflict-toggle, set-
destination, disconnect, and a multi-schedule delete (incl. the refuse-last + promote-default guards).

## CV-6 — event-type editor SAVE (co-hosts — the headline) → Convex; slot-hold evaluated + skipped

**Goal:** make the event-type editor Save work on the no-Postgres fork — ESPECIALLY co-host assignment
(the "both founders free" collective panel) — and decide the Booker slot-hold path.

### Part A — editor Save (`viewer.eventTypesHeavy.update`) → Convex ✅ REWIRED

**The problem (corrects the CV-2c/§CV-5 note):** the editor Save fires `trpc.viewer.eventTypesHeavy.update`
(NOT `viewer.eventTypes.update`, which doesn't exist). Its handler
(`packages/trpc/server/routers/viewer/eventTypes/heavy/update.handler.ts`) opened with
`ctx.prisma.eventType.findUniqueOrThrow` and closed with `ctx.prisma.eventType.update` — **100% Prisma**, so
**any real edit threw a DB-connection error on the first statement.** The dead `adminUpdateEventType` adapter
(`calcomAdminAdapters.ts`) had ZERO callers; the editor never reached it. So co-host assignment was reachable
ONLY through the throwing path, AND its UI (`EventTeamAssignmentTab`) is stubbed to `() => null`
(`EventTypeWebWrapper.tsx:48`).

**Backend (dibslist repo, `packages/backend/convex` — UNCOMMITTED, matches CV-1..CV-5 scope):**
- `scheduling/eventTypes.ts` — NEW `setEventTypeHostsCore` + `setEventTypeHosts` (mutation) +
  `listEventTypeHostsCore` + `listEventTypeHosts` (query). Reconciles the `eventTypeHosts` roster for one
  event type (insert new / patch changed / delete removed), owner-rechecked + `booking_enabled`-gated.
  **COLLECTIVE/MANAGED ⇒ every host forced `isFixed:true`** (the panel invariant, mirroring cal's
  `isFixed = schedulingType === COLLECTIVE`); round_robin honors the caller's `isFixed`. De-dupes a host
  listed twice (last write wins); validates any per-host `scheduleId` belongs to the owner.
- `scheduling/calcomAdmin.ts` — NEW s2s wrappers `adminSetEventTypeHosts` (mutation) +
  `adminListEventTypeHosts` (query). Accept `calEventTypeId` (int) + a `hosts[]` where each host carries a cal
  USER int (`calHostUserId`) + optional cal SCHEDULE int (`calScheduleId`). **Reverse-resolves**
  cal-user-int → dibslist authUserId via `calcomUsers:getCalcomUserByCalId` (the `calcomUserMap`, CV-1) and
  cal-schedule-int → Convex `_id` via the schedule id-map (CV-2c). An unknown cal user int is SKIPPED (not a
  throw) — the editor only ever passes minted ids. The read wrapper enriches each row with
  `calHostUserId` + `calScheduleId` so the editor round-trips ids.
- `eventTypeHosts` is the EXISTING table (schema unchanged, already drift-guarded in `_clear.ts` +
  `userDeletion.ts`); CV-6 adds NO new table → ZERO new drift failures.
- Tests: NEW `scheduling/cv6EventTypeHosts.test.ts` (11 cases) — collective forces isFixed; RR honors it;
  reconcile insert/patch/delete; de-dupe; empty-clears; ownership; flag-gate; foreign-schedule reject; +
  the s2s cal-int reverse-resolution round-trip (user int + schedule int) and unknown-user-int skip.

**Fork (COMMITTED, this repo):**
- `packages/lib/server/calcomAdminAdapters.ts` — widened `updateOwnerEventTypeByCalId` to forward the extra
  in-scope editor fields (`locationText`, `minimumBookingNoticeMinutes`, `slotIntervalMinutes`); NEW
  `setOwnerEventTypeHostsByCalId` + `listOwnerEventTypeHostsByCalId` adapters + `CalHostInput`/
  `ConvexEventTypeHostRow` types + the two function refs.
- `packages/trpc/server/routers/viewer/eventTypes/heavy/update.handler.ts` — **body fully rewritten** to the
  Convex path. The cal React components, the tRPC client, and the zod input/output schemas are UNTOUCHED;
  only the resolver body changed (input is still `TUpdateInputSchema`, `id` is the cal int). It:
  - patches IN-SCOPE scalars (only the DIRTY fields the editor sends, so no unrelated clobber),
  - persists the co-host roster via `setOwnerEventTypeHostsByCalId` when `hosts` was sent (THE HEADLINE),
  - maps a slug-collision ConvexError → the same `error_event_type_url_duplicate` BAD_REQUEST cal expects,
  - returns the `{ eventType: { id, slug, title, schedulingType } }` shape (the editor's onSuccess does NOT
    read it — it re-reads via `revalidateEventTypeEditPage` + `eventTypes.get.invalidate`).

**IN-SCOPE fields rewired:** title, slug, description, length→durationMinutes, hidden, schedulingType
(COLLECTIVE/ROUND_ROBIN), scheduleId (availability link), hosts[] (co-hosts), locations→locationText
(first location collapsed to free text), minimumBookingNotice, slotInterval.

**OUT-OF-SCOPE fields (destructured out → DOCUMENTED NO-OPS, never written):** recurringEvent, seats*,
price/currency, bookingLimits/durationLimits, metadata (app-store/payment/bookerLayouts), customInputs,
eventTypeColor, period*/buffers-beyond-mapping, children (managed/team), multiplePrivateLinks (hashedLink),
disable*/workflows/AI/phone/secondaryEmail/calVideoSettings/hostGroups/team/per-host location.
**`requiresConfirmation` — NO backing column exists in the Convex `eventTypes` schema** (the closest is
`requireEmailVerification`, a different gate) → it is an explicit documented no-op, NOT rewired.
`scheduleId` 0/null (unset) is a no-op (no Convex unlink op; a positive int re-links).

### Part B — Booker slot HOLD/release (`slots.reserveSlot` / `removeSelectedSlotMark`) — SKIPPED (documented)

**Verdict: NOT rewired — the throw is SWALLOWED, not fatal.** Research + the code confirm:
- `reserveSlot` IS reached on the normal single-host path (`useSlots.ts` `useEffect` on timeslot select,
  `BookerWebWrapper.tsx` mounts `useSlots` unconditionally) — not seats-only.
- Its Prisma body (`reserveSlot.handler.ts`: `prisma.eventType.findUnique` / `PrismaSelectedSlotRepository`
  / `prisma.selectedSlots.upsert`) DOES reject without Postgres.
- BUT the fork fires it **fire-and-forget**: `reserveSlotMutation.mutate(...)` (no `await`/`mutateAsync`),
  the mutation defines only `onSuccess` (no `onError`), and the booking-create path (`useBookings.ts`) never
  reads `slotReservationId`/`reservationId`. So a rejection becomes an unread react-query error; the
  form/confirm/create flow is unaffected and the booking still goes through.
- `removeSelectedSlotMark` is cleanup-only, also fire-and-forget, and only fires if a reservation succeeded.

Per the CV-6 task rule ("if it's swallowed/best-effort, DOCUMENT the evidence and SKIP"), both resolvers
were LEFT on Prisma. The only user-visible degradation is loss of the optimistic ~5-min slot lock + the
`isAvailable` quick-check (gated on `slotReservationId`); the `createBookingPublic` write-time conflict
re-check (CV-3, already on Convex) remains the real availability gate. The Convex `bookingHolds` table +
`claimHold`/`releaseHold`/`sweepExpiredHolds` already exist if a future CV-x wants the optimistic lock back.

### Build status — TYPE-CLEAN + TESTED (2026-06-02, local macOS arm64)

| Gate | Result |
|---|---|
| dibslist `tsc -p convex/tsconfig.json --noEmit` | **EXIT 0, 0 errors** |
| dibslist `vitest scheduling/cv6EventTypeHosts.test.ts` | **11 passed** (new file) |
| dibslist `vitest scheduling/` | **301 passed** (21 files; was 290/20 — +11 CV-6) |
| dibslist drift (`_clear.test.ts` + `userDeletion.drift.test.ts`) | **unchanged from baseline** — same pre-existing failures (`apiIdempotencyKeys`/`apiSpendLog`/`mobileDevices`, unrelated dev-API/mobile tables); CV-6 adds NO new table → ZERO new drift failures |
| fork `tsc -p packages/trpc/tsconfig.json --noEmit` | **EXIT 0, 0 errors** |
| fork `tsc -p apps/web/tsconfig.json --noEmit` | **EXIT 0, 0 errors** |

(NOTE: `convex/scheduling/schema.test.ts` still reports a vitest "1 error" — its forks worker can't start
because `@edge-runtime/vm` is absent in the monorepo. PRE-EXISTING + environment-only; unrelated to CV-6.)

### Runtime status: [R] — needs deploy + a live editor session

Type-clean + unit-tested but **runtime-unverified**. To go live needs: (a) the backend deployed so the NEW
`scheduling/calcomAdmin:adminSetEventTypeHosts` / `adminListEventTypeHosts` + `scheduling/eventTypes:setEventTypeHosts`
/ `listEventTypeHosts` fns exist (run `convex dev --once` to register — NOT `codegen`); (b) the
`booking_enabled` flag ON (the editor Save returns `booking_disabled` while dark); (c) `NEXT_PUBLIC_CONVEX_URL`
set on the fork; (d) the `EventTeamAssignmentTab` UI un-stubbed (currently `() => null` in
`EventTypeWebWrapper.tsx:48`) so a real co-host picker can drive `hosts[]` — until then the backend persists
co-hosts but no UI surface emits them; and (e) a signed-in owner editing a collective event type with ≥1
co-host to confirm the live "both founders free" round-trip.

---

## CV-7 — co-host-by-email picker (the headline UI): un-stubs the assignment tab + emits `hosts[]`

**Goal:** close the gap CV-6 §Part-A left open at step (d) — give the owner a real UI to assign co-hosts so the
"both founders free" collective availability actually fires. dibslist has **no team concept**, so the product
model is: the owner sets `schedulingType = COLLECTIVE` and adds co-hosts **by typing their dibslist email**.

### Chosen approach (vs un-stubbing cal's real EE tab)

cal.com's real `EventTeamAssignmentTab` source was **physically deleted** during the fork's EE-code removal
(only the dangling `import type` at `EventTypePlatformWrapper.tsx:18` survived). Its dependency cone
(`AddMembersWithSwitch`, RR-segment/weight machinery, org/membership context, team-scoped tRPC) is the wrong
abstraction for a non-team booking tool and would drag back the removed EE code. So CV-7 builds a **MINIMAL
native control from cal's OWN `@calcom/ui` primitives** (`SettingsToggle` / `EmailField` / `Button` / `Avatar`
/ `Badge` / `Icon`) that drives the SAME react-hook-form fields the CV-6 Save reads — no bespoke CSS, no
hand-rolled widgets. The new file lives at the upstream path so the dangling type import resolves too.

### Backend (dibslist repo, `packages/backend/convex` — UNCOMMITTED, matches CV-1..CV-6 scope)

- `scheduling/calcomAdmin.ts` — NEW owner-scoped s2s query `resolveCoHostByEmail` (+ exported
  `resolveCoHostByEmailImpl` for unit tests). Takes `{ ownerAuthUserId, email }`, returns
  `{ found, status, calUserId, authUserId, name, email, avatar }` where `status ∈
  {"assignable","needs_signin","self","not_found"}`:
  - `"assignable"` — the email has a `calcomUserMap` row (the person signed into booking + got a minted cal
    int) → `calUserId` set. THIS is the int the picker emits into `hosts[].userId`.
  - `"needs_signin"` — a Better-Auth (dibslist) account exists but **no** `calcomUserMap` row yet →
    `calUserId: null`. The picker shows "ask them to sign into booking + connect a calendar first" and does
    NOT add them (an unminted int would be silently dropped by `adminSetEventTypeHosts`'s reverse-resolve).
  - `"self"` — resolves to the owner (can't co-host yourself).
  - `"not_found"` — no dibslist account with that email.
  - Reuses `calcomUsers:getCalcomUserByEmailImpl` (CV-1, bounded scan, case-insensitive) for the mapped path
    and `components.betterAuth.adapter.findMany` (operator `"eq"` + `insensitive`, NO admin gate — mirrors
    `adminUsers.findUserByEmail` but exact-match + owner-not-operator) for the unmapped path. Does **not** gate
    on `booking_enabled` (must resolve while the surface is dark, same as the rest of `calcomUsers/*`); the
    WRITE it feeds (`adminSetEventTypeHosts`) stays flag-gated off.
- NO schema change, NO new table → ZERO new drift (the optional `by_email` index on `calcomUserMap` from the
  research was NOT added — the bounded scan is fine for this cold surface).
- Tests: NEW `scheduling/cv7CoHostResolve.test.ts` (10 cases): mapped→assignable (+ minted int + avatar);
  case-insensitive; unmapped-but-real→needs_signin (calUserId null); unknown→not_found; empty email
  short-circuits without hitting Better-Auth; owner's own email→self (both mapped + Better-Auth-only); query
  wrapper delegates; **END-TO-END headline** — resolve(email)→calUserId→`adminSetEventTypeHosts`→
  `adminListEventTypeHosts` on a COLLECTIVE event type returns BOTH hosts forced `isFixed:true` (the
  intersection input; the downstream COLLECTIVE→intersection is in `availableSlots.test.ts`); and a
  needs_signin co-host yields no int so the picker never emits an unminted host.

### Fork (COMMITTED, this repo)

- `packages/lib/server/calcomAdminAdapters.ts` — NEW `resolveCoHostByEmail` adapter + `resolveCoHostByEmailRef`
  + `ResolveCoHostResult`/`ResolveCoHostStatus` types (best-effort: a transport error → `not_found`).
- `packages/trpc/server/routers/viewer/eventTypes/resolveCoHostByEmail.{schema,handler}.ts` — NEW lean
  `authedProcedure` query (zod input `{ email }` only). Handler routes through the adapter with
  `ownerAuthUserId = ctx.user.uuid` (the trusted authUserId the fork carries on the validated session). Wired
  into `eventTypes/_router.ts`. No unrelated procedure touched.
- `apps/web/modules/event-types/components/tabs/assignment/EventTeamAssignmentTab.tsx` — NEW minimal native
  co-host control (un-stubs the upstream path; exports `EventTeamAssignmentTabCustomClassNames` so the
  dangling `EventTypePlatformWrapper.tsx:18` type import resolves). Reads/writes the RHF fields
  (`useFormContext<FormValues>`): a `SettingsToggle` sets `schedulingType=COLLECTIVE`; an `EmailField`+`Add`
  resolves via `trpc.useUtils().viewer.eventTypes.resolveCoHostByEmail.fetch` and, only for `assignable`,
  pushes the cal int into `hosts[]` with `isFixed:true` via `setValue("hosts", …, { shouldDirty:true })`
  (CV-6 Save reads ONLY dirty fields, so `shouldDirty` is load-bearing). `needs_signin`/`not_found`/`self`
  surface a clear toast and are NOT added.
- `apps/web/modules/event-types/components/EventTypeWebWrapper.tsx` — un-stubbed the `EventTeamAssignmentTab`
  dynamic import (was `() => null`) to the new component.
- `packages/platform/atoms/event-types/hooks/useTabsNavigations.tsx` — the assignment ("team") tab nav item
  was gated `if (team)`; since dibslist has no team, it is now ALWAYS shown so the co-host picker is reachable
  for single-owner events (the headline). The tab itself renders the collective toggle + email-add regardless.
- New i18n keys (`en/common.json`): `add_co_hosts_by_email_description`, `co_host_already_added`,
  `co_host_needs_to_sign_in_to_booking`, `no_dibslist_account_for_email`, `you_are_already_the_host`.

### Verify (real results)

| check | result |
| --- | --- |
| convex `vitest run convex/scheduling/` (excl. edge-runtime `schema.test.ts`) | **22 files / 311 tests PASS, EXIT 0** (incl. new `cv7CoHostResolve.test.ts` 10/10) |
| convex `tsc -p convex/tsconfig.json --noEmit` | **EXIT 0, 0 errors** |
| fork `tsc -p packages/trpc/tsconfig.json --noEmit` | **EXIT 0, 0 errors** |
| fork `tsc -p apps/web/tsconfig.json --noEmit` | **EXIT 0, 0 errors** |

⚠ **Fork `types/` build-artifact hazard (recorded for the next agent):** `packages/trpc/types/**` is a
GITIGNORED, pre-generated `.d.ts` tree (cal's lambda-split type gen). The web client's `AppRouter` type INLINES
the whole router into `types/server/routers/_app.d.ts`, so a new procedure must appear there for `apps/web`
tsc to see it. Regenerating that tree locally (`trpc build:server` / `turbo build`) **degraded unrelated
`viewer.bookings.get` declarations to `never[]` (130 spurious errors in `bookings`/`booking` modules)** — a
PRISMA-6 client-regeneration artifact in this sandbox, NOT a code defect (the original turbo cache
`ea4e8322b5cd1917` @ 04:44 had healthy bookings types). To keep web tsc honest CV-7 restored that healthy
cached tree and surgically added only the `resolveCoHostByEmail` QueryProcedure to `_app.d.ts`. **CI rebuilds
`types/` from source on a clean checkout (where prisma generates healthily), so the committed SOURCE
(`_router.ts` + handler + schema + adapter) is the source of truth; the local `.d.ts` is derived.** Do NOT
commit `types/` (it's gitignored) and do NOT trust a local full `types/` regen for the bookings router.

### Runtime status: [R] — needs deploy + `booking_enabled` ON + the partner to have signed in once

Type-clean + unit-tested but **runtime-unverified** (the live editor/Booker is not deployed). To go live:
(a) deploy the backend so `scheduling/calcomAdmin:resolveCoHostByEmail` exists (`convex dev --once` to
register — NOT `codegen`); (b) `booking_enabled` ON (the resolve query itself is flag-independent, but the
`hosts[]` Save it feeds returns `booking_disabled` while dark); (c) `NEXT_PUBLIC_CONVEX_URL` set on the fork;
(d) **the co-host must have signed into the booking app at least once** so a `calcomUserMap` row (their cal
int) exists — otherwise they resolve as `needs_signin` and are correctly un-addable; and (e) a signed-in owner
adds that co-host by email on a COLLECTIVE event type, saves, and confirms the Booker offers only the
two-host availability intersection (the "both founders free" headline).

---

## CV-8 — residual data-layer cleanup (the LAST reachable throwing WRITE paths)

**Goal:** close every remaining in-scope owner-action WRITE path the prior CV milestones left on Prisma
(they THREW against the no-Postgres fork) — rewiring the mechanical ones to Convex and CLEANLY DISABLING the
niche ones (return a typed no-op / friendly `TRPCError` BEFORE any `ctx.prisma` call — never let the raw
no-Postgres prisma client throw). The cal React components, the tRPC client, and the zod input/output schemas
are UNTOUCHED — only resolver/repo bodies + the adapter layer changed, plus additive Convex fns.

### Per-path disposition

| Path | UI surface | CV-8 disposition |
|---|---|---|
| `eventTypesHeavy.duplicate` | event-type list DuplicateDialog | **REWIRED** — clone via create+setHosts |
| `availability.schedule.duplicate` | availability list / ScheduleListItem | **REWIRED** — clone schedule+availability+overrides |
| `availability.bulkUpdateToDefaultAvailability` | availability-view / schedule-view (set-default) | **REWIRED** — batch repoint eventType.scheduleId |
| `me.updateProfile` (booking-prefs subset) | profile/settings save | **REWIRED** (subset) — tz/timeFormat/weekStart/locale to Convex; IDENTITY no-op |
| `me.updateProfile` (identity fields) | same | **CLEANLY NO-OP** — name/email/username/bio/avatar/secondaryEmails/travel ignored, never written, never thrown |
| `calendars.setDestinationReminder` | DestinationCalendarSettings panel | **CLEANLY DISABLED** — no-op `{ success: true }` (no Convex reminder model) |
| `bookings.confirm` | bookings dashboard / magic-link routes | **CLEANLY DISABLED** — friendly `NOT_IMPLEMENTED` before prisma (no confirm/refund/recurring model) |
| `bookings.addGuests` | AddGuestsDialog | **CLEANLY DISABLED** — friendly `NOT_IMPLEMENTED` before prisma (no add-guest model) |
| `bookings.editLocation` | EditLocationDialog | **CLEANLY DISABLED** — friendly `NOT_IMPLEMENTED` before prisma (no location-edit + calendar-resync model) |

### Backend (dibslist repo, `packages/backend/convex` — UNCOMMITTED, matches CV-1..CV-7 scope)

- **`schema.ts`** — ADDITIVE, OPTIONAL columns on `calcomUserMap`: `timeFormat` (number) + `defaultScheduleId`
  (`v.id("schedules")`). No migration (absent rows read undefined → cal-shaped defaults). NO new table → ZERO
  new drift; the same `_clear.ts` / `userDeletion.ts` cascade entries cover the row.
- **`scheduling/eventTypes.ts`** — NEW `duplicateEventTypeCore` (+ `duplicateEventType` mutation). Reads the
  owner-rechecked source, creates a clone copying ONLY the in-scope template fields (title/slug/description/
  durationMinutes + schedulingType/scheduleId/slotInterval/notice/buffers/bookingWindow/dailyLimit/
  requireEmailVerification/hidden/locationText/active) via `createEventTypeCore`, **defensively
  slug-uniquifies** (appends `-N` until `by_slug` is free, bounded 50) so a same-slug clone never hits
  `assertSlugFree`'s throw, then clones the co-host roster via `setEventTypeHostsCore` (collective forces
  isFixed). DROPS cal's connected-model tail (customInputs / hashedLink / calVideoSettings / destinationCalendar
  / restrictionSchedule / recurringEvent / booking-and-duration-limits / secondaryEmail / webhooks) — none modeled.
- **`scheduling/schedules.ts`** — NEW `duplicateScheduleCore` (+ mutation): reads the source (embeds children),
  creates a `"<name> (Copy)"` clone FORCED `isDefault:false` (never steals the default), full-replaces its
  weekly windows from the source, upserts each date override. NEW `bulkUpdateToDefaultAvailabilityCore` (+
  mutation): resolves the target = the explicit selection (owner-rechecked) else the owner's `by_owner_default`
  schedule; REFUSES with `ConvexError("Default schedule not set")` when neither resolves; loops the listed
  owner-owned event types patching each `scheduleId`; returns `{ count }` (cal BatchPayload). (The default is the
  `isDefault` flag — NO `user.defaultScheduleId` column — so the core reads the flag, not a user field.)
- **`scheduling/calcomUsers.ts`** — NEW `updateCalcomUserPrefsImpl` (+ `updateCalcomUserPrefs` mutation) +
  `timeFormat`/`defaultScheduleId` added to the `calcomUserRow` return validator. PATCH semantics: writes ONLY
  the provided prefs (timeZone/weekStart/timeFormat/locale/defaultScheduleId — undefined = leave as-is), NEVER
  touches identity fields; a forged `defaultScheduleId` not owned by the caller is silently dropped; a no-map-row
  owner is a clean `{ updated:false }` no-op (does NOT mint — that needs email+name); optional tz→default-schedule
  propagation (cal's tz-change side effect). NO auth gate / NO `booking_enabled` gate (identity/prefs infra,
  same trust model as the rest of `calcomUsers/*` — reached s2s after the fork validated the cookie).
- **`scheduling/calcomAdmin.ts`** — NEW s2s wrappers (explicit `ownerAuthUserId`, cal-int round-trip via the
  existing id-maps): `adminDuplicateEventType` (resolves source cal int → clone → returns the NEW clone's stable
  cal int + final slug), `adminDuplicateSchedule` (→ NEW clone cal int + name), `adminBulkUpdateToDefaultAvailability`
  (resolves each `calEventTypeId` + the optional `calSelectedDefaultScheduleId` → `_id`s, skips unknown ints),
  `adminUpdateCalcomUserPrefs` (resolves the optional `calDefaultScheduleId` → `_id`; forwards the prefs subset).
- **Tests:** NEW `scheduling/cv8DataCleanup.test.ts` (22 cases): duplicate-event-type happy/duration-override/
  **co-host clone**/slug-collision-auto-suffix/ownership-reject/flag-gate-off/s2s-cal-int-round-trip;
  duplicate-schedule clone-children-non-default/ownership-reject/s2s; bulk-repoint current-default/explicit-
  selection/"Default schedule not set" guard/skip-not-owned/reject-foreign-selection/s2s-cal-int; prefs-patch
  subset/only-provided-fields/tz-propagation/owned-defaultScheduleId-only/no-map-row-no-op/s2s-cal-int.

### Fork (COMMITTED, this repo)

- **`packages/lib/server/calcomAdminAdapters.ts`** — NEW fn-refs + adapters: `duplicateOwnerEventTypeByCalId`
  (→ `{ calId, slug }`), `duplicateOwnerScheduleByCalId` (→ `{ calId, name }`), `bulkUpdateToDefaultAvailability`
  (→ `{ count }`), `updateOwnerBookingPrefs` (best-effort: a transport error → `{ updated:false }` so a settings
  save can't 500). No existing adapter touched.
- **`.../eventTypes/heavy/duplicate.handler.ts`** — body fully rewired to `duplicateOwnerEventTypeByCalId`
  (`ownerAuthUserId = ctx.user.uuid`). Maps a Convex slug-collision → cal's `CONFLICT
  "duplicate_event_slug_conflict"`; `booking_disabled`/not-found → `BAD_REQUEST`. Returns `{ eventType: { id:
  <NEW clone cal int>, slug, title, length, description } }` (the dialog navigates by it).
- **`.../availability/schedule/duplicate.handler.ts`** — body rewired to `duplicateOwnerScheduleByCalId`. Maps
  ConvexError not-found → `UNAUTHORIZED`, else `INTERNAL_SERVER_ERROR` (matching the original catch-all). Returns
  `{ schedule: { id: <NEW clone cal int>, name } }` (the list navigates + toasts off it).
- **`.../availability/schedule/bulkUpdateDefaultAvailability.handler.ts`** — body rewired to
  `bulkUpdateToDefaultAvailability` (cal ints forwarded). "Default schedule not set" → `BAD_REQUEST` (same
  message cal raised); else `BAD_REQUEST`. Returns `{ count }`.
- **`.../me/updateProfile.handler.ts`** — body rewired: persists ONLY the booking-prefs subset (timeZone/
  weekStart/timeFormat/locale + tz→default-schedule propagation when tz changed) via `updateOwnerBookingPrefs`;
  IDENTITY + out-of-scope fields (name/email/username/bio/avatarUrl/secondaryEmails/travelSchedules/premium-
  username/Stripe/completedOnboarding-team-propagation/email-verification) are **cleanly ignored — never
  written, never thrown**. The pure booker-layout validation (`validateBookerLayouts`) + metadata allow-list
  clean (`cleanMetadataAllowedUpdateKeys`/`handleUserMetadata`) are KEPT (no DB). Returns the EXACT cal shape
  (echo input + metadata + `email`/`avatarUrl` echoed + `hasEmailBeenChanged:false` + `sendEmailVerification:false`),
  so the settings form's onSuccess + SSR reload stay valid. **NOTHING in this handler touches `ctx.prisma`.**
  NOTE: `defaultScheduleId` is NOT in `ZUpdateProfileInputSchema` (cal writes it only as a tz-change side
  effect / via the availability set-default flow), so the profile save does not carry it — the backend
  `adminUpdateCalcomUserPrefs` accepts it for completeness but the profile handler doesn't pass it.
- **`.../calendars/setDestinationReminder.handler.ts`** — CLEANLY DISABLED: a `{ success: true }` no-op (no
  Convex per-destination reminder field). The original Prisma-repo call is gone.
- **`.../bookings/confirm.handler.ts`** — CLEANLY DISABLED: the entire 450-line Prisma body is REPLACED with a
  friendly `TRPCError("NOT_IMPLEMENTED", "Confirming bookings is not available in this deployment.")` thrown
  BEFORE anything. The `confirmHandler` export name + signature + `{ message, status }` return are PRESERVED so
  the platform-libraries re-export + the magic-link routes (`api/link`, `api/verify-booking-token`) stay
  type-clean.
- **`.../bookings/addGuests.handler.ts`** — CLEANLY DISABLED: `addGuestsHandler` now throws the friendly
  `NOT_IMPLEMENTED` as its FIRST statement, before `getBooking`'s prisma call. The helper exports
  (`getBooking`/`validateUserPermissions`/`updateBookingAttendees`/…) are RETAINED for type-compat (the platform
  `BookingAttendeesService`/`BookingAttendeesRemoveService` re-import them) — but are unreachable from this
  handler. The unreachable original body is kept below the throw (tsc-clean).
- **`.../bookings/editLocation.handler.ts`** — CLEANLY DISABLED: `editLocationHandler` throws the friendly
  `NOT_IMPLEMENTED` before `new UserRepository(prisma).findByIdOrThrow`. Helper exports retained for type-compat.

### Why duplicate/bulk REWIRED but confirm/addGuests/editLocation DISABLED

The two duplicate paths + bulk-repoint are pure clone/patch operations whose fields map 1:1 onto the existing
Convex event-type/schedule model — composable from cores that already exist (createEventType + setHosts;
createSchedule + setAvailability + addDateOverride; updateEventType.scheduleId). me.updateProfile's prefs map
onto `calcomUserMap`. The three booking host actions, by contrast, each depend on a cal feature with NO Convex
equivalent (requiresConfirmation + payments/refunds + recurring + the confirmation-email engine; post-create
add-guest + attendee/credential re-sync; post-create location-edit + calendar re-sync) — not a mechanical
rewrite, and CV-4 already explicitly deferred them. So they are cleanly disabled (friendly throw, no prisma)
rather than half-rewired.

### Verify (real results — local macOS arm64, 2026-06-02)

| check | result |
| --- | --- |
| convex `vitest run convex/scheduling/` | **23 files / 333 tests PASS** (was 22/311 — +1 file, +22 CV-8 in `cv8DataCleanup.test.ts`). The single `schema.test.ts` "1 error" is the PRE-EXISTING `@edge-runtime/vm`-absent forks-worker env error (unrelated; same as CV-5/6/7). |
| convex `tsc -p convex/tsconfig.json --noEmit` | **EXIT 0, 0 errors** |
| fork `tsc -p packages/trpc/tsconfig.json --noEmit` | **EXIT 0, 0 errors** (baseline-clean) |
| fork `tsc -p apps/web/tsconfig.json --noEmit` | **EXIT 0, 0 errors** (baseline-clean) |

**`types/` hazard (CV-7 §):** CV-8 added NO new tRPC procedure (all four targets are EXISTING procedures with
rewired bodies; the niche edges are existing too), so the `packages/trpc/types/**` pre-generated `.d.ts`
AppRouter tree needed NO surgical edit — the body rewrites don't change any procedure's input/output type. No
full `types/` regen was run.

### Runtime status: [R] — needs deploy + a live owner session

Type-clean + unit-tested but **runtime-unverified**. To go live needs: (a) the backend deployed so the NEW
`scheduling/calcomAdmin:adminDuplicateEventType` / `adminDuplicateSchedule` / `adminBulkUpdateToDefaultAvailability`
/ `adminUpdateCalcomUserPrefs` + `scheduling/eventTypes:duplicateEventType` + `scheduling/schedules:duplicateSchedule`
/ `bulkUpdateToDefaultAvailability` + `scheduling/calcomUsers:updateCalcomUserPrefs` fns exist AND the
`calcomUserMap` `timeFormat`/`defaultScheduleId` columns are pushed (run `convex dev --once` to register — NOT
`codegen`); (b) the `booking_enabled` flag ON (the duplicate/bulk WRITES return `booking_disabled` while dark;
the prefs patch is flag-independent); (c) `NEXT_PUBLIC_CONVEX_URL` set on the fork; and (d) a signed-in owner to
confirm: a list "Duplicate" (incl. co-hosts copied), an availability "Duplicate", a set-default repoint, and a
settings save that persists timezone/timeFormat/weekStart while leaving the dibslist-owned name/email untouched
— plus that the disabled niche actions surface a clean "not available" toast rather than a 500.

### End-state claim (in-scope owner-action surfaces checked)

Every reachable in-scope owner-action WRITE surface the research enumerated is now either REWIRED to Convex or
CLEANLY DISABLED with the resolver returning a typed no-op / friendly TRPCError BEFORE any `ctx.prisma` access:
event-type **Duplicate** (DuplicateDialog) → Convex; schedule **Duplicate** (ScheduleListItem) → Convex;
**set-default repoint** (bulkUpdateToDefaultAvailability, availability-view/schedule-view) → Convex; **profile
save** (me.updateProfile) → prefs subset to Convex + identity no-op; **destination-reminder** panel → no-op;
**bookings confirm / addGuests / editLocation** → friendly NOT_IMPLEMENTED before prisma. Combined with CV-1..CV-7,
**no in-scope owner-action surface reaches an unhandled `ctx.prisma` runtime throw on the no-Postgres fork.**

---

## CV-9 — the MIDDLEWARE chokepoints (gating `.use()` prisma) + residual reachable reads → Convex

**Goal:** CV-2c..CV-8 were body-scoped — they rewired/disabled handler BODIES. They could not see that three tRPC
`.use()` MIDDLEWARES run `prisma.*` UNCONDITIONALLY *before* the (already-rewired) bodies execute, so on the
no-Postgres fork they throw (ECONNREFUSED) and 500 the surface before the body runs. tsc can't catch it
(`ctx.prisma` / the repos are fully typed; the throw is runtime-only). CV-9 fixes the middlewares + the last
flagged reachable reads (incl. the PUBLIC/anonymous Booker paths). All `.use()` + body changes preserve the React
components, the tRPC client, and the zod input/output schemas untouched.

### The three middleware chokepoints (the root bugs)

1. **`createEventPbacProcedure` (`eventTypes/util.ts`) — THE NAMED CHOKEPOINT.** Its `.use()` ran an unconditional
   `ctx.prisma.eventType.findUnique` then an ownership/PBAC check — gating the ENTIRE event-type editor lifecycle
   (`get` / `eventTypesHeavy.update` / `delete` / `eventTypesHeavy.duplicate` + the 6 host sub-queries). **REWIRED**
   to resolve ownership via the owner-scoped Convex `adminCheckEventTypeOwner` (keyed by the SAME cal int the editor
   round-trips, via the CV-2c eventType id-map). Semantics PRESERVED for the personal-owner / no-team model:
   `!found → NOT_FOUND`; `found && !owned → FORBIDDEN` (an owner-scoped Convex row is the owner's by construction, so
   owner-match ≡ cal's `event.userId === ctx.user.id`); else proceed. The dead team/`PermissionCheckService` branch
   is dropped. The `input.users` assignment guard is kept as a PURE in-memory check (`every(u => u === ctx.user.id)`,
   no DB). **NO `ctx.prisma`.** (`eventOwnerProcedure` in the same file is a latent twin gate but is referenced by NO
   in-scope procedure — left as-is, documented landmine.)
2. **`isAuthed` → `getUserFromSession` (`features/auth/lib/userFromSessionUtils.ts`) — ROOT BUG #2 (gates EVERY authed
   procedure).** `isAuthed` (the shared `authedProcedure` middleware) calls `getUserFromSession`, which ran
   `new UserRepository(prisma).findUnlockedUserForSession` + `enrichUserWithTheProfile` (also prisma) on EVERY authed
   request — so it threw upstream of ALL authed handlers (the CV-1 note that "isAuthed is unchanged" was wrong: CV-1
   rewired `getServerSession`, NOT `getUserFromSession`). **REWIRED:** the prisma reads are wrapped so that on a
   throw / null (the no-Postgres fork) the user is synthesized from the CV-1 `Session.user` (id/uuid/name/username/
   email/role/locale/profile) + the owner's Convex booking prefs (`getOwnerSessionPrefs` → timeZone / weekStart /
   timeFormat / locale + the cal-int default schedule). **types/ HAZARD handled:** the fallback is cast to the SAME
   prisma-inferred `user` type *in the success-path scope* (NOT via `ReturnType<findUnlockedUserForSession>`, which
   collapses to `never` cross-package) — so `UserFromSession` / `TrpcSessionUser` / `ctx.user` keep their EXACT type
   and NOTHING downstream ripples (verified: a literal-reconstruction attempt regressed `calendarOverlay`/`me.get`/
   `bulkUpdateToDefaultLocation`/`create.handler`/`getUserTopBanners` types — reverted in favour of the cast). On a
   real Postgres deploy the prisma path is unchanged. (`getUserSession`'s `session.profileId` prisma branch is dead —
   CV-1 sessions set `profileId: null` — so it never executes; left documented-unreachable.)
3. **`bookingsProcedure` (`bookings/util.ts`) — editLocation gate.** Its `.use()` ran TWO `prisma.booking.findFirst`
   (admin + organizer/collective) to resolve `ctx.booking` before the handler — the same pattern. Its SOLE consumer
   is `viewer.bookings.editLocation`, which CV-8 already CLEANLY DISABLED (its body throws NOT_IMPLEMENTED first,
   never reading `ctx.booking`). **REWIRED:** the middleware now surfaces the SAME friendly NOT_IMPLEMENTED BEFORE any
   prisma (verified `bookingsProcedure` has no other consumer); the router bridges the now-booking-less ctx with a
   type cast; the handler body is unreachable. **NO `ctx.prisma`.**

### Residual reachable reads (CV-8-flagged + the trace sweep)

| Surface | Type | CV-9 disposition |
|---|---|---|
| `availability.schedule.getScheduleByUserId` | authed | **REWIRED** — drops `ctx.prisma.user.findUnique`; resolves the owner's DEFAULT via `get.handler` (no scheduleId → isDefault). Keeps EMPTY_SCHEDULE fallback. |
| `availability.schedule.getScheduleByEventSlug` | authed | **REWIRED** — drops both `ctx.prisma.eventType/user.findUnique` (the slug read ran OUTSIDE the try → uncaught 500); resolves the event's pinned schedule cal int from Convex (`resolveOwnerEventScheduleCalIdBySlug`), else owner default. EMPTY_SCHEDULE fallback. |
| `eventTypes.get` chain (`getEventTypeById.ts`) | authed | **REWIRED/GUARDED** — `getRawEventType` no longer calls `eventTypeRepo.findById` (eventTypeRepository.ts:795) on the Convex path (it ran before the overlay short-circuit → 500); the fallback-user (`prisma.user.findUnique`, :173) + default-destinationCalendar (`prisma.destinationCalendar.findFirst`, :258) reads are skipped when `ownerAuthUserId` is set (synthesize / leave null). The `prisma.team.findUnique` (:290) is org-admin-gated dead code. |
| eventTypes `getHostsForAvailability` / `getHostsForAssignment` / `exportHostsForWeights` / `getChildrenForAssignment` / `getHostsWithLocationOptions` / `massApplyHostLocation` | authed (pbac) | **CLEANLY DISABLED** — TEAM round-robin/weights/per-host-location/managed-children UIs; no-team model. Each body returned its prisma-backed service/repo result; now returns the empty/typed default (`{hosts:[],nextCursor:undefined,hasMore:false}` / `{members:[]}` / `{children:[],…}` / `{success:true,updatedCount:0}`) with NO `ctx.prisma`. (The pbac wrapper is now Convex-backed per #1, so it provides the owner gate without prisma.) |
| `slots.reserveSlot` | **PUBLIC** | **DISABLED-as-no-op** — Booker slot HOLD. Dropped `prisma.eventType.findUnique` + (seated) `prisma.booking.findFirst` + `selectedSlots.upsert`; mints + returns the `uid` (no Convex transient-hold model — concurrency is the booking write path's race-guard). |
| `slots.isAvailable` | **PUBLIC** | **DISABLED** — optimistic pre-check. Dropped `EventTypeRepository.findByIdMinimal` + `PrismaSelectedSlotRepository`; returns every requested slot `available` (the real check is `getSchedule`, already Convex). |
| `slots.removeSelectedSlotMark` | **PUBLIC** | **DISABLED-as-no-op** — dropped `prisma.selectedSlots.deleteMany` (no holds to release). |
| `bookings.find` | **PUBLIC** | **DISABLED** — dropped the anonymous `prisma.booking.findUnique`; returns `{ booking: null }` (the shape findUnique could already return). |
| `bookings.getBookingDetails` | authed | **CLEANLY DISABLED** (missed by CV-8) — dropped `new BookingDetailsService(prisma)` (BookingRepository/BookingAccessService prisma); friendly NOT_IMPLEMENTED before any prisma. |

### Backend (dibslist repo, `packages/backend/convex` — UNCOMMITTED, matches CV-1..CV-8 scope)

- **`scheduling/calcomAdmin.ts`** — NEW s2s query **`adminCheckEventTypeOwner({ ownerAuthUserId, calEventTypeId })
  → { found, owned }`**. Delegates to the EXISTING `getEventTypeByCalIdImpl` (calcomIdMaps.ts) — the id-map row
  already denormalises `ownerAuthUserId`, so it's a SINGLE id-map read (no second `eventTypes` fetch). Owner-scoped;
  no `booking_enabled` gate (the editor must gate while the public surface is dark — same as the rest of the read
  surface). This is the ONLY new backend fn; everything else CV-9 needs (`adminGetEventTypeBySlug`,
  `getCalcomUserByAuthUserId`, `getScheduleCalIdByConvexId`, `adminGetSchedule`/`adminListSchedules` via
  `getDetailedScheduleFromConvex`) already existed.
- **Tests:** NEW `scheduling/cv9OwnershipCheck.test.ts` (5 cases): owner match → `{found:true,owned:true}`;
  cross-owner → `{found:true,owned:false}`; unknown cal int → `{found:false,owned:false}`; a second owner's row is
  owned by them not by ME (no cross-owner leak); resolves off the id-map row alone (succeeds even with the underlying
  `eventTypes` row deleted — proves no second fetch).

### Fork (COMMITTED, this repo)

- **`packages/lib/server/calcomAdminAdapters.ts`** — NEW fn-refs + adapters: `checkOwnerEventTypeOwnership`
  (→ `{found,owned}`, FAIL-CLOSED to `{found:false}` on transport error so a backend blip is a clean NOT_FOUND, never
  a silent authorise), `getOwnerSessionPrefs` (cal user prefs + cal-int default schedule for the isAuthed session
  hydration, best-effort → nulls), `resolveOwnerEventScheduleCalIdBySlug` (slug → event's pinned schedule cal int,
  best-effort → null). No existing adapter touched.
- **`eventTypes/util.ts`** — `createEventPbacProcedure` `.use()` rewired (chokepoint #1). `eventOwnerProcedure`
  untouched (unused).
- **`features/auth/lib/userFromSessionUtils.ts`** — `getUserFromSession` rewired (chokepoint #2) with the
  type-preserving cast.
- **`bookings/util.ts`** + **`bookings/_router.tsx`** — `bookingsProcedure` middleware neutralised (chokepoint #3) +
  the editLocation ctx cast bridge.
- **`features/eventtypes/lib/getEventTypeById.ts`** — the 3 `eventTypes.get`-chain prisma reads guarded behind
  `ownerAuthUserId`.
- **`availability/schedule/getScheduleByUserId.handler.ts`** + **`getScheduleByEventTypeSlug.handler.ts`** — rewired
  off prisma.
- **6 eventTypes host sub-query handlers** + **`slots/reserveSlot.handler.ts`** / **`isAvailable.handler.ts`** /
  **`slots/_router.tsx` (removeSelectedSlotMark)** / **`bookings/find.handler.ts`** / **`bookings/getBookingDetails.handler.ts`**
  — disabled / no-op'd per the table above. (Now-unused value imports left in place; `noUnusedLocals:false`.)
- **`eventTypes/__tests__/util.test.ts`** — the old prisma-behavior tests (which mocked `ctx.prisma.eventType.findUnique`
  + the dead team/`PermissionCheckService` branches) are **REPLACED** with Convex-backed tests (mock
  `checkOwnerEventTypeOwnership`; assert NOT_FOUND/FORBIDDEN/allow + the in-memory `users` guard + `eventTypeId↔id`
  resolution). The `ensureEmailOrPhoneNumberIsPresent` tests are UNCHANGED. 15 tests pass.

### Verify (real results — local macOS arm64, 2026-06-02)

| check | result |
| --- | --- |
| convex `vitest run convex/scheduling/` | **24 files / 338 tests PASS** (was 23/333 — +1 file, +5 in `cv9OwnershipCheck.test.ts`). The single `schema.test.ts` "1 error" is the PRE-EXISTING `@edge-runtime/vm`-absent forks-worker env error (unrelated; same as CV-5..CV-8). |
| convex `tsc -p convex/tsconfig.json --noEmit` | **EXIT 0, 0 errors** |
| fork `vitest run …/eventTypes/__tests__/util.test.ts` | **15/15 PASS** (8 rewritten pbac + 7 unchanged email/phone) |
| fork `tsc -p packages/trpc/tsconfig.json --noEmit` | **EXIT 0, 0 errors** (incl. test files) |
| fork `tsc -p apps/web/tsconfig.json --noEmit` | **EXIT 0, 0 errors** |

**`types/` hazard:** CV-9 added NO new tRPC procedure (only rewired existing middlewares + bodies), so the
`packages/trpc/types/**` pre-generated `.d.ts` AppRouter tree needed NO edit, and NO full `types/` regen was run. The
`getUserFromSession` rewire was specifically engineered to keep `UserFromSession`/`TrpcSessionUser` byte-identical
(the in-scope cast, not a `ReturnType<>` reference) — confirmed by the clean web+trpc tsc.

### Runtime status: [R] — needs deploy + a live owner/visitor session

Type-clean + unit-tested but runtime-unverified. To go live: deploy the backend so `scheduling/calcomAdmin:adminCheckEventTypeOwner`
exists (run `convex dev --once` to register — NOT `codegen`), set `NEXT_PUBLIC_CONVEX_URL` on the fork, then confirm
with a signed-in owner: the event-type editor LOADS (`get`) / SAVES (`update`) / DELETEs / DUPLICATEs without a 500
(was 500ing in the pbac middleware before any body ran), the availability page loads its default schedule, and an
ANONYMOUS visitor can open a booking page + pick a slot (reserveSlot/isAvailable no longer 500). The host-assignment
sub-tabs + bookings detail/editLocation/find should surface empty/"not available" rather than a 500.

### End-state claim (full authed + public surface)

With CV-9, the three gating `.use()` middlewares (`createEventPbacProcedure`, `isAuthed`/`getUserFromSession`,
`bookingsProcedure`) no longer touch `ctx.prisma`, and every CV-8-flagged + trace-swept reachable read (authed AND
public/anonymous) is REWIRED to Convex or CLEANLY DISABLED with a typed no-op / friendly TRPCError BEFORE any
`ctx.prisma` access. Combined with CV-1..CV-8: **no in-scope surface — middleware, handler, or helper — reaches an
unhandled `ctx.prisma` runtime throw on the no-Postgres fork.**

> ⚠️ CV-9's end-state claim was scoped to the tRPC RESOLVER-BODY + `.use()` MIDDLEWARE layer. It did NOT sweep the
> App-Router PAGE-SSR prefetch layer (`page.tsx` server data-loaders + client-on-mount `useQuery`s) nor one app-store
> helper reached from a rewired resolver. CV-10 closes those — see below.

---

## CV-10 — the residual PAGE-LOAD prisma close-out (SSR prefetch + client-on-mount reads)

**Goal:** CV-1..CV-9 rewired resolver bodies + the three gating middlewares. A re-grep + per-page load-time trace found
SIX category-(A) breaks that 500 the page on the no-Postgres fork because they run in the App-Router page-SSR prefetch
layer (or a client-on-mount `useQuery`) that CV-1..CV-9 never swept — INCLUDING the confirmed BLOCKING LEAF the prior
review flagged. All are now REWIRED to Convex (reusing existing s2s fns) or CLEANLY DISABLED to a cal-shaped default,
using the established **DUAL-MODE GUARD**: a no-Postgres-fork signal short-circuits BEFORE any prisma, leaving the
original prisma path intact for a real Postgres cal.com deploy. tsc can't catch these (prisma is fully typed; the throw
is runtime-only). NO React component, tRPC client, or zod input/output schema was touched; NO new tRPC procedure was
added (only bodies/guards rewired) so the `types/` `.d.ts` tree needed NO edit and NO regen was run.

### The dual-mode signal

- **Authed handlers / app-store helpers**: `ctx.user.uuid` (the dibslist authUserId — present iff the CV-1 session
  hydrated, i.e. the no-Postgres fork) or, for `getConnectedApps`, the `user.uuid` it carries.
- **Anonymous public SSR / non-uuid call sites** (`getUsersInOrgContext`, `FeaturesRepository`): the env
  `NEXT_PUBLIC_CONVEX_URL` (required + always set on `book.dibslist.app`; absent on a real Postgres cal.com deploy).

### THE BLOCKING LEAF (fixed first)

`packages/features/eventtypes/lib/getEventTypeById.ts:227` called `getLocationGroupedOptions({ userId }, t)`
**UNCONDITIONALLY** (NOT guarded by `ownerAuthUserId`). That fn (`packages/app-store/server.ts:58` `prisma.user.findUnique`
+ `:65` `prisma.credential.findMany`) THREW on the no-Postgres fork → 500'd `eventTypes.get` (the EDITOR LOAD), despite
CV-9 fixing the gating middleware + the other 3 reads in this file. **CV-10**: a NEW pure export
`defaultLocationGroupedOptions(t)` in `app-store/server.ts` builds the cal-shaped location groups from `defaultLocations`
ONLY (no DB, same `{label,options}[]` shape, freshly-mutable for the MANAGED `.splice`). The call site is now
`ownerAuthUserId ? defaultLocationGroupedOptions(t) : await getLocationGroupedOptions(...)` — mirroring the CV-9
getRawEventType/fallback-user/destinationCalendar skips in the SAME file. Prisma path intact for `ownerAuthUserId`-absent.

### Category (A) — closed (each REWIRED to Convex or DISABLED to a default, dual-mode)

| # | file:line | surface (page load) | disposition |
|---|---|---|---|
| A5 | `features/eventtypes/lib/getEventTypeById.ts:227` | event-type EDITOR SSR (`caller.get`) | **THE BLOCKING LEAF — guarded** behind `ownerAuthUserId` → `defaultLocationGroupedOptions(t)` (no prisma). |
| apps | `app-store/_utils/getConnectedApps.ts:65,69` | connected-CALENDARS SSR + EDITOR client `apps.integrations` | **DISABLED on fork** — `user.uuid` ⇒ `credentials = []` (skips `getUsersCredentialsIncludeServiceAccountKey` raw `prisma.credential.findMany`) + skips the `prisma.team.findMany` block; the rest of `getConnectedApps` runs over the empty set → correct "no installed apps" shape. |
| A2 | `eventTypes/getUserEventGroups.handler.ts:39,53` | event-type LIST SSR (`getCachedEventGroups`) | **REWIRED** — `user.uuid` ⇒ synthesize the ONE personal group from `ctx.user` via cal's PURE `createUserEventGroup`/`createProfilesWithPermissions` + empty `teamPermissionsMap` (drops `ProfileRepository.findByUpIdWithAuth` + `EventGroupBuilder.buildEventGroups` prisma). |
| A3 | `eventTypes/getEventTypesFromGroup.handler.ts:49,156,172` | event-type LIST client `useInfiniteQuery` (mount) | **REWIRED → Convex** — `ctx.user.uuid` ⇒ `listOwnerEventTypeRows` (`adminListEventTypes`); each row → a synthesized `EventType` base (empty users/hosts/children so `mapEventType`'s prisma enrich never runs) → cal's own `mapEventType` → `isCurrentUserHost:false`. Drops `findAllByUpId` + `prisma.host.findMany` + `prisma.membership.findFirst`. `id` = the persistent round-trippable `calId`. |
| bulk | `eventTypes/bulkEventFetch.handler.ts` | availability LIST + EDITOR client `bulkEventFetch` (mount) | **REWIRED → Convex** — `ctx.user.uuid` ⇒ `getOwnerBulkEventTypesFromConvex` (`adminListEventTypes`) → `{ eventTypes:[{id=calId,title,slug,...}] }`; `id` = the persistent `calId` the bulk dialog feeds back into `bulkUpdateToDefaultAvailability` (CV-8). Drops `getBulkUserEventTypes` raw `prisma.eventType.findMany`. |
| travel | `travelSchedules/getTravelSchedules.handler.ts` | availability EDITOR SSR (parallel `travelSchedulesCaller.get()`) | **DISABLED** — `ctx.user.uuid` ⇒ `[]` (our backend has no travel schedules). Drops `TravelScheduleRepository.findTravelSchedulesByUserId` raw `prisma.travelSchedule.findMany`. |
| A4 | `bookings/[status]/page.tsx:46,47` → `flags/features.repository.ts:checkIfUserHasFeature` | `/bookings` SSR feature-flag gate | **DISABLED** — `NEXT_PUBLIC_CONVEX_URL` set ⇒ return `false` (the flags default OFF = the page's fallback branch) BEFORE the `prisma.userFeatures.findFirst` that RE-THROWS. Guarded in the repo (the page is a server component — not editable per scope). |
| A1 | `apps/web/server/lib/[user]/getServerSideProps.ts:getUsersInOrgContext` | PUBLIC Booker `/[user]/[type]` SSR | **REWIRED** — `NEXT_PUBLIC_CONVEX_URL` set ⇒ synthesize ONE minimal cal-shaped user per username (`buildPublicForkUser`); the `[user]` segment is display-only (the Convex public read keys off the `[type]` slug — §CV-2a), event existence + meta come from the CV-2a `EventRepository.getPublicEvent`. Drops `UserRepository.findUsersByUsername` raw `prisma.user.findMany`. |

### Category (B) — already handled by CV-1..CV-9 (left as-is, verified)

All action-path writes/reads (eventTypes heavy update/duplicate/delete, availability schedule create/update/get/delete,
me.updateProfile, bookings confirm/addGuests/editLocation/getBookingDetails/find, slots reserve/isAvailable/remove,
calendars connect/setDestination/conflict-toggle, credentials delete, the 6 host sub-queries, the 3 `.use()`
middlewares, `viewer.bookings.get` → `listBookingsViaConvex`) route through Convex or throw a friendly TRPCError BEFORE
any `ctx.prisma`. Unchanged by CV-10.

### Category (C) — dead-code, re-CONFIRMED unreachable in the single-user/no-team model (NO guard added)

Per "do not guard genuinely-unreachable code", these were verified to have NO in-scope page-load call site and are left
exactly as-is:

- **`eventTypes/getActiveOnOptions.handler.ts:80`** (`new EventTypeRepository(ctx.prisma)`) — ZERO `useQuery`/prefetch
  callers in `apps/web` (managed-event "active on" picker, no in-scope UI). Unreachable.
- **`eventTypes/searchTeamMembers.handler.ts:23`** (`new EventTypeHostService(ctx.prisma)`) — ZERO `useQuery` callers
  (CV-7's assignment tab uses `resolveCoHostByEmail`, not this team-member search). Unreachable.
- **`availability/calendarOverlay.handler.ts:33`** — sole call site `useCalendars.ts:34` is `enabled: hasSession &&
  set.size>0 && switchEnabled` (a USER ACTION — toggling overlay calendars on the Booker), NOT a default load. Action-only.
- **`availability/schedule/getAllSchedulesByUserId.handler.ts:33`** — only assigned as a function-ref
  (`hostSchedulesQuery`, `EventAvailabilityTabWebWrapper.tsx:64`) passed to host-availability subcomponents that mount
  only on the editor's Availability TAB click (not `?tabName=setup`). Action-only / host-subcomponent.
- **`getEventTypeById.ts` `getRawEventType:313` (`prisma.team.findUnique`)** — `isUserOrganizationAdmin &&
  currentOrganizationId` false single-user (org-admin dead branch). `:191` fallback-user + `:293` destinationCalendar are
  CV-9-guarded behind `ownerAuthUserId`. `app-store/server.ts:37` `prisma.team.findFirst` is the `"teamId" in userOrTeamId`
  branch — never taken for `{ userId }`, and `getLocationGroupedOptions` itself is now bypassed on the editor path anyway.
- **`eventTypes/util.ts:eventOwnerProcedure` PBAC**, **`getUserSession` profileId branch**, **`getEventTypeById:290` team
  block**, **`create.handler:138` org** — all org/team/profileId-gated; `organizationId`/`teamId`/`profileId` are
  null/undefined in the CV-1 single-user session. Re-confirmed latent.

### Backend (dibslist repo, `packages/backend/convex`)

**NO new Convex fn or schema change.** Every read CV-10 sources reuses the EXISTING `scheduling/calcomAdmin:adminListEventTypes`
(s2s, `ownerAuthUserId`-scoped, NOT `booking_enabled`-gated — owner can inspect config while the public surface is dark;
delegates to `listEventTypesCore`). So no new convex-test was required; `calcomAdmin.test.ts` already covers
`adminListEventTypes`. (`calendarOverlay`'s only Convex backing would be a per-credential `getBusyForCredential`
internalAction + an unbuilt `freebusyCache` merge — out of scope; it's action-only/dead here anyway.)

### Fork (COMMITTED, this repo)

- **`packages/app-store/server.ts`** — NEW pure export `defaultLocationGroupedOptions(t)`.
- **`packages/features/eventtypes/lib/getEventTypeById.ts`** — the `getLocationGroupedOptions:227` call guarded behind
  `ownerAuthUserId`.
- **`packages/app-store/_utils/getConnectedApps.ts`** — `user.uuid` ⇒ empty credentials + skip team prisma.
- **`packages/trpc/server/routers/viewer/eventTypes/getUserEventGroups.handler.ts`** — personal-group synthesis on fork.
- **`packages/trpc/server/routers/viewer/eventTypes/getEventTypesFromGroup.handler.ts`** — Convex list + synthesized
  `EventType` base + `mapEventType` on fork.
- **`packages/trpc/server/routers/viewer/eventTypes/bulkEventFetch.handler.ts`** — Convex bulk list on fork.
- **`packages/trpc/server/routers/viewer/travelSchedules/getTravelSchedules.handler.ts`** — `[]` on fork.
- **`packages/features/flags/features.repository.ts`** — `checkIfUserHasFeature` returns `false` on fork.
- **`apps/web/server/lib/[user]/getServerSideProps.ts`** — `getUsersInOrgContext` synthesizes the public user on fork.
- **`packages/lib/server/calcomAdminAdapters.ts`** — NEW adapters `listOwnerEventTypeRows` + `getOwnerBulkEventTypesFromConvex`
  (both over `adminListEventTypes`). No existing adapter touched.

### Per-page LOAD-time reachable-prisma status (post-CV-10)

| Page | Load-time chain | reachable runtime prisma |
|---|---|---|
| event-type LIST `/event-types` | `getServerSession` (Convex) → `getUserEventGroups` (A2, fork→Convex/synth) → client `getEventTypesFromGroup` (A3, fork→Convex) | **NONE** |
| event-type EDITOR `/event-types/[type]` | SSR `caller.get` → `getEventTypeById` (CV-9 guards + A5 location guard) → client `apps.integrations` (apps, fork→[]) + `me.get` (CV-2c, Convex) | **NONE** |
| availability LIST `/availability` | SSR `availability.list` (CV-2c, Convex) → client `bulkEventFetch` (fork→Convex) | **NONE** |
| availability EDITOR `/availability/[schedule]` | SSR `schedule.get` (CV-2c, Convex) ∥ `travelSchedules.get` (fork→[]) → client `bulkEventFetch` (fork→Convex) | **NONE** |
| connected calendars `/settings/my-account/calendars` | SSR `calendars.connectedCalendars` (CV-2c/5, Convex) ∥ `apps.integrations` (apps, fork→[]) | **NONE** |
| `/bookings/[status]` | SSR `getServerSession` + `checkIfUserHasFeature` ×2 (A4, fork→false) → client `bookings.get` (CV-4, Convex) | **NONE** |
| profile `/settings/my-account/profile` | SSR `me.get` (CV-2c, pure off `ctx.user`) | **NONE** (already clean) |
| PUBLIC Booker `/[user]/[type]` | SSR `getServerSession` + `handleOrgRedirect` + `getUsersInOrgContext` (A1, fork→synth) + `EventRepository.getPublicEvent` (CV-2a, Convex) | **NONE** |

### GREP GATE result

Re-ran the exhaustive grep restricted to the in-scope page-LOAD chains (`getEventTypeById` + the 8 page chains above + the
app-store helpers they reach). **ZERO reachable runtime `ctx.prisma` / raw `prisma.*` remains on a default page load.**
Every prisma call still present in those files is EITHER positioned AFTER a dual-mode early-return guard (unreachable on
the fork) OR is documented Category-(C) dead-code (org/team/profileId-gated, never reached single-user) — see the table
above for the gating proof of each.

### Verify (real results — local macOS arm64, 2026-06-02)

| check | result |
| --- | --- |
| convex `vitest run convex/scheduling/` | **24 files / 338 tests PASS** (no new test — reuses `adminListEventTypes`). EXIT 1 is the PRE-EXISTING `@edge-runtime/vm`-absent forks-worker env error for `schema.test.ts` (same as CV-5..CV-9; all 338 tests pass). |
| convex `tsc -p convex/tsconfig.json --noEmit` | **EXIT 0, 0 errors** |
| fork `tsc -p packages/trpc/tsconfig.json --noEmit` | **EXIT 0, 0 errors** |
| fork `tsc -p apps/web/tsconfig.json --noEmit` | **EXIT 0, 0 errors** |
| grep gate (in-scope page-load chains) | **ZERO reachable runtime prisma** (remaining hits are guard-gated or documented dead-code) |

### Runtime status: [R] — needs deploy + live page loads

Type-clean + tested but runtime-unverified. To confirm: deploy the backend (the reused `adminListEventTypes` already
exists), set `NEXT_PUBLIC_CONVEX_URL` on the fork, then load — signed-in — the event-type LIST + EDITOR, availability
LIST + EDITOR, connected-calendars, `/bookings`, profile; and ANONYMOUSLY the public Booker `/[user]/[type]`. None should
500 (all previously 500'd on at least one load-time prisma read).

### End-state claim (CV-1..CV-10)

The resolver-body + middleware layer (CV-1..CV-9) AND the App-Router page-SSR prefetch + client-on-mount layer (CV-10)
are now both swept. **No in-scope page LOAD — SSR loader, prefetch, client-on-mount query, middleware, handler, or
app-store helper — reaches an unhandled runtime `ctx.prisma` / raw `prisma.*` throw on the no-Postgres fork.** Remaining
prisma in the in-scope files is exclusively dual-mode-guarded (Postgres-deploy-only) or documented single-user dead-code.

## CV-11 — FINAL transitive-import-closure prisma sweep (the 4 residual leaves)

**Goal:** CV-10 closed the page-SSR/client-on-mount layer, but a CV-10 post-review + an EXHAUSTIVE
transitive-import-closure trace (every load-time import chain, per in-scope page, down to the leaf prisma call) found
FOUR residual UNGUARDED runtime-prisma sites that CV-10's guards did NOT transitively cover. The CV-10 LESSON applies
directly: **a guarded function can still call an UNGUARDED helper, and SSR pre-handler code runs before the Convex
guard.** Two were pre-confirmed by the review (#1, #2); the closure trace surfaced two MORE (#3 on the bare `/[user]`
profile page CV-10 never traced, #4 on the dynamic-group Booker branch that bypasses CV-10's A1 wrapper). All four are
now closed with the established **DUAL-MODE GUARD**, guarding the HELPER ITSELF (or the call into it) so the transitive
reach is covered. NO React component, tRPC client, or zod schema touched; NO new tRPC procedure → `types/` `.d.ts` tree
needed NO edit and NO regen was run. NO new Convex fn or schema change (all four resolve to cal-shaped defaults, not new reads).

### The four residual leaves — each CLOSED

| # | leaf (file:line) | reached via | in-scope page(s) | fix |
|---|---|---|---|---|
| 1 | `packages/app-store/_utils/getEnabledAppsFromCredentials.ts:56,61` `prisma.app.findMany` ×2 (unconditional) | `getConnectedApps.ts:156` (called on EVERY path; CV-10 guarded `getConnectedApps`'s OWN credential/team prisma but still calls this helper unconditionally) → `integrations.handler.ts:16` | event-type EDITOR (client `apps.integrations.useQuery`) + connected-calendars (SSR `appsCaller.integrations`) | **Guard the HELPER ITSELF** — `NEXT_PUBLIC_CONVEX_URL` set ⇒ both `prisma.app.findMany` SKIPPED, DB enablement list = `[]`; the PURE `getApps` + `appDbQuery?.enabled \|\| app.isGlobal` reduce runs unchanged → global-only `EnabledApp[]`; after `getConnectedApps`'s `onlyInstalled` filter → `{ items: [] }` (the cal-shaped "no installed apps" envelope every consumer reads via `.items`). Env signal (the helper has no `ctx.user`/`user.uuid` in scope). Prisma path intact off-fork. |
| 2 | `apps/web/lib/handleOrgRedirect.ts:48` `prisma.tempOrgRedirect.findMany` | `getTemporaryOrgRedirect` ← `handleOrgRedirect` `if(!isOrgContext)` (always true single-user) — SSR PRE-HANDLER, runs BEFORE every Convex/guarded read | public Booker `/[user]/[type]` (BOTH `getUserPageProps:223` + `getDynamicGroupPageProps:125`) + `/[user]` profile (`:85`) | **Guard the HELPER ITSELF** (`getTemporaryOrgRedirect`) — `NEXT_PUBLIC_CONVEX_URL` set ⇒ early-return `null` (the cal-shaped "no redirect, continue SSR" value; matches the declared `Promise<NextJsRedirect\|null>` + the `if(redirect) return redirect;` call sites that fall through to `EventRepository.getPublicEvent`). Single-user fork has no org-rename history → never a temp redirect. Anonymous SSR → env signal. Prisma intact off-fork. |
| 3 | `packages/features/eventtypes/lib/getEventTypesPublic.ts:33` `prisma.$queryRaw` | `getEventTypesWithHiddenFromDB` ← `getEventTypesPublic(user.id)` called UNCONDITIONALLY at `apps/web/server/lib/[user]/getServerSideProps.ts:165` | `/[user]` PROFILE SSR (**NOT in the CV-10 table — that traced only `/[user]/[type]`**) | **Guard the HELPER ITSELF** (`getEventTypesWithHiddenFromDB`) — `NEXT_PUBLIC_CONVEX_URL` set ⇒ return `[]` (`RawEventType[]`). Fork synth user has `id:0` (no real PG graph); no per-owner public-event-type-LIST Convex read exists (only the slug-scoped single-event `EventRepository.getPublicEvent` §CV-2a), and the profile grid is display-only → empty list is the cal-shaped default (SSR `eventTypes.length===1` redirect + `.map` both tolerate `[]`). Anonymous SSR → env signal. Prisma intact off-fork. |
| 4 | `packages/features/users/repositories/UserRepository.ts:175(/203)` `prisma.user.findMany` in `findUsersByUsername` | DIRECT `new UserRepository(prisma).findUsersByUsername(...)` at `apps/web/server/lib/[user]/[type]/getServerSideProps.ts:137-138`, **bypassing CV-10's A1-guarded `getUsersInOrgContext` wrapper** | public Booker DYNAMIC-GROUP `/[u1]+[u2]/[type]` SSR (the `user.length>1` branch) | **Route the call THROUGH the guarded wrapper** — `getDynamicGroupPageProps` now calls `getUsersInOrgContext(usernames, …)` (CV-10 A1: fork → synthesized `buildPublicForkUser` per username) instead of the raw repo. Removed the now-dead `new UserRepository(prisma)` + its unused `UserRepository` import. Event existence + meta still come from the CV-2a Convex read. Prisma path (inside the guarded wrapper) intact off-fork. |

### Per-page LOAD-time reachable-prisma status (post-CV-11) — transitive closure, ALL 8+1 entry points

| Page | transitive closure → reachable runtime prisma (post-CV-11) |
|---|---|
| event-type LIST `/event-types` | **NONE** — `getUserEventGroups` (CV-10 A2 synth) + client `getEventTypesFromGroup` (CV-10 A3 Convex); `mapEventType` enrich never iterates (empty users/hosts/children). |
| event-type EDITOR `/event-types/[type]` | **NONE** — SSR `getEventTypeById` (CV-9 guards + CV-10 A5 location guard) clean; **client `apps.integrations` → `getConnectedApps` → `getEnabledAppsFromCredentials` now CV-11 #1 guarded** (was the residual leaf); `me.get` pure. |
| availability LIST `/availability` | **NONE** — SSR `availability.list` (Convex) + client `bulkEventFetch` (CV-10 Convex). |
| availability EDITOR `/availability/[schedule]` | **NONE** — SSR `schedule.get` (Convex) ∥ `travelSchedules.get` (CV-10 `[]`) + client `bulkEventFetch` (CV-10 Convex). |
| connected calendars `/settings/my-account/calendars` | **NONE** — SSR `calendars.connectedCalendars` (CV-2c/5 Convex) ∥ `appsCaller.integrations` → `getConnectedApps` → **`getEnabledAppsFromCredentials` now CV-11 #1 guarded** (was the residual leaf). `CalendarList`'s own `apps.integrations.useQuery` renders only in the out-of-scope onboarding branch. |
| bookings dashboard `/bookings/[status]` | **NONE** — SSR `checkIfUserHasFeature` (CV-10 A4 `false`) + client `bookings.get` (CV-4 Convex). |
| profile `/settings/my-account/profile` | **NONE** — `me.get` pure off `ctx.user` (already clean). |
| public Booker `/[user]/[type]` (single-user) | **NONE** — **`handleOrgRedirect` now CV-11 #2 guarded** (was the residual pre-handler leaf) → `getUsersInOrgContext` (CV-10 A1 synth) → `EventRepository.getPublicEvent` (CV-2a Convex). Reschedule/seated paths query-param-gated (Category B). |
| public Booker `/[u1]+[u2]/[type]` (dynamic-group) | **NONE** — **`handleOrgRedirect` CV-11 #2 guarded** → **`findUsersByUsername` now routed through CV-10 A1 `getUsersInOrgContext` (CV-11 #4)** (was the bypass leaf) → `EventRepository.getPublicEvent` (CV-2a Convex). |
| `/[user]` profile SSR | **NONE** — **`handleOrgRedirect` CV-11 #2 guarded** → `getUsersInOrgContext` (CV-10 A1 synth) → **`getEventTypesPublic` now CV-11 #3 guarded** (was the residual leaf, untraced by CV-10). |

### Fork (COMMITTED, this repo)

- **`packages/app-store/_utils/getEnabledAppsFromCredentials.ts`** — CV-11 #1: `NEXT_PUBLIC_CONVEX_URL` ⇒ skip both `prisma.app.findMany`, DB enablement list `[]`.
- **`apps/web/lib/handleOrgRedirect.ts`** — CV-11 #2: `getTemporaryOrgRedirect` early-returns `null` on the env signal (before `prisma.tempOrgRedirect.findMany`).
- **`packages/features/eventtypes/lib/getEventTypesPublic.ts`** — CV-11 #3: `getEventTypesWithHiddenFromDB` returns `[]` on the env signal (before `prisma.$queryRaw`).
- **`apps/web/server/lib/[user]/[type]/getServerSideProps.ts`** — CV-11 #4: dynamic-group branch routed through guarded `getUsersInOrgContext`; dead `new UserRepository`/import removed.

### Backend (dibslist repo, `packages/backend/convex`)

**NO change.** All four CV-11 leaves resolve to cal-shaped defaults (empty enabled-apps / null redirect / empty event-type
list / reuse of CV-10's `buildPublicForkUser`) — no new Convex query or schema. No new convex-test required.

### GREP GATE result (transitive closure, post-CV-11)

Re-ran the exhaustive transitive-import-closure grep across ALL 8 in-scope page-load chains (+ the `/[user]` profile +
dynamic-group variant the closure trace added). **ZERO unguarded reachable runtime `prisma.*` / `ctx.prisma` /
`$queryRaw` remains on any default page load.** Every prisma call still present in the closure files is EITHER behind a
dual-mode early-return guard (CV-1..CV-11; unreachable on the fork) OR documented dead-code/action-path:

- `getEnabledAppsFromCredentials.ts:75,82`, `handleOrgRedirect.ts:64`, `getEventTypesPublic.ts:48` — CV-11-guarded.
- `getConnectedApps.ts:80` — CV-10 `if(!isConvexFork…)`. `getEventTypeById.ts:191,293` — CV-9 `ownerAuthUserId`-guarded; `:325` dead org-admin branch.
- `[user]/[type]/getServerSideProps.ts:70` (`processReschedule`) — query-param-gated action path (Category B).
- `UserRepository.findUsersByUsername:175/203` — sole in-scope caller (`getUsersInOrgContext:270`) is AFTER the CV-10 A1 `IS_CONVEX_FORK` early-return; the dynamic-group bypass is now CV-11 #4-routed through it. Other `findUsersByUsername` callers (`/d/[link]` route, slots `util.ts`, booking-create `loadUsers.ts`, the LEGACY `getPublicEvent.ts` which CV-2a replaced for in-scope use) are out-of-scope/action-path/type-only.

### Verify (real results — local macOS arm64, 2026-06-02)

| check | result |
| --- | --- |
| convex `vitest run convex/scheduling/` | **24 files / 338 tests PASS** (no new test — CV-11 adds no Convex fn). EXIT 1 = the PRE-EXISTING `@edge-runtime/vm`-absent forks-worker env error for `schema.test.ts` (same as CV-5..CV-10; all 338 tests pass). |
| convex `tsc -p convex/tsconfig.json --noEmit` | **EXIT 0, 0 errors** |
| fork `tsc -p packages/trpc/tsconfig.json --noEmit` | **EXIT 0, 0 errors** |
| fork `tsc -p apps/web/tsconfig.json --noEmit` | **EXIT 0, 0 errors** |
| grep gate (transitive closure, all in-scope page-load chains) | **ZERO unguarded reachable runtime prisma** (remaining hits are CV-1..CV-11 guard-gated or documented dead-code/action-path) |

### Runtime status: [R] — needs deploy + live page loads

Type-clean + tested but runtime-unverified (no Convex fn added, so nothing new to deploy beyond the existing backend).
To confirm: with `NEXT_PUBLIC_CONVEX_URL` set on the fork, load — signed-in — the event-type EDITOR + connected-calendars
(must not 500 on the apps `integrations` query); and ANONYMOUSLY the public Booker single-user `/[user]/[type]`, the
dynamic-group `/[u1]+[u2]/[type]`, and the bare `/[user]` profile (none should 500 on the pre-handler `handleOrgRedirect`,
`getEventTypesPublic`, or the dynamic-group `findUsersByUsername`).

### End-state claim (CV-1..CV-11)

The resolver-body + middleware layer (CV-1..CV-9), the App-Router page-SSR prefetch + client-on-mount layer (CV-10), AND
the final transitive-import-closure leaves (CV-11: transitively-called app-store helper, SSR pre-handler redirect, the
untraced `/[user]` profile read, and the dynamic-group wrapper bypass) are all swept. **No in-scope page LOAD reaches an
unhandled runtime `prisma.*` throw on the no-Postgres fork along ANY transitive import path — SSR loader, pre-handler,
prefetch, client-on-mount query, middleware, handler, app-store helper, or repository.** All remaining prisma in the
closure is dual-mode-guarded (Postgres-deploy-only) or documented single-user dead-code/action-path.
