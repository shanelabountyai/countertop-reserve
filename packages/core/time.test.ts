// Calendar validity, which shape alone never gave us. Pure — no database.
import { describe, expect, it } from 'vitest';
import { BOOKING_HORIZON_DAYS, lastBookableDay } from './availability';
import { dayOf, isCalendarDay, weekdayOf, zonedTimeToInstant } from './time';

const TZ = 'America/Los_Angeles';

describe('isCalendarDay', () => {
  it.each(['2026-01-01', '2026-02-28', '2026-12-31', '2024-02-29', '2000-02-29'])('accepts %s', (day) => {
    expect(isCalendarDay(day)).toBe(true);
  });

  // Each of these is date-SHAPED and names no date. The old shape-only regex
  // took every one of them, and Date.UTC silently rolled it onto another day.
  it.each([
    ['a 31st that does not exist', '2026-09-31'],
    ['February 30th', '2026-02-30'],
    ['February 29th in a common year', '2026-02-29'],
    ['a 29th February in a century non-leap year', '1900-02-29'],
    ['month 13', '2026-13-01'],
    ['month 00', '2026-00-10'],
    ['day 00', '2026-09-00'],
    ['day 32', '2026-09-32'],
  ])('rejects %s', (_label, day) => {
    expect(isCalendarDay(day)).toBe(false);
  });

  it.each([['wrong shape', '2026-9-1'], ['a time attached', '2026-09-01T00:00'], ['empty', ''], ['rubbish', 'tomorrow']])(
    'rejects %s',
    (_label, day) => {
      expect(isCalendarDay(day)).toBe(false);
    },
  );
});

// The defect this closes: both parsers fed their captured groups straight to
// Date.UTC, which normalises out of range instead of complaining. September
// 31st became October 1st, and the reservation kept "2026-09-31" as its
// businessDay while its startAt sat on a different day entirely.
describe('the parsers refuse a day that does not exist', () => {
  it('weekdayOf throws rather than rolling over', () => {
    expect(() => weekdayOf('2026-09-31')).toThrow(/Malformed day/);
    expect(() => weekdayOf('2026-02-30')).toThrow(/Malformed day/);
  });

  it('zonedTimeToInstant throws rather than rolling over', () => {
    expect(() => zonedTimeToInstant('2026-09-31', 19 * 60, TZ)).toThrow(/Malformed day/);
  });

  it('still converts the real days either side', () => {
    expect(weekdayOf('2026-09-30')).toBe(3); // Wednesday
    expect(dayOf(zonedTimeToInstant('2026-10-01', 19 * 60, TZ), TZ)).toBe('2026-10-01');
  });

  // The round trip is the invariant every stored reservation must satisfy:
  // the day it NAMES is the day its instant FALLS on, in restaurant time.
  it.each(['2026-01-01', '2026-03-08', '2026-11-01', '2026-06-15'])('round-trips %s through the restaurant timezone', (day) => {
    expect(dayOf(zonedTimeToInstant(day, 19 * 60, TZ), TZ)).toBe(day);
  });
});

describe('lastBookableDay', () => {
  it('is the horizon in DAYS, so a late slot on the last day is still inside it', () => {
    const now = zonedTimeToInstant('2026-09-21', 9 * 60, TZ);
    expect(lastBookableDay(now, TZ)).toBe('2026-11-20');
    expect(BOOKING_HORIZON_DAYS).toBe(60);
  });

  it('moves with the restaurant calendar, not with UTC', () => {
    // 23:30 in Los Angeles is already the next day in UTC.
    const late = zonedTimeToInstant('2026-09-21', 23 * 60 + 30, TZ);
    expect(lastBookableDay(late, TZ)).toBe('2026-11-20');
    expect(lastBookableDay(late, 'UTC')).toBe('2026-11-21');
  });
});
