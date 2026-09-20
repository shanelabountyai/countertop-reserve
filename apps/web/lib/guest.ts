// What the guest-facing pages and actions need to reach @reserve/db/guest
// (V-012), plus the parsing every guest URL and form goes through.
//
// The schedule is READ PER REQUEST and never cached at module scope. Hours,
// overrides, blackouts and pacing caps are rows the host edits from
// /host/hours; a Schedule held across requests would leave the guest flow
// offering times the restaurant has stopped serving (V-011).
import { headers } from 'next/headers';
import { zonedTimeToInstant } from '@reserve/core';
import type { GuestConfig } from '@reserve/db/guest';
import { loadSchedule } from '@reserve/db/schedule';
import { RESTAURANT } from './restaurant';

export async function guestConfig(): Promise<GuestConfig> {
  const h = await headers();
  // The origin the guest actually reached us on — the same rule the inbound
  // webhook uses for the links it texts back.
  const host = h.get('host') ?? 'localhost:3500';
  const origin = `${h.get('x-forwarded-proto') ?? 'http'}://${host}`;
  return {
    ...RESTAURANT,
    schedule: await loadSchedule(RESTAURANT.timezone),
    manageBaseUrl: `${origin}/m`,
    bookUrl: `${origin}/book`,
  };
}

/**
 * The consent sentence as the guest sees it, stored verbatim with the
 * booking (P0-8) — the text, not a boolean, so a later edit to this wording
 * cannot rewrite what a guest agreed to.
 *
 * It lives here rather than beside the write because a `'use server'` file
 * may export nothing but async functions. One constant, imported by both the
 * checkbox and the action, so the rendered sentence and the stored one
 * cannot drift apart.
 */
export const CONSENT = 'Text me about this reservation — a confirmation, a reminder, and anything that changes. Reply STOP to opt out.';

export const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** 1 through 12. Larger parties are a phone call (PRD P1-4 is the rules engine, not this). */
export const MAX_PARTY = 12;

/** The party size in a query string or form field, or null. */
export function parseParty(text: string): number | null {
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 && n <= MAX_PARTY ? n : null;
}

/**
 * A slot as the guest picked it: the restaurant-local day and minute-of-day,
 * never an instant off the wire. The URL carries "2026-09-25" and "1900"; the
 * timezone turns them into the instant, so a guest cannot hand us a time that
 * means something different than what they saw.
 */
export function parseSlot(day: string, minute: string, timezone: string): Date | null {
  // Digits explicitly: `Number('')` and `Number(' ')` are both 0, which would
  // turn "no time picked yet" into a booking form for midnight.
  if (!DAY.test(day) || !/^\d{1,4}$/.test(minute)) return null;
  const m = Number(minute);
  return m < 24 * 60 ? zonedTimeToInstant(day, m, timezone) : null;
}

/** "1900" → "7:00 PM", in the restaurant's timezone, for a label. */
export function clock(minute: number, timezone: string, day: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' })
    .format(zonedTimeToInstant(day, minute, timezone))
    .replace(/ /g, ' ');
}
