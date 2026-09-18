// Restaurant-calendar ↔ instant conversion (P0-11).
//
// Carried from Countertop's `business-day.ts` — only the two functions the
// availability engine needs. `Intl` is the only timezone database in the
// platform, so no dependency. Every call names the restaurant's timezone;
// nothing here reads the process timezone.

/** 0 = Sunday for a "YYYY-MM-DD" restaurant-calendar day. Calendar → calendar, no instant involved. */
export function weekdayOf(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`Malformed day: ${day}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
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
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`Malformed day: ${day}`);
  const naiveMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + minuteOfDay * 60_000;
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
