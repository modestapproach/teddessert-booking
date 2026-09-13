// Lifted from cal.diy
// `packages/features/bookings/lib/conflictChecker/checkForConflicts.ts`
// (@180ede28, MIT). Adapted on lift:
//   - `@calcom/dayjs`                  -> `./dayjs`
//   - `BufferedBusyTime` (@calcom)     -> inlined { start: string | Date; end: string | Date }
//   - `CurrentSeats` (Prisma-derived)  -> shimmed to Array<{ startTime: Date }>
//     (only `.startTime.toISOString()` is read)
import type { Dayjs } from "./dayjs";
import dayjs from "./dayjs";

// Was `BufferedBusyTime` from `@calcom/types/BufferedBusyTime`.
export type BufferedBusyTime = { start: string | Date; end: string | Date };

// Was `CurrentSeats` from `@calcom/features/availability/lib/getUserAvailability`
// (a deep Prisma-derived `Awaited<ReturnType<...>>`). Only `.startTime` is read.
export type CurrentSeats = Array<{ startTime: Date }>;

type BufferedBusyTimes = BufferedBusyTime[];

// if true, there are conflicts.
export function checkForConflicts({
  busy,
  time,
  eventLength,
  currentSeats,
}: {
  busy: BufferedBusyTimes;
  time: Dayjs;
  eventLength: number;
  currentSeats?: CurrentSeats;
}) {
  // Early return
  if (!Array.isArray(busy) || busy.length < 1) {
    return false; // guaranteed no conflicts when there is no busy times.
  }
  // no conflicts if some seats are found for the current time slot
  if (currentSeats?.some((booking) => booking.startTime.toISOString() === time.toISOString())) {
    return false;
  }
  const slotStart = time.valueOf();
  const slotEnd = slotStart + eventLength * 60 * 1000;

  const sortedBusyTimes = busy
    .map((busyTime) => ({
      start: dayjs.utc(busyTime.start).valueOf(),
      end: dayjs.utc(busyTime.end).valueOf(),
    }))
    .sort((a, b) => a.start - b.start);

  for (const busyTime of sortedBusyTimes) {
    if (busyTime.start >= slotEnd) {
      break;
    }
    if (busyTime.end <= slotStart) {
      continue;
    }
    return true;
  }

  return false;
}
