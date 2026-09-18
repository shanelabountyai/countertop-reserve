import { describe, expect, it } from 'vitest';
import {
  HOLDS_TABLES,
  SHOWED,
  STATUSES,
  TERMINAL,
  UPCOMING,
  parseStatus,
  revert,
  transition,
  type Actor,
  type Status,
} from './lifecycle';
import { plusMs, zonedTimeToInstant } from './time';

const START = zonedTimeToInstant('2026-10-02', 19 * 60, 'America/Chicago');
const at = (minutesFromStart: number) => plusMs(START, minutesFromStart * 60_000);
const BEFORE = at(-120);
const AFTER_GRACE = at(20);
const res = (status: Status) => ({ status, startAt: START });

// Hand-written from the PRD (P0-4), NOT derived from the module's EDGES.
// Every (from, to, actor) not listed here must be refused.
const VALID: readonly [Status, Status, Actor][] = [
  ['waitlisted', 'seated', 'host'],
  ['waitlisted', 'abandoned', 'host'],
  ['waitlisted', 'abandoned', 'system'],
  ['booked', 'confirmed', 'guest'],
  ['booked', 'confirmed', 'host'],
  ['booked', 'seated', 'host'],
  ['booked', 'cancelled', 'guest'],
  ['booked', 'cancelled', 'host'],
  ['booked', 'no_show', 'host'],
  ['booked', 'released', 'system'],
  ['confirmed', 'seated', 'host'],
  ['confirmed', 'cancelled', 'guest'],
  ['confirmed', 'cancelled', 'host'],
  ['confirmed', 'no_show', 'host'],
  ['seated', 'completed', 'host'],
];
const ACTORS: readonly Actor[] = ['guest', 'host', 'system'];

// A time at which the edge's own clock rule is satisfied.
const legalNow = (to: Status, actor: Actor) => (to === 'no_show' ? AFTER_GRACE : actor === 'guest' ? BEFORE : AFTER_GRACE);

describe('transition table (P0-4) — every (from, to, actor) enumerated', () => {
  for (const from of STATUSES)
    for (const to of STATUSES)
      for (const actor of ACTORS) {
        const valid = VALID.some(([f, t, a]) => f === from && t === to && a === actor);
        it(`${from} → ${to} by ${actor}: ${valid ? 'allowed' : 'refused'}`, () => {
          expect(transition(res(from), to, actor, legalNow(to, actor)).ok).toBe(valid);
        });
      }
});

describe('invalid transitions, by reason', () => {
  const cases: [string, Status, Status, Actor, Date, string][] = [
    ['a second "C" from the guest', 'confirmed', 'confirmed', 'guest', BEFORE, 'no_change'],
    ['completed cannot reopen', 'completed', 'seated', 'host', AFTER_GRACE, 'terminal'],
    ['a cancel is not un-cancelled by a later action', 'cancelled', 'confirmed', 'guest', BEFORE, 'terminal'],
    ['a released table is not re-confirmed — it is a new booking', 'released', 'confirmed', 'guest', BEFORE, 'terminal'],
    ['a no-show cannot later be marked cancelled', 'no_show', 'cancelled', 'host', AFTER_GRACE, 'terminal'],
    ['a confirmed guest is never auto-released', 'confirmed', 'released', 'system', AFTER_GRACE, 'no_edge'],
    ['a seated party cannot be a no-show', 'seated', 'no_show', 'host', AFTER_GRACE, 'no_edge'],
    ['seated cannot go back to booked except by revert', 'seated', 'booked', 'host', AFTER_GRACE, 'no_edge'],
    ['a waitlisted party cannot confirm', 'waitlisted', 'confirmed', 'guest', BEFORE, 'no_edge'],
    ['a guest cannot seat themselves (SMS is a trust boundary)', 'confirmed', 'seated', 'guest', BEFORE, 'actor'],
    ['a guest cannot mark themselves a no-show', 'booked', 'no_show', 'guest', AFTER_GRACE, 'actor'],
    ['the sweep cannot cancel — release is its only edge', 'booked', 'cancelled', 'system', BEFORE, 'actor'],
    ['no-show inside the grace period', 'confirmed', 'no_show', 'host', at(14), 'too_early'],
    ['guest cancel at the start minute', 'confirmed', 'cancelled', 'guest', START, 'too_late'],
    ['guest confirm after the start', 'booked', 'confirmed', 'guest', at(5), 'too_late'],
  ];
  for (const [name, from, to, actor, now, reason] of cases)
    it(name, () => expect(transition(res(from), to, actor, now)).toEqual({ ok: false, reason }));

  it('no-show allowed exactly at the grace boundary', () => {
    expect(transition(res('confirmed'), 'no_show', 'host', at(15)).ok).toBe(true);
  });
  it('guest cancel allowed one minute before the start', () => {
    expect(transition(res('confirmed'), 'cancelled', 'guest', at(-1)).ok).toBe(true);
  });
});

describe('table effect — what the caller does to TableHold rows', () => {
  it.each([
    ['booked', 'confirmed', 'host', 'keep'],
    ['confirmed', 'seated', 'host', 'keep'],
    ['booked', 'released', 'system', 'release'],
    ['confirmed', 'no_show', 'host', 'release'],
    ['confirmed', 'cancelled', 'host', 'release'],
    ['seated', 'completed', 'host', 'release'],
    ['waitlisted', 'seated', 'host', 'acquire'],
    ['waitlisted', 'abandoned', 'system', 'none'],
  ] as const)('%s → %s: %s', (from, to, actor, tables) => {
    expect(transition(res(from), to, actor, AFTER_GRACE)).toMatchObject({ ok: true, tables });
  });
});

describe('derived status lists', () => {
  it('the occupied set is exactly the statuses that hold tables', () => {
    expect(HOLDS_TABLES).toEqual(['booked', 'confirmed', 'seated']);
  });
  it('no_show, cancelled and released are distinct, terminal, and hold nothing', () => {
    for (const s of ['no_show', 'cancelled', 'released'] as const) {
      expect(TERMINAL).toContain(s);
      expect(HOLDS_TABLES).not.toContain(s);
      expect(SHOWED).not.toContain(s);
    }
  });
  it('an inbound reply can act only on booked or confirmed', () => {
    expect(UPCOMING).toEqual(['booked', 'confirmed']);
  });
  it('covers count seated and completed', () => {
    expect(SHOWED).toEqual(['seated', 'completed']);
  });
});

describe('revert — undo is a logged event, never a delete', () => {
  const seatedAt = at(0);
  const lastSeat = { fromStatus: 'confirmed', toStatus: 'seated', at: seatedAt, actor: 'host' } as const;
  const plus = (s: number) => plusMs(seatedAt, s * 1000);

  it('undoes a seat inside 5s, back to the prior status, keeping the tables', () => {
    expect(revert(res('seated'), lastSeat, plus(5))).toEqual({ ok: true, from: 'seated', to: 'confirmed', tables: 'keep' });
  });
  it('undoing a no-show re-acquires the tables', () => {
    const last = { fromStatus: 'booked', toStatus: 'no_show', at: seatedAt, actor: 'host' } as const;
    expect(revert(res('no_show'), last, plus(2))).toMatchObject({ ok: true, to: 'booked', tables: 'acquire' });
  });
  it('refuses after the undo window', () => {
    expect(revert(res('seated'), lastSeat, plus(6))).toEqual({ ok: false, reason: 'undo_expired' });
  });
  it('refuses to undo a guest action or a system release', () => {
    const guest = { fromStatus: 'confirmed', toStatus: 'cancelled', at: seatedAt, actor: 'guest' } as const;
    const sweep = { fromStatus: 'booked', toStatus: 'released', at: seatedAt, actor: 'system' } as const;
    expect(revert(res('cancelled'), guest, plus(1))).toEqual({ ok: false, reason: 'not_revertible' });
    expect(revert(res('released'), sweep, plus(1))).toEqual({ ok: false, reason: 'not_revertible' });
  });
  it('refuses when the event is stale (status moved on since)', () => {
    expect(revert(res('completed'), lastSeat, plus(1))).toEqual({ ok: false, reason: 'not_revertible' });
  });
});

describe('parseStatus — the DB column is plain text', () => {
  it('accepts every status and rejects anything else', () => {
    for (const s of STATUSES) expect(parseStatus(s)).toBe(s);
    expect(() => parseStatus('Seated')).toThrow(/unknown reservation status/);
  });
});
