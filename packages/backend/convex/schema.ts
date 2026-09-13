// Standalone booking backend schema. The scheduling/booking tables are lifted
// verbatim from the dibslist monorepo (packages/backend/convex/schema.ts,
// "Scheduling / booking suite" block); the handful of support tables below
// (featureFlags, recentErrors, apiCallLog, apiKeys, notifications, profile
// stubs) are the minimal set the scheduling modules still reference.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // ── Support tables ────────────────────────────────────────────────────
  // In-app notification feed (owner-facing: booking_received, calendar_sync_failed).
  notifications: defineTable({
    authUserId: v.string(),
    kind: v.string(),
    title: v.string(),
    body: v.optional(v.string()),
    href: v.optional(v.string()),
    readAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_user", ["authUserId", "createdAt"]),
  // Minimal owner profile rows the public booking page reads a display name from.
  userPreferences: defineTable({
    authUserId: v.string(),
    displayName: v.optional(v.string()),
  }).index("by_user", ["authUserId"]),
  sellerProfiles: defineTable({
    authUserId: v.string(),
    displayName: v.optional(v.string()),
    avatarStorageId: v.optional(v.id("_storage")),
  }).index("by_user", ["authUserId"]),

  featureFlags: defineTable({
    key: v.string(),
    value: v.boolean(),
    updatedAt: v.number(),
    updatedBy: v.string(),
    reason: v.optional(v.string()),
  }).index("by_key", ["key"]),

  // PRD locked decision #3 — pilot ZIP allowlist as seed table with admin
  // editor. Server-enforced gate. Client-side ZIP check is UX, not security.
  // Out-of-pilot users land on waitlistSignups, not the marketplace.
  //
  // ADMIN-AUDIT-iter53 S2: `deletedAt` is a soft-delete marker. The admin
  // "Delete" button now patches `deletedAt: Date.now()` instead of hard-
  // deleting the row, preserving `addedByAuthUserId` + `addedAt` history
  // and giving operators a one-click "Undo delete" affordance. All read
  // paths (isZipInPilot, getMyPilotStatus, listPilotZips for live rows,
  // addPilotZip's duplicate check) filter `deletedAt === undefined`.
  // Operator policy: soft-deleted rows are kept indefinitely for now;
  // a future cron can hard-purge rows where Date.now() - deletedAt >= 30d.
  recentErrors: defineTable({
    at: v.number(),
    level: v.union(
      v.literal("error"),
      v.literal("warn"),
      v.literal("critical"),
    ),
    event: v.string(),
    requestId: v.optional(v.string()),
    authUserId: v.optional(v.string()),
    endpoint: v.optional(v.string()),
    // JSON.stringify of the structured context (err + caller context),
    // capped at 4KB on the write side. Stored as a string (not v.any())
    // so the table cost stays bounded and the read path doesn't need
    // to re-serialize for the admin UI.
    details: v.optional(v.string()),
  })
    .index("by_at", ["at"])
    .index("by_endpoint_at", ["endpoint", "at"])
    .index("by_event_at", ["event", "at"])
    .index("by_level_at", ["level", "at"]),

  // CRON-AUDIT-iter75 H1 (iter-76 fix) + CONCURRENCY-AUDIT-iter73 M3 / M5 —
  // per-cron mutex table so long-running ticks don't self-overlap when the
  // next scheduled fire arrives before the previous tick drains. Convex has
  // no built-in skip-when-busy; without this table two parallel ticks of
  // the same handler race on the same backlog, doing double-work that
  // mostly self-corrects via state guards but amplifies cost and will mask
  // future side-effect bugs as cron bodies grow.
  //
  // Shape:
  //   - cronName    — stable slug matching the `crons.ts` registration name
  //   - acquiredAt  — Date.now() when the lock was claimed
  //   - expiresAt   — acquiredAt + ttlMs; the next `acquireCronLock` call
  //                   treats any row with `expiresAt <= now` as releasable
  //                   and overwrites it. Convex has no row-level TTL — the
  //                   expiry is enforced lazily at next acquire.
  //   - acquiredBy  — optional process tag for forensics (e.g. "cron-tick"
  //                   vs "manual-replay"); writers may omit it.
  //
  // Race-safety: insert + scan run inside a single mutation, so OCC
  // serializes two simultaneous "first acquire" attempts on the same
  // cronName — one wins, the other retries, sees the fresh row, and
  // returns false. See `_helpers/cronLock.ts` for the helper pair.
  apiCallLog: defineTable({
    authUserId: v.string(),
    kind: v.string(),
  }).index("by_authUserId_kind", ["authUserId", "kind"]),

  // SECURITY-AUDIT-iter109 H1+H2 — per-admin rate-limit ledger for
  // destructive admin ops (`forceDeleteUser`, `revokeUserSession`,
  // `summarizeStep`, etc.). Separate from `apiCallLog` so the per-kind
  // scan cost stays cheap and so an operator can grep "every destructive
  // attempt admin X made in the last hour" without joining against the
  // user-facing throttle. Writer + reader: `_helpers/adminRateLimit.ts`.
  //
  // Every ATTEMPT is logged (even ones that exceed the cap) so an
  // attacker scripting forceDeleteUser leaves a fingerprint in this
  // table even when the throw blocks the underlying mutation. The
  // (adminAuthUserId, kind, at) composite index bounds the sliding-
  // window scan to the relevant slice.
  //
  // 90-day TTL: TODO(iter-110) — piggyback the daily apiCallLog evict
  // chain. Until then, expected volume is low (single-digit/hour per
  // admin across a handful of kinds) so the table stays small.
  apiKeys: defineTable({
    authUserId: v.string(),
    name: v.string(),
    mode: v.union(v.literal("live"), v.literal("test")),
    scopes: v.array(v.string()),
    hashedKey: v.string(), // SHA-256 hex of the full secret
    last4: v.string(),
    spendCapPerOrderUsd: v.optional(v.number()),
    spendCapPerDayUsd: v.optional(v.number()),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_user", ["authUserId"])
    .index("by_hashedKey", ["hashedKey"]),

  // OAuth apps a developer registered (docs US-28). client_secret stored hashed.

  // Scheduling / booking suite — docs/integration-prd.md §5.3 +
  // backend-port-prd §3 (canonical for field detail). All ADDITIVE.
  // A Cal.com-style booking layer: hosts define `eventTypes` backed by
  // `schedules` (`availability` + `dateOverrides`), connect external
  // calendars (`calendarCredentials` / `selectedCalendars`, secrets
  // AES-256-GCM at rest via _helpers/cryptoEnvelope reusing the
  // REFRESH_TOKEN_ENCRYPTION_KEY), and bookers reserve confirmed slots
  // (`bookings` + `bookingAttendees`). `freebusyCache` / `bookingHolds`
  // back a reactive `getAvailableSlots`; `reminders` is the notification
  // sweep queue. Where the integration-PRD §5.3 high-level shape and the
  // backend-port §3 detail differ, backend-port wins for names/types.

  // Host-defined booking page (one per interview/meeting type).
  eventTypes: defineTable({
    ownerAuthUserId: v.string(),
    slug: v.string(), // globally unique (enforced in mutation)
    title: v.string(),
    description: v.optional(v.string()),
    durationMinutes: v.number(),
    // MVP uses collective/round_robin; managed reserved for later.
    schedulingType: v.union(
      v.literal("collective"),
      v.literal("round_robin"),
      v.literal("managed"),
    ),
    scheduleId: v.optional(v.id("schedules")), // pin; else host's default
    slotIntervalMinutes: v.optional(v.number()), // default = duration
    minimumBookingNoticeMinutes: v.number(), // default 120
    bufferBeforeMinutes: v.number(), // default 0
    bufferAfterMinutes: v.number(), // default 0
    bookingWindowDays: v.optional(v.number()), // rolling N days
    dailyBookingLimit: v.optional(v.number()), // per-event-type daily cap
    requireEmailVerification: v.boolean(), // 6-digit verify before confirm
    // E4 anti-abuse (additive; undefined = off):
    //   - requireCaptcha: when true AND TURNSTILE_SECRET_KEY is set, the booking
    //     POST must carry a valid Cloudflare Turnstile token (verified
    //     server-side). No-op when the secret is unset.
    //   - isSingleUse: when true the booking page requires a single-use token
    //     (singleUseTokens row); the token is burned on the first confirmed
    //     booking and subsequent slot-reads/bookings via it return 410/gone.
    requireCaptcha: v.optional(v.boolean()),
    isSingleUse: v.optional(v.boolean()),
    // E3 GROUP capacity (additive; undefined / 1 = solo, current behavior;
    // >1 = group). Orthogonal to schedulingType — a group event is structurally
    // collective, but the slot may absorb up to N bookings before it disappears.
    // No index needed (low cardinality, never range-queried).
    seatsPerSlot: v.optional(v.number()),
    hidden: v.boolean(), // public on org page vs direct-link-only
    locationText: v.optional(v.string()), // free-text/place (no video in MVP)
    active: v.boolean(), // soft-disable without deleting
    // BOOKING-PAYMENTS-PRD §4.1 — Stripe-paid bookings (all optional; absence =
    // free event = current behavior). Gated behind `booking_payments_enabled`.
    //   - priceCents: integer minor units (e.g. 1000 = $10.00). Server is the
    //     SOLE source of the charge amount — never trust a client-supplied price.
    //   - currency: ISO-4217 lowercase ("usd"). Phase 1 ships USD only.
    //   - paymentRequired: true => a completed Stripe payment is required before
    //     the booking is confirmed (the webhook creates the booking, not the
    //     browser). Absent/false => free, unchanged.
    //   - dropMode: null/absent = standard paid slots (immediate capture, refund
    //     the rare race loser). "first_come_drop" = one slot / shared link /
    //     many racers; first completed payment wins, losers voided not charged.
    //   - captureMode: derived default ("manual" when dropMode set, else
    //     "automatic"); persisted so the webhook knows whether to capture/void.
    priceCents: v.optional(v.number()),
    currency: v.optional(v.string()),
    paymentRequired: v.optional(v.boolean()),
    dropMode: v.optional(v.union(v.literal("first_come_drop"))),
    captureMode: v.optional(
      v.union(v.literal("automatic"), v.literal("manual")),
    ),
    // BOOKING-LOTTERY-PRD §3 — the "???" interaction mode. Absent = standard
    // booking. "lottery": slots aren't booked directly — people ENTER a
    // per-slot drawing; the draw at closesAt creates the real booking for a
    // random winner (createBookingHandler rejects direct creates with
    // kind:"lottery_only"). "first_come": a claim-framed session — first
    // person to claim a slot books it instantly (server behavior = standard
    // create; the mode drives the claim UX and is the attachment point for the
    // future pay-to-claim requirement — the dark paid-drop machinery above).
    // Future odd modes extend this union.
    // WAVE-2 (booking-interactions-prd.md): "application" = applicants pitch
    // via intake, the OWNER picks the winner (one-click email links);
    // "threshold" = a group slot confirms only at minimum headcount, else
    // cancels-all; "pair" = the booking holds `pending` until a partner joins
    // via link. "auction"/"dutch" reserved for the Stripe wave (NOT in the
    // union until built).
    interactionMode: v.optional(
      v.union(
        v.literal("lottery"),
        v.literal("first_come"),
        v.literal("application"),
        v.literal("threshold"),
        v.literal("pair"),
      ),
    ),
    // Lottery/application/threshold: entries close N minutes before the slot
    // start (default 1440 = 24h; effective lead = max(this,
    // minimumBookingNoticeMinutes) so the resolve-time booking can never fail
    // the too-soon validation). Generic close lead despite the legacy name.
    lotteryCloseLeadMinutes: v.optional(v.number()),
    // Threshold mode: minimum attendees for the session to confirm. Must be
    // ≤ seatsPerSlot (validated in the editor write path).
    thresholdMinAttendees: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner", ["ownerAuthUserId"])
    .index("by_slug", ["slug"])
    .index("by_owner_active", ["ownerAuthUserId", "active"]),

  // Named availability profile (e.g. "Working hours") with a single tz.
  schedules: defineTable({
    ownerAuthUserId: v.string(),
    name: v.string(),
    timeZone: v.string(), // IANA id e.g. "America/New_York"
    isDefault: v.boolean(), // host default when an eventType pins none
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner", ["ownerAuthUserId"])
    .index("by_owner_default", ["ownerAuthUserId", "isDefault"]),

  // Recurring weekly working-hour windows. One row per (schedule, window).
  availability: defineTable({
    scheduleId: v.id("schedules"),
    ownerAuthUserId: v.string(), // denormalized for owner-scoped scans
    days: v.array(v.number()), // 0=Sunday..6=Saturday
    startMinute: v.number(), // minutes-from-midnight in the schedule's tz
    endMinute: v.number(),
    createdAt: v.number(),
  })
    .index("by_schedule", ["scheduleId"])
    .index("by_owner", ["ownerAuthUserId"]),

  // Single-date exceptions. Null window = unavailable all day.
  dateOverrides: defineTable({
    scheduleId: v.id("schedules"),
    ownerAuthUserId: v.string(), // denormalized
    dateUtc: v.number(), // override's calendar date as UTC midnight epoch-ms
    startMinute: v.optional(v.number()), // null window = unavailable all day
    endMinute: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_schedule", ["scheduleId"])
    .index("by_schedule_dateUtc", ["scheduleId", "dateUtc"]),

  // Connected calendar accounts. Secrets AES-256-GCM at rest via
  // _helpers/cryptoEnvelope's {ciphertext, iv} envelope (two-string flat
  // form, mirroring gmailAccounts; reuse REFRESH_TOKEN_ENCRYPTION_KEY).
  calendarCredentials: defineTable({
    authUserId: v.string(), // owner of this connection
    provider: v.union(v.literal("google"), v.literal("caldav")),
    label: v.string(), // human label e.g. "ted@gmail.com"
    // EncryptedEnvelope.ciphertext (hex). Google: OAuth refresh token.
    // CalDAV: app-specific password.
    encSecretCiphertext: v.string(),
    encSecretIv: v.string(), // EncryptedEnvelope.iv (hex)
    caldavServerUrl: v.optional(v.string()), // CalDAV-only
    caldavUsername: v.optional(v.string()), // CalDAV-only
    googleSyncToken: v.optional(v.string()), // Google incremental events.list
    googleChannelId: v.optional(v.string()), // Google push-channel bookkeeping
    googleChannelResourceId: v.optional(v.string()),
    googleChannelExpiresAt: v.optional(v.number()),
    invalid: v.boolean(), // true when refresh/auth fails (re-prompt UX)
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_authUserId", ["authUserId"])
    .index("by_authUserId_provider", ["authUserId", "provider"])
    .index("by_googleChannelId", ["googleChannelId"]),

  // Which sub-calendars within a credential count as "busy" / are written to.
  selectedCalendars: defineTable({
    authUserId: v.string(),
    credentialId: v.id("calendarCredentials"),
    externalCalendarId: v.string(), // Google calendarId or CalDAV calendar URL
    displayName: v.optional(v.string()),
    checkForConflicts: v.boolean(), // default true; blocks availability
    isDestination: v.boolean(), // default false; the write-target calendar
    timeZone: v.optional(v.string()), // per-calendar tz (Google OOO calibration)
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_authUserId", ["authUserId"])
    .index("by_credential", ["credentialId"])
    .index("by_credential_external", ["credentialId", "externalCalendarId"]),

  // Who staffs an event type (the master PRD calls this `hosts`).
  eventTypeHosts: defineTable({
    eventTypeId: v.id("eventTypes"),
    ownerAuthUserId: v.string(), // denormalized event-type owner
    hostAuthUserId: v.string(), // the interviewer's account
    isFixed: v.boolean(), // true = must attend (collective: all fixed)
    groupId: v.optional(v.string()), // RR grouping: one host per group free
    priority: v.optional(v.number()), // RR star priority tiebreak
    weight: v.optional(v.number()), // RR weighted distribution (LATER)
    scheduleId: v.optional(v.id("schedules")), // host's schedule for THIS type
    createdAt: v.number(),
  })
    .index("by_eventType", ["eventTypeId"])
    .index("by_host", ["hostAuthUserId"])
    .index("by_eventType_host", ["eventTypeId", "hostAuthUserId"]),

  // Confirmed reservations — source of truth, independent of calendar sync.
  bookings: defineTable({
    eventTypeId: v.id("eventTypes"),
    ownerAuthUserId: v.string(), // denormalized event-type owner
    assignedHostAuthUserId: v.optional(v.string()), // RR: the picked host
    startTime: v.number(), // UTC epoch-ms
    endTime: v.number(), // UTC epoch-ms
    timeZone: v.string(), // booker's tz at booking time
    status: v.union(
      v.literal("accepted"),
      v.literal("pending"),
      v.literal("cancelled"),
      v.literal("rescheduled"),
    ),
    rescheduledToBookingId: v.optional(v.id("bookings")),
    rescheduledFromBookingId: v.optional(v.id("bookings")),
    idempotencyKey: v.string(), // dedupe double-submitted confirms
    locationText: v.optional(v.string()), // snapshot from event type
    bookerNotes: v.optional(v.string()),
    // BOOKING-PAYMENTS-PRD §4.2 / §6 — answers to the event type's custom
    // booking questions (the "what kind of session" intake form). Flat
    // label/value array (not free `v.any()`) so it's renderable to the owner
    // without a per-event schema. System fields (name/email/notes) stay where
    // they are; this holds ONLY the custom questions. Absent = none asked.
    intakeResponses: v.optional(
      v.array(
        v.object({
          name: v.string(), // the field's stable identifier
          label: v.string(), // human label snapshot at booking time
          value: v.string(), // the booker's answer (stringified)
        }),
      ),
    ),
    // WAVE-2 PAIR mode — a pair booking lands `pending` with a partner-join
    // capability token + a hold deadline (min(slotStart, now+24h)). The join
    // flips it `accepted`; the expiry check/sweep cancels a still-pending
    // hold. `pending` already occupies the slot in every conflict check.
    partnerToken: v.optional(v.string()),
    partnerDeadline: v.optional(v.number()),
    // Per-host external calendar event refs; externalEventId absent while
    // pending/failed; tries for retry counting.
    externalEvents: v.optional(
      v.array(
        v.object({
          hostAuthUserId: v.string(),
          credentialId: v.id("calendarCredentials"),
          externalCalendarId: v.string(),
          externalEventId: v.optional(v.string()),
          syncStatus: v.union(
            v.literal("pending"),
            v.literal("synced"),
            v.literal("failed"),
          ),
          lastTriedAt: v.optional(v.number()),
          tries: v.optional(v.number()),
        }),
      ),
    ),
    reminderSentAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_eventType", ["eventTypeId"])
    .index("by_owner", ["ownerAuthUserId"])
    .index("by_assignedHost_startTime", ["assignedHostAuthUserId", "startTime"])
    .index("by_owner_startTime", ["ownerAuthUserId", "startTime"])
    .index("by_status_startTime", ["status", "startTime"])
    .index("by_idempotencyKey", ["idempotencyKey"])
    // WAVE-2 PAIR — partner-join capability lookup.
    .index("by_partnerToken", ["partnerToken"]),

  // The people on a booking (the master PRD calls this `attendees`).
  bookingAttendees: defineTable({
    bookingId: v.id("bookings"),
    ownerAuthUserId: v.string(), // denormalized organizer (deletion cascade)
    name: v.string(),
    email: v.string(), // candidate email (unauthenticated booker)
    timeZone: v.string(),
    role: v.union(
      v.literal("booker"),
      v.literal("host"),
      v.literal("guest"),
    ),
    emailVerifiedAt: v.optional(v.number()), // email-verification gate
    createdAt: v.number(),
  })
    .index("by_booking", ["bookingId"])
    .index("by_email", ["email"])
    .index("by_owner", ["ownerAuthUserId"]),

  // Cached external busy intervals per (selectedCalendar, window). Replaces
  // cal.com's Redis withSlotsCache so getAvailableSlots stays a reactive query.
  freebusyCache: defineTable({
    authUserId: v.string(),
    credentialId: v.id("calendarCredentials"),
    externalCalendarId: v.string(), // Google calendarId or CalDAV calendar URL
    windowStart: v.number(), // UTC epoch-ms; the queried window start
    windowEnd: v.number(), // UTC epoch-ms
    busy: v.array(v.object({ start: v.number(), end: v.number() })),
    fetchedAt: v.number(), // for TTL
    expiresAt: v.number(), // fetchedAt + TTL (~2 min); cron/webhook invalidates
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_authUserId", ["authUserId"])
    .index("by_credential", ["credentialId"])
    .index("by_credential_external_window", [
      "credentialId",
      "externalCalendarId",
      "windowStart",
    ])
    .index("by_expiresAt", ["expiresAt"]),

  // Short-lived slot reservations. Replaces cal.com's SelectedSlot / Redis
  // SET NX. ~5-min TTL.
  bookingHolds: defineTable({
    eventTypeId: v.id("eventTypes"),
    startTime: v.number(), // UTC epoch-ms
    endTime: v.number(), // UTC epoch-ms
    holderToken: v.string(), // anonymous session token for unauth candidates
    expiresAt: v.number(), // ~5 min TTL
    createdAt: v.number(),
  })
    .index("by_eventType_start", ["eventTypeId", "startTime"])
    .index("by_expiresAt", ["expiresAt"])
    .index("by_holderToken", ["holderToken"]),

  // BOOKING-PAYMENTS-PRD §4.3 — Stripe payment ledger for paid bookings. One
  // row per Checkout attempt. The booking is created by the WEBHOOK (server-to-
  // server) from `bookingIntent`, never by the browser success redirect — so we
  // persist the full intent here at checkout-create time. Gated behind
  // `booking_payments_enabled`. Fully additive; no existing table is touched
  // (the instabuy mock-pay seam in payments.ts/instabuy.ts is untouched, and
  // this uses its OWN webhook route + signing secret).
  bookingPayments: defineTable({
    eventTypeId: v.id("eventTypes"),
    ownerAuthUserId: v.string(), // denormalized event-type owner
    // Stripe identifiers (absent until sessions.create / the PI is known).
    stripeSessionId: v.optional(v.string()), // cs_...
    paymentIntentId: v.optional(v.string()), // pi_...
    // Money — amount is the SERVER's snapshot of eventTypes.priceCents.
    amountCents: v.number(),
    currency: v.string(), // ISO-4217 lowercase, e.g. "usd"
    captureMode: v.union(v.literal("automatic"), v.literal("manual")),
    status: v.union(
      v.literal("pending"), // session created, awaiting payment
      v.literal("authorized"), // drop: PI authorized, not yet captured
      v.literal("paid"), // captured/completed → booking created
      v.literal("voided"), // drop loser: auth canceled, never charged
      v.literal("refunded"), // standard race loser: charged then refunded
      v.literal("expired"), // session/auth expired without capture
      v.literal("failed"), // payment_intent.payment_failed
    ),
    // Everything needed to create the booking AFTER payment, so the webhook
    // never trusts client re-submission. Mirrors the createBooking body.
    bookingIntent: v.object({
      slug: v.string(),
      start: v.number(), // UTC epoch-ms
      end: v.number(), // UTC epoch-ms
      name: v.string(),
      email: v.string(),
      notes: v.optional(v.string()),
      timeZone: v.string(),
      holderToken: v.optional(v.string()),
      intakeResponses: v.optional(
        v.array(
          v.object({
            name: v.string(),
            label: v.string(),
            value: v.string(),
          }),
        ),
      ),
    }),
    bookingId: v.optional(v.id("bookings")), // set once finalized
    idempotencyKey: v.string(), // dedupe checkout-create + webhook finalize
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_stripeSession", ["stripeSessionId"])
    .index("by_paymentIntent", ["paymentIntentId"])
    .index("by_eventType_status", ["eventTypeId", "status"])
    .index("by_status_createdAt", ["status", "createdAt"])
    .index("by_idempotencyKey", ["idempotencyKey"]),

  // BOOKING-LOTTERY-PRD §3 — one drawing per (eventType, slot). Created lazily
  // by the FIRST entry for that slot; the draw fires at `closesAt` (exact-time
  // ctx.scheduler.runAt + the hourly booking-lottery-sweep backstop) and
  // creates the winner's real booking via createBookingHandler. Status machine:
  // open → drawn (winner booked) | cancelled (slot unfulfillable at draw —
  // entrants emailed an apology) | expired (no entries left, defensive).
  slotLotteries: defineTable({
    eventTypeId: v.id("eventTypes"),
    ownerAuthUserId: v.string(), // denormalized event-type owner
    slotStart: v.number(), // UTC epoch-ms
    slotEnd: v.number(), // UTC epoch-ms
    closesAt: v.number(), // entries close + draw fires (epoch-ms)
    // WAVE-2 — how the round resolves at closesAt. Absent = "random" (the
    // original lottery, back-compat). "owner_pick" = APPLICATION mode: freeze
    // entries, email the owner one-click pick links, await the pick.
    // "threshold" = the round tracks REAL bookings on a group slot; resolve
    // confirms (count ≥ thresholdMinAttendees) or cancels-all.
    resolution: v.optional(
      v.union(
        v.literal("random"),
        v.literal("owner_pick"),
        v.literal("threshold"),
      ),
    ),
    status: v.union(
      v.literal("open"),
      v.literal("drawn"),
      v.literal("cancelled"),
      v.literal("expired"),
      // APPLICATION: entries frozen, owner pick links emailed, awaiting pick.
      v.literal("awaiting_pick"),
    ),
    // APPLICATION: single-use capability for the owner's emailed pick links
    // (burned on pick; the round expires unpicked at slotStart).
    pickToken: v.optional(v.string()),
    // Draw audit trail (set when drawn).
    winnerEntryId: v.optional(v.id("slotLotteryEntries")),
    bookingId: v.optional(v.id("bookings")),
    winnerIndex: v.optional(v.number()), // index into the entry list at draw
    entrantCountAtDraw: v.optional(v.number()),
    drawnAt: v.optional(v.number()),
    // The ctx.scheduler.runAt handle for the exact-time draw (cancellable).
    scheduledDrawId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_eventType_slotStart", ["eventTypeId", "slotStart"])
    .index("by_status_closesAt", ["status", "closesAt"]),

  // BOOKING-LOTTERY-PRD §3 — one row per entrant per slot lottery. Carries the
  // entrant's email PII + intake answers → registered in _clear.ts +
  // userDeletion.purgeUserData (cascaded from the owner's lotteries). Deduped
  // one-entry-per-email-per-lottery via by_lottery_email.
  slotLotteryEntries: defineTable({
    lotteryId: v.id("slotLotteries"),
    ownerAuthUserId: v.string(), // denormalized for deletion cascade
    name: v.string(),
    email: v.string(),
    timeZone: v.string(),
    notes: v.optional(v.string()),
    intakeResponses: v.optional(
      v.array(
        v.object({ name: v.string(), label: v.string(), value: v.string() }),
      ),
    ),
    createdAt: v.number(),
  })
    .index("by_lottery", ["lotteryId"])
    .index("by_lottery_email", ["lotteryId", "email"]),

  // E4 ANTI-ABUSE — email-verification OTP store. The 6-digit code is stored
  // ONLY as its SHA-256 hash (never plaintext); a constant-time hashed compare
  // checks a candidate guess. One row per (email, eventType) pending
  // verification; consumed (deleted) on a correct guess + the booker attendee's
  // `emailVerifiedAt` is stamped. `attempts` bounds brute force (lock at N).
  // Rows age out via the `expiresAt` sweep cron (same pattern as bookingHolds).
  bookingVerificationCodes: defineTable({
    email: v.string(), // address the code was sent to
    eventTypeId: v.id("eventTypes"), // scope: no cross-event-type reuse
    codeHash: v.string(), // SHA-256 of the 6-digit code (NOT plaintext)
    expiresAt: v.number(), // epoch-ms; expired rows rejected + swept
    attempts: v.number(), // wrong-guess counter; locked out at MAX_VERIFY_ATTEMPTS
    createdAt: v.number(),
  })
    .index("by_email_eventType", ["email", "eventTypeId"])
    .index("by_expiresAt", ["expiresAt"]),

  // E4 ANTI-ABUSE — single-use / personalized booking links. When an event type
  // has `isSingleUse`, the booking page requires one of these tokens; it is
  // burned (`usedAt` + `usedByBookingId` set) on the first confirmed booking so
  // a re-load / re-book via the same link returns 410/gone. Additive: the
  // `eventTypes.isSingleUse` flag controls whether the page requires a token at
  // all, so flipping it never silently disables the page for everyone.
  singleUseTokens: defineTable({
    token: v.string(), // opaque URL-safe token minted by the host
    eventTypeId: v.id("eventTypes"), // which event type this token grants
    createdByAuthUserId: v.string(), // the host who minted the link
    usedAt: v.optional(v.number()), // set when a booking is confirmed via it
    usedByBookingId: v.optional(v.id("bookings")), // back-ref for audit
    expiresAt: v.optional(v.number()), // optional wall-clock expiry
    createdAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_eventType", ["eventTypeId"])
    .index("by_creator", ["createdByAuthUserId", "createdAt"]),

  // E3 MEETING POLL — Doodle-style "propose times, invitees vote, organizer (or
  // auto) picks" coordination primitive (PRD §4.2 / §14: the right peer-to-peer
  // meetup model for marketplace pickups). FULLY ADDITIVE — `bookingPolls` /
  // `bookingPollVotes` reference each other + (on close) a `bookings` row, but no
  // existing table is modified. closePoll DELEGATES to the existing createBooking
  // path so poll-originated bookings are indistinguishable downstream.
  bookingPolls: defineTable({
    organizerAuthUserId: v.string(), // Better Auth user id of the poll creator
    eventTypeId: v.optional(v.id("eventTypes")), // nullable: ad-hoc OR page-tied
    title: v.string(),
    description: v.optional(v.string()),
    location: v.optional(v.string()), // free-text/place (marketplace pickup)
    // Proposed time options — a flat embedded array (O(5-20), read whole to
    // render the vote grid; never queried individually). `idx` is a stable
    // 0-based int key used in votes so reordering doesn't cascade vote updates.
    options: v.array(
      v.object({
        idx: v.number(),
        startMs: v.number(), // UTC epoch-ms
        endMs: v.number(), // UTC epoch-ms
      }),
    ),
    status: v.union(
      v.literal("open"), // accepting votes
      v.literal("closed"), // organizer closed; winning slot picked (or cancelled)
      v.literal("expired"), // TTL-swept if nobody closed it
    ),
    expiresAt: v.optional(v.number()), // epoch-ms; cron sweeps open → expired
    pickedOptionIdx: v.optional(v.number()), // which option won (undefined = none)
    resultBookingId: v.optional(v.id("bookings")), // booking created at close
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organizerAuthUserId", ["organizerAuthUserId"])
    .index("by_eventTypeId", ["eventTypeId"])
    .index("by_status_expiresAt", ["status", "expiresAt"]),

  // E3 MEETING POLL — one vote row per voter per poll (upsert on re-vote). Voter
  // identity is public (no login required, like bookingAttendees) — carries the
  // voterEmail PII, so it cascades from its parent poll on user deletion.
  bookingPollVotes: defineTable({
    pollId: v.id("bookingPolls"),
    voterEmail: v.string(),
    voterName: v.optional(v.string()),
    // The option `idx` values this voter is available for (multi-select).
    selectedOptionIdxs: v.array(v.number()),
    // Optional Doodle-style "if-needed" tristate (yes / if-needed / no). Stored
    // separately so the common binary yes/no case is a single-field check.
    ifNeededOptionIdxs: v.optional(v.array(v.number())),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_pollId", ["pollId"])
    .index("by_pollId_voterEmail", ["pollId", "voterEmail"]),

  // Scheduled notification rows — the reminder cron sweep fans out from here.
  reminders: defineTable({
    bookingId: v.id("bookings"),
    kind: v.union(
      v.literal("confirmation"),
      v.literal("reminder_24h"),
      v.literal("reconfirm"),
      v.literal("no_show"),
    ),
    channel: v.union(
      v.literal("email"),
      v.literal("sms"),
      v.literal("in_app"),
    ),
    recipient: v.union(v.literal("host"), v.literal("booker")),
    sendAt: v.number(), // scheduled send time epoch-ms
    sentAt: v.optional(v.number()), // set when dispatched
  })
    .index("by_bookingId", ["bookingId"])
    .index("by_sendAt", ["sendAt"]),

  // ─────────────────────────────────────────────────────────────
  // SCHEDULING-BOOKING SUITE — Cal.com auth shim identity map (CV-1).
  //
  // The forked Cal.com app (book.dibslist.app) authenticates via dibslist
  // Better Auth (no Postgres `User` table). Its `getServerSession` validates
  // the Better-Auth session cookie, then needs a STABLE INTEGER user id (the
  // cal `Session.user.id` is a Prisma Int, not a string). These two tables
  // mint + persist that integer per dibslist user.
  // ─────────────────────────────────────────────────────────────

  // Global auto-increment counter for stable Cal.com integer user ids. One
  // row; `nextId` monotonically increases. resolveOrCreateCalcomUser reads +
  // bumps it inside a single mutation (Convex serialises mutations per
  // document key, so the read-bump-write is atomic — no SEQUENCE primitive
  // needed). No authUserId → does NOT cascade on user delete; the counter
  // must never decrement (a reused calId could collide with a stale cal-side
  // reference). Kept as operator-owned config (TABLES_KEPT), same rationale
  // as extensionSkills.
  calcomSeq: defineTable({
    nextId: v.number(), // starts at 1; bumped on every new calcomUserMap row
  }).index("by_nextId", ["nextId"]),

  // Maps a dibslist authUserId → a stable Cal.com integer user id + a
  // snapshot of the user's Cal-profile fields (email, name, username).
  // One row per dibslist user, created on first booking-surface contact by
  // resolveOrCreateCalcomUser. The integer `calId` is assigned from
  // `calcomSeq.nextId` so it is stable for the lifetime of the account and
  // never reused after deletion (the counter never decrements).
  //
  // Profile fields are snapshotted at creation and re-synced lazily by
  // resolveOrCreateCalcomUser on every call so the Cal shim always has a
  // fresh copy without re-querying Better Auth.
  //
  // Privacy: carries email + name PII — MUST cascade on user deletion
  // (purgeUserData) and MUST be in TABLES_TO_WIPE.
  calcomUserMap: defineTable({
    authUserId: v.string(), // dibslist Better Auth user id (stable)
    calId: v.number(), // stable Cal.com integer user id (from calcomSeq)
    email: v.string(), // snapshotted from Better Auth user row
    name: v.string(), // display name
    username: v.string(), // derived slug (e.g. lowercased email local-part)
    timeZone: v.optional(v.string()), // IANA zone; set from userPreferences when known
    locale: v.optional(v.string()), // e.g. "en" — default "en" on read
    bio: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    weekStart: v.optional(v.string()), // "Monday" | "Sunday" | etc.
    // CV-8 — booking PREFS the cal `me.updateProfile` save subset writes (the
    // IDENTITY fields name/email/avatar/username/bio stay Better-Auth-owned and
    // are cleanly ignored by the prefs patch). Both additive + optional (no
    // migration: absent rows read as undefined → cal-shaped defaults downstream).
    timeFormat: v.optional(v.number()), // 12 | 24 (cal's hour-format pref)
    defaultScheduleId: v.optional(v.id("schedules")), // owner's default availability schedule
    // Booking onboarding: true once the owner finishes cal's 5-step getting-started
    // flow. Drives the root redirect (absent/false → /getting-started, true →
    // /event-types). Additive + optional (absent rows read as undefined → treated
    // as not-yet-onboarded, so existing owners see onboarding once).
    completedBookingOnboarding: v.optional(v.boolean()),
    // CV — theme prefs from the cal Appearance settings (me.updateProfile).
    // `theme` = public booking-page theme; `appTheme` = the owner's dashboard
    // theme. light/dark store the string; "system" stores null (the cal form sends
    // null for system) — so the union must allow null. Absent → cal default.
    theme: v.optional(v.union(v.string(), v.null())),
    appTheme: v.optional(v.union(v.string(), v.null())),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_authUserId", ["authUserId"]) // primary upsert path
    .index("by_calId", ["calId"]), // reverse shim lookup (calId → dibslist user)

  // ─────────────────────────────────────────────────────────────
  // CV-2c — Cal.com int↔string id maps for EVENT TYPES + SCHEDULES.
  //
  // cal.com keys event types / schedules by a Prisma INTEGER PK that is
  // round-tripped: a GET returns the int, the editor feeds the SAME int back
  // into update/delete. Convex uses opaque STRING `_id`s, so the fork cannot
  // recover the Convex `_id` from a fabricated int. These tables mint + persist
  // a STABLE integer per Convex eventType/schedule `_id` (exactly mirroring the
  // calcomUserMap/calcomSeq precedent), giving a bijection so the editor's
  // numeric ids round-trip back into Convex writes.
  //
  // The two `*IdSeq` tables are single-row monotonic counters (same pattern as
  // calcomSeq); the read-bump-write inside one mutation is atomic because Convex
  // serialises mutations per document key. The counters NEVER decrement, so a
  // calId is never reused even after the underlying row is deleted.
  //
  // Privacy: these maps carry NO PII (only a Convex id, an int, and the
  // owner's authUserId for owner-scoped cleanup). They are KEPT on a dev wipe
  // (the counters must never decrement) but the per-row map entries cascade on
  // account purge (userDeletion.ts) since they reference the deleted user's
  // event types / schedules.
  // ─────────────────────────────────────────────────────────────

  // Monotonic counter for stable event-type integer ids (one row).
  eventTypeIdSeq: defineTable({
    nextId: v.number(), // starts at 1; bumped on every new eventTypeIdMap row
  }).index("by_nextId", ["nextId"]),

  // Monotonic counter for stable schedule integer ids (one row).
  scheduleIdSeq: defineTable({
    nextId: v.number(), // starts at 1; bumped on every new scheduleIdMap row
  }).index("by_nextId", ["nextId"]),

  // Maps a Convex eventTypes `_id` → a stable Cal.com integer id. One row per
  // event type, created on first id-resolution by resolveEventTypeCalId.
  eventTypeIdMap: defineTable({
    convexId: v.id("eventTypes"), // Convex string id
    calId: v.number(), // stable cal integer id (from eventTypeIdSeq)
    ownerAuthUserId: v.string(), // denorm for owner-scoped cascade/cleanup
    createdAt: v.number(),
  })
    .index("by_convexId", ["convexId"]) // Convex string → cal int (primary upsert)
    .index("by_calId", ["calId"]) // cal int → Convex string (reverse lookup)
    .index("by_owner", ["ownerAuthUserId"]), // owner-scoped cascade on purge

  // Maps a Convex schedules `_id` → a stable Cal.com integer id. One row per
  // schedule, created on first id-resolution by resolveScheduleCalId.
  scheduleIdMap: defineTable({
    convexId: v.id("schedules"), // Convex string id
    calId: v.number(), // stable cal integer id (from scheduleIdSeq)
    ownerAuthUserId: v.string(), // denorm for owner-scoped cascade/cleanup
    createdAt: v.number(),
  })
    .index("by_convexId", ["convexId"]) // Convex string → cal int (primary upsert)
    .index("by_calId", ["calId"]) // cal int → Convex string (reverse lookup)
    .index("by_owner", ["ownerAuthUserId"]), // owner-scoped cascade on purge

  // ─────────────────────────────────────────────────────────────
  // CV-5 — Cal.com int↔string id map for CALENDAR CREDENTIALS.
  //
  // cal's `connectedCalendars` read hands the UI a numeric `credentialId`, and
  // the calendar DISCONNECT (`viewer.credentials.delete` → `{ id }`) and
  // CONFLICT-TOGGLE (`/api/availability/calendar` POST/DELETE → `{ credentialId }`)
  // write paths feed that SAME int back. CV-2c used a display-only FNV-1a hash for
  // it, which is NOT reversible — so a write keyed by the int could not recover the
  // Convex `_id`. This map (mirroring eventTypeIdMap/scheduleIdMap VERBATIM) mints a
  // STABLE, reversible integer per `calendarCredentials._id`, giving the bijection
  // those two write paths need. (set-destination keys on integration+externalId, not
  // the int, so it does not use this map; schedule-delete reuses scheduleIdMap.)
  //
  // Privacy / lifecycle: carries NO PII (a Convex id, an int, the owner's
  // authUserId for owner-scoped cleanup). KEPT companion counter
  // (`calendarCredentialIdSeq`) must never decrement (a reused calId could collide
  // with a stale cal-side reference); the per-row map entries cascade on account
  // purge (userDeletion.ts) since they reference the deleted user's credentials.
  // ─────────────────────────────────────────────────────────────

  // Monotonic counter for stable calendar-credential integer ids (one row).
  calendarCredentialIdSeq: defineTable({
    nextId: v.number(), // starts at 1; bumped on every new calendarCredentialIdMap row
  }).index("by_nextId", ["nextId"]),

  // Maps a Convex calendarCredentials `_id` → a stable Cal.com integer id. One row
  // per credential, created on first id-resolution by resolveCalendarCredentialCalId.
  calendarCredentialIdMap: defineTable({
    convexId: v.id("calendarCredentials"), // Convex string id
    calId: v.number(), // stable cal integer id (from calendarCredentialIdSeq)
    ownerAuthUserId: v.string(), // denorm for owner-scoped cascade/cleanup
    createdAt: v.number(),
  })
    .index("by_convexId", ["convexId"]) // Convex string → cal int (primary upsert)
    .index("by_calId", ["calId"]) // cal int → Convex string (reverse lookup)
    .index("by_owner", ["ownerAuthUserId"]), // owner-scoped cascade on purge

  // ONBOARDING-PRD §5 — first-run onboarding progress (additive). One row per
  // user, lazy-created on first write. Drives the welcome carousel, the intent
  // picker, the branched activation path, and the post-activation coachmark
  // tour. Read-only derivations (hasGmail / hasImported / shouldStartTour) are
  // computed in onboarding.getMine, never stored. `version` carries TOUR_VERSION
  // at completion so a bump can re-show onboarding after a major UI change.
});
