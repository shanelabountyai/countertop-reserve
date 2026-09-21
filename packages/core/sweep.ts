// The deadline sweep's decisions (P0-7 auto-release, P0-5 reminders). Pure:
// the db sweep feeds it rows and `now`, and does what it says.
//
// Release and its notice are separate decisions on purpose: the table frees
// at the deadline, the notice goes whenever sending is allowed (quiet hours,
// V-009). Nothing here knows about sending.

import { isUpcoming, type Status } from './lifecycle';
import { dayOf, plusMs } from './time';

/** Minutes before the reservation's start. */
export type SweepPolicy = {
  /** An unconfirmed booking is released this long before start. 0 disables auto-release entirely (P0-7). */
  releaseLead: number;
  /** …or this long, when it was booked on the day it is for. */
  sameDayReleaseLead: number;
  reminderLead: number;
  /** The fallback when the booking was made after `reminderLead` had already passed. */
  lateReminderLead: number;
};
export const DEFAULT_SWEEP: SweepPolicy = { releaseLead: 180, sameDayReleaseLead: 90, reminderLead: 24 * 60, lateReminderLead: 180 };

/** Appendix A3: a guest who confirmed this close to the reminder doesn't get one. */
export const RECENT_CONFIRM_MS = 6 * 3_600_000;

export type SweepRow = {
  status: Status;
  businessDay: string;
  startAt: Date;
  createdAt: Date;
  statusChangedAt: Date;
  /**
   * When the confirmation REQUEST actually reached the guest, or null if it
   * never did — no consent, no number, or a send the provider refused.
   * Deliberately not "was queued": a queued-but-unsent text is a question
   * nobody was asked.
   */
  confirmationSentAt: Date | null;
};

const before = (r: SweepRow, minutes: number) => plusMs(r.startAt, -minutes * 60_000);

/**
 * When an unconfirmed `r` releases, or null for never: auto-release is
 * disabled, or the booking was made at or after its own deadline — a guest
 * who books at 6:30 for 7:00 was never given a window to confirm in.
 */
export function releaseAt(r: SweepRow, timezone: string, p: SweepPolicy = DEFAULT_SWEEP): Date | null {
  if (p.releaseLead === 0) return null;
  const sameDay = dayOf(r.createdAt, timezone) === r.businessDay;
  const at = before(r, sameDay ? p.sameDayReleaseLead : p.releaseLead);
  return r.createdAt < at ? at : null;
}

/**
 * Past the deadline and still unconfirmed. Once the start has passed it is
 * the host's call (seat or no-show), even if a stalled sweep never got to it.
 *
 * A reservation we never ASKED is never released. A guest who declined texts
 * (P0-8's consent is a checkbox, not a requirement) would otherwise be booked,
 * never sent a confirmation request, never sent a reminder, never sent the
 * release notice — and silently lose the table at T-3h for failing to answer
 * a question nobody put to them. They confirm on the manage page instead, and
 * until they do the host works the door with an unconfirmed row, which is the
 * pre-SMS status quo and strictly better than a vanished booking.
 *
 * Keyed on the request having been SENT, not on current consent: a guest who
 * confirmed by text and then sent STOP was still asked, so their deadline
 * still stands. Opting out of texts is not opting out of the policy.
 */
export function shouldRelease(r: SweepRow, now: Date, timezone: string, p: SweepPolicy = DEFAULT_SWEEP): boolean {
  if (r.confirmationSentAt === null) return false;
  const at = releaseAt(r, timezone, p);
  return r.status === 'booked' && at !== null && now >= at && now < r.startAt;
}

/** The first lead the booking predates — T-24h, else T-3h — or null when it was booked inside both. */
export function reminderAt(r: SweepRow, p: SweepPolicy = DEFAULT_SWEEP): Date | null {
  for (const lead of [p.reminderLead, p.lateReminderLead]) {
    const at = before(r, lead);
    if (r.createdAt < at) return at;
  }
  return null;
}

/**
 * Due, still ahead of the guest, and not just confirmed. "Just" is measured
 * from the reminder's due time, not `now`, so a late sweep cannot turn a
 * skipped reminder into a sent one.
 */
export function shouldRemind(r: SweepRow, now: Date, p: SweepPolicy = DEFAULT_SWEEP): boolean {
  const at = reminderAt(r, p);
  if (!at || !isUpcoming(r.status) || now < at || now >= r.startAt) return false;
  return !(r.status === 'confirmed' && r.statusChangedAt.getTime() >= at.getTime() - RECENT_CONFIRM_MS);
}
