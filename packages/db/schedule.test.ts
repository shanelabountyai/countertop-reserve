import { beforeEach, describe, expect, it } from 'vitest';
import { periodsFor, zonedTimeToInstant } from '@reserve/core';
import { prisma } from './index';
import { editSchedule, loadSchedule, type ScheduleEdit } from './schedule';
import { placeReservation, type PlaceRequest, type PlacementConfig } from './placement';
import { resetDatabase, seedSchedule } from './testing/index';

// Friday 2026-10-02, America/Los_Angeles. `now` = noon that day.
const DAY = '2026-10-02';
const TZ = 'America/Los_Angeles';
const NOW = zonedTimeToInstant(DAY, 12 * 60, TZ);
const FRIDAY = 5;

const period = (over: Partial<Parameters<typeof prisma.servicePeriod.create>[0]['data']> = {}) => ({
  weekday: FRIDAY,
  name: 'Dinner',
  openMinute: 17 * 60,
  closeMinute: 21 * 60,
  lastSeatingMinute: null,
  pacingCap: 20,
  ...over,
});

const addPeriod = (over = {}): ScheduleEdit => ({ kind: 'addPeriod', period: { day: null, ...period(over) } });

/** A booked party at `time` on `day`, holding one table for `turn` minutes. */
let n = 0;
async function reserve(day: string, time: number, turnMinutes = 75, guestName = 'Dana Reyes') {
  n += 1;
  return prisma.reservation.create({
    data: {
      idempotencyKey: `key-${n}`,
      manageToken: `token-${n}`,
      businessDay: day,
      startAt: zonedTimeToInstant(day, time, TZ),
      partySize: 2,
      turnMinutes,
      tableIds: ['T1'],
      guestName,
      guestPhone: '+15035550100',
      status: 'booked',
      createdAt: NOW,
      statusChangedAt: NOW,
    },
  });
}

beforeEach(resetDatabase);

describe('loadSchedule (P0-10)', () => {
  it('builds the engine’s Schedule from rows: weekly by weekday, overrides by date, blackouts by day', async () => {
    await prisma.servicePeriod.createMany({
      data: [period(), period({ weekday: 6, name: 'Brunch', openMinute: 10 * 60, closeMinute: 14 * 60, pacingCap: 12 })],
    });
    await prisma.servicePeriod.create({ data: { ...period(), weekday: null, day: DAY, name: 'Private event', openMinute: 18 * 60, closeMinute: 20 * 60 } });
    await prisma.blackout.create({ data: { day: '2026-12-25', reason: 'Christmas' } });

    const schedule = await loadSchedule(TZ);
    expect(schedule.timezone).toBe(TZ);
    expect(schedule.weekly[FRIDAY]?.map((p) => p.name)).toEqual(['Dinner']);
    expect(schedule.weekly[6]?.map((p) => p.name)).toEqual(['Brunch']);
    expect(schedule.weekly[1]).toEqual([]);
    expect(schedule.blackouts).toEqual(['2026-12-25']);
    // The override REPLACES Friday's periods on that date, and only that date.
    expect(periodsFor(schedule, DAY).map((p) => p.name)).toEqual(['Private event']);
    expect(periodsFor(schedule, '2026-10-09').map((p) => p.name)).toEqual(['Dinner']);
    expect(periodsFor(schedule, '2026-12-25')).toEqual([]);
  });

  it('a null last seating is ABSENT, not null — the engine branches on undefined', async () => {
    await prisma.servicePeriod.createMany({ data: [period(), period({ weekday: 6, lastSeatingMinute: 20 * 60 })] });
    const schedule = await loadSchedule(TZ);
    expect(schedule.weekly[FRIDAY]?.[0] && 'lastSeatingMinute' in schedule.weekly[FRIDAY][0]).toBe(false);
    expect(schedule.weekly[6]?.[0]?.lastSeatingMinute).toBe(20 * 60);
  });
});

describe('editSchedule — the constraints (P0-10)', () => {
  it('refuses a weekly period overlapping one already set for that weekday', async () => {
    expect(await editSchedule(addPeriod(), TZ, NOW)).toEqual({ ok: true });
    const clash = await editSchedule(addPeriod({ name: 'Late', openMinute: 20 * 60, closeMinute: 23 * 60 }), TZ, NOW);
    expect(clash).toEqual({ ok: false, reason: 'overlap' });
    expect(await prisma.servicePeriod.count()).toBe(1);
  });

  it('the same window on another weekday, or touching end-to-end, is fine', async () => {
    expect(await editSchedule(addPeriod(), TZ, NOW)).toEqual({ ok: true });
    expect(await editSchedule(addPeriod({ weekday: 6 }), TZ, NOW)).toEqual({ ok: true });
    expect(await editSchedule(addPeriod({ name: 'Late', openMinute: 21 * 60, closeMinute: 23 * 60 }), TZ, NOW)).toEqual({ ok: true });
  });

  it('a date override overlaps only its own date', async () => {
    const override = (over = {}): ScheduleEdit => ({ kind: 'addPeriod', period: { ...period({ weekday: null, ...over }), day: DAY } });
    expect(await editSchedule(override(), TZ, NOW)).toEqual({ ok: true });
    expect(await editSchedule(override({ openMinute: 20 * 60, closeMinute: 23 * 60 }), TZ, NOW)).toEqual({ ok: false, reason: 'overlap' });
    expect(await editSchedule({ kind: 'addPeriod', period: { ...period({ weekday: null }), day: '2026-10-09' } }, TZ, NOW)).toEqual({ ok: true });
  });

  it('an off-grid open, a backwards window and a nonsense cap are refused by the database, not by the form', async () => {
    expect(await editSchedule(addPeriod({ openMinute: 17 * 60 + 5 }), TZ, NOW)).toEqual({ ok: false, reason: 'invalid' });
    expect(await editSchedule(addPeriod({ closeMinute: 15 * 60 }), TZ, NOW)).toEqual({ ok: false, reason: 'invalid' });
    expect(await editSchedule(addPeriod({ pacingCap: 0 }), TZ, NOW)).toEqual({ ok: false, reason: 'invalid' });
    expect(await editSchedule(addPeriod({ lastSeatingMinute: 21 * 60 }), TZ, NOW)).toEqual({ ok: false, reason: 'invalid' });
    expect(await prisma.servicePeriod.count()).toBe(0);
  });

  it('removing something already gone is `not_found`, never a crash', async () => {
    expect(await editSchedule({ kind: 'removeBlackout', day: '2026-12-25' }, TZ, NOW)).toEqual({ ok: false, reason: 'not_found' });
    expect(await editSchedule({ kind: 'removePeriod', id: '00000000-0000-0000-0000-000000000000' }, TZ, NOW)).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('editSchedule — the hours-edit diff warning (P0-10)', () => {
  beforeEach(async () => {
    await editSchedule(addPeriod(), TZ, NOW);
  });

  it('warns and writes NOTHING when the edit would strand a booked party', async () => {
    await reserve(DAY, 19 * 60, 75, 'Stranded Sam');
    const row = await prisma.servicePeriod.findFirstOrThrow();

    const r = await editSchedule({ kind: 'removePeriod', id: row.id }, TZ, NOW);
    expect(r).toEqual({
      ok: false,
      reason: 'strands',
      conflicts: [expect.objectContaining({ reason: 'closed', row: expect.objectContaining({ guestName: 'Stranded Sam' }) })],
    });
    expect(await prisma.servicePeriod.count()).toBe(1);
  });

  it('`force` is the host saying they know: the edit lands, the party stays booked', async () => {
    await reserve(DAY, 19 * 60);
    const row = await prisma.servicePeriod.findFirstOrThrow();

    expect(await editSchedule({ kind: 'removePeriod', id: row.id }, TZ, NOW, 'force')).toEqual({ ok: true });
    expect(await prisma.servicePeriod.count()).toBe(0);
    expect(await prisma.reservation.count({ where: { status: 'booked' } })).toBe(1);
  });

  it('a blackout over a booked date strands it; a blackout over an empty one does not', async () => {
    await reserve(DAY, 19 * 60);
    const blackout = (day: string): ScheduleEdit => ({ kind: 'addBlackout', day, reason: 'Private hire' });
    expect(await editSchedule(blackout(DAY), TZ, NOW)).toMatchObject({ ok: false, reason: 'strands' });
    expect(await editSchedule(blackout('2026-10-09'), TZ, NOW)).toEqual({ ok: true });
    expect((await prisma.blackout.findMany()).map((b) => b.day)).toEqual(['2026-10-09']);
  });

  it('a tightened last seating strands the turns that now overhang, and leaves the rest alone', async () => {
    await reserve(DAY, 17 * 60, 90, 'Early Erin');
    await reserve(DAY, 20 * 60, 120, 'Late Lee');
    const row = await prisma.servicePeriod.findFirstOrThrow();
    await prisma.servicePeriod.update({ where: { id: row.id }, data: { lastSeatingMinute: 19 * 60 } });

    // Nothing pending: the CHECK runs against the rows as they already are.
    const r = await editSchedule({ kind: 'addBlackout', day: '2027-01-01', reason: 'New Year' }, TZ, NOW);
    expect(r).toMatchObject({ ok: false, reason: 'strands' });
    if (r.ok || r.reason !== 'strands') throw new Error('expected strands');
    expect(r.conflicts.map((c) => [c.row.guestName, c.reason])).toEqual([['Late Lee', 'overhang']]);
  });

  it('ignores parties already behind `now` and those that no longer hold a table', async () => {
    await reserve(DAY, 9 * 60, 75, 'This morning'); // before NOW
    const cancelled = await reserve(DAY, 19 * 60, 75, 'Cancelled Cass');
    await prisma.reservation.update({ where: { id: cancelled.id }, data: { status: 'cancelled' } });

    const row = await prisma.servicePeriod.findFirstOrThrow();
    expect(await editSchedule({ kind: 'removePeriod', id: row.id }, TZ, NOW)).toEqual({ ok: true });
  });

  it('`check` never commits, even when nothing would be stranded', async () => {
    expect(await editSchedule({ kind: 'addBlackout', day: '2026-12-25', reason: 'Christmas' }, TZ, NOW, 'check')).toEqual({ ok: true });
    expect(await prisma.blackout.count()).toBe(0);
  });
});


// The schema has allowed a midnight close since the service-schedule
// migration (`closeMinute <= 1440`), but nothing could produce one: the hours
// parser's regex stopped at 23:59 and a native time input cannot express it,
// so a kitchen closing at midnight had no way to say so.
describe('a kitchen that closes at midnight', () => {
  it('stores a period closing at minute 1440', async () => {
    expect(await editSchedule(addPeriod({ name: 'Late', openMinute: 21 * 60, closeMinute: 24 * 60, lastSeatingMinute: 23 * 60 }), TZ, NOW)).toEqual({ ok: true });
    const rows = await prisma.servicePeriod.findMany({ where: { name: 'Late' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.closeMinute).toBe(1440);
  });

  it('is still refused past midnight — the CHECK constraint, as a clean refusal', async () => {
    expect(await editSchedule(addPeriod({ name: 'Too late', openMinute: 21 * 60, closeMinute: 24 * 60 + 15 }), TZ, NOW)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await prisma.servicePeriod.count({ where: { name: 'Too late' } })).toBe(0);
  });
});

// `guestConfig` loads the schedule before placement's transaction opens, so a
// booking could be decided against hours a blackout had already removed:
// committed, outside service, and invisible to the edit's own stranding check
// because the row did not exist when that check ran. Both sides were correct
// in isolation; they had no boundary in common. They share one advisory lock
// now — bookings take it shared and reload the schedule under it, edits take
// it exclusive.
describe('a booking and an hours edit cannot pass through each other', () => {
  const placement = (): PlacementConfig => ({
    schedule: { timezone: TZ, weekly: Array.from({ length: 7 }, () => [{ name: 'Dinner', openMinute: 17 * 60, closeMinute: 21 * 60, pacingCap: 40 }]), overrides: {}, blackouts: [] },
    overSeatCap: 2,
    restaurant: 'Firebird Kitchen',
    manageBaseUrl: 'https://firebird.example/m',
  });
  const booking = (over: Partial<PlaceRequest> = {}): PlaceRequest => ({
    idempotencyKey: `race-${(n += 1)}`,
    day: DAY,
    startAt: zonedTimeToInstant(DAY, 19 * 60, TZ),
    partySize: 2,
    guestName: 'Dana Reyes',
    guestPhone: '+15035550100',
    source: 'guest_web',
    now: NOW,
    ...over,
  });

  beforeEach(async () => {
    await seedSchedule(placement().schedule);
    await prisma.diningTable.createMany({ data: [{ id: 'T1', seats: 2, minParty: 1, section: 'main' }] });
  });

  // The stale snapshot the caller hands in is exactly what `guestConfig`
  // produced before the blackout landed. The booking must not honour it.
  it('a booking carrying pre-blackout hours is refused, not stranded', async () => {
    const stale = placement();
    expect(await editSchedule({ kind: 'addBlackout', day: DAY, reason: 'deep clean' }, TZ, NOW)).toEqual({ ok: true });

    const res = await placeReservation(booking(), stale);
    expect(res).toMatchObject({ ok: false, reason: 'closed' });
    expect(await prisma.reservation.count()).toBe(0);
  });

  // Run together: whichever order they land in, the pair must agree. Either
  // the booking is refused, or it exists and the edit reported it as stranded
  // rather than committing over it.
  it('run concurrently, the two always agree — never a silently stranded booking', async () => {
    const stale = placement();
    const [placed, edited] = await Promise.all([
      placeReservation(booking(), stale),
      editSchedule({ kind: 'addBlackout', day: DAY, reason: 'deep clean' }, TZ, NOW),
    ]);

    const rows = await prisma.reservation.findMany();
    if (!placed.ok) {
      expect(rows).toHaveLength(0);
      return;
    }
    // The booking won the lock. Then the edit saw it, and either refused with
    // it named as stranded, or the blackout never landed.
    expect(rows).toHaveLength(1);
    const blackouts = await prisma.blackout.findMany();
    if (blackouts.length > 0) throw new Error('blackout committed over a live booking');
    expect(edited).toMatchObject({ ok: false, reason: 'strands' });
    expect(edited.ok === false && edited.reason === 'strands' && edited.conflicts.map((c) => c.row.id)).toContain(placed.reservation.id);
  });

  it('with no edit in flight the booking is taken as normal', async () => {
    expect(await placeReservation(booking(), placement())).toMatchObject({ ok: true });
  });

  // Bookings must not serialize against EACH OTHER on the schedule lock —
  // they take it shared. Different buckets, so no pacing lock contention either.
  it('two bookings in different buckets still run together', async () => {
    await prisma.diningTable.create({ data: { id: 'T2', seats: 2, minParty: 1, section: 'main' } });
    const results = await Promise.all([
      placeReservation(booking({ startAt: zonedTimeToInstant(DAY, 19 * 60, TZ) }), placement()),
      placeReservation(booking({ startAt: zonedTimeToInstant(DAY, 19 * 60 + 15, TZ) }), placement()),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});
