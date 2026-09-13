// Booking maintenance sweeps (lifted registrations from dibslist crons.ts).
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.hourly("booking-hold-sweep", { minuteUTC: 47 }, internal.scheduling.holds.sweepExpiredHolds, {});
crons.hourly("booking-payment-sweep", { minuteUTC: 52 }, internal.scheduling.payments.sweepStaleBookingPayments, {});
crons.hourly("booking-lottery-sweep", { minuteUTC: 57 }, internal.scheduling.lottery.sweepDueSlotLotteries, {});
crons.hourly("booking-verify-code-sweep", { minuteUTC: 12 }, internal.scheduling.antiAbuse.sweepExpiredVerificationCodes, {});
crons.hourly("booking-reminder-sweep", { minuteUTC: 5 }, internal.scheduling.reminders.sweepDueReminders, {});
crons.interval("booking-freebusy-refresh", { minutes: 15 }, internal.scheduling.freebusy.refreshAllFreebusy, {});

export default crons;
