import { describe, expect, it } from 'vitest';
import { MESSAGE_KINDS } from './messages';
import { quietUntil, sendDecision, type Outgoing } from './compliance';
import { zonedTimeToInstant } from './time';

// Friday 2026-10-02 in Los Angeles; quiet 21:00–09:00.
const TZ = 'America/Los_Angeles';
const at = (h: number, m = 0, day = '2026-10-02') => zonedTimeToInstant(day, h * 60 + m, TZ);
const NINE_TOMORROW = at(9, 0, '2026-10-03');

const msg = (over: Partial<Outgoing> = {}): Outgoing => ({ kind: 'reminder', isReply: false, startAt: at(19, 0, '2026-10-03'), optedOut: false, sentToday: 0, ...over });

describe('quietUntil — the boundary minutes', () => {
  it.each([
    [at(8, 59), at(9)],
    [at(9), null],
    [at(20, 59), null],
    [at(21), NINE_TOMORROW],
    [at(23, 59), NINE_TOMORROW],
    [at(0, 0, '2026-10-03'), NINE_TOMORROW],
  ])('%s → %s', (now, until) => expect(quietUntil(now, TZ)).toEqual(until));

  it('ends at 09:00 local across the DST change (Nov 1 2026, LA)', () => {
    expect(quietUntil(at(22, 0, '2026-10-31'), TZ)).toEqual(at(9, 0, '2026-11-01'));
  });
});

describe('sendDecision (P0-8)', () => {
  it('defers a reminder for tomorrow at 21:00, not at 20:59', () => {
    expect(sendDecision(msg(), at(20, 59), TZ)).toBe('send');
    expect(sendDecision(msg(), at(21), TZ)).toBe('defer');
    expect(sendDecision(msg(), at(8, 59, '2026-10-03'), TZ)).toBe('defer');
    expect(sendDecision(msg(), at(9, 0, '2026-10-03'), TZ)).toBe('send');
  });

  it("sends in quiet hours what can't wait: tonight's table, and replies to the guest's own text", () => {
    expect(sendDecision(msg({ kind: 'confirmation', startAt: at(21, 45) }), at(21, 30), TZ)).toBe('send');
    expect(sendDecision(msg({ kind: 'released', startAt: at(8, 30, '2026-10-03') }), at(23), TZ)).toBe('send'); // before 09:00 = before the window ends
    expect(sendDecision(msg({ kind: 'confirmation', startAt: NINE_TOMORROW }), at(23), TZ)).toBe('defer');
    expect(sendDecision(msg({ kind: 'help', isReply: true, startAt: null }), at(2, 0, '2026-10-03'), TZ)).toBe('send');
  });

  it('a STOP stops every kind but its own acknowledgement — at any hour, over any limit', () => {
    for (const kind of MESSAGE_KINDS) {
      const expected = kind === 'opted_out' ? 'send' : 'opted_out';
      expect(sendDecision(msg({ kind, optedOut: true }), at(12), TZ)).toBe(expected);
    }
    expect(sendDecision(msg({ kind: 'opted_out', isReply: true, optedOut: true, sentToday: 99 }), at(23), TZ)).toBe('send');
  });

  it('drops the sixth text to a number in a day', () => {
    expect(sendDecision(msg({ sentToday: 4 }), at(12), TZ)).toBe('send');
    expect(sendDecision(msg({ sentToday: 5 }), at(12), TZ)).toBe('rate_limited');
    expect(sendDecision(msg({ sentToday: 5 }), at(22), TZ)).toBe('defer'); // deferred, not dropped: tomorrow is a new day
    expect(sendDecision(msg({ sentToday: 5 }), at(12), TZ, { quietStart: 21 * 60, quietEnd: 9 * 60, dailyLimit: 6 })).toBe('send');
  });
});
