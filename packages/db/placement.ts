// Booking placement (P0-3): server-side allocation inside ONE transaction.
//
//   1. Advisory lock on the pacing bucket. A covers SUM cannot be a
//      constraint, so pacing is the one deliberate check-then-write, and the
//      lock serializes only same-bucket bookings (V-003 decision).
//   2. The availability engine, fed from rows read AFTER the lock. READ
//      COMMITTED gives every statement a fresh snapshot, so a same-bucket
//      booking that just committed is visible here.
//   3. Reservation + TableHold rows under the exclusion constraint, one
//      savepoint per candidate unit. A booking in a DIFFERENT bucket can take
//      the table between our read and our insert; the constraint, not the
//      read, is what refuses it (23P01). We fall through to the next unit,
//      and when none is left we return a clean refusal.
//
// A refusal or an error rolls the whole transaction back, so no failure
// leaves an orphan hold (P0-3).

import {
  availability,
  HOLDS_TABLES,
  invalidGuestField,
  plusMs,
  turnMinutes,
  DEFAULT_TURN_BANDS,
  type DayReason,
  type FloorPlan,
  type GuestFields,
  type InvalidField,
  type Schedule,
  type TurnBands,
} from '@reserve/core';
import { Prisma, prisma, type Reservation } from './index';

/** Restaurant config that is not in the database yet (V-011 moves the schedule). */
export type PlacementConfig = { schedule: Schedule; overSeatCap: number; turnBands?: TurnBands };

export type PlaceRequest = GuestFields & {
  /** Client-generated; a retry with the same key gets the same reservation back. */
  idempotencyKey: string;
  /** Restaurant-timezone "YYYY-MM-DD". */
  day: string;
  startAt: Date;
  partySize: number;
  source: 'guest_web' | 'host';
  now: Date;
};

export type Placement =
  | { ok: true; reservation: Reservation; replayed: boolean }
  | { ok: false; reason: 'invalid'; field: InvalidField }
  /** `no_longer_available`: every fitting unit was taken under the constraint. */
  | { ok: false; reason: DayReason | 'no_longer_available' };

const NO_OVERLAP = /table_hold_no_overlap/;

export async function placeReservation(req: PlaceRequest, config: PlacementConfig): Promise<Placement> {
  const field = invalidGuestField(req);
  if (field) return { ok: false, reason: 'invalid', field };

  const replay = async (): Promise<Placement | null> => {
    const existing = await prisma.reservation.findUnique({ where: { idempotencyKey: req.idempotencyKey } });
    return existing && { ok: true, reservation: existing, replayed: true };
  };

  try {
    // ponytail: a replay returns the stored body without comparing the request
    // to it. Compare fields if a client ever reuses keys across different bookings.
    return (await replay()) ?? (await prisma.$transaction((tx) => allocate(tx, req, config), { maxWait: 10_000, timeout: 10_000 }));
  } catch (e) {
    // A concurrent double-submit: the other request committed the key first.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const r = await replay();
      if (r) return r;
    }
    throw e;
  }
}

async function allocate(tx: Prisma.TransactionClient, req: PlaceRequest, config: PlacementConfig): Promise<Placement> {
  // The bucket IS the slot's start instant (slots sit on the 15-minute grid).
  // Single-key form: nothing else in this database takes advisory locks.
  const bucket = req.startAt.getTime() / 60_000;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${bucket}::bigint)`;

  const [tables, combos, held] = [
    await tx.diningTable.findMany(),
    await tx.combination.findMany({ include: { members: true } }),
    await tx.reservation.findMany({
      where: { businessDay: req.day, status: { in: [...HOLDS_TABLES] } },
      select: { startAt: true, partySize: true, turnMinutes: true, tableIds: true },
    }),
  ];
  const plan: FloorPlan = {
    tables,
    combinations: combos.map((c) => ({ ...c, tableIds: c.members.map((m) => m.tableId) })),
    overSeatCap: config.overSeatCap,
  };
  const bands = config.turnBands ?? DEFAULT_TURN_BANDS;
  const avail = availability({
    day: req.day,
    partySize: req.partySize,
    plan,
    schedule: config.schedule,
    reservations: held.map((r) => ({ ...r, start: r.startAt })),
    now: req.now,
    turnBands: bands,
  });
  const slot = avail.slots.find((s) => s.start.getTime() === req.startAt.getTime());
  if (!slot) return { ok: false, reason: avail.reason ?? 'closed' }; // off-grid or outside every period
  if (!slot.bookable) return { ok: false, reason: slot.reason };

  const turn = turnMinutes(req.partySize, bands);
  const endAt = plusMs(req.startAt, turn * 60_000);
  for (const unit of slot.units) {
    await tx.$executeRaw`SAVEPOINT unit`;
    try {
      const reservation = await tx.reservation.create({
        data: {
          idempotencyKey: req.idempotencyKey,
          businessDay: req.day,
          startAt: req.startAt,
          partySize: req.partySize,
          turnMinutes: turn,
          tableIds: [...unit.tableIds],
          guestName: req.guestName.trim(),
          guestPhone: req.guestPhone,
          note: req.note ?? null,
          tags: [...(req.tags ?? [])],
          status: 'booked',
          createdAt: req.now,
          statusChangedAt: req.now,
          holds: { create: unit.tableIds.map((tableId) => ({ tableId, startAt: req.startAt, endAt })) },
        },
      });
      await tx.reservationEvent.create({
        data: { reservationId: reservation.id, at: req.now, fromStatus: null, toStatus: 'booked', source: req.source },
      });
      return { ok: true, reservation, replayed: false };
    } catch (e) {
      if (!NO_OVERLAP.test(String(e))) throw e;
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT unit`;
    }
  }
  return { ok: false, reason: 'no_longer_available' };
}
