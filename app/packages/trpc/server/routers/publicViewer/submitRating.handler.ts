import { prisma } from "@calcom/prisma";

import type { TSubmitRatingInputSchema } from "./submitRating.schema";

type SubmitRatingOptions = {
  input: TSubmitRatingInputSchema;
};

export const submitRatingHandler = async ({ input }: SubmitRatingOptions) => {
  const { bookingUid, rating, comment } = input;
  // no-Postgres fork: `prisma.booking.update` THROWS. Booking ratings aren't modeled on the fork
  // yet → no-op on the public rating endpoint instead of 500.
  if (process.env.NEXT_PUBLIC_CONVEX_URL) {
    return;
  }
  await prisma.booking.update({
    where: {
      uid: bookingUid,
    },
    data: {
      rating: rating,
      ratingFeedback: comment,
    },
  });
};

export default submitRatingHandler;
