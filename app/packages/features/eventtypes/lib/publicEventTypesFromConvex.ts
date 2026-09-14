/**
 * Maps the owner's Convex event-type rows onto the shape the public profile
 * page (`/[user]`) expects from `getEventTypesPublic`: cal's
 * `baseEventTypeSelect` columns plus `metadata`.
 *
 * Pure and dependency-free so it can be unit-tested without the cal workspace.
 * Field gaps in our backend get cal's defaults (no price, no seats, no
 * per-event metadata); the profile grid only renders id/slug/title.
 */
export interface ConvexPublicEventTypeInput {
  _id: string;
  calId?: number;
  slug: string;
  title: string;
  description?: string | null;
  durationMinutes: number;
  schedulingType?: "collective" | "round_robin" | "managed";
  hidden?: boolean;
  active?: boolean;
  requireEmailVerification?: boolean;
  seatsPerSlot?: number;
}

export interface PublicEventTypeRow {
  id: number;
  title: string;
  description: string | null;
  length: number;
  schedulingType: "COLLECTIVE" | "ROUND_ROBIN" | "MANAGED" | null;
  recurringEvent: null;
  slug: string;
  hidden: boolean;
  price: number;
  currency: string;
  lockTimeZoneToggleOnBookingPage: boolean;
  lockedTimeZone: string | null;
  requiresConfirmation: boolean;
  requiresBookerEmailVerification: boolean;
  canSendCalVideoTranscriptionEmails: boolean;
  seatsPerTimeSlot: number | null;
  metadata: Record<string, never>;
}

const SCHEDULING: Record<NonNullable<ConvexPublicEventTypeInput["schedulingType"]>, PublicEventTypeRow["schedulingType"]> = {
  collective: "COLLECTIVE",
  round_robin: "ROUND_ROBIN",
  managed: "MANAGED",
};

export function toPublicEventTypeRow(row: ConvexPublicEventTypeInput, fallbackId: (convexId: string) => number): PublicEventTypeRow {
  return {
    id: row.calId ?? fallbackId(row._id),
    title: row.title,
    description: row.description ?? null,
    length: row.durationMinutes,
    schedulingType: row.schedulingType ? SCHEDULING[row.schedulingType] : null,
    recurringEvent: null,
    slug: row.slug,
    hidden: row.hidden ?? false,
    price: 0,
    currency: "usd",
    lockTimeZoneToggleOnBookingPage: false,
    lockedTimeZone: null,
    requiresConfirmation: false,
    requiresBookerEmailVerification: row.requireEmailVerification ?? false,
    canSendCalVideoTranscriptionEmails: false,
    seatsPerTimeSlot: row.seatsPerSlot && row.seatsPerSlot > 1 ? row.seatsPerSlot : null,
    metadata: {},
  };
}

/**
 * Published rows only (soft-deleted ones have `active: false`), in cal's
 * default profile order: every row has position 0, so it falls back to id
 * ascending, i.e. creation order.
 */
export function publicEventTypeRows(rows: ConvexPublicEventTypeInput[], fallbackId: (convexId: string) => number): PublicEventTypeRow[] {
  return rows
    .filter((row) => row.active !== false)
    .map((row) => toPublicEventTypeRow(row, fallbackId))
    .sort((a, b) => a.id - b.id);
}
