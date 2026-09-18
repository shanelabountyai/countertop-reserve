// Send-time compliance (P0-8). Pure: dispatch asks this about every queued
// row at the moment it would send, so a STOP or a quiet hour that began after
// the row was queued still wins.
//
// Quiet hours defer the MESSAGE, never a state change: nothing here is asked
// before a release or a transition, only before a send.

import type { MessageKind } from './messages';
import { dayOf, plusMs, zonedTimeToInstant } from './time';

/**
 * Quiet window in restaurant-local minutes of day, wrapping midnight
 * (`quietStart` > `quietEnd`). Default 21:00–09:00 and 5 texts per number per
 * restaurant day (P0-8).
 */
export type SendPolicy = { quietStart: number; quietEnd: number; dailyLimit: number };
export const DEFAULT_SEND: SendPolicy = { quietStart: 21 * 60, quietEnd: 9 * 60, dailyLimit: 5 };

/** The answer to STOP. It must reach the guest, so no rule below holds it back. */
const ALWAYS: MessageKind = 'opted_out';

function minuteOfDay(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return part('hour') * 60 + part('minute');
}

/** The instant the quiet window `now` falls in ends, or null outside it. */
export function quietUntil(now: Date, timezone: string, p: SendPolicy = DEFAULT_SEND): Date | null {
  const m = minuteOfDay(now, timezone);
  const today = dayOf(now, timezone);
  if (m < p.quietEnd) return zonedTimeToInstant(today, p.quietEnd, timezone);
  if (m < p.quietStart) return null;
  // Noon + 24h is tomorrow whatever DST does overnight.
  const tomorrow = dayOf(plusMs(zonedTimeToInstant(today, 12 * 60, timezone), 24 * 3_600_000), timezone);
  return zonedTimeToInstant(tomorrow, p.quietEnd, timezone);
}

/** Start of the restaurant day `now` is in — the rate limit's window. */
export const dayStart = (now: Date, timezone: string) => zonedTimeToInstant(dayOf(now, timezone), 0, timezone);

export type Outgoing = {
  kind: MessageKind;
  /** Answers a text the guest just sent us. */
  isReply: boolean;
  /** The reservation it is about, if any. */
  startAt: Date | null;
  /** STOP on file for the number, read at send time. */
  optedOut: boolean;
  /** Texts the provider has accepted for this number since `dayStart`. */
  sentToday: number;
};

/**
 * `defer` leaves the row queued for a later sweep; `opted_out` and
 * `rate_limited` drop it (recorded as a failed send with that reason).
 *
 * Quiet hours hold back only what can wait for morning (operator decision at
 * V-009 kickoff): a reply to the guest's own text, and anything about a
 * reservation that starts before the window ends — tonight's table — still
 * go. That is the reminder and the release notice for tomorrow, deferred.
 */
export function sendDecision(m: Outgoing, now: Date, timezone: string, p: SendPolicy = DEFAULT_SEND): 'send' | 'defer' | 'opted_out' | 'rate_limited' {
  if (m.kind === ALWAYS) return 'send';
  if (m.optedOut) return 'opted_out';
  const until = quietUntil(now, timezone, p);
  if (until && !m.isReply && !(m.startAt && m.startAt < until)) return 'defer';
  return m.sentToday >= p.dailyLimit ? 'rate_limited' : 'send';
}
