// The hours form's parsing rules. Pure — no database, no clock.
import { describe, expect, it } from 'vitest';
import { closeMinutesOf, hhmm, minutesOf, parseEdit, MIDNIGHT_CLOSE } from './edit';

const form = (fields: Record<string, string>) => (name: string) => fields[name] ?? '';

const addPeriod = (over: Record<string, string> = {}) =>
  form({ kind: 'addPeriod', scope: 'weekly', weekday: '5', name: 'Dinner', open: '17:00', close: '22:00', cap: '20', ...over });

describe('minutesOf / closeMinutesOf', () => {
  it.each([['17:30', 1050], ['00:00', 0], ['23:45', 1425]])('reads %s', (text, want) => {
    expect(minutesOf(text)).toBe(want);
    expect(closeMinutesOf(text)).toBe(want);
  });

  // The defect: the schema allows minute 1440 and `hhmm` renders it, but the
  // parser's regex stopped at 23:59, so submitting it failed the whole edit.
  it('accepts a midnight CLOSE, and only as a close', () => {
    expect(closeMinutesOf('24:00')).toBe(MIDNIGHT_CLOSE);
    expect(minutesOf('24:00')).toBeNull();
  });

  it.each(['24:15', '25:00', '99:99', '7:00', '', 'midnight'])('rejects %s either way', (text) => {
    expect(minutesOf(text)).toBeNull();
    expect(closeMinutesOf(text)).toBeNull();
  });

  it('round-trips through hhmm', () => {
    expect(hhmm(MIDNIGHT_CLOSE)).toBe('24:00');
    expect(closeMinutesOf(hhmm(MIDNIGHT_CLOSE))).toBe(MIDNIGHT_CLOSE);
    expect(minutesOf(hhmm(1050))).toBe(1050);
  });
});

describe('parseEdit', () => {
  it('builds a period closing at midnight', () => {
    expect(parseEdit(addPeriod({ close: '24:00', last: '23:00' }))).toMatchObject({
      kind: 'addPeriod',
      period: { closeMinute: MIDNIGHT_CLOSE, lastSeatingMinute: 23 * 60 },
    });
  });

  it('refuses a midnight OPENING rather than storing minute 1440 as an open', () => {
    expect(parseEdit(addPeriod({ open: '24:00' }))).toBeNull();
  });

  it('refuses a midnight LAST SEATING', () => {
    expect(parseEdit(addPeriod({ last: '24:00' }))).toBeNull();
  });

  // Date-shaped strings that name no date, at the schedule edges too.
  it.each(['2026-09-31', '2026-02-30', '2026-13-01'])('refuses a date-scoped period on %s', (day) => {
    expect(parseEdit(addPeriod({ scope: 'date', day }))).toBeNull();
  });

  it.each(['2026-09-31', '2026-02-30'])('refuses a blackout on %s', (day) => {
    expect(parseEdit(form({ kind: 'addBlackout', day }))).toBeNull();
    expect(parseEdit(form({ kind: 'removeBlackout', day }))).toBeNull();
  });

  it('still takes a real date-scoped period', () => {
    expect(parseEdit(addPeriod({ scope: 'date', day: '2026-10-02' }))).toMatchObject({
      kind: 'addPeriod',
      period: { day: '2026-10-02', weekday: null },
    });
  });
});
