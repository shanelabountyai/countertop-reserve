import { describe, expect, it } from 'vitest';
import { DEFAULT_SWEEP, releaseAt, reminderAt, shouldRelease, shouldRemind, type SweepRow } from './sweep';
import { dayOf, plusMs, zonedTimeToInstant } from './time';

// Friday 2026-10-02 19:00, Los Angeles. Hand-calculated deadlines:
// release T-3h = 16:00 (T-90m = 17:30 same-day); reminder T-24h = Thu 19:00 (T-3h = 16:00).
const TZ = 'America/Los_Angeles';
const DAY = '2026-10-02';
const at = (h: number, m = 0, day = DAY) => zonedTimeToInstant(day, h * 60 + m, TZ);
const START = at(19);
const row = (over: Partial<SweepRow> = {}): SweepRow => {
  const createdAt = over.createdAt ?? at(12, 0, '2026-09-25');
  return { status: 'booked', businessDay: DAY, startAt: START, createdAt, statusChangedAt: createdAt, ...over };
};
const ms = (d: Date, delta: number) => plusMs(d, delta);

describe('dayOf', () => {
  it('names the restaurant-calendar day, not the UTC one', () => {
    expect(dayOf(START, TZ)).toBe(DAY); // 02:00 UTC Saturday
    expect(dayOf(START, 'UTC')).toBe('2026-10-03');
  });
});

describe('releaseAt (P0-7)', () => {
  it.each([
    ['booked days ahead → T-3h', at(12, 0, '2026-09-25'), at(16)],
    ['booked the day before → T-3h', at(20, 0, '2026-10-01'), at(16)],
    // 23:30 Thursday in LA is already Friday in UTC: a UTC "same day" would say T-90m.
    ['booked 23:30 the night before → T-3h', at(23, 30, '2026-10-01'), at(16)],
    ['booked same-day → T-90m', at(12), at(17, 30)],
    ['booked same-day one ms before its deadline → T-90m', ms(at(17, 30), -1), at(17, 30)],
    ['booked same-day AT its deadline → never', at(17, 30), null],
    ['booked same-day after its deadline → never', at(18, 30), null],
    ['booked same-day after T-3h → T-90m', at(16, 30), at(17, 30)],
  ])('%s', (_, createdAt, want) => expect(releaseAt(row({ createdAt }), TZ)).toEqual(want));

  it('0 disables auto-release entirely', () => {
    expect(releaseAt(row(), TZ, { ...DEFAULT_SWEEP, releaseLead: 0 })).toBeNull();
    expect(shouldRelease(row(), at(18), TZ, { ...DEFAULT_SWEEP, releaseLead: 0 })).toBe(false);
  });
});

describe('shouldRelease', () => {
  it('fires at the deadline minute, not one ms before', () => {
    expect(shouldRelease(row(), ms(at(16), -1), TZ)).toBe(false);
    expect(shouldRelease(row(), at(16), TZ)).toBe(true);
  });
  it('never releases a guest who confirmed, or anything not booked', () => {
    for (const status of ['confirmed', 'seated', 'cancelled', 'released'] as const) {
      expect(shouldRelease(row({ status }), at(18), TZ)).toBe(false);
    }
  });
  it('leaves a started reservation to the host, even after a stalled sweep', () => {
    expect(shouldRelease(row(), ms(START, -1), TZ)).toBe(true);
    expect(shouldRelease(row(), START, TZ)).toBe(false);
  });
});

describe('reminderAt (P0-5)', () => {
  it.each([
    ['booked a week ahead → T-24h', at(12, 0, '2026-09-25'), at(19, 0, '2026-10-01')],
    ['booked inside T-24h the day before → T-3h', at(20, 0, '2026-10-01'), at(16)],
    ['booked same-day morning → T-3h', at(9), at(16)],
    ['booked inside T-3h → none', at(16), null],
  ])('%s', (_, createdAt, want) => expect(reminderAt(row({ createdAt }))).toEqual(want));
});

describe('shouldRemind', () => {
  const due = at(19, 0, '2026-10-01');
  it('is due at its minute, for booked and confirmed alike', () => {
    expect(shouldRemind(row(), ms(due, -1))).toBe(false);
    expect(shouldRemind(row(), due)).toBe(true);
    expect(shouldRemind(row({ status: 'confirmed', statusChangedAt: at(12, 0, '2026-09-26') }), due)).toBe(true);
  });
  it('skips a guest who confirmed within 6h of the reminder (A3)', () => {
    const confirmed = (h: number) => row({ status: 'confirmed', statusChangedAt: ms(due, -h * 3_600_000) });
    expect(shouldRemind(confirmed(5), due)).toBe(false);
    expect(shouldRemind(confirmed(6), due)).toBe(false);
    expect(shouldRemind(confirmed(7), due)).toBe(true);
  });
  it('a late sweep does not turn a skipped reminder into a sent one', () => {
    const r = row({ status: 'confirmed', statusChangedAt: ms(due, -3_600_000) });
    expect(shouldRemind(r, ms(due, 8 * 3_600_000))).toBe(false);
  });
  it('nothing once the reservation is over, started, or never had a reminder', () => {
    expect(shouldRemind(row({ status: 'cancelled' }), due)).toBe(false);
    expect(shouldRemind(row({ status: 'released' }), due)).toBe(false);
    expect(shouldRemind(row(), START)).toBe(false);
    expect(shouldRemind(row({ createdAt: at(16) }), at(18))).toBe(false);
  });
});
