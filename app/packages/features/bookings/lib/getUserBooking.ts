import { getConvex } from "@calcom/lib/server/convex";
import prisma from "@calcom/prisma";
import { BookingStatus } from "@calcom/prisma/enums";
import { makeFunctionReference } from "convex/server";

// CV-B5: on the no-Postgres fork, bookings live in CONVEX (created via createBookingPublic), not
// `prisma.booking`. The cal confirmation page (`/booking/[uid]`) calls this to load the booking;
// reading prisma here finds nothing → 404 after a successful booking. So on the fork we read the
// booking from Convex (`scheduling/publicApi:getBookingByUid`) and map it into cal's prisma-shaped
// booking object so the success page renders the just-made booking. The Postgres path is kept
// intact for a real deploy (`NEXT_PUBLIC_CONVEX_URL` unset).
const getBookingByUidRef = makeFunctionReference<"query">("scheduling/publicApi:getBookingByUid");

const CONVEX_STATUS_TO_PRISMA: Record<string, BookingStatus> = {
  accepted: BookingStatus.ACCEPTED,
  pending: BookingStatus.PENDING,
  cancelled: BookingStatus.CANCELLED,
  rescheduled: BookingStatus.CANCELLED,
};

const getFromPrisma = async (uid: string) =>
  prisma.booking.findUnique({
    where: {
      uid: uid,
    },
    select: {
      title: true,
      id: true,
      uid: true,
      description: true,
      customInputs: true,
      smsReminderNumber: true,
      recurringEventId: true,
      startTime: true,
      endTime: true,
      location: true,
      status: true,
      metadata: true,
      cancellationReason: true,
      cancelledBy: true,
      responses: true,
      rejectionReason: true,
      userPrimaryEmail: true,
      fromReschedule: true,
      rescheduled: true,
      rescheduledBy: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          username: true,
          timeZone: true,
          avatarUrl: true,
        },
      },
      attendees: {
        select: {
          name: true,
          email: true,
          timeZone: true,
          phoneNumber: true,
        },
        orderBy: {
          id: "asc",
        },
      },
      eventTypeId: true,
      eventType: {
        select: {
          eventName: true,
          slug: true,
          timeZone: true,
          schedulingType: true,
          hideOrganizerEmail: true,
        },
      },
      seatsReferences: {
        select: {
          referenceUid: true,
        },
      },
      tracking: {
        select: {
          utm_source: true,
          utm_medium: true,
          utm_campaign: true,
          utm_term: true,
          utm_content: true,
        },
      },
      assignmentReason: {
        select: {
          reasonEnum: true,
          reasonString: true,
        },
        orderBy: {
          createdAt: "desc",
        },
        take: 1,
      },
    },
  });

type BookingInfo = Awaited<ReturnType<typeof getFromPrisma>>;

const getUserBooking = async (uid: string): Promise<BookingInfo> => {
  if (process.env.NEXT_PUBLIC_CONVEX_URL) {
    let data: {
      uid: string;
      startTime: number;
      endTime: number;
      status: string;
      timeZone: string;
      location: string | null;
      notes: string | null;
      eventType: { title: string; slug: string; schedulingType: string; durationMinutes: number } | null;
      organizer: {
        name: string;
        email: string;
        username: string;
        timeZone: string;
        avatarUrl: string | null;
      } | null;
      attendees: Array<{ name: string; email: string; timeZone: string }>;
    } | null = null;
    try {
      data = await getConvex().query(getBookingByUidRef, { uid });
    } catch {
      return null;
    }
    if (!data) return null;

    const mapped = {
      title: data.eventType?.title ?? "",
      id: 0,
      uid: data.uid,
      description: data.notes ?? null,
      customInputs: null,
      smsReminderNumber: null,
      recurringEventId: null,
      startTime: new Date(data.startTime),
      endTime: new Date(data.endTime),
      location: data.location ?? null,
      status: CONVEX_STATUS_TO_PRISMA[data.status] ?? BookingStatus.ACCEPTED,
      metadata: null,
      cancellationReason: null,
      cancelledBy: null,
      responses: {},
      rejectionReason: null,
      userPrimaryEmail: data.organizer?.email ?? null,
      fromReschedule: null,
      rescheduled: null,
      rescheduledBy: null,
      // The confirmation view reads `.user.name`/`.email`/`.avatarUrl` directly → keep non-null.
      user: {
        id: 0,
        name: data.organizer?.name ?? "",
        email: data.organizer?.email ?? "",
        username: data.organizer?.username ?? "",
        timeZone: data.organizer?.timeZone ?? "UTC",
        avatarUrl: data.organizer?.avatarUrl ?? null,
      },
      // `.attendees.map(...)` / `.find(...)` → must be a non-null array.
      attendees: (data.attendees ?? []).map((a) => ({
        name: a.name,
        email: a.email,
        timeZone: a.timeZone,
        phoneNumber: null,
      })),
      eventTypeId: 0,
      eventType: {
        eventName: data.eventType?.title ?? null,
        slug: data.eventType?.slug ?? "",
        timeZone: data.timeZone ?? null,
        schedulingType: null,
        hideOrganizerEmail: false,
      },
      // `.some(...)` → must be a non-null array.
      seatsReferences: [],
      tracking: null,
      assignmentReason: [],
    };

    // Fork boundary: a Convex booking shaped into cal's prisma `booking.findUnique` result. The
    // confirmation view only reads the fields populated above (CV-B5 shape audit); assert at the seam.
    return mapped as unknown as BookingInfo;
  }

  return getFromPrisma(uid);
};

export default getUserBooking;
