import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATES,
  DELIVERY_STATUSES,
  REPLY_KEYS,
  canDeliver,
  confirmationBody,
  render,
  segments,
  type DeliveryStatus,
} from './messages';
import { zonedTimeToInstant } from './time';

// Friday 2026-10-02 19:00 in Los Angeles is Saturday 02:00 UTC — a body
// formatted through UTC or the process TZ would say "Sat" or "2:00 AM".
const START = zonedTimeToInstant('2026-10-02', 19 * 60, 'America/Los_Angeles');
const LINK = 'https://firebird.example/m/AAAAAAAAAAAAAAAAAAAAAA';
const input = { template: DEFAULT_TEMPLATES.confirmation, restaurant: 'Firebird Kitchen', timezone: 'America/Los_Angeles', startAt: START, partySize: 4, link: LINK };

describe('segments', () => {
  it.each([
    ['a'.repeat(160), 1],
    ['a'.repeat(161), 2],
    ['a'.repeat(306), 2],
    ['a'.repeat(307), 3],
    ['€'.repeat(80), 1], // extension chars cost two septets
    ['€'.repeat(81), 2],
    ['é'.repeat(160), 1], // é is in the GSM basic set
    ['ê'.repeat(70), 1], // ê is not: UCS-2
    ['ê'.repeat(71), 2],
    ['ê'.repeat(134), 2],
    ['ê'.repeat(135), 3],
    ['a'.repeat(159) + ' ', 3], // one narrow no-break space turns 160 chars into UCS-2
  ])('%# → %i', (body, n) => expect(segments(body)).toBe(n));
});

describe('render', () => {
  it('fills every named slot', () => {
    expect(render('{restaurant}|{date}|{time}|{party}|{link}|{replyKeys}', { restaurant: 'R', date: 'D', time: 'T', party: '2', link: 'L', replyKeys: 'K' })).toBe('R|D|T|2|L|K');
  });
  it('throws on an unknown slot rather than texting a literal', () => {
    expect(() => render('at {tiem}', { restaurant: '', date: '', time: '', party: '', link: '', replyKeys: '' })).toThrow('{tiem}');
  });
});

describe('confirmationBody (P0-5)', () => {
  it('renders in the restaurant timezone, whatever the process TZ', () => {
    expect(confirmationBody(input)).toBe(`Firebird Kitchen: table for 4 on Fri, Oct 2 at 7:00 PM. ${REPLY_KEYS} Manage: ${LINK}`);
  });
  it('the default confirmation is GSM-7 and within 2 segments', () => {
    const body = confirmationBody(input);
    expect(segments(body)).toBeLessThanOrEqual(2);
    expect(segments(body)).toBe(Math.ceil(body.length / 153)); // i.e. GSM, not UCS-2
  });
  it('refuses a body over 2 segments instead of sending a third', () => {
    expect(() => confirmationBody({ ...input, restaurant: 'F'.repeat(200) })).toThrow(/3 segments/);
  });
  it('refuses a body that goes UCS-2 past 2 segments', () => {
    expect(() => confirmationBody({ ...input, restaurant: 'Fírebird Kitchen' })).toThrow(/segments/);
  });
});

describe('delivery state', () => {
  const VALID: [DeliveryStatus, DeliveryStatus][] = [
    ['queued', 'sent'],
    ['queued', 'failed'],
    ['sent', 'delivered'],
    ['sent', 'failed'],
  ];
  it.each(DELIVERY_STATUSES.flatMap((f) => DELIVERY_STATUSES.map((t) => [f, t] as const)))('%s → %s', (from, to) => {
    expect(canDeliver(from, to)).toBe(VALID.some(([f, t]) => f === from && t === to));
  });
});
