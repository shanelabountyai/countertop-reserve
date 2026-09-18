import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATES, segments, zonedTimeToInstant, type Schedule } from '@reserve/core';
import { prisma } from './index';
import { dispatchQueued, mockProvider, recordDelivery } from './messages';
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
  restaurant: 'Firebird Kitchen',
  manageBaseUrl: 'https://firebird.example/m',
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
        idempotencyKey: `race-${tableId}`, manageToken: `race-${tableId}`, businessDay: DAY, startAt: at(19), partySize: 2, turnMinutes: 75,
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

describe('confirmation text (P0-5)', () => {
  const booked = async (over: Partial<PlaceRequest> = {}, cfg = config()) => {
    const res = await placeReservation(request(over), cfg);
    if (!res.ok) throw new Error(res.reason);
    return res.reservation;
  };

  it('queues one rendered confirmation with the booking, linking a 128-bit token', async () => {
    await floor([['T1', 4]]);
    const r = await booked({ partySize: 3 });
    expect(r.manageToken).toMatch(/^[A-Za-z0-9_-]{22}$/); // 16 bytes base64url
    const msgs = await prisma.outboundMessage.findMany();
    expect(msgs).toEqual([
      expect.objectContaining({
        reservationId: r.id,
        kind: 'confirmation',
        toPhone: '+15035550100',
        status: 'queued',
        providerMessageId: null,
        body: `Firebird Kitchen: table for 3 on Fri, Oct 2 at 7:00 PM. Reply C to confirm, X to cancel, CHANGE to change. Manage: https://firebird.example/m/${r.manageToken}`,
      }),
    ]);
    expect(segments(msgs[0]!.body)).toBeLessThanOrEqual(2);
  });

  it('tokens are unique per reservation', async () => {
    await floor([['T1', 2], ['T2', 2]]);
    const [a, b] = [await booked(), await booked()];
    expect(a.manageToken).not.toBe(b.manageToken);
  });

  it('a replayed booking queues nothing more; a concurrent double-submit queues exactly one', async () => {
    await floor([['T1', 2], ['T2', 2]]);
    await booked({ idempotencyKey: 'dbl' });
    await booked({ idempotencyKey: 'dbl' });
    await Promise.all(Array.from({ length: 4 }, () => placeReservation(request({ idempotencyKey: 'burst' }), config())));
    expect(await prisma.outboundMessage.count()).toBe(2);
  });

  it('a refusal queues nothing', async () => {
    await floor([['T1', 2]]);
    await booked();
    expect((await placeReservation(request(), config())).ok).toBe(false);
    expect(await prisma.outboundMessage.count()).toBe(1);
  });

  it('a body too long to text rolls the booking back — no table held, nothing queued', async () => {
    await floor([['T1', 2]]);
    await expect(placeReservation(request(), { ...config(), restaurant: 'F'.repeat(200) })).rejects.toThrow(/segments/);
    expect(await counts()).toEqual({ reservations: 0, holds: 0, events: 0 });
    expect(await prisma.outboundMessage.count()).toBe(0);
  });

  it('the database refuses a second confirmation for the same reservation', async () => {
    await floor([['T1', 2]]);
    const r = await booked();
    await expect(
      prisma.outboundMessage.create({
        data: { reservationId: r.id, kind: 'confirmation', toPhone: r.guestPhone, body: 'again', status: 'queued', createdAt: NOW, statusChangedAt: NOW },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('snapshot: template, floor plan and turn edits after booking change nothing stored or sent', async () => {
    await floor([['T1', 2]]);
    const r = await booked();
    const before = { reservation: await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } }), message: await prisma.outboundMessage.findFirstOrThrow() };

    await prisma.diningTable.update({ where: { id: 'T1' }, data: { seats: 3, section: 'patio' } });
    const edited = { ...config(), restaurant: 'Firebird', turnBands: [{ upToParty: Infinity, minutes: 45 }], templates: { ...DEFAULT_TEMPLATES, confirmation: 'EDITED {date} {time} {link}' } };
    await booked({ startAt: at(20, 15) }, edited); // the edited config is live and in use

    expect(await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).toEqual(before.reservation);
    const { provider, sent } = mockProvider();
    await dispatchQueued(provider, NOW);
    expect(sent.find((m) => m.id === before.message.id)?.body).toBe(before.message.body);
    expect(sent.find((m) => m.id !== before.message.id)?.body).toMatch(/^EDITED /);
  });
});

describe('delivery state (P0-5)', () => {
  const LATER = zonedTimeToInstant(DAY, 12 * 60 + 1, TZ);

  it('queued → sent → delivered, with the provider id stored', async () => {
    await floor([['T1', 2]]);
    await placeReservation(request(), config());
    const { provider, sent } = mockProvider();
    const [m] = await dispatchQueued(provider, NOW);
    expect(m).toMatchObject({ status: 'sent', providerMessageId: sent[0]!.providerMessageId, statusChangedAt: NOW });
    expect(await recordDelivery(sent[0]!.providerMessageId, { status: 'delivered' }, LATER)).toBe(true);
    expect(await prisma.outboundMessage.findFirstOrThrow()).toMatchObject({ status: 'delivered', statusChangedAt: LATER });
  });

  it('a retried dispatch never texts the guest twice', async () => {
    await floor([['T1', 2]]);
    await placeReservation(request(), config());
    const { provider, sent } = mockProvider();
    await dispatchQueued(provider, NOW);
    await dispatchQueued(provider, NOW);
    expect(sent).toHaveLength(1);
  });

  it('concurrent dispatchers send each message exactly once', async () => {
    await floor([['T1', 2], ['T2', 2], ['T3', 2]]);
    for (const h of [17, 18, 19]) await placeReservation(request({ startAt: at(h) }), config());
    const { provider: fast, sent } = mockProvider();
    // A slow carrier, so every dispatcher has read the queue before any commits.
    const provider = { send: async (m: Parameters<typeof fast.send>[0]) => (await new Promise((r) => setTimeout(r, 50)), fast.send(m)) };
    await Promise.all(Array.from({ length: 4 }, () => dispatchQueued(provider, NOW)));
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((m) => m.id)).size).toBe(3);
  });

  it('a provider refusal is queued → failed, with the reason', async () => {
    await floor([['T1', 2]]);
    await placeReservation(request(), config());
    const { provider, sent } = mockProvider(new Set(['+15035550100']));
    await dispatchQueued(provider, NOW);
    expect(sent).toHaveLength(0);
    expect(await prisma.outboundMessage.findFirstOrThrow()).toMatchObject({ status: 'failed', failureReason: 'unreachable', providerMessageId: null });
  });

  it('sent → failed from the callback; a redelivered or late callback changes nothing', async () => {
    await floor([['T1', 2]]);
    await placeReservation(request(), config());
    const { provider, sent } = mockProvider();
    await dispatchQueued(provider, NOW);
    const id = sent[0]!.providerMessageId;
    expect(await recordDelivery(id, { status: 'failed', reason: 'carrier: 30006' }, LATER)).toBe(true);
    expect(await recordDelivery(id, { status: 'failed', reason: 'carrier: 30006' }, LATER)).toBe(false);
    expect(await recordDelivery(id, { status: 'delivered' }, LATER)).toBe(false);
    expect(await recordDelivery('mock-unknown', { status: 'delivered' }, LATER)).toBe(false);
    expect(await prisma.outboundMessage.findFirstOrThrow()).toMatchObject({ status: 'failed', failureReason: 'carrier: 30006' });
  });

  it('the database refuses a sent row without a provider id and a failed row without a reason', async () => {
    await floor([['T1', 2]]);
    await placeReservation(request(), config());
    await expect(prisma.outboundMessage.updateMany({ data: { status: 'sent' } })).rejects.toThrow(/outbound_sent_has_provider_id/);
    await expect(prisma.outboundMessage.updateMany({ data: { status: 'failed' } })).rejects.toThrow(/outbound_failed_has_reason/);
    await expect(prisma.outboundMessage.updateMany({ data: { status: 'bounced' } })).rejects.toThrow(/outbound_status_known/);
  });
});
