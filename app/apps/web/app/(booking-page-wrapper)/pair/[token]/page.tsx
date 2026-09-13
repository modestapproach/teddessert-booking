import type { PageProps as _PageProps } from "app/_types";
import { _generateMetadata } from "app/_utils";

import { PairJoinView } from "~/pair/pair-join-view";

// WAVE-2 PAIR — the partner-join page. Pure client rendering (the view talks
// to the Convex public endpoints directly); 404-equivalent states are handled
// by the view. Token is a capability — never indexed.

export const generateMetadata = async ({ params }: _PageProps) => {
  const { token } = await params;
  const metadata = await _generateMetadata(
    () => "You're invited",
    () => "Join a booking held for two.",
    false,
    undefined,
    `/pair/${token}`
  );
  return { ...metadata, robots: { index: false, follow: false } };
};

const ServerPage = async ({ params }: _PageProps) => {
  const { token } = await params;
  return <PairJoinView token={String(token)} />;
};

export default ServerPage;
