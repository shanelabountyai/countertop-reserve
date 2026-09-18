import { beforeEach, describe, expect, it } from 'vitest';
import { zonedTimeToInstant, type Schedule } from '@reserve/core';
import { prisma } from './index';
import { placeReservation, type PlaceRequest, type PlacementConfig } from './placement';
import { resetDatabase } from './testing/index';

// Friday 2026-10-02, America/Los_Angeles. Dinner 17:00–21:00, `now` = noon.
const DAY = '2026-10-02';
const TZ = 'America/Los_Angeles';
const NOW = zonedTimeToInstant(DAY, 12 * 60, TZ);
const at = (h: number, m = 0) => zonedTimeToInstant(DAY, h * 60 + m, TZ);

const config = (pacingCap = 40): PlacementConfig => ({
  schedule: {
    timezone: TZ,
    weekly: Array.from({ length: 7 }, () => [{ name: 'dinner', openMinute: 17 * 60, closeMinute: 21 * 60, pacingCap }]),
    overrides: {},
    blackouts: [],
  } satisfies Schedule,
  overSeatCap: 2,
});

let n = 0;
const request = (over: Partial<PlaceRequest> = {}): PlaceRequest => ({
  idempotencyKey: `key-${(n += 1)}`,
  day: DAY,
  startAt: at(19),
  partySize: 2,
  guestName: 'Dana Reyes',
  guestPhone: '+15035550100',
  source: 'guest_web',
  now: NOW,
  ...over,
});

async function floor(tables: [id: string, seats: number, minParty?: number][], combos: [id: string, members: string[], seats: number][] = []) {
  await prisma.diningTable.createMany({ data: tables.map(([id, seats, minParty = 1]) => ({ id, seats, minParty, section: 'main' })) });
  for (const [id, members, seats] of combos) {
    await prisma.combination.create({
      data: { id, seats, minParty: 3, members: { create: members.map((tableId) => ({ tableId })) } },
    });
  }
}

const counts = async () => ({
  reservations: await prisma.reservation.count(),
  holds: await prisma.tableHold.count(),
  events: await prisma.reservationEvent.count(),
});

beforeEach(resetDatabase);

describe('placement (P0-3)', () => {
  it('captures the full snapshot, holds the table for the quoted turn, logs `booked`', async () => {
    await floor([['T1', 2]]);
    const res = await placeReservation(
      request({ partySize: 2, note: 'Window if possible', tags: ['allergy', 'occasion'] }),
      config(),
    );
    if (!res.ok) throw new Error(res.reason);
    expect(res.replayed).toBe(false);
    expect(res.reservation).toMatchObject({
      businessDay: DAY,
      startAt: at(19),
      partySize: 2,
      turnMinutes: 75,
      tableIds: ['T1'],
      guestName: 'Dana Reyes',
      guestPhone: '+15035550100',
      note: 'Window if possible',
      tags: ['allergy', 'occasion'],
      status: 'booked',
      createdAt: NOW,
    });
    expect(await prisma.tableHold.findMany()).toEqual([
      { reservationId: res.reservation.id, tableId: 'T1', startAt: at(19), endAt: at(20, 15) },
    ]);
    expect(await prisma.reservationEvent.findMany({ select: { fromStatus: true, toStatus: true, source: true } })).toEqual([
      { fromStatus: null, toStatus: 'booked', source: 'guest_web' },
    ]);
  });

  it('a combination holds every member table', async () => {
    await floor([['T4', 2], ['T5', 2]], [['C45', ['T4', 'T5'], 4]]);
    const res = await placeReservation(request({ partySize: 4 }), config());
    if (!res.ok) throw new Error(res.reason);
    expect(res.reservation.tableIds).toEqual(['T4', 'T5']);
    expect((await prisma.tableHold.findMany({ orderBy: { tableId: 'asc' } })).map((h) => h.tableId)).toEqual(['T4', 'T5']);
  });

  it('refuses with the engine’s reason, writing nothing', async () => {
    await floor([['T1', 2]]);
    expect(await placeReservation(request({ startAt: at(20, 30) }), config())).toEqual({ ok: false, reason: 'closed' }); // 75-min turn overhangs 21:00
    expect(await placeReservation(request({ startAt: at(19, 5) }), config())).toEqual({ ok: false, reason: 'closed' }); // off the grid
    expect(await placeReservation(request({ startAt: at(11) }), config())).toEqual({ ok: false, reason: 'closed' }); // before dinner
    expect(await placeReservation(request({ partySize: 9 }), config())).toEqual({ ok: false, reason: 'too_large' });
    expect(await placeReservation(request({ now: at(19) }), config())).toEqual({ ok: false, reason: 'past' });
    expect(await counts()).toEqual({ reservations: 0, holds: 0, events: 0 });
  });

  it.each([
    ['guestName', { guestName: '   ' }],
    ['guestPhone', { guestPhone: '503-555-0100' }],
    ['guestPhone', { guestPhone: '+0035550100' }],
    ['note', { note: 'x'.repeat(141) }],
    ['tags', { tags: ['vip'] }],
  ] as const)('rejects an invalid %s before touching the database', async (field, over) => {
    await floor([['T1', 2]]);
    expect(await placeReservation(request(over), config())).toEqual({ ok: false, reason: 'invalid', field });
    expect(await counts()).toEqual({ reservations: 0, holds: 0, events: 0 });
  });

  it('accepts a 140-code-point note of emoji (Postgres counts code points, not UTF-16 units)', async () => {
    await floor([['T1', 2]]);
    const res = await placeReservation(request({ note: '🎂'.repeat(140) }), config());
    expect(res.ok).toBe(true);
  });
});

describe('the last table, contended (P0-3)', () => {
  it('N simultaneous bookings: exactly one reservation, N-1 clean refusals, zero orphan holds', async () => {
    await floor([['T1', 4, 2]]);
    const N = 8;
    const results = await Promise.all(Array.from({ length: N }, () => placeReservation(request({ partySize: 4 }), config())));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    // Serialized by the bucket lock, the losers see the winner and hear "full".
    expect(results.filter((r) => !r.ok).map((r) => !r.ok && r.reason)).toEqual(Array(N - 1).fill('full'));
    expect(await counts()).toEqual({ reservations: 1, holds: 1, events: 1 });
  });

  it('overlapping bookings in DIFFERENT buckets: the constraint decides, exactly one wins', async () => {
    await floor([['T1', 2]]);
    // Every pair overlaps: the spread (60 min) is under the 75-min turn. An
    // 18:30 and a 19:45 would be back-to-back, and both could rightly win.
    const starts = [at(19), at(19, 15), at(19, 30), at(18, 45), at(18, 30)];
    const results = await Promise.all(starts.map((startAt) => placeReservation(request({ startAt }), config())));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results) if (!r.ok) expect(['full', 'no_longer_available']).toContain(r.reason);
    expect(await counts()).toEqual({ reservations: 1, holds: 1, events: 1 });
  });

  // A booking that commits between our availability read and our insert,
  // made deterministic: a row the read cannot see (a status outside
  // HOLDS_TABLES) whose hold the constraint still can.
  async function invisibleHoldOn(tableId: string) {
    await prisma.reservation.create({
      data: {
        idempotencyKey: `race-${tableId}`, businessDay: DAY, startAt: at(19), partySize: 2, turnMinutes: 75,
        tableIds: [tableId], guestName: 'Racer', guestPhone: '+15035550199', status: 'cancelled',
        createdAt: NOW, statusChangedAt: NOW,
        holds: { create: [{ tableId, startAt: at(19), endAt: at(20, 15) }] },
      },
    });
  }

  it('maps 23P01 to `no_longer_available` and leaves no orphan reservation or hold', async () => {
    await floor([['T1', 2]]);
    await invisibleHoldOn('T1');
    expect(await placeReservation(request(), config())).toEqual({ ok: false, reason: 'no_longer_available' });
    expect(await counts()).toEqual({ reservations: 1, holds: 1, events: 0 });
  });

  it('falls through to the next fitting unit when the first is taken under it', async () => {
    await floor([['T1', 2], ['T2', 2]]);
    await invisibleHoldOn('T1');
    const res = await placeReservation(request(), config());
    if (!res.ok) throw new Error(res.reason);
    expect(res.reservation.tableIds).toEqual(['T2']);
    expect(await counts()).toEqual({ reservations: 2, holds: 2, events: 1 });
  });
});

describe('pacing under concurrency (P0-3 × P0-10)', () => {
  it('the bucket lock holds the cap: 5 simultaneous deuces, cap 4 covers, tables for all → exactly 2 booked', async () => {
    await floor([['T1', 2], ['T2', 2], ['T3', 2], ['T4', 2], ['T5', 2]]);
    const results = await Promise.all(Array.from({ length: 5 }, () => placeReservation(request(), config(4))));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok).map((r) => !r.ok && r.reason)).toEqual(['pacing', 'pacing', 'pacing']);
  });
});

describe('idempotency key (P0-3)', () => {
  it('a sequential double-submit returns the same body, not just no duplicate', async () => {
    await floor([['T1', 2], ['T2', 2]]);
    const first = await placeReservation(request({ idempotencyKey: 'dbl' }), config());
    const second = await placeReservation(request({ idempotencyKey: 'dbl' }), config());
    if (!first.ok || !second.ok) throw new Error('expected both ok');
    expect(second).toEqual({ ok: true, reservation: first.reservation, replayed: true });
    expect(await counts()).toEqual({ reservations: 1, holds: 1, events: 1 });
  });

  it('a concurrent double-submit: one reservation, every response carries it', async () => {
    await floor([['T1', 2], ['T2', 2], ['T3', 2]]);
    const results = await Promise.all(Array.from({ length: 4 }, () => placeReservation(request({ idempotencyKey: 'burst' }), config())));
    const ids = new Set(results.map((r) => (r.ok ? r.reservation.id : r.reason)));
    expect(ids.size).toBe(1);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await counts()).toEqual({ reservations: 1, holds: 1, events: 1 });
  });
});
