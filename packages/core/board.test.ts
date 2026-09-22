import { describe, expect, it } from 'vitest';
import { allUnits, type FloorPlan } from './floor-plan';
import { tableStates, type BoardReservation, type TableStateRow } from './board';
import { zonedTimeToInstant } from './time';

// ─── Hand-calculated board fixtures (P0-13) ─────────────────────────────────
// Friday 2026-10-02, America/Los_Angeles. Two deuces in `window` that combine
// into a four; a four-top and a six-top in `main`. `now` is 19:00 local and
// the horizon is 30 minutes, so 19:30 is the line between `reserved_soon` and
// a `free` that carries a free-until.
const PLAN: FloorPlan = {
  tables: [
    { id: 'T1', seats: 2, minParty: 1, section: 'window' },
    { id: 'T2', seats: 2, minParty: 1, section: 'window' },
    { id: 'T3', seats: 4, minParty: 2, section: 'main' },
    { id: 'T4', seats: 6, minParty: 3, section: 'main' },
  ],
  combinations: [{ id: 'C12', tableIds: ['T1', 'T2'], seats: 4, minParty: 3 }],
  overSeatCap: 2,
};

const DAY = '2026-10-02';
const TZ = 'America/Los_Angeles';
/** 19:40 → 1180. */
const at = (hour: number, minute = 0) => zonedTimeToInstant(DAY, hour * 60 + minute, TZ);
const NOW = at(19);
const HORIZON = 30;

let n = 0;
const held = (r: Partial<BoardReservation> & { start: Date; tableIds: readonly string[] }): BoardReservation => ({
  id: `r${(n += 1)}`,
  guestName: 'Guest',
  partySize: 2,
  turnMinutes: 75,
  seated: false,
  ...r,
});

const board = (reservations: readonly BoardReservation[], now = NOW, horizon = HORIZON) => {
  const rows = tableStates(PLAN, reservations, now, horizon);
  return new Map(rows.map((row) => [row.unit.id, row]));
};

/** Narrowed lookup: a fixture asserting on a `free` row should fail loudly, not read `undefined`. */
function row<S extends TableStateRow['state']>(rows: Map<string, TableStateRow>, id: string, state: S) {
  const found = rows.get(id);
  expect(found, `no board row for ${id}`).toBeDefined();
  expect(found!.state, `${id} should be ${state}`).toBe(state);
  return found as Extract<TableStateRow, { state: S }> & TableStateRow;
}

describe('allUnits (P0-13)', () => {
  it('lists every table then every combination, sections carried', () => {
    expect(allUnits(PLAN).map((u) => [u.id, u.section])).toEqual([
      ['T1', 'window'],
      ['T2', 'window'],
      ['T3', 'main'],
      ['T4', 'main'],
      ['C12', 'window'],
    ]);
  });
});

describe('tableStates — free carries its free-until (P0-13)', () => {
  it('an empty service reads free with no next hold', () => {
    const rows = board([]);
    expect([...rows.keys()]).toEqual(['T1', 'T2', 'T3', 'T4', 'C12']);
    for (const id of ['T1', 'T2', 'T3', 'T4', 'C12']) {
      const free = row(rows, id, 'free');
      expect(free.freeUntil).toBeNull();
      expect(free.freeMinutes).toBeNull();
    }
  });

  it('a hold 40 minutes out leaves the table free for exactly 40 minutes', () => {
    const free = row(board([held({ start: at(19, 40), tableIds: ['T3'], partySize: 4, turnMinutes: 90 })]), 'T3', 'free');
    expect(free.freeUntil?.getTime()).toBe(at(19, 40).getTime());
    expect(free.freeMinutes).toBe(40);
  });

  it('free-until is the EARLIEST next hold, not the first one listed', () => {
    const free = row(
      board([held({ start: at(21), tableIds: ['T3'] }), held({ start: at(19, 45), tableIds: ['T3'] })]),
      'T3',
      'free',
    );
    expect(free.freeMinutes).toBe(45);
  });

  it("a combination's free-until comes from a hold on one member", () => {
    const free = row(board([held({ start: at(19, 40), tableIds: ['T1'] })]), 'C12', 'free');
    expect(free.freeMinutes).toBe(40);
  });

  it('the horizon decides free-with-a-window vs reserved_soon, and nothing else does', () => {
    const reservations = [held({ start: at(19, 40), tableIds: ['T3'], partySize: 4, turnMinutes: 90 })];
    expect(row(board(reservations, NOW, 60), 'T3', 'reserved_soon').inMinutes).toBe(40);
    expect(row(board(reservations, NOW, 30), 'T3', 'free').freeMinutes).toBe(40);
  });

  it('`now` is a parameter: the same hold reads 100 minutes out an hour earlier', () => {
    const reservations = [held({ start: at(19, 40), tableIds: ['T3'] })];
    expect(row(board(reservations, at(18)), 'T3', 'free').freeMinutes).toBe(100);
  });
});

describe('tableStates — occupied (P0-13)', () => {
  it('names the party, when they sat, and when the table is expected back', () => {
    const occupied = row(
      board([held({ id: 'res-patel', start: at(19), tableIds: ['T3'], partySize: 4, turnMinutes: 90, guestName: 'Patel', seated: true, seatedAt: at(19, 5) })]),
      'T3',
      'occupied',
    );
    expect(occupied.party).toEqual({ reservationId: 'res-patel', guestName: 'Patel', partySize: 4 });
    expect(occupied.since.getTime()).toBe(at(19, 5).getTime());
    expect(occupied.expectedClear.getTime()).toBe(at(20, 30).getTime());
    expect(occupied.overdue).toBe(false);
  });

  it('a long turn past its expected clear still reads occupied, never free', () => {
    // Seated 17:00 on a 120-minute turn: due back at 19:00, and it is 19:00.
    const occupied = row(
      board([held({ start: at(17), tableIds: ['T4'], partySize: 6, turnMinutes: 120, seated: true })]),
      'T4',
      'occupied',
    );
    expect(occupied.overdue).toBe(true);
    expect(occupied.expectedClear.getTime()).toBe(at(19).getTime());
  });

  it('since falls back to the booked start when no seat event was recorded', () => {
    const occupied = row(board([held({ start: at(18, 30), tableIds: ['T3'], seated: true })]), 'T3', 'occupied');
    expect(occupied.since.getTime()).toBe(at(18, 30).getTime());
  });

  it('a hold covering now that nobody has sat at reads reserved_soon, and the party is late', () => {
    const soon = row(board([held({ start: at(18, 50), tableIds: ['T3'], turnMinutes: 90 })]), 'T3', 'reserved_soon');
    expect(soon.start.getTime()).toBe(at(18, 50).getTime());
    expect(soon.inMinutes).toBe(-10);
  });
});

describe('tableStates — combinations are inventory lines (P0-13)', () => {
  it('committing the combination blocks every member table, naming the combination', () => {
    const rows = board([held({ start: at(19), tableIds: ['T1', 'T2'], partySize: 4, turnMinutes: 90, guestName: 'Okafor', seated: true })]);
    expect(row(rows, 'C12', 'occupied').party.guestName).toBe('Okafor');
    expect(row(rows, 'T1', 'blocked').by).toEqual(['C12']);
    expect(row(rows, 'T2', 'blocked').by).toEqual(['C12']);
  });

  it('committing one member blocks the combination, naming the member', () => {
    const rows = board([held({ start: at(19), tableIds: ['T1'], seated: true })]);
    expect(row(rows, 'T1', 'occupied').party.partySize).toBe(2);
    expect(row(rows, 'C12', 'blocked').by).toEqual(['T1']);
    // The other deuce is untouched.
    expect(row(rows, 'T2', 'free').freeUntil).toBeNull();
  });

  it('a combination whose member is occupied can never read free', () => {
    for (const seated of [true, false]) {
      const rows = board([held({ start: at(19), tableIds: ['T2'], seated })]);
      expect(rows.get('C12')!.state).not.toBe('free');
    }
  });

  it('two members held by two different parties name both blockers, once each', () => {
    const rows = board([held({ start: at(19), tableIds: ['T1'], seated: true }), held({ start: at(19), tableIds: ['T2'], seated: true })]);
    expect(row(rows, 'C12', 'blocked').by).toEqual(['T1', 'T2']);
  });

  it('a member is only blocked once the combination is imminent — before that it is free with a window', () => {
    const reservations = [held({ start: at(19, 40), tableIds: ['T1', 'T2'], partySize: 4, turnMinutes: 90 })];
    expect(row(board(reservations, NOW, 30), 'T1', 'free').freeMinutes).toBe(40);
    expect(row(board(reservations, NOW, 60), 'T1', 'blocked').by).toEqual(['C12']);
  });

  it('a hold on an undeclared set of tables is named by its tables, not dropped', () => {
    const rows = board([held({ start: at(19), tableIds: ['T2', 'T3'], partySize: 5, seated: true })]);
    expect(row(rows, 'C12', 'blocked').by).toEqual(['T2+T3']);
    expect(row(rows, 'T2', 'blocked').by).toEqual(['T2+T3']);
  });
});
