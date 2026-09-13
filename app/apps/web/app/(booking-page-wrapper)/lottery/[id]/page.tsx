import type { PageProps as _PageProps } from "app/_types";
import { _generateMetadata } from "app/_utils";

import { LotteryCountdownView } from "~/lottery/lottery-countdown-view";

// BOOKING-LOTTERY — the public countdown page for one slot's drawing.
// Pure client rendering: the view polls the Convex public endpoint
// (`GET {NEXT_PUBLIC_CONVEX_SITE_URL}/book/api/lottery/{id}`) so the page needs
// no SSR data and works for every entrant anonymously. 404-equivalent states
// (dark flags / unknown id) are handled by the view ("drawing not found").

export const generateMetadata = async ({ params }: _PageProps) => {
  const { id } = await params;
  return await _generateMetadata(
    () => "Drawing",
    () => "Countdown to the drawing for this time slot.",
    false,
    undefined,
    `/lottery/${id}`
  );
};

const ServerPage = async ({ params }: _PageProps) => {
  const { id } = await params;
  return <LotteryCountdownView lotteryId={String(id)} />;
};

export default ServerPage;
