// The hours form, parsed. Shared by the server action and the page, so the
// "this would strand N reservations — go ahead?" step reads the pending edit
// with exactly the code that will apply it. A round trip through the URL
// cannot turn one edit into a different one.
//
// Window and grid rules are NOT re-checked here: the migration's CHECK
// constraints own them, and a second copy would be the one that drifts.
import { isCalendarDay } from '@reserve/core';
import type { ScheduleEdit } from '@reserve/db/schedule';

/** Every form field, so the confirm link can carry the edit back verbatim. */
export const FIELDS = ['kind', 'scope', 'weekday', 'day', 'name', 'open', 'close', 'last', 'cap', 'id', 'reason'] as const;

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];


const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** "17:30" → 1050. Null when it is not a time — never a Date, never a parse. */
export const minutesOf = (text: string): number | null => {
  const m = TIME.exec(text);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Midnight at the END of the day. Not 0 — that is midnight at the start. */
export const MIDNIGHT_CLOSE = 24 * 60;

/**
 * A CLOSING time, which may be midnight.
 *
 * The migration's CHECK allows `closeMinute` up to and including 1440 and
 * `hhmm` already renders that as "24:00", but nothing could produce it: the
 * parser's regex stopped at 23:59 and `<input type="time">` cannot represent
 * midnight at all, so a kitchen that closes at midnight had no way to say so
 * and the form silently rejected the whole edit. Closing only — an opening or
 * a last seating at "24:00" is a day with no service in it, and 00:00 already
 * means midnight at the start of the day for those.
 */
export const closeMinutesOf = (text: string): number | null => (text === '24:00' ? MIDNIGHT_CLOSE : minutesOf(text));

/** 1050 → "17:30". A close at midnight reads "24:00", which is what it means. */
export const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

export function parseEdit(get: (name: string) => string): ScheduleEdit | null {
  const kind = get('kind');
  if (kind === 'removePeriod') {
    const id = get('id');
    return UUID.test(id) ? { kind, id } : null;
  }
  if (kind === 'removeBlackout' || kind === 'addBlackout') {
    const day = get('day');
    if (!isCalendarDay(day)) return null;
    if (kind === 'removeBlackout') return { kind, day };
    const reason = get('reason').trim().slice(0, 80);
    return { kind, day, reason: reason === '' ? null : reason };
  }
  if (kind !== 'addPeriod') return null;

  const name = get('name').trim().slice(0, 40);
  const openMinute = minutesOf(get('open'));
  const closeMinute = closeMinutesOf(get('close'));
  const lastText = get('last');
  const lastSeatingMinute = lastText === '' ? null : minutesOf(lastText);
  const pacingCap = Number(get('cap'));
  if (name === '' || openMinute === null || closeMinute === null) return null;
  if (lastText !== '' && lastSeatingMinute === null) return null;
  if (!Number.isInteger(pacingCap) || pacingCap < 1 || pacingCap > 500) return null;

  // A weekly period or a single-date override, never both (the DB says so too).
  const scope = get('scope');
  const weekday = Number(get('weekday'));
  const day = get('day');
  const where =
    scope === 'weekly' && Number.isInteger(weekday) && weekday >= 0 && weekday <= 6
      ? { weekday, day: null }
      : scope === 'date' && isCalendarDay(day)
        ? { weekday: null, day }
        : null;
  if (!where) return null;

  return { kind, period: { ...where, name, openMinute, closeMinute, lastSeatingMinute, pacingCap } };
}
