import { beforeEach, describe, expect, it } from 'vitest';
import { plusMs, zonedTimeToInstant, type Schedule } from '@reserve/core';
import { prisma } from './index';
import { handleInbound, parseInboundPayload, signBody, verifySignature, type InboundConfig } from './inbound';
import { dispatchQueued, mockProvider } from './messages';
import { changeReservation, placeReservation, type PlaceRequest, type PlacementConfig } from './placement';
import { resetDatabase, seedSchedule } from './testing/index';

// Friday 2026-10-02, America/Los_Angeles. Dinner 17:00–22:00, `now` = noon.
const DAY = '2026-10-02';
const TZ = 'America/Los_Angeles';
const CONSENT = 'Text me about this reservation. Reply STOP to opt out.';
const NOW = zonedTimeToInstant(DAY, 12 * 60, TZ);
const at = (h: number, m = 0, day = DAY) => zonedTimeToInstant(day, h * 60 + m, TZ);
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
const inbound: InboundConfig = {
  restaurant: 'Firebird Kitchen',
  timezone: TZ,
  phone: '+15035550199',
  manageBaseUrl: 'https://firebird.example/m',
  bookUrl: 'https://firebird.example/book',
};

let n = 0;
async function book(over: Partial<PlaceRequest> = {}) {
  const res = await placeReservation(
    { idempotencyKey: `key-${(n += 1)}`, day: DAY, startAt: at(19), partySize: 2, guestName: 'Dana Reyes', guestPhone: PHONE, source: 'guest_web', smsConsent: CONSENT, now: NOW, ...over },
    placement,
  );
  if (!res.ok) throw new Error(res.reason);
  return res.reservation;
}
let m = 0;
const text = (body: string, over: { id?: string; from?: string; now?: Date } = {}) =>
  handleInbound({ providerMessageId: over.id ?? `SM${(m += 1)}`, from: over.from ?? PHONE, body }, inbound, over.now ?? NOW);
const status = async (id: string) => (await prisma.reservation.findUniqueOrThrow({ where: { id } })).status;
const replies = () => prisma.outboundMessage.findMany({ where: { inboundMessageId: { not: null } }, orderBy: { createdAt: 'asc' } });

beforeEach(async () => {
  await resetDatabase();
  await seedSchedule(placement.schedule);
  await prisma.diningTable.createMany({ data: [{ id: 'T1', seats: 2, minParty: 1, section: 'main' }] });
});

describe('the webhook boundary', () => {
  const raw = JSON.stringify({ providerMessageId: 'SM1', from: PHONE, body: 'C' });

  it('accepts only the exact signature, in constant time', () => {
    const sig = signBody(raw, 'secret');
    expect(verifySignature(raw, sig, 'secret')).toBe(true);
    expect(verifySignature(raw, sig, 'other-secret')).toBe(false);
    expect(verifySignature(raw.replace('"C"', '"X"'), sig, 'secret')).toBe(false); // tampered body
    expect(verifySignature(raw, sig.slice(1), 'secret')).toBe(false); // wrong length must not throw
    expect(verifySignature(raw, null, 'secret')).toBe(false);
  });

  it.each([
    ['not json', '{'],
    ['not an object', '"C"'],
    ['missing id', JSON.stringify({ from: PHONE, body: 'C' })],
    ['id with odd characters', JSON.stringify({ providerMessageId: 'SM1; DROP', from: PHONE, body: 'C' })],
    ['from not E.164', JSON.stringify({ providerMessageId: 'SM1', from: '503-555-0100', body: 'C' })],
    ['body not a string', JSON.stringify({ providerMessageId: 'SM1', from: PHONE, body: { $ne: '' } })],
  ])('rejects a payload with %s', (_, payload) => expect(parseInboundPayload(payload)).toBeNull());

  it('parses a well-formed payload', () => {
    expect(parseInboundPayload(raw)).toEqual({ providerMessageId: 'SM1', from: PHONE, body: 'C' });
  });
});

describe('confirm and cancel by reply (P0-6)', () => {
  it('C confirms: the transition, its sms event, the inbound row and the rendered reply commit together', async () => {
    const r = await book();
    expect(await text('  yes! ', { id: 'SM-c' })).toEqual({
      replayed: false,
      outcome: 'confirmed',
      reply: 'Confirmed - 2 on Fri, Oct 2 at 7:00 PM. See you then. Reply X to cancel or CHANGE to reschedule.',
    });
    expect(await status(r.id)).toBe('confirmed');
    const row = await prisma.inboundMessage.findUniqueOrThrow({ where: { providerMessageId: 'SM-c' } });
    expect(row).toMatchObject({ fromPhone: PHONE, body: '  yes! ', outcome: 'confirmed', reservationId: r.id });
    expect(await prisma.reservationEvent.findMany({ where: { source: 'sms' } })).toMatchObject([
      { reservationId: r.id, fromStatus: 'booked', toStatus: 'confirmed', inboundMessageId: row.id },
    ]);
    expect(await replies()).toMatchObject([{ inboundMessageId: row.id, reservationId: null, kind: 'confirmed', toPhone: PHONE, status: 'queued' }]);
  });

  it('a second C is answered again and logs no second transition', async () => {
    const r = await book();
    await text('C');
    expect(await text('C')).toMatchObject({ outcome: 'confirmed', reply: expect.stringMatching(/^Confirmed/) });
    expect(await prisma.reservationEvent.count({ where: { reservationId: r.id, source: 'sms' } })).toBe(1);
  });

  it('X cancels and the table is real inventory the instant it commits', async () => {
    const r = await book();
    expect(await text('cancel')).toMatchObject({ outcome: 'cancelled', reply: 'Cancelled - Fri, Oct 2 at 7:00 PM. Thanks for letting us know. Book again anytime: https://firebird.example/book' });
    expect(await status(r.id)).toBe('cancelled');
    expect(await prisma.tableHold.count()).toBe(0);
    expect((await book({ guestPhone: '+15035550111' })).tableIds).toEqual(['T1']);
  });

  it('a reservation that has already started is not upcoming — the fallback, not a late cancel', async () => {
    const r = await book();
    expect(await text('X', { now: at(19) })).toMatchObject({ outcome: 'no_reservation' });
    expect(await status(r.id)).toBe('booked');
  });
});

describe('idempotent on the provider message id (P0-6)', () => {
  it('a redelivered webhook returns the first answer and causes exactly one transition', async () => {
    const r = await book();
    const first = await text('X', { id: 'SM-dup' });
    const again = await text('X', { id: 'SM-dup' });
    expect(again).toEqual({ ...first, replayed: true });
    expect(await status(r.id)).toBe('cancelled');
    expect(await prisma.inboundMessage.count()).toBe(1);
    expect(await prisma.reservationEvent.count({ where: { source: 'sms' } })).toBe(1);
    expect(await replies()).toHaveLength(1);
  });

  it('eight concurrent deliveries of one message: one row, one transition, one reply', async () => {
    const r = await book();
    const results = await Promise.all(Array.from({ length: 8 }, () => text('C', { id: 'SM-burst' })));
    expect(results.filter((x) => !x.replayed)).toHaveLength(1);
    expect(new Set(results.map((x) => x.reply)).size).toBe(1);
    expect(await status(r.id)).toBe('confirmed');
    expect(await prisma.inboundMessage.count()).toBe(1);
    expect(await prisma.reservationEvent.count({ where: { source: 'sms' } })).toBe(1);
    expect(await replies()).toHaveLength(1);
  });

  it('a redelivery after the state moved on still replays — it is not re-parsed against today', async () => {
    const r = await book();
    await text('C', { id: 'SM-old' });
    await text('X');
    expect(await text('C', { id: 'SM-old' })).toMatchObject({ replayed: true, outcome: 'confirmed' });
    expect(await status(r.id)).toBe('cancelled');
  });
});

describe('which reservation (P0-6)', () => {
  it('two upcoming: numbered choices, never a guess; the number selects silently; X then cancels only that one', async () => {
    await prisma.diningTable.create({ data: { id: 'T2', seats: 2, minParty: 1, section: 'main' } });
    const fri = await book();
    const sat = await book({ day: '2026-10-03', startAt: at(20, 30, '2026-10-03') });
    expect(await text('X')).toMatchObject({
      outcome: 'choose',
      reply: 'You have 2 upcoming: 1) Fri, Oct 2 7:00 PM, 2) Sat, Oct 3 8:30 PM. Reply with the number, then C or X.',
    });
    expect([await status(fri.id), await status(sat.id)]).toEqual(['booked', 'booked']);
    expect(await text('2', { now: plusMs(NOW, 60_000) })).toEqual({ replayed: false, outcome: 'selected', reply: null });
    expect(await text('X', { now: plusMs(NOW, 90_000) })).toMatchObject({ outcome: 'cancelled', reply: expect.stringContaining('Sat, Oct 3') });
    expect([await status(fri.id), await status(sat.id)]).toEqual(['booked', 'cancelled']);
  });

  it('no upcoming reservation: the polite fallback with the booking link', async () => {
    expect(await text('C', { from: '+15035550177' })).toMatchObject({
      outcome: 'no_reservation',
      reply: "We don't see an upcoming reservation for this number. Book here: https://firebird.example/book",
    });
  });

  it('CHANGE replies with the manage link and moves nothing', async () => {
    const r = await book();
    expect(await text('Change')).toMatchObject({ outcome: 'change_link', reply: expect.stringContaining(`https://firebird.example/m/${r.manageToken}`) });
    expect(await status(r.id)).toBe('booked');
    expect(await prisma.reservationEvent.count({ where: { source: 'sms' } })).toBe(0);
  });

  it('one clarifying reply for an unrecognised body, then a handoff to the host with no bot reply', async () => {
    await book();
    expect(await text('can we do 8ish?')).toMatchObject({ outcome: 'unrecognised', reply: expect.stringMatching(/^Sorry/) });
    expect(await text('8 please')).toEqual({ replayed: false, outcome: 'handoff', reply: null });
    expect(await replies()).toHaveLength(1);
    expect((await prisma.inboundMessage.findMany({ where: { outcome: 'handoff' } })).map((i) => i.body)).toEqual(['8 please']);
  });
});

describe('STOP (P0-6 / P0-8)', () => {
  it('opts out before anything else, acknowledges once, then silence — and the reservation stands', async () => {
    const r = await book();
    expect(await text('Stop')).toMatchObject({ outcome: 'opted_out', reply: expect.stringContaining('+15035550199') });
    expect(await prisma.smsOptOut.findUnique({ where: { phone: PHONE } })).not.toBeNull();
    expect(await status(r.id)).toBe('booked');
    expect(await text('STOP')).toMatchObject({ outcome: 'opted_out', reply: null });
    // A confirm still confirms — opting out of texts is not opting out of the table — but nothing is texted back.
    expect(await text('C')).toMatchObject({ outcome: 'confirmed', reply: null });
    expect(await status(r.id)).toBe('confirmed');
    expect((await replies()).map((x) => x.kind)).toEqual(['opted_out']);
  });

  it('START opts back in and is answered with HELP', async () => {
    await text('STOP');
    expect(await text('start')).toMatchObject({ outcome: 'opted_in', reply: expect.stringMatching(/^Firebird Kitchen reservations/) });
    expect(await prisma.smsOptOut.count()).toBe(0);
  });
});

describe('the inbound log is evidence', () => {
  it('stores a hostile body verbatim (NUL stripped, capped at 1600) and never acts on it', async () => {
    const r = await book();
    const body = ` '); DELETE FROM "Reservation"; --${'x'.repeat(2000)}`;
    expect(await text(body)).toMatchObject({ outcome: 'unrecognised' });
    const row = await prisma.inboundMessage.findFirstOrThrow();
    expect([...row.body]).toHaveLength(1600);
    expect(row.body.startsWith(`'); DELETE`)).toBe(true);
    expect(await status(r.id)).toBe('booked');
  });

  it('is append-only, and a message has exactly one owner', async () => {
    await text('HELP');
    await expect(prisma.inboundMessage.updateMany({ data: { outcome: 'handoff' } })).rejects.toThrow(/append-only/);
    await expect(prisma.inboundMessage.deleteMany()).rejects.toThrow(/append-only/);
    await expect(
      prisma.outboundMessage.create({ data: { kind: 'help', toPhone: PHONE, body: 'x', status: 'queued', createdAt: NOW, statusChangedAt: NOW } }),
    ).rejects.toThrow(/outbound_one_owner/);
  });
});

describe('a change is a re-allocation (P0-6)', () => {
  const change = (id: string, over: { startAt?: Date; partySize?: number; now?: Date } = {}) =>
    changeReservation({ reservationId: id, day: DAY, startAt: at(19), partySize: 2, source: 'guest_web', now: NOW, ...over }, placement);

  it('moves the holds and the snapshot together, keeps the status, logs the change', async () => {
    const r = await book();
    await text('C');
    const res = await change(r.id, { startAt: at(20, 30) });
    expect(res).toMatchObject({ ok: true, reservation: { startAt: at(20, 30), status: 'confirmed', tableIds: ['T1'] } });
    expect(await prisma.tableHold.findMany()).toEqual([{ reservationId: r.id, tableId: 'T1', startAt: at(20, 30), endAt: at(21, 45) }]);
    expect(await prisma.reservationEvent.findFirst({ where: { reservationId: r.id, note: { startsWith: 'changed' } } })).toMatchObject({
      fromStatus: 'confirmed', toStatus: 'confirmed', source: 'guest_web',
    });
  });

  it('can slide 15 minutes on its own table — it does not collide with the booking it replaces', async () => {
    const r = await book();
    expect(await change(r.id, { startAt: at(19, 15) })).toMatchObject({ ok: true, reservation: { tableIds: ['T1'] } });
  });

  it('an unavailable time leaves the original byte-for-byte intact', async () => {
    const r = await book();
    await book({ startAt: at(20, 30), guestPhone: '+15035550111' });
    const before = { r: await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } }), holds: await prisma.tableHold.findMany({ orderBy: { startAt: 'asc' } }) };
    expect(await change(r.id, { startAt: at(20, 30) })).toEqual({ ok: false, reason: 'full' });
    expect(await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).toEqual(before.r);
    expect(await prisma.tableHold.findMany({ orderBy: { startAt: 'asc' } })).toEqual(before.holds);
  });

  it('refused by the constraint, not the engine (a hold the read did not see): the old holds come back with the rollback', async () => {
    const r = await book({ startAt: at(17) });
    // A hold the engine cannot see — its reservation is cancelled — stands in for one committed from another bucket mid-change.
    await prisma.reservation.create({
      data: {
        idempotencyKey: 'racer', manageToken: 'racer', businessDay: DAY, startAt: at(20, 30), partySize: 2, turnMinutes: 75,
        tableIds: ['T1'], guestName: 'Racer', guestPhone: '+15035550155', status: 'cancelled', createdAt: NOW, statusChangedAt: NOW,
        holds: { create: [{ tableId: 'T1', startAt: at(20, 30), endAt: at(21, 45) }] },
      },
    });
    expect(await change(r.id, { startAt: at(20, 30) })).toEqual({ ok: false, reason: 'no_longer_available' });
    expect(await prisma.tableHold.findMany({ where: { reservationId: r.id } })).toEqual([
      { reservationId: r.id, tableId: 'T1', startAt: at(17), endAt: at(18, 15) },
    ]);
    expect(await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ startAt: at(17) });
  });

  it('a party size that no longer fits is refused, not half-applied', async () => {
    const r = await book();
    expect(await change(r.id, { partySize: 6 })).toEqual({ ok: false, reason: 'too_large' });
    expect(await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ partySize: 2, startAt: at(19) });
    expect(await prisma.tableHold.count({ where: { reservationId: r.id } })).toBe(1);
  });

  it('a cancelled or already-started reservation cannot be changed', async () => {
    const r = await book();
    expect(await change(r.id, { startAt: at(20), now: at(19) })).toEqual({ ok: false, reason: 'not_changeable' });
    await text('X');
    expect(await change(r.id, { startAt: at(20) })).toEqual({ ok: false, reason: 'not_changeable' });
  });

  it('a change racing a new booking for the last free table at 19:00: exactly one wins, and a losing change keeps its table', async () => {
    await prisma.diningTable.create({ data: { id: 'T2', seats: 2, minParty: 1, section: 'main' } });
    const r = await book({ startAt: at(17) });
    await book({ startAt: at(19), guestPhone: '+15035550111' }); // one table left at 19:00
    const [moved, fresh] = await Promise.all([
      change(r.id, { startAt: at(19) }),
      placeReservation({ idempotencyKey: 'race', day: DAY, startAt: at(19), partySize: 2, guestName: 'Lee', guestPhone: '+15035550144', source: 'guest_web', now: NOW }, placement),
    ]);
    expect([moved.ok, fresh.ok].filter(Boolean)).toHaveLength(1);
    const holds = await prisma.tableHold.findMany({ where: { reservationId: r.id } });
    expect(holds).toHaveLength(1);
    expect(holds[0]!.startAt).toEqual(moved.ok ? at(19) : at(17));
  });
});

describe('send-time compliance (P0-8)', () => {
  const dispatch = (now = NOW) => {
    const { provider, sent } = mockProvider();
    return dispatchQueued(provider, now, { timezone: TZ }).then(() => sent);
  };
  const byKind = async () => Object.fromEntries((await prisma.outboundMessage.findMany()).map((m) => [m.kind, m]));

  it('STOP: everything already queued, owned or reply, is dropped at send time — only the acknowledgement goes', async () => {
    await book(); // confirmation queued
    await text('C'); // `confirmed` reply queued
    await text('STOP');
    const sent = await dispatch();
    expect(sent.map((m) => m.body)).toEqual([expect.stringMatching(/opted out/)]);
    const k = await byKind();
    expect(k.confirmation).toMatchObject({ status: 'failed', failureReason: 'opted_out' });
    expect(k.confirmed).toMatchObject({ status: 'failed', failureReason: 'opted_out' });
    expect(await status((await prisma.reservation.findFirstOrThrow()).id)).toBe('confirmed'); // opting out is not cancelling
  });

  it('a reply to a text at 23:00 is not held for quiet hours — the guest just wrote to us', async () => {
    await text('HELP', { now: at(23) });
    expect(await dispatch(at(23))).toHaveLength(1);
  });

  it('the sixth text of the day to one number is dropped and logged; STOP is still acknowledged', async () => {
    for (let i = 0; i < 6; i += 1) await text('HELP');
    expect(await dispatch()).toHaveLength(5);
    expect(await prisma.outboundMessage.findMany({ where: { status: 'failed' } })).toEqual([
      expect.objectContaining({ kind: 'help', failureReason: 'rate_limited' }),
    ]);
    await text('STOP');
    expect((await dispatch()).map((m) => m.body)).toEqual([expect.stringMatching(/opted out/)]);
  });

  it('the limit is per restaurant day: a new day, a new five', async () => {
    for (let i = 0; i < 5; i += 1) await text('HELP');
    await dispatch();
    await text('HELP', { now: at(9, 0, '2026-10-03') });
    expect(await dispatch(at(9, 0, '2026-10-03'))).toHaveLength(1);
  });
});
