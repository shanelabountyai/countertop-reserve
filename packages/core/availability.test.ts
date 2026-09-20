import { describe, expect, it } from 'vitest';
import { fittingUnits, turnMinutes, type FloorPlan } from './floor-plan';
import { availability, outsideHours, walkIn, type HeldReservation, type Schedule, type ServicePeriod, type Slot } from './availability';
import { zonedTimeToInstant } from './time';

// Hand-built plan: two deuces that combine into a four, a four-top, a six-top.
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

const ids = (party: number) => fittingUnits(PLAN, party).map((u) => u.id);

describe('fittingUnits (P0-1)', () => {
  it('seats a 4 on a 4-top, the 2+2 combination, or a 6-top (waste 2) — never a 2-top', () => {
    expect(ids(4)).toEqual(['T3', 'C12', 'T4']);
  });

  it('prefers a single table over a combination of equal size', () => {
    expect(ids(3)).toEqual(['T3', 'C12']);
  });

  it('respects the over-seat cap: a 3 at the 6-top wastes 3 > 2', () => {
    expect(ids(3)).not.toContain('T4');
  });

  it("a table's min party blocks a deuce at the 6-top", () => {
    expect(ids(2)).toEqual(['T1', 'T2', 'T3']);
  });

  it('a combination occupies every member table', () => {
    expect(fittingUnits(PLAN, 4).find((u) => u.id === 'C12')?.tableIds).toEqual(['T1', 'T2']);
  });

  it('nothing fits a party larger than the largest unit', () => {
    expect(ids(7)).toEqual([]);
  });
});

describe('turnMinutes (P0-1)', () => {
  it('uses the PRD default bands: 1–2 → 75, 3–4 → 90, 5+ → 120', () => {
    expect([1, 2, 3, 4, 5, 12].map((p) => turnMinutes(p))).toEqual([75, 75, 90, 90, 120, 120]);
  });

  it('takes configured bands', () => {
    expect(turnMinutes(3, [{ upToParty: 4, minutes: 60 }, { upToParty: Infinity, minutes: 100 }])).toBe(60);
  });
});

// ─── Availability fixture matrix (P0-2) ─────────────────────────────────────
// Friday 2026-10-02, America/Los_Angeles (PDT, UTC−7). Dinner 17:00–21:00,
// pacing cap 8 covers per 15-minute bucket. `now` = noon that day.
const DAY = '2026-10-02';
const TZ = 'America/Los_Angeles';
const DINNER: ServicePeriod = { name: 'dinner', openMinute: 17 * 60, closeMinute: 21 * 60, pacingCap: 8 };
const SCHEDULE: Schedule = {
  timezone: TZ,
  weekly: [[DINNER], [], [DINNER], [DINNER], [DINNER], [DINNER], [DINNER]], // Monday dark
  overrides: {},
  blackouts: ['2026-10-31'],
};
const NOON = new Date(Date.UTC(2026, 9, 2, 19, 0));

const hm = (text: string) => {
  const [h, m] = text.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const at = (text: string) => zonedTimeToInstant(DAY, hm(text), TZ);
const held = (table: string | string[], start: string, partySize: number, turn: number): HeldReservation => ({
  start: at(start),
  partySize,
  turnMinutes: turn,
  tableIds: Array.isArray(table) ? table : [table],
});

function run(partySize: number, reservations: HeldReservation[] = [], extra: Partial<Parameters<typeof availability>[0]> = {}) {
  return availability({ day: DAY, partySize, plan: PLAN, schedule: SCHEDULE, reservations, now: NOON, ...extra });
}
const slot = (result: { slots: Slot[] }, time: string) => {
  const found = result.slots.find((s) => s.minute === hm(time));
  if (!found) throw new Error(`no slot at ${time}`);
  return found;
};
const units = (s: Slot) => (s.bookable ? s.units.map((u) => u.id) : s.reason);

describe('availability (P0-2)', () => {
  it('resolves local slot times in the restaurant timezone, not the process one', () => {
    expect(slot(run(2), '17:00').start).toEqual(new Date(Date.UTC(2026, 9, 3, 0, 0)));
  });

  it('an empty book offers every 15 minutes while the turn fits before close', () => {
    const r = run(4); // 90-minute turn → last start 19:30
    expect(r.reason).toBeNull();
    expect(r.slots).toHaveLength(16); // 17:00 … 20:45
    expect(units(slot(r, '17:00'))).toEqual(['T3', 'C12', 'T4']);
    expect(units(slot(r, '19:30'))).toEqual(['T3', 'C12', 'T4']);
    expect(units(slot(r, '19:45'))).toBe('closed');
    // A deuce's 75-minute turn fits at 19:45 but not 20:00.
    expect(units(slot(run(2), '19:45'))).toEqual(['T1', 'T2', 'T3']);
    expect(units(slot(run(2), '20:00'))).toBe('closed');
  });

  it('an explicit last seating allows the turn to overhang close', () => {
    const r = run(4, [], {
      schedule: { ...SCHEDULE, overrides: { [DAY]: [{ ...DINNER, lastSeatingMinute: hm('20:30') }] } },
    });
    expect(units(slot(r, '20:30'))).toEqual(['T3', 'C12', 'T4']);
    expect(units(slot(r, '20:45'))).toBe('closed');
  });

  it('combination-only fit: the 4-top and 6-top are taken, the 2+2 is not', () => {
    const book = [held('T3', '18:30', 4, 90), held('T4', '18:00', 5, 120)];
    expect(units(slot(run(4, book), '19:00'))).toEqual(['C12']);
  });

  it('the last table: one half of the combination taken makes a 4 full', () => {
    // T2, the SECOND member: an engine that only checks a combination's first table passes with T1.
    const book = [held('T3', '18:30', 4, 90), held('T4', '18:00', 5, 120), held('T2', '18:45', 2, 75)];
    expect(units(slot(run(4, book), '19:00'))).toBe('full');
    // …while the other half still seats a deuce.
    expect(units(slot(run(2, book), '19:00'))).toEqual(['T1']);
  });

  it('a booked combination blocks each of its member tables', () => {
    const book = [held(['T1', 'T2'], '18:00', 4, 90)];
    expect(units(slot(run(1, book), '18:30'))).toBe('full');
  });

  it('turns are half-open: a table freed at 18:30 seats an 18:30 party', () => {
    const book = [held('T3', '17:00', 4, 90)];
    expect(units(slot(run(4, book), '18:15'))).toEqual(['C12', 'T4']);
    expect(units(slot(run(4, book), '18:30'))).toEqual(['T3', 'C12', 'T4']);
  });

  it("uses the reservation's snapshotted turn, not today's bands", () => {
    // Booked when turns were 60 minutes; today's bands say 90 for a 4.
    const book = [held('T3', '17:00', 4, 60)];
    expect(units(slot(run(4, book), '18:00'))).toEqual(['T3', 'C12', 'T4']);
  });

  it('pacing-blocked bucket with tables free', () => {
    const book = [held('T4', '18:00', 5, 120), held('T1', '18:00', 2, 75), held('T2', '18:15', 2, 75)];
    // 18:00 bucket: 5 + 2 = 7 covers. T3 is free, but 7 + 2 = 9 > 8.
    expect(units(slot(run(2, book), '18:00'))).toBe('pacing');
    // The 18:15 reservation counts in ITS bucket, not 18:00's: a 2 at 18:15 sees 2 + 2 = 4.
    expect(units(slot(run(2, book), '18:15'))).toEqual(['T3']);
  });

  it('pacing cap is inclusive', () => {
    const book = [held('T4', '18:00', 6, 120)];
    expect(units(slot(run(2, book), '18:00'))).toEqual(['T1', 'T2', 'T3']); // 6 + 2 = 8
    expect(units(slot(run(3, book), '18:00'))).toBe('pacing'); // 6 + 3 = 9
  });

  it('a blackout date is closed with a reason', () => {
    expect(run(2, [], { day: '2026-10-31' })).toEqual({ slots: [], reason: 'closed' });
  });

  it('a day with no service periods is closed', () => {
    expect(run(2, [], { day: '2026-10-05' })).toEqual({ slots: [], reason: 'closed' }); // a Monday
  });

  it('a party larger than the largest legal unit is too_large', () => {
    expect(run(7)).toEqual({ slots: [], reason: 'too_large' });
  });

  it('a party no unit will take for being small is too_small, not too_large', () => {
    const plan: FloorPlan = { ...PLAN, tables: PLAN.tables.map((t) => ({ ...t, minParty: 2 })) };
    expect(run(1, [], { plan })).toEqual({ slots: [], reason: 'too_small' });
  });

  it('slots at or before now are past', () => {
    const r = run(2, [], { now: new Date(Date.UTC(2026, 9, 3, 0, 30)) }); // 17:30 PDT
    expect(units(slot(r, '17:30'))).toBe('past');
    expect(units(slot(r, '17:45'))).toEqual(['T1', 'T2', 'T3']);
  });

  it('a fully booked night reports full, not the overhang slots’ closed', () => {
    const book = ['T1', 'T2', 'T3', 'T4'].map((t) => held(t, '17:00', 1, 240));
    const r = run(2, book);
    expect(r.slots.some((s) => s.bookable)).toBe(false);
    expect(r.reason).toBe('full');
  });

  it('a day entirely behind now reports past', () => {
    expect(run(2, [], { now: new Date(Date.UTC(2026, 9, 4, 0, 0)) }).reason).toBe('past');
  });

  it('rejects a nonsense party size', () => {
    expect(() => run(0)).toThrow();
    expect(() => run(2.5)).toThrow();
  });
});

// ─── Walk-ins (P0-9) ────────────────────────────────────────────────────────
// Same plan, same Friday. A party at the stand at 19:10; windows hand-calculated.
describe('walkIn — a party at the host stand now', () => {
  const now = zonedTimeToInstant(DAY, 19 * 60 + 10, TZ);
  const hold = (tableIds: string[], h: number, m: number, turn: number, seated = false) => ({
    start: zonedTimeToInstant(DAY, h * 60 + m, TZ),
    partySize: 2,
    turnMinutes: turn,
    tableIds,
    seated,
  });
  const ask = (partySize: number, reservations: ReturnType<typeof hold>[]) => walkIn({ partySize, plan: PLAN, reservations, now });

  it('seats at once, off the 15-minute grid, when a table is free for the whole turn', () => {
    expect(ask(2, [])).toMatchObject({ seatable: true, units: [{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }] });
  });

  it('quotes a range from the first table that frees: T3 at 19:30 → 20–35 min', () => {
    const r = [hold(['T1'], 18, 30, 75), hold(['T2'], 19, 0, 75), hold(['T3'], 18, 0, 90)]; // ends 19:45, 20:15, 19:30
    expect(ask(2, r)).toEqual({ seatable: false, reason: 'wait', wait: { fromMinutes: 20, toMinutes: 35 } });
  });

  it('a combination needs both halves free, and a gap shorter than the turn is no gap', () => {
    // Party of 4 (90 min). T3 frees 19:30 but is booked again at 20:00; T1 frees
    // 19:40, T2 19:45 → C12 at 19:45; T4 20:10. First real fit: 19:45 → 35–50.
    const r = [hold(['T3'], 18, 0, 90), hold(['T3'], 20, 0, 90), hold(['T1'], 18, 25, 75), hold(['T2'], 18, 30, 75), hold(['T4'], 18, 10, 120)];
    expect(ask(4, r)).toEqual({ seatable: false, reason: 'wait', wait: { fromMinutes: 35, toMinutes: 50 } });
  });

  it('a seated party past its turn still occupies the table, assumed gone within a slot', () => {
    const others = [hold(['T2'], 19, 0, 75), hold(['T3'], 19, 0, 90)];
    // T1's turn ended 18:45 — but they are still sitting there. 19:10 + 15 = 19:25.
    expect(ask(2, [hold(['T1'], 17, 30, 75, true), ...others])).toEqual({ seatable: false, reason: 'wait', wait: { fromMinutes: 15, toMinutes: 30 } });
    // The same window, not seated (a no-show's old hold, say), is free now.
    expect(ask(2, [hold(['T1'], 17, 30, 75), ...others])).toMatchObject({ seatable: true, units: [{ id: 'T1' }] });
  });

  it('a party no unit fits is refused with the reason, not quoted', () => {
    expect(ask(7, [])).toEqual({ seatable: false, reason: 'too_large' });
  });
});

// ─── The hours-edit diff warning (P0-10) ────────────────────────────────────
// A host is about to change the hours; which already-booked parties does the
// new schedule strand? Rows are named as the reservation table stores them.
const booked = (businessDay: string, time: string, turnMinutes: number, guestName = 'Dana') => ({
  guestName,
  businessDay,
  startAt: zonedTimeToInstant(businessDay, hm(time), TZ),
  turnMinutes,
});

describe('outsideHours — the hours-edit diff warning (P0-10)', () => {
  it('says nothing about reservations the new hours still cover', () => {
    expect(outsideHours(SCHEDULE, [booked(DAY, '17:30', 90), booked(DAY, '19:00', 75)])).toEqual([]);
  });

  it('a seating no period contains is `closed`', () => {
    // 21:15 is past dinner's close; Monday is dark all day.
    expect(outsideHours(SCHEDULE, [booked(DAY, '21:15', 75)])).toEqual([{ row: booked(DAY, '21:15', 75), reason: 'closed' }]);
    expect(outsideHours(SCHEDULE, [booked('2026-10-05', '19:00', 75)])[0]?.reason).toBe('closed');
  });

  it('a blackout strands the whole date, weekly periods or not', () => {
    expect(outsideHours(SCHEDULE, [booked('2026-10-31', '19:00', 75)])[0]?.reason).toBe('closed');
  });

  it("a turn that now runs past close is `overhang`, not `closed` — the party's time still exists", () => {
    expect(outsideHours(SCHEDULE, [booked(DAY, '20:00', 120)])[0]).toEqual({ row: booked(DAY, '20:00', 120), reason: 'overhang' });
  });

  it('an explicit last seating decides the overhang, and a start past it strands', () => {
    const withLast: Schedule = { ...SCHEDULE, weekly: SCHEDULE.weekly.map((day) => day.map((p) => ({ ...p, lastSeatingMinute: hm('20:00') }))) };
    // 20:00 + a 120-minute turn overhangs close, but last seating says yes.
    expect(outsideHours(withLast, [booked(DAY, '20:00', 120)])).toEqual([]);
    expect(outsideHours(withLast, [booked(DAY, '20:15', 60)])[0]?.reason).toBe('overhang');
  });

  it('reports every stranded row, not just the first', () => {
    const rows = [booked(DAY, '19:00', 75, 'fine'), booked(DAY, '21:15', 75, 'a'), booked('2026-10-31', '19:00', 75, 'b')];
    expect(outsideHours(SCHEDULE, rows).map((c) => c.row.guestName)).toEqual(['a', 'b']);
  });
});
