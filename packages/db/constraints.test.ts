import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './index';
import { resetDatabase } from './testing/index';

// These assert the DATABASE refuses, not that the application remembers to
// check. Placement (V-005) maps 23P01 to a clean refusal; here we prove the
// refusal exists at all.

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 6, 4, h, m));
const EXCLUSION_VIOLATION = /table_hold_no_overlap/;

let n = 0;
async function book(tableIds: string[], [h, m]: [number, number], turnMinutes = 90, key = `idem-${(n += 1)}`) {
  const start = at(h, m);
  const end = at(h, m + turnMinutes); // Date.UTC normalizes minute overflow
  return prisma.reservation.create({
    data: {
      idempotencyKey: key,
      businessDay: '2026-07-04',
      startAt: start,
      partySize: 2,
      turnMinutes,
      tableIds,
      guestName: 'Dana',
      guestPhone: '+15035550100',
      status: 'booked',
      createdAt: start,
      statusChangedAt: start,
      holds: { create: tableIds.map((tableId) => ({ tableId, startAt: start, endAt: end })) },
    },
  });
}

beforeEach(async () => {
  await resetDatabase();
  await prisma.diningTable.createMany({
    data: ['T4', 'T5'].map((id) => ({ id, seats: 2, minParty: 1, section: 'main' })),
  });
});

describe('the allocation constraint (P0-3)', () => {
  it('refuses a second party on a table whose turn overlaps', async () => {
    await book(['T4'], [19, 0]);
    await expect(book(['T4'], [19, 30])).rejects.toThrow(EXCLUSION_VIOLATION);
  });

  it('refuses an overlap that starts EARLIER — windows, not start times, collide', async () => {
    await book(['T4'], [19, 0], 120);
    await expect(book(['T4'], [18, 0], 75)).rejects.toThrow(EXCLUSION_VIOLATION);
  });

  it('allows back-to-back turns — the window is half-open', async () => {
    await book(['T4'], [19, 0]);
    await expect(book(['T4'], [20, 30])).resolves.toBeTruthy();
  });

  it('refuses a combination whose half is already held', async () => {
    await book(['T5'], [19, 0]);
    await expect(book(['T4', 'T5'], [19, 15])).rejects.toThrow(EXCLUSION_VIOLATION);
    // The failed booking left nothing behind: no reservation, no half-hold on T4.
    expect(await prisma.reservation.count()).toBe(1);
    expect(await prisma.tableHold.count({ where: { tableId: 'T4' } })).toBe(0);
  });

  it('lets exactly one of many concurrent bookings take the last table', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        book(['T4'], [19, 0]).then(
          () => 'won' as const,
          () => 'lost' as const,
        ),
      ),
    );
    expect(results.filter((r) => r === 'won')).toHaveLength(1);
    expect(await prisma.reservation.count()).toBe(1);
    expect(await prisma.tableHold.count()).toBe(1);
  });

  it('frees the table the instant its holds are deleted (release)', async () => {
    const first = await book(['T4'], [19, 0]);
    await prisma.tableHold.deleteMany({ where: { reservationId: first.id } });
    await expect(book(['T4'], [19, 0])).resolves.toBeTruthy();
  });

  it('refuses a zero-length hold', async () => {
    const r = await book(['T5'], [12, 0]);
    await expect(
      prisma.tableHold.create({ data: { reservationId: r.id, tableId: 'T4', startAt: at(19), endAt: at(19) } }),
    ).rejects.toThrow(/table_hold_window_positive/);
  });
});

describe('the booking idempotency key (P0-3)', () => {
  it('refuses a second reservation with the same key', async () => {
    await book(['T4'], [19, 0], 90, 'double-submit');
    await expect(book(['T5'], [19, 0], 90, 'double-submit')).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('the reservation event log', () => {
  it('is append-only: UPDATE and DELETE are refused', async () => {
    const r = await book(['T4'], [19, 0]);
    const e = await prisma.reservationEvent.create({
      data: { reservationId: r.id, at: at(19), toStatus: 'booked', source: 'guest_web' },
    });
    await expect(
      prisma.reservationEvent.update({ where: { id: e.id }, data: { toStatus: 'cancelled' } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.reservationEvent.delete({ where: { id: e.id } })).rejects.toThrow(/append-only/);
  });
});
