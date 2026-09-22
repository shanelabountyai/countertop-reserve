import { beforeEach, describe, expect, it } from 'vitest';
import { plusMs, zonedTimeToInstant, type Schedule } from '@reserve/core';
import { addWalkIn, assignUnit, hostMove, loadFloor, undoLast, type FloorConfig, type WalkInRequest } from './floor';
import { prisma } from './index';
import { placeReservation, type PlaceRequest, type PlacementConfig } from './placement';
import { resetDatabase, seedSchedule } from './testing/index';

// ─── Manual assignment (P0-14) ──────────────────────────────────────────────
//
// Friday 2026-10-02, Los Angeles. Two deuces that combine into a four, a
// four-top and a six-top on the patio — the board's plan, so the two items'
// fixtures read against each other. Over-seat cap 2.
//
//   fittingUnits(2) = T1, T2, T3      (a deuce never gets C12 or T4)
//   fittingUnits(3) = T3, C12
//   fittingUnits(4) = T3, C12, T4
//
// Saturday the 3rd is the same service with a pacing cap of 6 instead of 40 —
// the one fixture where the cap is reachable, and so the one that can assert
// the deliberate asymmetry about pacing both ways.
const DAY = '2026-10-02';
const TIGHT = '2026-10-03';
const TZ = 'America/Los_Angeles';
const at = (h: number, m = 0, s = 0) => plusMs(zonedTimeToInstant(DAY, h * 60 + m, TZ), s * 1000);
const tight = (h: number, m = 0) => zonedTimeToInstant(TIGHT, h * 60 + m, TZ);
const BOOKED_AT = zonedTimeToInstant('2026-09-25', 12 * 60, TZ);
const PHONE = '+15035550100';
const dinner = (pacingCap: number) => [{ name: 'dinner', openMinute: 17 * 60, closeMinute: 22 * 60, pacingCap }];

const placement: PlacementConfig = {
  schedule: {
    timezone: TZ,
    weekly: Array.from({ length: 7 }, () => dinner(40)),
    overrides: { [TIGHT]: dinner(6) },
    blackouts: [],
  } satisfies Schedule,
  overSeatCap: 2,
  restaurant: 'Firebird Kitchen',
  manageBaseUrl: 'https://firebird.example/m',
};
const config: FloorConfig = { restaurant: 'Firebird Kitchen', timezone: TZ, overSeatCap: 2 };

let n = 0;
async function book(over: Partial<PlaceRequest> = {}) {
  const res = await placeReservation(
    { idempotencyKey: `key-${(n += 1)}`, day: DAY, startAt: at(19), partySize: 2, guestName: 'Dana Reyes', guestPhone: PHONE, source: 'guest_web', smsConsent: 'Text me.', now: BOOKED_AT, ...over },
    placement,
  );
  if (!res.ok) throw new Error(`fixture booking failed: ${res.reason}`);
  return res.reservation;
}
async function walk(over: Partial<WalkInRequest> = {}) {
  const res = await addWalkIn({ idempotencyKey: `walk-${(n += 1)}`, day: DAY, partySize: 2, guestName: 'Walk-in', guestPhone: null, textWhenReady: false, now: at(19), ...over }, config);
  if (!res.ok) throw new Error(`fixture walk-in failed: ${res.reason}`);
  return res.reservation;
}
const get = (id: string) => prisma.reservation.findUniqueOrThrow({ where: { id }, include: { holds: { orderBy: { tableId: 'asc' } }, events: { orderBy: { id: 'asc' } }, messages: { orderBy: { id: 'asc' } } } });

beforeEach(async () => {
  await resetDatabase();
  await seedSchedule(placement.schedule);
  await prisma.diningTable.createMany({
    data: [
      { id: 'T1', seats: 2, minParty: 1, section: 'main' },
      { id: 'T2', seats: 2, minParty: 1, section: 'main' },
      { id: 'T3', seats: 4, minParty: 2, section: 'main' },
      { id: 'T4', seats: 6, minParty: 3, section: 'patio' },
    ],
  });
  await prisma.combination.create({ data: { id: 'C12', seats: 4, minParty: 3, members: { create: [{ tableId: 'T1' }, { tableId: 'T2' }] } } });
});

describe('the host names the unit, the transaction still decides (P0-14)', () => {
  it('moves a booked party onto a named free unit, logging where they came from', async () => {
    const r = await book(); // a deuce: the engine picks T1, the host wants T3
    expect(r.tableIds).toEqual(['T1']);

    expect(await assignUnit(r.id, 'T3', config, at(18))).toEqual({ ok: true, status: 'booked', tableIds: ['T3'], from: ['T1'] });

    const after = await get(r.id);
    expect(after.tableIds).toEqual(['T3']);
    // The hold moved with it — one row, the booked window, on the new table.
    expect(after.holds.map((h) => [h.tableId, h.startAt, h.endAt])).toEqual([['T3', at(19), at(20, 15)]]);
    // Append-only, actor host, and the previous unit recorded: the undo has
    // no status edge to grip, so this column is the only way back.
    expect(after.events.map((e) => [e.fromStatus, e.toStatus, e.source, e.note, e.fromTableIds])).toEqual([
      [null, 'booked', 'guest_web', null, []],
      ['booked', 'booked', 'host', 'moved from T1 to T3', ['T1']],
    ]);
  });

  it('refuses a unit outside the fitting set by NAME, and never forces it', async () => {
    const deuce = await book();
    const three = await book({ partySize: 3, idempotencyKey: 'key-three' });
    const four = await book({ partySize: 4, idempotencyKey: 'key-four' });

    // Each is one rule saying no. A host hears which.
    expect(await assignUnit(four.id, 'T1', config, at(18))).toEqual({ ok: false, reason: 'too_large' });
    expect(await assignUnit(deuce.id, 'T4', config, at(18))).toEqual({ ok: false, reason: 'too_small' });
    expect(await assignUnit(three.id, 'T4', config, at(18))).toEqual({ ok: false, reason: 'over_seat_cap' });
    expect(await assignUnit(deuce.id, 'T99', config, at(18))).toEqual({ ok: false, reason: 'unknown_unit' });

    // Refused means untouched, every time.
    expect((await get(deuce.id)).tableIds).toEqual(['T1']);
    expect((await get(three.id)).tableIds).toEqual(['T3']);
    expect((await get(four.id)).tableIds).toEqual(['T4']); // T3 taken, C12 blocked by the deuce on T1
  });

  it('refuses a unit another party holds for the window', async () => {
    const first = await book(); // T1
    const second = await book(); // T2
    expect(await assignUnit(second.id, 'T1', config, at(18))).toEqual({ ok: false, reason: 'unit_held' });
    expect((await get(second.id)).tableIds).toEqual(['T2']);
    expect((await get(first.id)).tableIds).toEqual(['T1']);
  });

  it('refuses a unit whose member table is committed to the combination that contains it', async () => {
    const four = await book({ partySize: 4 }); // T3
    const deuce = await book(); // T1
    // C12 is T1+T2, and T1 is taken — a combination whose member is committed
    // is not inventory, whatever the host taps.
    expect(await assignUnit(four.id, 'C12', config, at(18))).toEqual({ ok: false, reason: 'unit_held' });
    expect((await get(four.id)).tableIds).toEqual(['T3']);
    expect((await get(deuce.id)).tableIds).toEqual(['T1']);
  });

  it('re-reads the schedule under the lock: a blackout applied after booking refuses the assignment', async () => {
    const r = await book();
    await prisma.blackout.create({ data: { day: DAY, reason: 'burst pipe' } });
    expect(await assignUnit(r.id, 'T3', config, at(18))).toEqual({ ok: false, reason: 'outside_hours' });
    expect((await get(r.id)).tableIds).toEqual(['T1']);
  });

  it('refuses a terminal reservation outright', async () => {
    const r = await book();
    await hostMove(r.id, 'cancelled', config, at(18));
    expect(await assignUnit(r.id, 'T3', config, at(18, 1))).toEqual({ ok: false, reason: 'not_assignable' });
  });

  it('assigns a party who is already late — the past-slot gate is a booking rule, not a seating one', async () => {
    const r = await book(); // 19:00, still `booked` at 19:10
    expect(await assignUnit(r.id, 'T3', config, at(19, 10))).toMatchObject({ ok: true, tableIds: ['T3'] });
  });
});

describe('pacing: inventory planning, never seating (P0-14)', () => {
  it('applies to a future reservation and not to a party already in the building', async () => {
    // Saturday, cap 6. A booked four takes T3 (4 covers in the 19:00 bucket).
    const booked = await book({ day: TIGHT, startAt: tight(19), partySize: 4, now: BOOKED_AT });
    expect(booked.tableIds).toEqual(['T3']);
    // A walk-in of four at 19:05 skips pacing on the way in (v1's rule) and
    // lands on C12 — the bucket now holds 8 covers against a cap of 6. A
    // combination stores the TABLES it occupies, which is what makes it
    // inventory rather than a display detail.
    const walkedIn = await walk({ day: TIGHT, partySize: 4, now: tight(19, 5) });
    expect(walkedIn.tableIds).toEqual(['T1', 'T2']);
    expect(walkedIn.status).toBe('seated');

    // Moving the BOOKED party is inventory planning: the cap refuses it.
    expect(await assignUnit(booked.id, 'T4', config, tight(19, 6))).toEqual({ ok: false, reason: 'over_pacing_cap' });
    // Moving the party who is physically in the room is seating: it does not.
    expect(await assignUnit(walkedIn.id, 'T4', config, tight(19, 6))).toMatchObject({ ok: true, tableIds: ['T4'] });
  });
});

describe('a seated party may be moved, and the turn carries (P0-14, resolved)', () => {
  // A walk-in of two seated at 19:00 on a 75-minute turn: they are done at
  // 20:15 whichever table they sit at. Moved at 19:20, so 55 minutes remain.
  //
  //   T2 is held from 20:15 — free for the remainder, NOT for a fresh turn.
  //   T3 is held from 20:00 — held during the remainder.
  const setup = async () => {
    const party = await walk(); // T1, 19:00–20:15
    await book({ startAt: at(20, 15) }); // T1 again, from 20:15
    await book({ startAt: at(20, 15) }); // T1 taken at that hour → T2
    await book({ startAt: at(20) }); // T1 and T2 both busy → T3, 20:00–21:15
    return party;
  };

  it('moves onto a unit free only for the remainder, and does not restart the turn', async () => {
    const party = await setup();
    expect(await assignUnit(party.id, 'T2', config, at(19, 20))).toMatchObject({ ok: true, status: 'seated', tableIds: ['T2'] });

    const after = await get(party.id);
    // The window is anchored to the seat event: still 19:00, still 75 minutes.
    expect([after.startAt, after.turnMinutes]).toEqual([at(19), 75]);
    // The hold runs from the move to the END THEY ALREADY HAD. A fresh turn
    // would have run to 20:35, over T2's 20:15 hold, and would have refused a
    // legal move while extending T2 past the free-until the board displayed.
    expect(after.holds.map((h) => [h.tableId, h.startAt, h.endAt])).toEqual([['T2', at(19, 20), at(20, 15)]]);
  });

  it('refuses a unit held during the remainder, leaving them where they were', async () => {
    const party = await setup();
    expect(await assignUnit(party.id, 'T3', config, at(19, 20))).toEqual({ ok: false, reason: 'unit_held' });
    const after = await get(party.id);
    expect(after.tableIds).toEqual(['T1']);
    expect(after.holds.map((h) => [h.tableId, h.startAt, h.endAt])).toEqual([['T1', at(19), at(20, 15)]]);
  });

  it('refuses a move into a unit that no longer fits, leaving the original intact', async () => {
    const party = await walk(); // a deuce on T1
    expect(await assignUnit(party.id, 'T4', config, at(19, 20))).toEqual({ ok: false, reason: 'too_small' });
    const after = await get(party.id);
    expect(after.tableIds).toEqual(['T1']);
    expect(after.holds.map((h) => h.tableId)).toEqual(['T1']);
  });

  it('frees the vacated table as real inventory in the same session', async () => {
    const party = await walk(); // T1
    await assignUnit(party.id, 'T3', config, at(19, 20));
    // A walk-in at the stand one minute later must be seatable on T1 — not
    // waiting for a sweep to notice it came free.
    const next = await walk({ now: at(19, 21) });
    expect([next.status, next.tableIds]).toEqual(['seated', ['T1']]);
  });
});

describe('seating a waitlisted party onto a named unit (P0-14)', () => {
  // Everything at 19:00 is committed, so the walk-in waits: T1, T2, T3 to
  // three deuces and T4 to a four.
  const setup = async () => {
    const onT1 = await book();
    await book();
    await book();
    await book({ partySize: 4 }); // T3 gone, C12 blocked by T1/T2 → T4
    const waiting = await walk({ now: at(19, 5) });
    expect(waiting.status).toBe('waitlisted');
    return { onT1, waiting };
  };

  it('refuses a unit that is still held, then seats them on one that is not', async () => {
    const { onT1, waiting } = await setup();
    expect(await assignUnit(waiting.id, 'T1', config, at(19, 5))).toEqual({ ok: false, reason: 'unit_held' });

    // Asserted, not assumed: `booked → completed` has no edge, and a fixture
    // whose setup silently failed tests nothing.
    expect(await hostMove(onT1.id, 'cancelled', config, at(19, 6))).toEqual({ ok: true, status: 'cancelled' });
    expect(await assignUnit(waiting.id, 'T1', config, at(19, 7))).toEqual({ ok: true, status: 'seated', tableIds: ['T1'], from: [] });

    const after = await get(waiting.id);
    expect([after.status, after.startAt, after.turnMinutes]).toEqual(['seated', at(19, 7), 75]);
    expect(after.holds.map((h) => [h.tableId, h.startAt, h.endAt])).toEqual([['T1', at(19, 7), at(20, 22)]]);
    // A waitlisted party had no previous unit, so the undo is the ordinary
    // status revert and the column stays empty.
    expect(after.events.map((e) => [e.fromStatus, e.toStatus, e.note, e.fromTableIds])).toEqual([
      [null, 'waitlisted', 'walk-in', []],
      ['waitlisted', 'seated', 'seated at T1', []],
    ]);
  });

  it('undoes that seat back to the waitlist, handing the table back whole', async () => {
    const { onT1, waiting } = await setup();
    expect(await hostMove(onT1.id, 'cancelled', config, at(19, 6))).toEqual({ ok: true, status: 'cancelled' });
    expect(await assignUnit(waiting.id, 'T1', config, at(19, 7))).toMatchObject({ ok: true });
    expect(await undoLast(waiting.id, config, at(19, 7, 4))).toEqual({ ok: true, status: 'waitlisted' });
    const after = await get(waiting.id);
    expect([after.status, after.tableIds, after.holds]).toEqual(['waitlisted', [], []]);
  });
});

describe('undo of a move (P0-14)', () => {
  it('puts the party back on the table they came off, inside the 5 seconds', async () => {
    const r = await book(); // T1
    await assignUnit(r.id, 'T3', config, at(19, 0, 0));
    expect((await loadFloor(DAY, at(19, 0, 3)))[0]).toMatchObject({ tableIds: ['T3'], undoUntil: at(19, 0, 5) });

    expect(await undoLast(r.id, config, at(19, 0, 5))).toEqual({ ok: true, status: 'booked' });
    const after = await get(r.id);
    expect(after.tableIds).toEqual(['T1']);
    expect(after.holds.map((h) => [h.tableId, h.startAt, h.endAt])).toEqual([['T1', at(19), at(20, 15)]]);
    expect(after.events.map((e) => [e.toStatus, e.note, e.fromTableIds])).toEqual([
      ['booked', null, []],
      ['booked', 'moved from T1 to T3', ['T1']],
      ['booked', 'undo: back to T1', []],
    ]);
    // The undo carries no previous unit, which is what makes it un-undoable:
    // otherwise a host could toggle a party between two tables for ever.
    expect(await undoLast(r.id, config, at(19, 0, 6))).toEqual({ ok: false, reason: 'not_revertible' });
  });

  it('refuses one second late, and the floor stops offering it', async () => {
    const r = await book();
    await assignUnit(r.id, 'T3', config, at(19, 0, 0));
    expect((await loadFloor(DAY, at(19, 0, 6)))[0]!.undoUntil).toBeNull();
    expect(await undoLast(r.id, config, at(19, 0, 6))).toEqual({ ok: false, reason: 'undo_expired' });
    expect((await get(r.id)).tableIds).toEqual(['T3']);
  });

  it('refuses when the vacated table was given away in those five seconds', async () => {
    const r = await book(); // T1
    await assignUnit(r.id, 'T3', config, at(19, 0, 0));
    const taker = await book(); // T1 is free again, so the next booking takes it
    expect(taker.tableIds).toEqual(['T1']);

    expect(await undoLast(r.id, config, at(19, 0, 2))).toEqual({ ok: false, reason: 'table_taken' });
    // An undo is an allocation like any other: refused leaves both parties put.
    expect((await get(r.id)).tableIds).toEqual(['T3']);
    expect((await get(taker.id)).tableIds).toEqual(['T1']);
  });
});

describe('two hosts, one table (P0-14)', () => {
  it('produces exactly one assignment, one clean refusal, and no orphan hold', async () => {
    const a = await book(); // T1
    const b = await book(); // T2
    const results = await Promise.all([assignUnit(a.id, 'T3', config, at(18)), assignUnit(b.id, 'T3', config, at(18))]);

    const won = results.filter((r) => r.ok);
    const lost = results.filter((r) => !r.ok);
    expect(won).toHaveLength(1);
    // Decided by the constraint or by the re-read under the bucket lock —
    // either way a refusal, never an error and never a second seat.
    expect(lost.map((r) => (r.ok ? null : r.reason))).toEqual([expect.stringMatching(/^(unit_held|no_longer_available)$/)]);

    expect(await prisma.tableHold.count({ where: { tableId: 'T3' } })).toBe(1);
    // Nobody was left holding nothing.
    for (const id of [a.id, b.id]) expect((await get(id)).holds).toHaveLength(1);
  });
});

describe('the snapshot rule is untouched by assignment (P0-14)', () => {
  it('assign, move and re-assign leave the stored messages byte-identical', async () => {
    const r = await book();
    const before = (await get(r.id)).messages;
    expect(before).toHaveLength(1); // the confirmation, rendered at booking

    await assignUnit(r.id, 'T3', config, at(18));
    await assignUnit(r.id, 'T2', config, at(18, 1));
    await assignUnit(r.id, 'T1', config, at(18, 2));

    const after = await get(r.id);
    expect(after.tableIds).toEqual(['T1']);
    expect(after.messages).toEqual(before);
    // And the reservation's own snapshot: the tables moved, nothing else did.
    expect([after.startAt, after.partySize, after.turnMinutes, after.guestName]).toEqual([at(19), 2, 75, 'Dana Reyes']);
  });
});
