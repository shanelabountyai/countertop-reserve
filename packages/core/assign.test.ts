import { describe, expect, it } from 'vitest';
import { allUnits, fittingUnits, unitMisfit, type FloorPlan, type UnitMisfit } from './floor-plan';
import { walkIn } from './availability';
import { revertTables } from './lifecycle';
import { plusMs, zonedTimeToInstant } from './time';

// ─── Hand-calculated fixtures for manual assignment (P0-14) ─────────────────
// The board's plan, kept deliberately identical so the two items' fixtures
// can be read against each other: two deuces in `window` combining into a
// four, a four-top and a six-top in `main`, over-seat cap 2.
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
const at = (hour: number, minute = 0) => zonedTimeToInstant(DAY, hour * 60 + minute, TZ);

describe('unitMisfit (P0-14): the rule that refuses a host-named unit', () => {
  // Each line is one rule saying no, hand-calculated against PLAN. The point
  // of the item: a host is told WHICH rule, never just "no".
  const cases: [unitId: string, partySize: number, expected: UnitMisfit | null, why: string][] = [
    ['T3', 4, null, '4 in a four-top: exact'],
    ['T3', 2, null, '2 in a four-top: 2 empty seats, exactly the cap'],
    ['T4', 4, null, '4 in a six-top: 2 empty seats, exactly the cap'],
    ['C12', 4, null, 'a combination seats its declared 4'],
    ['T1', 3, 'too_large', '3 will not sit at a deuce'],
    ['T3', 1, 'too_small', 'a solo diner is under the four-top’s minParty 2'],
    ['C12', 2, 'too_small', 'a deuce does not get a combination'],
    ['T4', 3, 'over_seat_cap', '3 in a six-top leaves 3 empty, over the cap of 2'],
    ['T9', 2, 'unknown_unit', 'no such unit on the plan'],
  ];
  it.each(cases)('%s, party of %i → %s (%s)', (unitId, partySize, expected) => {
    expect(unitMisfit(PLAN, unitId, partySize)).toBe(expected);
  });

  it('reports the first rule that refuses, not the last: T4 with a deuce is too_small, though the cap also refuses it', () => {
    // 2 < minParty 3, AND 6 - 2 = 4 > cap 2. The host hears the rule about
    // the party, which is the one they can do something about.
    expect(unitMisfit(PLAN, 'T4', 2)).toBe('too_small');
  });

  // The invariant that keeps the two readings honest. `fittingUnits` answers
  // "which units", `unitMisfit` answers "why not that one" — if they ever
  // disagree, a host is refused a table the engine would have picked itself,
  // or handed one it would not have.
  it('is null exactly when the unit is in fittingUnits, for every unit and every party size', () => {
    for (let partySize = 1; partySize <= 8; partySize += 1) {
      const fitting = new Set(fittingUnits(PLAN, partySize).map((u) => u.id));
      for (const u of allUnits(PLAN)) {
        expect(unitMisfit(PLAN, u.id, partySize) === null, `${u.id} party ${partySize}`).toBe(fitting.has(u.id));
      }
    }
  });
});

describe('walkIn windowMinutes (P0-14): a move checks the REMAINDER, never a fresh turn', () => {
  // A party of 2 seated 19:00 on a 90-minute turn, moving at 19:20. Their
  // window ends 20:30 whichever table they sit at — the meal did not restart
  // because the table did. T3 is held from 20:30.
  const movingAt = at(19, 20);
  const held = [{ start: at(20, 30), partySize: 2, turnMinutes: 90, tableIds: ['T3'] }];
  const remainder = 70; // 19:20 → 20:30

  const seatable = (windowMinutes?: number | undefined) => {
    const r = walkIn({ partySize: 2, plan: PLAN, reservations: held, now: movingAt, windowMinutes });
    return r.seatable ? r.units.map((u) => u.id) : [];
  };

  it('offers T3 for the 70 minutes actually left — the hold at 20:30 starts exactly as the window ends', () => {
    expect(seatable(remainder)).toContain('T3');
  });

  it('refuses T3 for a fresh 75-minute turn, which would run to 20:35 and over the hold', () => {
    // The rejected alternative, asserted so it stays rejected: restarting the
    // turn refuses a legal move AND would extend the new table past the
    // free-until the board displayed a moment earlier.
    expect(seatable()).not.toContain('T3');
  });
});

describe('revertTables (P0-14): a table-only host action gets the same 5 seconds', () => {
  const tapped = at(19);
  it('undoable inside the window', () => {
    expect(revertTables({ at: tapped, actor: 'host' }, plusMs(tapped, 5_000))).toEqual({ ok: true });
  });
  it('expired one millisecond past it', () => {
    expect(revertTables({ at: tapped, actor: 'host' }, plusMs(tapped, 5_001))).toEqual({ ok: false, reason: 'undo_expired' });
  });
  it.each(['guest', 'system'] as const)('never undoes a %s action', (actor) => {
    expect(revertTables({ at: tapped, actor }, plusMs(tapped, 1_000))).toEqual({ ok: false, reason: 'not_revertible' });
  });
});
