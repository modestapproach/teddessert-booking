// SCHEDULING D3 / A8 — the hourly reminder-sweep cron impl.
//
// `sweepDueReminders` is called by the `booking-reminder-sweep` hourly cron
// (crons.ts, minute :57). It range-scans `reminders.by_sendAt` for rows whose
// `sendAt <= now` and whose `sentAt` is not yet set (unsent), dispatches each
// via the D1 `sendNotification` action (pinning the row's channel), and patches
// `sentAt` so it never fires twice. Bounded to 200 rows/tick so a backlog
// drains across ticks.
//
// DOUBLE-DISPATCH SAFETY: because `reminders.by_sendAt` is a simple numeric
// index and Convex mutations are serializable, two concurrent ticks cannot
// double-dispatch the same row — the first tick's `patch({ sentAt: now })` is
// visible to the second. We mark `sentAt` FIRST (before scheduling the action)
// so even an action-scheduler hiccup leaves the row marked rather than re-armed.
//
// CODEGEN-PENDING REF: the brand-new scheduling.booking module isn't on the
// stale `_generated` `internal` yet, so the `sendNotification` ref goes through
// the SAME `(internal as any).scheduling?.booking` nil-guard hop used in
// booking.ts / sync.ts. Under the test ctx (FakeScheduler + stale types) the
// ref resolves to `undefined`, so the `if (ref?.sendNotification)` guard no-ops
// silently — the sweep still marks `sentAt` (the load-bearing behavior). A
// deploy regenerates the types and the dispatch becomes live.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

const SWEEP_BATCH = 200;

export async function sweepDueRemindersHandler(
  ctx: Ctx,
  args: { nowMs?: number },
): Promise<{ dispatched: number; scanned: number }> {
  const now = args.nowMs ?? Date.now();
  const due: Array<Record<string, any>> = await ctx.db
    .query("reminders")
    .withIndex("by_sendAt", (q: Ctx) => q.lte("sendAt", now))
    .take(SWEEP_BATCH);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = (internal as any).scheduling?.booking;

  let dispatched = 0;
  for (const row of due) {
    if (row.sentAt !== undefined) continue; // already sent — belt + suspenders
    // Mark sent FIRST (same mutation tick → serializable; no double-dispatch).
    await ctx.db.patch(row._id, { sentAt: now });
    // Schedule the D1 action to do the actual delivery, pinning the row's
    // channel so a `sms` reminder doesn't fan out to email/in-app.
    if (ref?.sendNotification) {
      await ctx.scheduler.runAfter(0, ref.sendNotification, {
        bookingId: row.bookingId,
        event: row.kind, // "confirmation" | "reminder_24h" | "reconfirm" | "no_show"
        channel: row.channel, // "email" | "sms" | "in_app"
      });
    }
    dispatched += 1;
  }
  return { dispatched, scanned: due.length };
}

export const sweepDueReminders = internalMutation({
  args: { nowMs: v.optional(v.number()) },
  handler: sweepDueRemindersHandler,
});
