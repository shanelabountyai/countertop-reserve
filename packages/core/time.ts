// Restaurant-calendar ↔ instant conversion (P0-11).
//
// Carried from Countertop's `business-day.ts` — only the two functions the
// availability engine needs. `Intl` is the only timezone database in the
// platform, so no dependency. Every call names the restaurant's timezone;
// nothing here reads the process timezone.

const DAY_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The parts of a REAL restaurant-calendar day, or null.
 *
 * Shape is not enough. `Date.UTC(2026, 8, 31)` silently normalises September
 * 31st to October 1st and `Date.UTC(2026, 1, 30)` gives March 2nd — so a
 * date-shaped string that names no date used to sail through every parser
 * here and land in the database as a `businessDay` whose own `startAt` was on
 * a different day. Round-tripping through UTC and demanding the same three
 * numbers back is what rejects it.
 */
function dayParts(day: string): { y: number; m: number; d: number } | null {
  const m = DAY_SHAPE.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = new Date(Date.UTC(y, mo - 1, d));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

/**
 * Whether `day` is a "YYYY-MM-DD" that names a day that exists. Every edge
 * that accepts a day string from a request checks this instead of a
 * shape-only regex — one predicate, so a new entry point cannot invent a
 * weaker rule.
 */
export const isCalendarDay = (day: string): boolean => dayParts(day) !== null;

/** 0 = Sunday for a "YYYY-MM-DD" restaurant-calendar day. Calendar → calendar, no instant involved. */
export function weekdayOf(day: string): number {
  const p = dayParts(day);
  if (!p) throw new Error(`Malformed day: ${day}`);
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
}

/** The restaurant-calendar "YYYY-MM-DD" an instant falls on — the instant → calendar direction. */
export function dayOf(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Restaurant-local minutes since midnight at an instant. */
export function minuteOfDay(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return part('hour') * 60 + part('minute');
}

/** Minutes east of UTC that `timezone` observes at `instant`. */
function offsetMinutesAt(instant: Date, timezone: string): number {
  const raw = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
    .formatToParts(instant)
    .find((part) => part.type === 'timeZoneName')?.value;
  // Intl renders UTC itself as bare "GMT".
  if (raw === 'GMT') return 0;
  const match = raw ? /^GMT([+-])(\d{2}):(\d{2})$/.exec(raw) : null;
  if (!match) throw new Error(`Could not read the UTC offset in timezone ${timezone}`);
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

/**
 * The instant a restaurant-calendar day + local minute-of-day names in `timezone`.
 *
 * The one local → instant conversion. One refinement pass: read the offset at
 * a naive guess, apply it, read again at the refined instant.
 *
 * ponytail: no DST-transition-date fixture. A slot in the one skipped/doubled
 * local hour a year lands on a real instant near that minute. Add a fixture on
 * the transition date if a service period ever spans 1–3am.
 */
export function zonedTimeToInstant(day: string, minuteOfDay: number, timezone: string): Date {
  const p = dayParts(day);
  if (!p) throw new Error(`Malformed day: ${day}`);
  const naiveMs = Date.UTC(p.y, p.m - 1, p.d) + minuteOfDay * 60_000;
  // The `new Date(<number>)` calls below are epoch ms already resolved against
  // the RESTAURANT's timezone — the local → instant exception, not a parse.
  // eslint-disable-next-line no-restricted-syntax
  const first = offsetMinutesAt(new Date(naiveMs), timezone);
  // eslint-disable-next-line no-restricted-syntax
  const second = offsetMinutesAt(new Date(naiveMs - first * 60_000), timezone);
  // eslint-disable-next-line no-restricted-syntax
  return new Date(naiveMs - second * 60_000);
}

/** An instant shifted by a duration — arithmetic on epoch ms, never a parse. */
export function plusMs(at: Date, ms: number): Date {
  // eslint-disable-next-line no-restricted-syntax
  return new Date(at.getTime() + ms);
}
