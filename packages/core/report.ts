// No-show & cover report (P1-1). Pure: the caller supplies the rows and the
// restaurant's timezone, and nothing here reads a clock.
//
// Every status list comes from the ONE lifecycle module (CLAUDE.md). Adding a
// status must make the compiler find this file, so the classifications below
// are asked of `lifecycle`, never spelled out as a literal list here.
//
// The interesting question the report exists to answer is "does confirming
// actually predict showing?", and a reservation's CURRENT status cannot
// answer it: `booked → confirmed → no_show` ends as plain `no_show`. So the
// input carries `history` — every status the append-only event log says the
// reservation reached — and confirmation is read from that, not from `status`.

import { SHOWED, type Status } from './lifecycle';
import { minuteOfDay } from './time';
import { SLOT_MINUTES } from './availability';

export type ReportRow = {
  businessDay: string;
  startAt: Date;
  partySize: number;
  status: Status;
  createdAt: Date;
  /** Every status this reservation ever reached, from ReservationEvent. */
  history: readonly Status[];
};

/** A count over a denominator. `rate` is null for 0/0 — never NaN, never a silent 0%. */
export type Rate = { of: number; count: number; rate: number | null };

const rate = (count: number, of: number): Rate => ({ of, count, rate: of === 0 ? null : count / of });

/**
 * Covers on the book vs. covers that sat down, per 15-minute seating bucket.
 *
 * A cancelled or released reservation stays in `booked`: the GAP between the
 * two numbers is the whole point of the report, and netting the losses out of
 * the denominator would hide exactly what a manager is looking for. Only
 * `abandoned` is left out — a waitlisted party who walked off was never on
 * the book for a time.
 */
export type CoverBucket = { day: string; minute: number; booked: number; seated: number };

/** Lead-time bands for the no-show split, ascending; the last covers everything longer. */
export const LEAD_BANDS: readonly { label: string; upToHours: number }[] = [
  { label: 'under 4h', upToHours: 4 },
  { label: '4-24h', upToHours: 24 },
  { label: '1-3 days', upToHours: 72 },
  { label: '3+ days', upToHours: Infinity },
];

export type Report = {
  covers: CoverBucket[];
  totals: { booked: number; seated: number; noShow: number; cancelled: number; released: number };
  /** Among reservations that reached service and neither cancelled nor released. */
  noShow: Rate;
  noShowByConfirmation: { confirmed: Rate; unconfirmed: Rate };
  noShowByLead: { label: string; rate: Rate }[];
  /** Released (never confirmed by the deadline) over every advance booking. */
  release: Rate;
  /** Waitlisted parties that ended up seated. */
  waitlist: Rate;
};

const showed = (r: ReportRow) => SHOWED.includes(r.status);
/** An advance booking, not a walk-in: it passed through `booked` on the way in. */
const advance = (r: ReportRow) => r.history.includes('booked');
const everConfirmed = (r: ReportRow) => r.history.includes('confirmed');
/** Turned up to be counted either way — the honest no-show denominator. */
const judged = (r: ReportRow) => advance(r) && (showed(r) || r.status === 'no_show');

const leadHours = (r: ReportRow) => (r.startAt.getTime() - r.createdAt.getTime()) / 3_600_000;
export const leadBand = (r: ReportRow) => (LEAD_BANDS.find((b) => leadHours(r) < b.upToHours) ?? LEAD_BANDS[LEAD_BANDS.length - 1]!).label;

export function report(rows: readonly ReportRow[], timezone: string): Report {
  const counted = rows.filter((r) => r.status !== 'abandoned');

  const buckets = new Map<string, CoverBucket>();
  for (const r of counted) {
    const minute = Math.floor(minuteOfDay(r.startAt, timezone) / SLOT_MINUTES) * SLOT_MINUTES;
    const key = `${r.businessDay} ${minute}`;
    const bucket = buckets.get(key) ?? { day: r.businessDay, minute, booked: 0, seated: 0 };
    bucket.booked += r.partySize;
    if (showed(r)) bucket.seated += r.partySize;
    buckets.set(key, bucket);
  }

  const noShows = counted.filter((r) => r.status === 'no_show');
  const judgedRows = counted.filter(judged);
  const byConfirmation = (want: boolean) => {
    const pool = judgedRows.filter((r) => everConfirmed(r) === want);
    return rate(pool.filter((r) => r.status === 'no_show').length, pool.length);
  };
  const advanceRows = counted.filter(advance);
  // From `rows`, not `counted`: a waitlisted party who walked off is left out
  // of the covers on purpose, but they are precisely what conversion is
  // measured against — dropping them would report 100% for a night where half
  // the waiting room gave up.
  const waitlisted = rows.filter((r) => r.history.includes('waitlisted'));

  return {
    covers: [...buckets.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.minute - b.minute)),
    totals: {
      booked: counted.reduce((n, r) => n + r.partySize, 0),
      seated: counted.filter(showed).reduce((n, r) => n + r.partySize, 0),
      noShow: noShows.length,
      cancelled: counted.filter((r) => r.status === 'cancelled').length,
      released: counted.filter((r) => r.status === 'released').length,
    },
    noShow: rate(noShows.filter(judged).length, judgedRows.length),
    noShowByConfirmation: { confirmed: byConfirmation(true), unconfirmed: byConfirmation(false) },
    noShowByLead: LEAD_BANDS.map(({ label }) => {
      const pool = judgedRows.filter((r) => leadBand(r) === label);
      return { label, rate: rate(pool.filter((r) => r.status === 'no_show').length, pool.length) };
    }),
    release: rate(advanceRows.filter((r) => r.status === 'released').length, advanceRows.length),
    waitlist: rate(waitlisted.filter((r) => r.history.includes('seated')).length, waitlisted.length),
  };
}
