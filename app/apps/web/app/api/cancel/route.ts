import { defaultResponderForAppDir } from "app/api/defaultResponderForAppDir";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { checkRateLimitAndThrowError } from "@calcom/lib/checkRateLimitAndThrowError";
import getIP from "@calcom/lib/getIP";
import { piiHasher } from "@calcom/lib/server/PiiHasher";
import { bookingCancelWithCsrfSchema } from "@calcom/prisma/zod-utils";
import { validateCsrfToken } from "@calcom/web/lib/validateCsrfToken";

import { buildLegacyRequest } from "@lib/buildLegacyCtx";

async function handler(req: NextRequest) {
  let appDirRequestBody;
  try {
    appDirRequestBody = await req.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid JSON" }, { status: 400 });
  }
  const bookingData = bookingCancelWithCsrfSchema.parse(appDirRequestBody);

  // Integer IDs are sequential/guessable — only accept high-entropy UIDs on this route
  if (!bookingData.uid) {
    return NextResponse.json(
      { success: false, message: "uid is required for booking cancellation" },
      { status: 400 }
    );
  }

  const csrfError = await validateCsrfToken(bookingData.csrfToken);
  if (csrfError) {
    return csrfError;
  }

  const session = await getServerSession({ req: buildLegacyRequest(await headers(), await cookies()) });

  // Rate limit: 10 booking cancellations per 60 seconds per user (or IP if not authenticated)
  const identifier = session?.user?.id
    ? `api:cancel-user:${session.user.id}`
    : `api:cancel-ip:${piiHasher.hash(getIP(req))}`;
  await checkRateLimitAndThrowError({
    rateLimitingType: "core",
    identifier,
  });

  // Strip integer id to ensure lookup is always by uid
  const { id: _id, ...safeBookingData } = bookingData;

  // CV-4 — REWIRED onto the dibslist Convex backend's owner-scoped
  // `adminCancelBooking` (scheduling/bookingAdmin). cal's Prisma-coupled
  // `handleCancelBooking` is SKIPPED on this path. The CSRF + rate-limit + uid-only
  // guards above are PRESERVED. `bookingData.uid` is the Convex booking `_id` string
  // (CV-3 sets booking uid = String(bookingId)); the owner is `session.user.uuid`
  // (the trusted dibslist authUserId), re-checked inside the Convex mutation.
  //
  // This is the OWNER/host cancel surface (the /bookings dashboard). It requires a
  // signed-in owner — the anonymous booker-cancel-by-token path stays on the
  // booking httpAction (bookCancelHandler), not this route.
  if (!session?.user?.uuid) {
    return NextResponse.json(
      { success: false, message: "Unauthorized" },
      { status: 401 }
    );
  }

  const { cancelBookingViaConvex } = await import("@calcom/lib/server/convexBookingsListAdapter");

  try {
    const cancelled = await cancelBookingViaConvex({
      ownerAuthUserId: session.user.uuid,
      bookingUid: safeBookingData.uid as string,
      reason: safeBookingData.cancellationReason ?? undefined,
    });
    return NextResponse.json(
      {
        success: true,
        message: "Booking successfully cancelled.",
        onlyRemovedAttendee: false,
        bookingId: 0,
        bookingUid: String(cancelled.bookingId),
        isPlatformManagedUserBooking: false,
      },
      { status: 200 }
    );
  } catch (err) {
    const data =
      err && typeof err === "object" && "data" in err
        ? (err as { data?: { kind?: string; message?: string } }).data
        : undefined;
    const kind = data?.kind;
    // booking_not_found (wrong owner / missing) + booking_disabled (dark) → 400;
    // surface a clean message the cancel dialog renders.
    const message =
      kind === "booking_not_found"
        ? "Booking not found."
        : kind === "cannot_cancel_status"
          ? "This booking has already been cancelled."
          : kind === "booking_disabled"
            ? "Booking is not available."
            : data?.message ?? "Failed to cancel booking.";
    return NextResponse.json({ success: false, message }, { status: 400 });
  }
}

export const DELETE = defaultResponderForAppDir(handler);
export const POST = defaultResponderForAppDir(handler);
