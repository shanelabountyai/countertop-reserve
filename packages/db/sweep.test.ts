import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SWEEP, zonedTimeToInstant, type Schedule } from '@reserve/core';
import { prisma } from './index';
import { mockProvider } from './messages';
import { placeReservation, type PlaceRequest, type PlacementConfig } from './placement';
import { sweep, type SweepConfig } from './sweep';
import { resetDatabase } from './testing/index';

// Friday 2026-10-02 19:00, Los Angeles, booked the Friday before: release at
// T-3h = 16:00, reminder at T-24h = Thursday 19:00. One two-top, so a second
// booking for 19:00 fits only once the first lets go of it.
const DAY = '2026-10-02';
const TZ = 'America/Los_Angeles';
const CONSENT = 'Text me about this reservation. Reply STOP to opt out.';
const at = (h: number, m = 0, day = DAY) => zonedTimeToInstant(day, h * 60 + m, TZ);
const BOOKED_AT = at(12, 0, '2026-09-25');
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
const config: SweepConfig = { restaurant: 'Firebird Kitchen', timezone: TZ, manageBaseUrl: 'https://firebird.example/m', bookUrl: 'https://firebird.example/book' };

let n = 0;
async function book(over: Partial<PlaceRequest> = {}) {
  const res = await placeReservation(
    { idempotencyKey: `key-${(n += 1)}`, day: DAY, startAt: at(19), partySize: 2, guestName: 'Dana Reyes', guestPhone: PHONE, source: 'guest_web', smsConsent: CONSENT, now: BOOKED_AT, ...over },
    placement,
  );
  if (!res.ok) throw new Error(res.reason);
  return res.reservation;
}
const get = (id: string) => prisma.reservation.findUniqueOrThrow({ where: { id }, include: { holds: true, messages: true, events: { orderBy: { id: 'asc' } } } });
const message = (id: string, kind: string) => prisma.outboundMessage.findUnique({ where: { reservationId_kind: { reservationId: id, kind } } });

beforeEach(async () => {
  await resetDatabase();
  await prisma.diningTable.createMany({ data: [{ id: 'T1', seats: 2, minParty: 1, section: 'main' }] });
});

describe('auto-release (P0-7)', () => {
  it('leaves the booking alone one minute before the deadline', async () => {
    const r = await book();
    expect((await sweep(mockProvider().provider, config, at(15, 59))).released).toEqual([]);
    expect((await get(r.id)).status).toBe('booked');
  });

  it('releases at the deadline: status, holds and a system event in one commit — and the table is bookable in the same session', async () => {
    const r = await book();
    expect((await sweep(mockProvider().provider, config, at(16))).released).toEqual([r.id]);
    const after = await get(r.id);
    expect(after.status).toBe('released');
    expect(after.holds).toEqual([]);
    expect(after.tableIds).toEqual(['T1']); // the snapshot stays for the host list
    expect(after.events.at(-1)).toMatchObject({ fromStatus: 'booked', toStatus: 'released', source: 'system' });

    const walkIn = await placeReservation(
      { idempotencyKey: 'walk-in', day: DAY, startAt: at(19), partySize: 2, guestName: 'Walk In', guestPhone: '+15035550111', source: 'host', now: at(16, 1) },
      placement,
    );
    expect(walkIn).toMatchObject({ ok: true, reservation: { tableIds: ['T1'] } });
  });

  it('never releases a guest who confirmed', async () => {
    const r = await book();
    await prisma.reservation.update({ where: { id: r.id }, data: { status: 'confirmed' } });
    expect((await sweep(mockProvider().provider, config, at(18))).released).toEqual([]);
  });

  it('a deadline of 0 disables auto-release', async () => {
    const r = await book();
    await sweep(mockProvider().provider, { ...config, policy: { ...DEFAULT_SWEEP, releaseLead: 0 } }, at(18));
    expect((await get(r.id)).status).toBe('booked');
  });

  it('two overlapping sweeps release once and notify once', async () => {
    const r = await book();
    const results = await Promise.all([sweep(mockProvider().provider, config, at(16)), sweep(mockProvider().provider, config, at(16))]);
    expect(results.flatMap((x) => x.released)).toEqual([r.id]);
    expect((await get(r.id)).events.filter((e) => e.toStatus === 'released')).toHaveLength(1);
    expect(await prisma.outboundMessage.count({ where: { kind: 'released' } })).toBe(1);
  });
});

describe('the release notice — a separate path from the release', () => {
  it('queues one notice with the re-book link and sends it; a later sweep sends nothing new', async () => {
    const r = await book();
    const { provider, sent } = mockProvider();
    await sweep(provider, config, at(16));
    const notice = await message(r.id, 'released');
    expect(notice).toMatchObject({ status: 'sent', toPhone: PHONE });
    expect(notice!.body).toBe("Firebird Kitchen: we released your Fri, Oct 2 7:00 PM table since we didn't hear back. Still want it? https://firebird.example/book");
    const count = sent.length;
    expect((await sweep(provider, config, at(16, 5))).notices).toBe(0);
    expect(sent).toHaveLength(count);
  });

  it('a number that texted STOP still loses the table on time, but gets no notice', async () => {
    const r = await book();
    await prisma.smsOptOut.create({ data: { phone: PHONE, at: BOOKED_AT } });
    await sweep(mockProvider().provider, config, at(16));
    expect((await get(r.id)).status).toBe('released');
    expect(await message(r.id, 'released')).toBeNull();
  });
});

describe('reminders (P0-5)', () => {
  it('one reminder at T-24h, never a second', async () => {
    const r = await book();
    const { provider, sent } = mockProvider();
    expect((await sweep(provider, config, at(18, 59, '2026-10-01'))).reminders).toBe(0);
    expect((await sweep(provider, config, at(19, 0, '2026-10-01'))).reminders).toBe(1);
    expect((await sweep(provider, config, at(12))).reminders).toBe(0);
    expect(sent.filter((m) => m.body.includes('reminder'))).toHaveLength(1);
    expect((await message(r.id, 'reminder'))!.body).toBe(
      `Firebird Kitchen: reminder, 2 on Fri, Oct 2 at 7:00 PM. Reply C to confirm, X if plans changed. https://firebird.example/m/${r.manageToken}`,
    );
  });

  it('the sweep also dispatches what placement queued — the confirmation goes out', async () => {
    const r = await book();
    const { provider, sent } = mockProvider();
    expect((await sweep(provider, config, BOOKED_AT)).sent).toBe(1);
    expect(await message(r.id, 'confirmation')).toMatchObject({ status: 'sent' });
    expect(sent[0]!.to).toBe(PHONE);
  });
});

describe('consent and quiet hours (P0-8)', () => {
  it('stores the consent wording verbatim; a booking without it gets no text, and still releases on time', async () => {
    const consented = await book();
    expect(consented.smsConsent).toBe(CONSENT);
    await prisma.diningTable.create({ data: { id: 'T2', seats: 2, minParty: 1, section: 'main' } });
    const silent = await book({ smsConsent: undefined, guestPhone: '+15035550122' });
    await sweep(mockProvider().provider, config, at(16));
    expect((await get(silent.id)).status).toBe('released');
    expect((await get(silent.id)).messages).toEqual([]);
  });

  // Released at 20:00 the evening before, so the notice lands around 21:00.
  const early = { ...config, policy: { ...DEFAULT_SWEEP, releaseLead: 23 * 60 } };

  it('20:59: releases and sends the notice', async () => {
    const r = await book();
    await sweep(mockProvider().provider, early, BOOKED_AT); // the confirmation goes out first
    await sweep(mockProvider().provider, early, at(20, 59, '2026-10-01'));
    expect(await message(r.id, 'released')).toMatchObject({ status: 'sent' });
  });

  it('21:00: releases on time — the table is free now — but holds the notice to 09:00', async () => {
    const r = await book();
    await sweep(mockProvider().provider, early, BOOKED_AT);
    const { provider, sent } = mockProvider();
    expect((await sweep(provider, early, at(21, 0, '2026-10-01'))).released).toEqual([r.id]);
    expect((await get(r.id)).holds).toEqual([]);
    expect(await message(r.id, 'released')).toMatchObject({ status: 'queued' });
    await sweep(provider, early, at(8, 59));
    expect(sent).toEqual([]);
    await sweep(provider, early, at(9));
    expect(await message(r.id, 'released')).toMatchObject({ status: 'sent', statusChangedAt: at(9) });
  });

  it('a STOP after the reminder was queued: the reminder is dropped at send time, and logged', async () => {
    const r = await book();
    await sweep(mockProvider().provider, config, BOOKED_AT);
    await sweep(mockProvider().provider, config, at(21, 30, '2026-10-01')); // T-24h reminder queued, then deferred
    expect(await message(r.id, 'reminder')).toMatchObject({ status: 'queued' });
    await prisma.smsOptOut.create({ data: { phone: PHONE, at: at(22, 0, '2026-10-01') } });
    const { provider, sent } = mockProvider();
    await sweep(provider, config, at(9));
    expect(sent).toEqual([]);
    expect(await message(r.id, 'reminder')).toMatchObject({ status: 'failed', failureReason: 'opted_out' });
  });
});
