import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATES, zonedTimeToInstant, type Schedule } from '@reserve/core';
import { dayAvailability, guestCancel, guestChange, guestConfirm, guestDayAvailability, loadManage, type GuestConfig } from './guest';
import { prisma } from './index';
import { placeReservation, type PlaceRequest } from './placement';
import { resetDatabase, seedSchedule } from './testing/index';

// Friday 2026-10-02, America/Los_Angeles. Dinner 17:00–21:00, `now` = noon.
const DAY = '2026-10-02';
const NEXT_DAY = '2026-10-03';
const TZ = 'America/Los_Angeles';
const CONSENT = 'Text me about this reservation. Reply STOP to opt out.';
const NOW = zonedTimeToInstant(DAY, 12 * 60, TZ);
// The guest comes back half an hour later: a later instant than the booking,
// so the messages have a real order rather than a uuid tie-break.
const LATER = zonedTimeToInstant(DAY, 12 * 60 + 30, TZ);
const at = (h: number, m = 0, day = DAY) => zonedTimeToInstant(day, h * 60 + m, TZ);

const config = (pacingCap = 40): GuestConfig => ({
  schedule: {
    timezone: TZ,
    weekly: Array.from({ length: 7 }, () => [{ name: 'dinner', openMinute: 17 * 60, closeMinute: 21 * 60, pacingCap }]),
    overrides: {},
    blackouts: [],
  } satisfies Schedule,
  overSeatCap: 2,
  restaurant: 'Firebird Kitchen',
  manageBaseUrl: 'https://firebird.example/m',
  bookUrl: 'https://firebird.example/book',
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
  smsConsent: CONSENT,
  now: NOW,
  ...over,
});

/** The tables AND the hours: `fit` reads both from the database now. */
async function floor(tables: [id: string, seats: number, minParty?: number][], pacingCap = 40) {
  await seedSchedule(config(pacingCap).schedule);
  await prisma.diningTable.createMany({ data: tables.map(([id, seats, minParty = 1]) => ({ id, seats, minParty, section: 'main' })) });
}

/** Books, and hands back the token a guest would be texted. */
async function booked(over: Partial<PlaceRequest> = {}) {
  const r = await placeReservation(request(over), config());
  if (!r.ok) throw new Error(`fixture failed to book: ${r.reason}`);
  return r.reservation;
}

const texts = (id: string) => prisma.outboundMessage.findMany({ where: { reservationId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const kinds = async (id: string) => (await texts(id)).map((m) => m.kind);
const events = (id: string) => prisma.reservationEvent.findMany({ where: { reservationId: id }, orderBy: { id: 'asc' } });
const holds = (id: string) => prisma.tableHold.findMany({ where: { reservationId: id }, orderBy: { tableId: 'asc' } });

beforeEach(resetDatabase);

describe('dayAvailability (P0-12)', () => {
  it('shows every unavailable time WITH its reason rather than hiding it', async () => {
    await floor([['T1', 2]]);
    await booked({ startAt: at(19) });

    const a = await dayAvailability({ day: DAY, partySize: 2, now: NOW }, config());
    const taken = a.slots.filter((s) => !s.bookable && s.reason === 'full').map((s) => s.minute);
    // A 2-top turn is 90 minutes, so 19:00 blocks 17:30 through 20:15 inclusive.
    expect(taken).toContain(19 * 60);
    expect(taken).toContain(18 * 60);
    expect(a.slots.some((s) => s.bookable)).toBe(true);
    // Nothing is dropped from the list: the guest sees the whole service.
    expect(a.slots).toHaveLength((21 - 17) * 4);
  });

  it('a party no table can hold comes back with the reason and no slots at all', async () => {
    await floor([['T1', 2]]);
    expect(await dayAvailability({ day: DAY, partySize: 9, now: NOW }, config())).toEqual({ slots: [], reason: 'too_large' });
  });

  it('reads the schedule it is given, so a blackout reaches the guest flow', async () => {
    await floor([['T1', 2]]);
    const shut = { ...config(), schedule: { ...config().schedule, blackouts: [DAY] } };
    expect(await dayAvailability({ day: DAY, partySize: 2, now: NOW }, shut)).toEqual({ slots: [], reason: 'closed' });
  });
});

describe('loadManage (P0-12)', () => {
  it('a token that is not one we could have minted never reaches the database', async () => {
    expect(await loadManage('../../etc/passwd', NOW)).toBeNull();
    expect(await loadManage("' OR 1=1 --", NOW)).toBeNull();
    expect(await loadManage('AAAAAAAAAAAAAAAAAAAAAA', NOW)).toBeNull();
  });

  it('shows the live reservation and the NEWEST text, which a change supersedes', async () => {
    await floor([['T1', 2], ['T2', 2]]);
    const r = await booked();
    const first = await loadManage(r.manageToken, NOW);
    expect(first).toMatchObject({ status: 'booked', partySize: 2, guestName: 'Dana Reyes', texts: true, actionable: true });
    expect(first?.latestMessage?.kind).toBe('confirmation');

    await guestChange(r.manageToken, { day: DAY, startAt: at(19, 30), partySize: 2, now: LATER }, config());
    const after = await loadManage(r.manageToken, NOW);
    // Superseded by being older, not by being deleted: both rows are still the log.
    expect(after?.latestMessage?.kind).toBe('change_confirmed');
    expect(after?.startAt).toEqual(at(19, 30));
    expect(await kinds(r.id)).toEqual(['confirmation', 'change_confirmed']);
  });

  it('a reservation the guest can no longer act on says so', async () => {
    await floor([['T1', 2]]);
    const r = await booked();
    // At the seating, `transition` refuses a guest cancel as `too_late`.
    expect((await loadManage(r.manageToken, at(19)))?.actionable).toBe(false);
  });
});

describe('guestChange — a change is a re-allocation (P0-6, P0-12)', () => {
  it('moves the holds with the reservation and texts the new details', async () => {
    await floor([['T1', 2]]);
    const r = await booked({ startAt: at(19) });

    const result = await guestChange(r.manageToken, { day: DAY, startAt: at(17, 30), partySize: 2, now: LATER }, config());
    expect(result).toMatchObject({ ok: true, changed: true });

    const [hold] = await holds(r.id);
    expect(hold?.startAt).toEqual(at(17, 30));
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).startAt).toEqual(at(17, 30));

    const [, a5] = await texts(r.id);
    expect(a5?.kind).toBe('change_confirmed');
    expect(a5?.body).toContain('5:30 PM');
    // {was}: same day, so the time alone.
    expect(a5?.body).toContain('previous 7:00 PM booking');
  });

  it('a change into a size that no longer fits leaves the ORIGINAL intact, and says so', async () => {
    await floor([['T1', 2]]);
    const r = await booked({ partySize: 2 });

    const result = await guestChange(r.manageToken, { day: DAY, startAt: at(19), partySize: 6, now: LATER }, config());
    expect(result).toEqual({ ok: false, reason: 'too_large' });

    const after = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } });
    expect(after).toMatchObject({ partySize: 2, startAt: at(19), status: 'booked' });
    expect(await holds(r.id)).toHaveLength(1);
    const [, a6] = await texts(r.id);
    expect(a6?.kind).toBe('change_failed');
    expect(a6?.body).toContain("isn't available for 6");
    expect(a6?.body).toContain('Your 7:00 PM booking is unchanged');
  });

  it('a guest-driven change COUNTS AS that guest’s confirmation (V-008)', async () => {
    await floor([['T1', 2]]);
    const r = await booked({ startAt: at(19) });
    expect(r.status).toBe('booked');

    await guestChange(r.manageToken, { day: DAY, startAt: at(19, 30), partySize: 2, now: LATER }, config());

    // Otherwise the deadline sweep judges the new time against the ORIGINAL
    // createdAt and releases the table out from under the change just made.
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('confirmed');
    // Two facts, two rows: the guest moved, and the guest confirmed.
    expect((await events(r.id)).map((e) => [e.fromStatus, e.toStatus, e.source])).toEqual([
      [null, 'booked', 'guest_web'],
      ['booked', 'booked', 'guest_web'],
      ['booked', 'confirmed', 'guest_web'],
    ]);
  });

  it('a confirmed guest who moves stays confirmed, and a host-driven change confirms nothing', async () => {
    await floor([['T1', 2], ['T2', 2]]);
    const r = await booked({ startAt: at(19) });
    await prisma.reservation.update({ where: { id: r.id }, data: { status: 'confirmed' } });

    await guestChange(r.manageToken, { day: DAY, startAt: at(19, 30), partySize: 2, now: LATER }, config());
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('confirmed');

    const host = await booked({ startAt: at(17, 30), idempotencyKey: 'host-row' });
    const { changeReservation } = await import('./placement');
    await changeReservation({ reservationId: host.id, day: DAY, startAt: at(18), partySize: 2, source: 'host', now: NOW }, config());
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: host.id } })).status).toBe('booked');
  });

  it('carries the date in {was} when the guest moved days — "your previous 7:00 booking" would be a lie', async () => {
    await floor([['T1', 2]]);
    const r = await booked({ startAt: at(19) });

    await guestChange(r.manageToken, { day: NEXT_DAY, startAt: at(19, 0, NEXT_DAY), partySize: 2, now: LATER }, config());
    const [, a5] = await texts(r.id);
    expect(a5?.body).toMatch(/previous Fri, Oct 2 7:00 PM booking/);
  });

  it('a double-submitted form changes nothing, logs nothing and texts nothing', async () => {
    await floor([['T1', 2]]);
    const r = await booked({ startAt: at(19) });
    const before = await events(r.id);

    const result = await guestChange(r.manageToken, { day: DAY, startAt: at(19), partySize: 2, now: LATER }, config());
    expect(result).toMatchObject({ ok: true, changed: false });
    expect(await events(r.id)).toHaveLength(before.length);
    expect(await kinds(r.id)).toEqual(['confirmation']);
  });

  it('a guest who moves twice gets two change texts — the unique index is partial for a reason', async () => {
    await floor([['T1', 2]]);
    const r = await booked({ startAt: at(19) });
    await guestChange(r.manageToken, { day: DAY, startAt: at(19, 30), partySize: 2, now: LATER }, config());
    await guestChange(r.manageToken, { day: DAY, startAt: at(18), partySize: 2, now: LATER }, config());
    expect(await kinds(r.id)).toEqual(['confirmation', 'change_confirmed', 'change_confirmed']);
  });

  it('refuses a cancelled reservation without texting about it', async () => {
    await floor([['T1', 2]]);
    const r = await booked();
    await guestCancel(r.manageToken, LATER, config());

    expect(await guestChange(r.manageToken, { day: DAY, startAt: at(19, 30), partySize: 2, now: LATER }, config())).toEqual({
      ok: false,
      reason: 'not_changeable',
    });
    expect(await kinds(r.id)).toEqual(['confirmation', 'cancelled']);
  });

  it('an unknown token changes nothing', async () => {
    await floor([['T1', 2]]);
    await booked();
    expect(await guestChange('AAAAAAAAAAAAAAAAAAAAAA', { day: DAY, startAt: at(19, 30), partySize: 2, now: LATER }, config())).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await prisma.outboundMessage.count()).toBe(1);
  });

  it('no consent, no text — the change still happens', async () => {
    await floor([['T1', 2]]);
    const r = await booked({ smsConsent: undefined });
    const result = await guestChange(r.manageToken, { day: DAY, startAt: at(19, 30), partySize: 2, now: LATER }, config());
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(await prisma.outboundMessage.count()).toBe(0);
  });
});

describe('guestCancel (P0-12)', () => {
  it('releases the table into real inventory in the same transaction as the event', async () => {
    await floor([['T1', 2]]);
    const r = await booked({ startAt: at(19) });

    expect(await guestCancel(r.manageToken, LATER, config())).toEqual({ ok: true, status: 'cancelled' });
    expect(await holds(r.id)).toEqual([]);
    expect((await events(r.id)).at(-1)).toMatchObject({ fromStatus: 'booked', toStatus: 'cancelled', source: 'guest_web' });

    // The one table is inventory again, this instant — not after a sweep.
    const walkUp = await placeReservation(request({ startAt: at(19), idempotencyKey: 'after-cancel' }), config());
    expect(walkUp.ok).toBe(true);
  });

  it('texts the cancellation with a way back', async () => {
    await floor([['T1', 2]]);
    const r = await booked({ startAt: at(19) });
    await guestCancel(r.manageToken, LATER, config());
    const [, a7] = await texts(r.id);
    expect(a7?.kind).toBe('cancelled');
    expect(a7?.body).toContain('https://firebird.example/book');
  });

  it('refuses at the seating, and a second cancel is a no-op the lifecycle module names', async () => {
    await floor([['T1', 2]]);
    const r = await booked({ startAt: at(19) });
    expect(await guestCancel(r.manageToken, at(19), config())).toEqual({ ok: false, reason: 'too_late' });

    await guestCancel(r.manageToken, LATER, config());
    expect(await guestCancel(r.manageToken, LATER, config())).toEqual({ ok: false, reason: 'no_change' });
    expect(await kinds(r.id)).toEqual(['confirmation', 'cancelled']);
  });

  it('a malformed or unknown token cancels nothing', async () => {
    await floor([['T1', 2]]);
    const r = await booked();
    expect(await guestCancel('nope', NOW, config())).toEqual({ ok: false, reason: 'not_found' });
    expect(await guestCancel('BBBBBBBBBBBBBBBBBBBBBB', NOW, config())).toEqual({ ok: false, reason: 'not_found' });
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('booked');
  });
});

// The picker and the change must agree. `changeReservation` already excluded
// the reservation being replaced (`fit`'s `except`); the picker did not, so it
// counted the guest's own table and their own covers against them and showed
// `full`/`pacing` on times the submit would have granted.
describe('the change picker excludes the booking being replaced (P0-12)', () => {
  const slotAt = (a: Awaited<ReturnType<typeof dayAvailability>>, h: number, m: number) => {
    const want = at(h, m).getTime();
    return a.slots.find((s) => s.start.getTime() === want);
  };

  it('a 19:00 → 19:15 move on the ONLY suitable table is offered, and taken', async () => {
    await floor([['T1', 2]]);
    const r = await booked();

    // What the old picker showed: its own booking made every overlapping slot full.
    const blind = await dayAvailability({ day: DAY, partySize: 2, now: LATER }, config());
    expect(slotAt(blind, 19, 15)).toMatchObject({ bookable: false, reason: 'full' });

    // What the guest sees now, through the token.
    const seen = await guestDayAvailability(r.manageToken, { day: DAY, partySize: 2, now: LATER }, config());
    expect(slotAt(seen, 19, 15)).toMatchObject({ bookable: true });

    // …and the submit agrees, which is the whole point.
    const moved = await guestChange(r.manageToken, { day: DAY, startAt: at(19, 15), partySize: 2, now: LATER }, config());
    expect(moved).toMatchObject({ ok: true, changed: true });
    expect((await holds(r.id)).map((h) => h.tableId)).toEqual(['T1']);
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).startAt).toEqual(at(19, 15));
  });

  it('does not excuse the guest from someone ELSE holding the table', async () => {
    await floor([['T1', 2]]);
    const mine = await booked();
    await prisma.diningTable.create({ data: { id: 'T2', seats: 2, minParty: 1, section: 'main' } });
    await booked({ startAt: at(19, 15), guestName: 'Other Party', guestPhone: '+15035550199' });
    // Two tables, two parties overlapping 19:15 — excluding only mine still
    // leaves theirs, so a third deuce at 19:15 has nowhere to go.
    const seen = await guestDayAvailability(mine.manageToken, { day: DAY, partySize: 2, now: LATER }, config());
    expect(slotAt(seen, 19, 15)).toMatchObject({ bookable: true }); // T1 freed by excluding mine
    const plain = await dayAvailability({ day: DAY, partySize: 2, now: LATER }, config());
    expect(slotAt(plain, 19, 15)).toMatchObject({ bookable: false, reason: 'full' });
  });

  it('frees the guest’s own covers from the pacing count', async () => {
    await floor([['T1', 2], ['T2', 2]]);
    const r = await booked();
    // Cap 2: the guest's own 2 covers at 19:00 fill the 19:00 bucket entirely.
    const blind = await dayAvailability({ day: DAY, partySize: 2, now: LATER }, config(2));
    expect(slotAt(blind, 19, 0)).toMatchObject({ bookable: false, reason: 'pacing' });
    const seen = await guestDayAvailability(r.manageToken, { day: DAY, partySize: 2, now: LATER }, config(2));
    expect(slotAt(seen, 19, 0)).toMatchObject({ bookable: true });
  });

  // The exclusion is the token's, not a caller's. An unknown token excludes
  // nothing rather than silently excluding the first row it finds.
  it('an unknown token excludes nothing', async () => {
    await floor([['T1', 2]]);
    await booked();
    const seen = await guestDayAvailability('z'.repeat(22), { day: DAY, partySize: 2, now: LATER }, config());
    expect(slotAt(seen, 19, 0)).toMatchObject({ bookable: false, reason: 'full' });
  });
});

// A guest change or cancel used to commit and THEN queue its text. A crash in
// between left the reservation moved or cancelled and the message that said
// so gone, with nothing recording that one had ever been owed. The queued row
// is now the durable intent and it commits with the state change; dispatch is
// the retryable path from there.
describe('a change or cancel and the text about it commit together (P0-12)', () => {
  // The one failure that can happen between the state write and the queued
  // row: a template that cannot be rendered. Everything after the queue is
  // `dispatchQueued`, which already retries.
  const broken = (kind: 'change_confirmed' | 'cancelled') => ({
    ...config(),
    templates: { ...DEFAULT_TEMPLATES, [kind]: 'Hello {nonsense}' },
  });

  it('a change whose text cannot be rendered leaves the reservation exactly where it was', async () => {
    await floor([['T1', 2]]);
    const r = await booked();
    await expect(guestChange(r.manageToken, { day: DAY, startAt: at(19, 15), partySize: 2, now: LATER }, broken('change_confirmed'))).rejects.toThrow();

    const after = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.startAt).toEqual(at(19));
    expect(after.status).toBe('booked');
    expect((await holds(r.id)).map((h) => h.tableId)).toEqual(['T1']);
    expect(await kinds(r.id)).toEqual(['confirmation']); // no change_confirmed, and no half-applied move
    expect((await events(r.id)).filter((e) => e.note?.startsWith('changed'))).toHaveLength(0);
  });

  it('and the guest can simply try again once it is fixed — recovery, not repair', async () => {
    await floor([['T1', 2]]);
    const r = await booked();
    await expect(guestChange(r.manageToken, { day: DAY, startAt: at(19, 15), partySize: 2, now: LATER }, broken('change_confirmed'))).rejects.toThrow();
    expect(await guestChange(r.manageToken, { day: DAY, startAt: at(19, 15), partySize: 2, now: LATER }, config())).toMatchObject({ ok: true, changed: true });
    expect(await kinds(r.id)).toEqual(['confirmation', 'change_confirmed']);
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).startAt).toEqual(at(19, 15));
  });

  it('a cancel whose text cannot be rendered leaves the table held and the booking live', async () => {
    await floor([['T1', 2]]);
    const r = await booked();
    await expect(guestCancel(r.manageToken, LATER, broken('cancelled'))).rejects.toThrow();
    const after = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.status).toBe('booked');
    expect(await holds(r.id)).toHaveLength(1);
    expect(await kinds(r.id)).toEqual(['confirmation']);
  });

  // Repeated requests must not repeat the notification.
  it('cancelling twice cancels once and texts once', async () => {
    await floor([['T1', 2]]);
    const r = await booked();
    expect(await guestCancel(r.manageToken, LATER, config())).toEqual({ ok: true, status: 'cancelled' });
    // `transition` sees cancelled → cancelled and says so; it never re-queues.
    expect(await guestCancel(r.manageToken, LATER, config())).toEqual({ ok: false, reason: 'no_change' });
    expect(await kinds(r.id)).toEqual(['confirmation', 'cancelled']);
  });

  it('a change submitted twice moves once and texts once', async () => {
    await floor([['T1', 2]]);
    const r = await booked();
    await guestChange(r.manageToken, { day: DAY, startAt: at(19, 15), partySize: 2, now: LATER }, config());
    // The same slot again: nothing moved, so nothing is logged and nothing is texted.
    expect(await guestChange(r.manageToken, { day: DAY, startAt: at(19, 15), partySize: 2, now: LATER }, config())).toMatchObject({ ok: true, changed: false });
    expect(await kinds(r.id)).toEqual(['confirmation', 'change_confirmed']);
  });

  it('confirming: the state change and its receipt commit together', async () => {
    await floor([['T1', 2]]);
    const r = await booked();
    expect(await guestConfirm(r.manageToken, LATER, config())).toEqual({ ok: true, status: 'confirmed' });
    expect(await kinds(r.id)).toEqual(['confirmation', 'confirmed']);
  });
});
