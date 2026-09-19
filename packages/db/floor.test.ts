import { beforeEach, describe, expect, it } from 'vitest';
import { plusMs, zonedTimeToInstant, type Schedule } from '@reserve/core';
import { addWalkIn, floorCursor, hostMove, loadFloor, tableReady, undoLast, WAITLIST_CONSENT, type FloorConfig, type WalkInRequest } from './floor';
import { prisma } from './index';
import { mockProvider } from './messages';
import { placeReservation, type PlaceRequest, type PlacementConfig } from './placement';
import { resetDatabase } from './testing/index';

// Friday 2026-10-02, Los Angeles. Two two-tops. A 19:00 booking for two
// (75 min turn → holds 19:00–20:15); the host works it through the evening.
const DAY = '2026-10-02';
const TZ = 'America/Los_Angeles';
const at = (h: number, m = 0, s = 0) => plusMs(zonedTimeToInstant(DAY, h * 60 + m, TZ), s * 1000);
const BOOKED_AT = zonedTimeToInstant('2026-09-25', 12 * 60, TZ);
const PHONE = '+15035550100';

const placement: PlacementConfig = {
  schedule: {
    timezone: TZ,
    weekly: Array.from({ length: 7 }, () => [{ name: 'dinner', openMinute: 17 * 60, closeMinute: 22 * 60, pacingCap: 40 }]),
    overrides: {},
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
  if (!res.ok) throw new Error(res.reason);
  return res.reservation;
}
const walk = (over: Partial<WalkInRequest> = {}) =>
  addWalkIn({ idempotencyKey: `walk-${(n += 1)}`, day: DAY, partySize: 2, guestName: 'Walk-in', guestPhone: null, textWhenReady: false, now: at(19, 30), ...over }, config);
const get = (id: string) => prisma.reservation.findUniqueOrThrow({ where: { id }, include: { holds: true, events: { orderBy: { id: 'asc' } } } });

beforeEach(async () => {
  await resetDatabase();
  await prisma.diningTable.createMany({ data: [{ id: 'T1', seats: 2, minParty: 1, section: 'main' }, { id: 'T2', seats: 2, minParty: 1, section: 'main' }] });
});

describe('one tap with a 5-second undo (P0-9)', () => {
  it('seats, then undoes inside 5s back to booked with the tables kept — three events, none deleted', async () => {
    const r = await book();
    expect(await hostMove(r.id, 'seated', config, at(19, 2))).toEqual({ ok: true, status: 'seated' });
    expect((await loadFloor(DAY, at(19, 2, 3)))[0]).toMatchObject({ status: 'seated', seatedAt: at(19, 2), undoUntil: at(19, 2, 5) });
    expect(await undoLast(r.id, config, at(19, 2, 5))).toEqual({ ok: true, status: 'booked' });
    const after = await get(r.id);
    expect(after.holds.map((h) => h.tableId)).toEqual(after.tableIds);
    expect(after.events.map((e) => [e.fromStatus, e.toStatus, e.source, e.note])).toEqual([
      [null, 'booked', 'guest_web', null],
      ['booked', 'seated', 'host', null],
      ['seated', 'booked', 'host', 'undo'],
    ]);
    // The undo is not itself undoable.
    expect(await undoLast(r.id, config, at(19, 2, 6))).toEqual({ ok: false, reason: 'not_revertible' });
  });

  it('refuses the undo one second late, and the floor stops offering it', async () => {
    const r = await book();
    await hostMove(r.id, 'seated', config, at(19, 2));
    expect((await loadFloor(DAY, at(19, 2, 6)))[0]!.undoUntil).toBeNull();
    expect(await undoLast(r.id, config, at(19, 2, 6))).toEqual({ ok: false, reason: 'undo_expired' });
    expect((await get(r.id)).status).toBe('seated');
  });

  it('refuses a no-show inside the grace period, by reason', async () => {
    const r = await book();
    expect(await hostMove(r.id, 'no_show', config, at(19, 14))).toEqual({ ok: false, reason: 'too_early' });
    expect(await hostMove(r.id, 'completed', config, at(19, 14))).toEqual({ ok: false, reason: 'no_edge' });
  });
});

describe('a walk-in into a released no-show\'s table (PRD Success Metrics)', () => {
  it('frees the table on the no-show tap, seats a walk-in there, and then refuses the no-show\'s undo cleanly', async () => {
    const r = await book(); // T1
    await book({ guestName: 'Other', guestPhone: '+15035550111' }); // T2, 19:00–20:15
    expect(await hostMove(r.id, 'no_show', config, at(19, 30))).toEqual({ ok: true, status: 'no_show' });
    expect((await get(r.id)).holds).toEqual([]);

    const w = await walk({ now: at(19, 30, 2) });
    expect(w).toMatchObject({ ok: true, reservation: { status: 'seated', tableIds: ['T1'], startAt: at(19, 30, 2) } });

    // Inside the 5s, but the table is someone else's now: a refusal, not an error.
    expect(await undoLast(r.id, config, at(19, 30, 4))).toEqual({ ok: false, reason: 'table_taken' });
    expect((await get(r.id)).status).toBe('no_show');
    expect(await prisma.tableHold.count({ where: { tableId: 'T1' } })).toBe(1);
  });
});

describe('the waitlist (P0-9)', () => {
  it('waitlists a party when nothing is free, quoting a range, and seats them when a table clears', async () => {
    const a = await book();
    await book({ guestName: 'Other', guestPhone: '+15035550111' });
    await hostMove(a.id, 'seated', config, at(19));
    // Both two-tops held until 20:15; at 19:30 → 45 min → quoted 45-60.
    const w = await walk({ guestName: 'Kim', guestPhone: '+15035550122', textWhenReady: true });
    expect(w).toMatchObject({ ok: true, reservation: { status: 'waitlisted', tableIds: [], quotedWait: '45-60 min', smsConsent: WAITLIST_CONSENT } });
    if (!w.ok) throw new Error();

    expect(await hostMove(w.reservation.id, 'seated', config, at(19, 40))).toEqual({ ok: false, reason: 'no_table' });
    await hostMove(a.id, 'completed', config, at(20, 5));
    expect(await hostMove(w.reservation.id, 'seated', config, at(20, 6))).toEqual({ ok: true, status: 'seated' });
    expect(await get(w.reservation.id)).toMatchObject({ tableIds: ['T1'], startAt: at(20, 6), holds: [{ tableId: 'T1', startAt: at(20, 6) }] });

    // Undo hands the table back and returns them to the list.
    expect(await undoLast(w.reservation.id, config, at(20, 6, 3))).toEqual({ ok: true, status: 'waitlisted' });
    expect(await get(w.reservation.id)).toMatchObject({ status: 'waitlisted', tableIds: [], holds: [] });
  });

  it('"table ready" goes out at 21:30 — quiet hours never hold it — and only once', async () => {
    await book({ startAt: at(20, 30) }); // both two-tops held until 21:45
    await book({ startAt: at(20, 30), guestName: 'Other', guestPhone: '+15035550111' });
    const w = await walk({ guestName: 'Kim', guestPhone: '+15035550122', textWhenReady: true, now: at(21, 20) });
    if (!w.ok) throw new Error();
    const { provider, sent } = mockProvider();
    expect(await tableReady(w.reservation.id, provider, config, at(21, 30))).toEqual({ ok: true, sent: true });
    expect(await tableReady(w.reservation.id, provider, config, at(21, 31))).toEqual({ ok: true, sent: false });
    expect(sent.filter((m) => m.to === '+15035550122').map((m) => m.body)).toEqual([
      'Firebird Kitchen: your table is ready. Please come to the host stand in the next 10 minutes.',
    ]);
  });

  it('a waitlisted guest who texted STOP is not texted, and the row says why', async () => {
    await book();
    await book({ guestName: 'Other', guestPhone: '+15035550111' });
    const w = await walk({ guestName: 'Kim', guestPhone: '+15035550122', textWhenReady: true });
    if (!w.ok) throw new Error();
    await prisma.smsOptOut.create({ data: { phone: '+15035550122', at: at(19, 31) } });
    expect(await tableReady(w.reservation.id, mockProvider().provider, config, at(19, 45))).toEqual({ ok: true, sent: false });
    const row = (await loadFloor(DAY, at(19, 45))).find((x) => x.id === w.reservation.id);
    expect(row?.messages).toEqual([{ kind: 'table_ready', status: 'failed', failureReason: 'opted_out' }]);
  });

  it('will not text a party that gave no number or no consent', async () => {
    expect(await walk({ textWhenReady: true })).toEqual({ ok: false, reason: 'invalid', field: 'guestPhone' });
    await book();
    await book({ guestName: 'Other', guestPhone: '+15035550111' });
    const w = await walk({ guestPhone: '+15035550122' });
    if (!w.ok) throw new Error();
    expect(await tableReady(w.reservation.id, mockProvider().provider, config, at(19, 45))).toEqual({ ok: false, reason: 'no_consent' });
  });

  it('removing a waitlisted party is undoable; a party no table fits is refused outright', async () => {
    await book();
    await book({ guestName: 'Other', guestPhone: '+15035550111' });
    const w = await walk();
    if (!w.ok) throw new Error();
    expect(await hostMove(w.reservation.id, 'abandoned', config, at(19, 50))).toEqual({ ok: true, status: 'abandoned' });
    expect(await undoLast(w.reservation.id, config, at(19, 50, 1))).toEqual({ ok: true, status: 'waitlisted' });
    expect(await walk({ partySize: 5 })).toEqual({ ok: false, reason: 'too_large' });
  });
});

describe('allocation under the constraint', () => {
  it('five walk-ins for the last table: exactly one seated, the rest refused or waitlisted, zero orphan holds', async () => {
    await book({ guestName: 'Other', guestPhone: '+15035550111' }); // T1
    const results = await Promise.all(Array.from({ length: 5 }, () => walk()));
    // A loser that read T2 free and lost at the constraint is refused; one that
    // read after the winner committed is waitlisted. Never a second seat.
    expect(results.filter((r) => r.ok && r.reservation.status === 'seated')).toHaveLength(1);
    for (const r of results) {
      if (r.ok) expect(['seated', 'waitlisted']).toContain(r.reservation.status);
      else expect(r).toEqual({ ok: false, reason: 'no_longer_available' });
    }
    expect(await prisma.tableHold.groupBy({ by: ['tableId'], _count: true })).toEqual([
      { tableId: 'T1', _count: 1 },
      { tableId: 'T2', _count: 1 },
    ]);
  });

  it('a double-tapped walk-in (same key) is one party', async () => {
    const [a, b] = [await walk({ idempotencyKey: 'same' }), await walk({ idempotencyKey: 'same' })];
    expect(a.ok && b.ok && a.reservation.id === b.reservation.id && b.replayed).toBe(true);
  });
});

describe('the server-issued cursor', () => {
  it('moves on a host tap and on a failed send, and on nothing else', async () => {
    const r = await book();
    const c0 = await floorCursor();
    expect(await floorCursor()).toBe(c0);
    await hostMove(r.id, 'seated', config, at(19));
    const c1 = await floorCursor();
    expect(c1).not.toBe(c0);
    // The confirmation queued at booking fails at the carrier: a screen change with no event.
    await prisma.outboundMessage.updateMany({ where: { reservationId: r.id }, data: { status: 'failed', failureReason: 'unreachable' } });
    expect(await floorCursor()).not.toBe(c1);
  });
});

describe('what the floor shows', () => {
  it('a host-entered booking reads as "no texts", a failed confirmation carries its reason', async () => {
    const quiet = await book({ smsConsent: undefined, source: 'host' });
    const loud = await book({ guestName: 'Other', guestPhone: '+15035550111' });
    await prisma.outboundMessage.updateMany({ where: { reservationId: loud.id }, data: { status: 'failed', failureReason: 'rate_limited' } });
    const rows = await loadFloor(DAY, at(18));
    expect(rows.find((x) => x.id === quiet.id)).toMatchObject({ texts: false, messages: [] });
    expect(rows.find((x) => x.id === loud.id)).toMatchObject({ texts: true, messages: [{ kind: 'confirmation', status: 'failed', failureReason: 'rate_limited' }] });
  });
});
