import { describe, expect, it } from 'vitest';
import { CHOICE_WINDOW_MS, decideInbound, parseReply, type LastInbound, type UpcomingReservation } from './inbound';
import { DEFAULT_TEMPLATES, REPLY_KEYS, renderMessage, segments, whenSlots } from './messages';
import { plusMs, zonedTimeToInstant } from './time';

const TZ = 'America/Los_Angeles';
const NOW = zonedTimeToInstant('2026-10-02', 12 * 60, TZ);
const later = (ms: number) => plusMs(NOW, ms);
const r = (id: string, status: UpcomingReservation['status'] = 'booked', h = 19): UpcomingReservation => ({
  id,
  status,
  startAt: zonedTimeToInstant('2026-10-02', h * 60, TZ),
});
const last = (outcome: LastInbound['outcome'], over: Partial<LastInbound> = {}): LastInbound => ({
  outcome,
  receivedAt: NOW,
  reservationId: null,
  choices: [],
  ...over,
});

describe('parseReply (Appendix B)', () => {
  it.each([
    ['STOP', 'stop'], ['stop', 'stop'], ['  Stop!  ', 'stop'], ['stop all', 'stop'], ['UNSUBSCRIBE', 'stop'],
    ['unsub', 'stop'], ['CANCEL ALL', 'stop'], ['quit', 'stop'], ['End.', 'stop'], ['\uff33\uff34\uff2f\uff30', 'stop'],
    ['start', 'start'], ['UNSTOP', 'start'],
    ['help', 'help'], ['Info?', 'help'],
    ['C', 'confirm'], ['c', 'confirm'], [' y ', 'confirm'], ['Yes!', 'confirm'], ['confirm', 'confirm'], ['ok', 'confirm'],
    ['X', 'cancel'], ['x', 'cancel'], ['n', 'cancel'], ['No.', 'cancel'], ['cancel', 'cancel'],
    ['CHANGE', 'change'], ['reschedule', 'change'], ['move', 'change'],
  ])('%j → %s', (body, keyword) => expect(parseReply(body)).toEqual({ keyword }));

  it.each([['1', 1], [' 7 ', 7], ['9.', 9]])('%j is choice %i', (body, choice) => expect(parseReply(body)).toEqual({ choice }));

  it.each([
    '', '   ', '0', '10', 'yes please', 'can we do 8ish sat?', 'C X', '👍', `'; DROP TABLE "Reservation";--`,
    'STOP'.repeat(400), 'x'.repeat(5000),
  ])('%j is unknown — nothing outside the allowlist moves state', (body) => {
    expect(parseReply(body)).toEqual({ unknown: true });
  });

  it('control characters are stripped like punctuation', () => {
    expect(parseReply('\u0000C\u200b')).toEqual({ keyword: 'confirm' });
  });
});

describe('decideInbound (P0-6)', () => {
  const confirm = parseReply('C');
  const cancel = parseReply('X');

  it('STOP, START and HELP act without looking for a reservation', () => {
    expect(decideInbound(parseReply('STOP'), [], null, NOW)).toEqual({ outcome: 'opted_out' });
    expect(decideInbound(parseReply('STOP'), [r('a'), r('b')], last('choose', { choices: ['a', 'b'] }), NOW)).toEqual({ outcome: 'opted_out' });
    expect(decideInbound(parseReply('START'), [], null, NOW)).toEqual({ outcome: 'opted_in' });
    expect(decideInbound(parseReply('HELP'), [], null, NOW)).toEqual({ outcome: 'help' });
  });

  it('one upcoming reservation: C confirms it, X cancels it and releases its tables', () => {
    expect(decideInbound(confirm, [r('a')], null, NOW)).toEqual({
      outcome: 'confirmed', reservationId: 'a', transition: { ok: true, from: 'booked', to: 'confirmed', tables: 'keep' },
    });
    expect(decideInbound(cancel, [r('a', 'confirmed')], null, NOW)).toEqual({
      outcome: 'cancelled', reservationId: 'a', transition: { ok: true, from: 'confirmed', to: 'cancelled', tables: 'release' },
    });
  });

  it('a second C is a no-op with the same reply, not an error', () => {
    expect(decideInbound(confirm, [r('a', 'confirmed')], null, NOW)).toMatchObject({
      outcome: 'confirmed', transition: { from: 'confirmed', to: 'confirmed', tables: 'keep' },
    });
  });

  it('CHANGE only sends the link — it never moves state', () => {
    expect(decideInbound(parseReply('change'), [r('a')], null, NOW)).toEqual({ outcome: 'change_link', reservationId: 'a' });
  });

  it('no upcoming reservation: the polite fallback, for every reservation keyword', () => {
    for (const body of ['C', 'X', 'CHANGE']) expect(decideInbound(parseReply(body), [], null, NOW)).toEqual({ outcome: 'no_reservation' });
  });

  it('two upcoming: never a silent guess — ask, then the number picks, then X acts on it', () => {
    const up = [r('a', 'booked', 19), r('b', 'booked', 20)];
    expect(decideInbound(cancel, up, null, NOW)).toEqual({ outcome: 'choose', choices: ['a', 'b'] });
    expect(decideInbound(parseReply('2'), up, last('choose', { choices: ['a', 'b'] }), later(60_000))).toEqual({
      outcome: 'selected', reservationId: 'b',
    });
    expect(decideInbound(cancel, up, last('selected', { reservationId: 'b', receivedAt: later(60_000) }), later(120_000))).toMatchObject({
      outcome: 'cancelled', reservationId: 'b',
    });
  });

  it('the choice window is 5 minutes, inclusive; a stale or out-of-range number is unrecognised', () => {
    const up = [r('a'), r('b')];
    const asked = last('choose', { choices: ['a', 'b'] });
    expect(decideInbound(parseReply('1'), up, asked, later(CHOICE_WINDOW_MS))).toEqual({ outcome: 'selected', reservationId: 'a' });
    expect(decideInbound(parseReply('1'), up, asked, later(CHOICE_WINDOW_MS + 1))).toEqual({ outcome: 'unrecognised' });
    expect(decideInbound(parseReply('3'), up, asked, NOW)).toEqual({ outcome: 'unrecognised' });
    expect(decideInbound(parseReply('1'), up, null, NOW)).toEqual({ outcome: 'unrecognised' });
    // A stale selection asks again rather than acting on a reservation picked long ago.
    expect(decideInbound(confirm, up, last('selected', { reservationId: 'a' }), later(CHOICE_WINDOW_MS + 1))).toMatchObject({ outcome: 'choose' });
  });

  it('a selection that is no longer upcoming (the host cancelled it meanwhile) is not acted on', () => {
    expect(decideInbound(confirm, [r('b'), r('c')], last('selected', { reservationId: 'a' }), NOW)).toMatchObject({ outcome: 'choose' });
  });

  // The fallback that made the case above safe only because TWO were left.
  // With one left it fired, and the guest's keyword landed on the booking
  // they had explicitly not chosen.
  describe('a stale selection never retargets the one reservation left', () => {
    const chose = (id: string) => last('selected', { reservationId: id });

    it.each([
      ['X', 'cancel'],
      ['C', 'confirm'],
      ['CHANGE', 'change'],
    ])('%s after the selected reservation is gone asks again instead of acting on B', (body) => {
      // Offered a and b, picked a, a is cancelled or has started — only b is upcoming.
      const action = decideInbound(parseReply(body), [r('b')], chose('a'), later(60_000));
      expect(action).toEqual({ outcome: 'choose', choices: ['b'] });
      // The thing that matters: nothing names b as a target.
      expect(action).not.toMatchObject({ reservationId: 'b' });
    });

    it('says so plainly when nothing is left at all', () => {
      expect(decideInbound(cancel, [], chose('a'), later(60_000))).toEqual({ outcome: 'no_reservation' });
    });

    it('still acts when the selected reservation IS still there', () => {
      expect(decideInbound(cancel, [r('a'), r('b')], chose('a'), later(60_000))).toMatchObject({
        outcome: 'cancelled',
        reservationId: 'a',
      });
    });

    // Without a prior selection there is nothing to be loyal to, so one
    // upcoming reservation is still an unambiguous target.
    it('leaves the no-selection single-reservation case alone', () => {
      expect(decideInbound(cancel, [r('b')], null, NOW)).toMatchObject({ outcome: 'cancelled', reservationId: 'b' });
    });

    // A selection expires after the window; past it the guest is starting a
    // fresh thread, so the ordinary single-reservation rule applies again.
    it('an EXPIRED selection is not a selection, so one reservation is unambiguous again', () => {
      expect(decideInbound(cancel, [r('b')], chose('a'), later(CHOICE_WINDOW_MS + 1))).toMatchObject({
        outcome: 'cancelled',
        reservationId: 'b',
      });
    });
  });

  it('at most nine choices — the digits that can select one', () => {
    const up = Array.from({ length: 12 }, (_, i) => r(`r${i}`));
    expect(decideInbound(confirm, up, null, NOW)).toEqual({ outcome: 'choose', choices: up.slice(0, 9).map((x) => x.id) });
  });

  it('an unrecognised body gets one clarifying reply; the second hands off to the host, and stays handed off', () => {
    const junk = parseReply('what time is it');
    expect(decideInbound(junk, [r('a')], null, NOW)).toEqual({ outcome: 'unrecognised' });
    expect(decideInbound(junk, [r('a')], last('unrecognised'), NOW)).toEqual({ outcome: 'handoff' });
    expect(decideInbound(junk, [r('a')], last('handoff'), NOW)).toEqual({ outcome: 'handoff' });
    expect(decideInbound(junk, [r('a')], last('confirmed'), NOW)).toEqual({ outcome: 'unrecognised' });
  });
});

describe('reply templates (Appendix A)', () => {
  const slots = {
    restaurant: 'Firebird Kitchen',
    ...whenSlots(NOW, TZ),
    party: '4',
    link: 'https://firebird.example/m/AAAAAAAAAAAAAAAAAAAAAA',
    bookLink: 'https://firebird.example/book',
    phone: '+15035550199',
    count: '9',
    // The long form of {was}: a change that moved days carries the date too.
    was: `${whenSlots(NOW, TZ).date} ${whenSlots(NOW, TZ).time}`,
    replyKeys: REPLY_KEYS,
    choices: Array.from({ length: 9 }, (_, i) => `${i + 1}) Sat, Oct 10 10:45 PM`).join(', '),
  };
  it.each(Object.entries(DEFAULT_TEMPLATES))('%s renders GSM-7 within 2 segments, nine choices included', (_, template) => {
    const body = renderMessage(template, slots);
    expect(segments(body)).toBe(body.length <= 160 ? 1 : Math.ceil(body.length / 153)); // i.e. GSM, not UCS-2
  });
  it('a missing slot throws rather than texting "undefined"', () => {
    expect(() => renderMessage(DEFAULT_TEMPLATES.help, {})).toThrow('{restaurant}');
  });
});
