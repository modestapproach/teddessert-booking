// Local interfaces replacing cal.diy's Prisma `Pick<Availability, ...>` types
// and the `@calcom/features/availability/lib/getUserAvailability` interfaces.
// Field shapes are derived directly from how the lifted code consumes them.
import type { Dayjs } from "./dayjs";

export type DateRange = {
  start: Dayjs;
  end: Dayjs;
};

// Was `Pick<Availability, "date" | "startTime" | "endTime">`.
// `startTime`/`endTime` are wall-clock, midnight-anchored UTC `Date`s; the code
// reads them via `.getUTCHours()` / `.getUTCMinutes()`.
export type DateOverride = {
  date: Date | null;
  startTime: Date;
  endTime: Date;
};

// Was `Pick<Availability, "days" | "startTime" | "endTime">`.
export type WorkingHours = {
  days: number[];
  startTime: Date;
  endTime: Date;
};

// Was the Prisma-generated `SchedulingType` enum from `@calcom/prisma/enums`.
export type SchedulingType = "COLLECTIVE" | "ROUND_ROBIN" | "MANAGED";

// Was `IOutOfOfficeData` from `@calcom/features/availability/lib/getUserAvailability`.
// Keys are ISO date strings; values carry the OOO display payload surfaced on a
// slot when it falls on an out-of-office day.
export interface IFromUser {
  id: number;
  displayName: string | null;
}

export interface IToUser {
  id: number;
  username: string | null;
  displayName: string | null;
}

export interface IOutOfOfficeDataEntry {
  fromUser?: IFromUser | null;
  toUser?: IToUser | null;
  reason?: string | null;
  emoji?: string | null;
  notes?: string | null;
  showNotePublicly?: boolean;
}

export type IOutOfOfficeData = Record<string, IOutOfOfficeDataEntry | undefined>;
