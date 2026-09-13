import type { PrismaClient } from "@calcom/prisma";

export async function maybeGetBookingUidFromSeat(prisma: PrismaClient, uid: string) {
  // no-Postgres fork: `prisma.bookingSeat` THROWS. Seated events aren't modeled on the fork, so
  // there's no seat→booking remap — return the uid as-is (fires on EVERY /booking/[uid] load).
  if (process.env.NEXT_PUBLIC_CONVEX_URL) {
    return { uid };
  }
  // Look bookingUid in bookingSeat
  const bookingSeat = await prisma.bookingSeat.findUnique({
    where: {
      referenceUid: uid,
    },
    select: {
      booking: {
        select: {
          id: true,
          uid: true,
        },
      },
      data: true,
    },
  });
  if (bookingSeat) return { uid: bookingSeat.booking.uid, seatReferenceUid: uid, bookingSeat };
  return { uid };
}
