// Booking placement (P0-3): server-side allocation inside ONE transaction.
//
//   1. Advisory lock on the pacing bucket. A covers SUM cannot be a
//      constraint, so pacing is the one deliberate check-then-write, and the
//      lock serializes only same-bucket bookings (V-003 decision).
//   2. The availability engine, fed from rows read AFTER the lock. READ
//      COMMITTED gives every statement a fresh snapshot, so a same-bucket
//      booking that just committed is visible here.
//   3. Reservation + TableHold rows under the exclusion constraint, one
//      savepoint per candidate unit (firstUnit, shared with a change). A booking in a DIFFERENT bucket can take
//      the table between our read and our insert; the constraint, not the
//      read, is what refuses it (23P01). We fall through to the next unit,
//      and when none is left we return a clean refusal.
//
// A refusal or an error rolls the whole transaction back, so no failure
// leaves an orphan hold (P0-3).

import {
  availability,
  confirmationBody,
  DEFAULT_TEMPLATES,
  HOLDS_TABLES,
  invalidGuestField,
  isUpcoming,
  parseStatus,
  plusMs,
  transition,
  turnMinutes,
  DEFAULT_TURN_BANDS,
  type DayReason,
  type FloorPlan,
  type GuestFields,
  type InvalidField,
  type Schedule,
  type Templates,
  type TurnBands,
} from '@reserve/core';
import { Prisma, prisma, type Reservation } from './index';
import { newManageToken } from './messages';

/** Restaurant config for a placement. `schedule` comes from `loadSchedule` (V-011). */
export type PlacementConfig = {
  schedule: Schedule;
  overSeatCap: number;
  turnBands?: TurnBands;
  /** The name the confirmation text opens with. */
  restaurant: string;
  /** The manage link is `${manageBaseUrl}/${token}`. */
  manageBaseUrl: string;
  templates?: Templates;
};

export type PlaceRequest = GuestFields & {
  /** A booking always has a number to confirm it by (P0-12). */
  guestPhone: string;
  /** Client-generated; a retry with the same key gets the same reservation back. */
  idempotencyKey: string;
  /** Restaurant-timezone "YYYY-MM-DD". */
  day: string;
  startAt: Date;
  partySize: number;
  source: 'guest_web' | 'host';
  /** The consent checkbox's wording, as shown, when the guest ticked it (P0-8). Absent = no texts. */
  smsConsent?: string | undefined;
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

/**
 * Steps 1–2: take the bucket lock, read what is held, ask the engine. `except`
 * leaves one reservation out of the occupied set — a change must not collide
 * with the booking it replaces.
 */
async function fit(
  tx: Prisma.TransactionClient,
  q: { day: string; startAt: Date; partySize: number; now: Date },
  config: PlacementConfig,
  except?: string,
) {
  // The bucket IS the slot's start instant (slots sit on the 15-minute grid).
  // Single-key form; the inbound handler's per-number locks use the two-key space.
  const bucket = q.startAt.getTime() / 60_000;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${bucket}::bigint)`;

  const plan = await loadPlan(tx, config.overSeatCap);
  const held = await tx.reservation.findMany({
    where: { businessDay: q.day, status: { in: [...HOLDS_TABLES] }, ...(except && { id: { not: except } }) },
    select: { startAt: true, partySize: true, turnMinutes: true, tableIds: true },
  });
  const bands = config.turnBands ?? DEFAULT_TURN_BANDS;
  const avail = availability({
    day: q.day,
    partySize: q.partySize,
    plan,
    schedule: config.schedule,
    reservations: held.map((r) => ({ ...r, start: r.startAt })),
    now: q.now,
    turnBands: bands,
  });
  const slot = avail.slots.find((s) => s.start.getTime() === q.startAt.getTime());
  if (!slot) return { ok: false as const, reason: avail.reason ?? 'closed' }; // off-grid or outside every period
  if (!slot.bookable) return { ok: false as const, reason: slot.reason };
  const turn = turnMinutes(q.partySize, bands);
  return { ok: true as const, units: slot.units, turn, endAt: plusMs(q.startAt, turn * 60_000) };
}

/** Today's floor plan, read inside the caller's transaction. */
export async function loadPlan(tx: Prisma.TransactionClient, overSeatCap: number): Promise<FloorPlan> {
  const [tables, combos] = [await tx.diningTable.findMany(), await tx.combination.findMany({ include: { members: true } })];
  return { tables, combinations: combos.map((c) => ({ ...c, tableIds: c.members.map((m) => m.tableId) })), overSeatCap };
}

/**
 * Step 3: `write` each candidate unit under its own savepoint until one
 * clears the exclusion constraint; null when every unit was taken under us.
 * A failed attempt rolls back everything `write` did, not just the hold.
 */
export async function firstUnit<T>(tx: Prisma.TransactionClient, units: readonly { tableIds: readonly string[] }[], write: (tableIds: string[]) => Promise<T>) {
  for (const unit of units) {
    await tx.$executeRaw`SAVEPOINT unit`;
    try {
      return await write([...unit.tableIds]);
    } catch (e) {
      if (!NO_OVERLAP.test(String(e))) throw e;
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT unit`;
    }
  }
  return null;
}

async function allocate(tx: Prisma.TransactionClient, req: PlaceRequest, config: PlacementConfig): Promise<Placement> {
  const f = await fit(tx, req, config);
  if (!f.ok) return f;
  const manageToken = newManageToken();
  // Rendered once, here, and stored: the snapshot rule for messages. Too long
  // to text throws, and the booking rolls back with it.
  const body = confirmationBody({
    template: (config.templates ?? DEFAULT_TEMPLATES).confirmation,
    restaurant: config.restaurant,
    timezone: config.schedule.timezone,
    startAt: req.startAt,
    partySize: req.partySize,
    link: `${config.manageBaseUrl}/${manageToken}`,
  });
  const reservation = await firstUnit(tx, f.units, async (tableIds) => {
    const reservation = await tx.reservation.create({
      data: {
        idempotencyKey: req.idempotencyKey,
        businessDay: req.day,
        startAt: req.startAt,
        partySize: req.partySize,
        turnMinutes: f.turn,
        tableIds,
        guestName: req.guestName.trim(),
        guestPhone: req.guestPhone,
        note: req.note ?? null,
        tags: [...(req.tags ?? [])],
        status: 'booked',
        createdAt: req.now,
        statusChangedAt: req.now,
        manageToken,
        smsConsent: req.smsConsent?.trim() || null,
        holds: { create: tableIds.map((tableId) => ({ tableId, startAt: req.startAt, endAt: f.endAt })) },
      },
    });
    await tx.reservationEvent.create({
      data: { reservationId: reservation.id, at: req.now, fromStatus: null, toStatus: 'booked', source: req.source },
    });
    // Queued in the booking's transaction: no booking without its
    // confirmation, no confirmation without its booking. A replay returns
    // before reaching here, and (reservation, kind) is unique regardless.
    // No consent, no text (P0-8).
    if (reservation.smsConsent) {
      await tx.outboundMessage.create({
        data: { reservationId: reservation.id, kind: 'confirmation', toPhone: req.guestPhone, body, status: 'queued', createdAt: req.now, statusChangedAt: req.now },
      });
    }
    return reservation;
  });
  return reservation ? { ok: true, reservation, replayed: false } : { ok: false, reason: 'no_longer_available' };
}

export type ChangeRequest = {
  reservationId: string;
  /** Restaurant-timezone "YYYY-MM-DD" of the new time. */
  day: string;
  startAt: Date;
  partySize: number;
  source: 'guest_web' | 'sms' | 'host';
  now: Date;
};

export type Change =
  /** `changed: false` — the request asked for the time and party it already has; nothing was written. */
  | { ok: true; reservation: Reservation; changed: boolean; was: { startAt: Date; partySize: number } }
  /** `not_changeable`: not upcoming (cancelled, seated, released…) or already started. */
  | { ok: false; reason: DayReason | 'no_longer_available' | 'not_changeable' };

/**
 * A time or party-size change is a RE-ALLOCATION (P0-6), not an edit: the
 * new window goes through the engine and the exclusion constraint like a new
 * booking. The old holds are deleted and the new ones inserted under one
 * savepoint, so a refusal restores the old holds with it — there is no
 * moment, committed or not, where the guest holds nothing.
 *
 * A guest-driven change COUNTS AS THAT GUEST'S CONFIRMATION (V-008): the
 * deadline sweep judges a reservation against its original `createdAt`, so a
 * `booked` party who moves after that deadline would otherwise be released
 * out from under the change they just made. Someone who reschedules by hand
 * has plainly told us they are coming. A host-driven change confirms nothing
 * — the host moved it, not the guest — and a `confirmed` guest who moves
 * stays confirmed either way.
 */
export async function changeReservation(req: ChangeRequest, config: PlacementConfig): Promise<Change> {
  return prisma.$transaction(async (tx): Promise<Change> => {
    const [current] = await tx.$queryRaw<Reservation[]>`SELECT * FROM "Reservation" WHERE id = ${req.reservationId}::uuid FOR UPDATE`;
    if (!current || !isUpcoming(parseStatus(current.status)) || req.now.getTime() >= current.startAt.getTime()) {
      return { ok: false, reason: 'not_changeable' };
    }
    const was = { startAt: current.startAt, partySize: current.partySize };
    // A double-submitted form, or a guest who re-picked the slot they already
    // have. Nothing moved, so nothing is logged and nothing is texted.
    if (req.startAt.getTime() === current.startAt.getTime() && req.partySize === current.partySize) {
      return { ok: true, reservation: current, changed: false, was };
    }
    const f = await fit(tx, req, config, current.id);
    if (!f.ok) return f;
    // booked → confirmed, through the ONE lifecycle module; `keep` tables.
    const confirm = req.source === 'host' ? null : transition({ status: parseStatus(current.status), startAt: current.startAt }, 'confirmed', 'guest', req.now);
    const status = confirm?.ok ? confirm.to : parseStatus(current.status);
    const updated = await firstUnit(tx, f.units, async (tableIds) => {
      await tx.tableHold.deleteMany({ where: { reservationId: current.id } });
      await tx.tableHold.createMany({ data: tableIds.map((tableId) => ({ reservationId: current.id, tableId, startAt: req.startAt, endAt: f.endAt })) });
      return tx.reservation.update({
        where: { id: current.id },
        data: {
          businessDay: req.day,
          startAt: req.startAt,
          partySize: req.partySize,
          turnMinutes: f.turn,
          tableIds,
          ...(confirm?.ok && { status, statusChangedAt: req.now }),
        },
      });
    });
    if (!updated) return { ok: false, reason: 'no_longer_available' };
    await tx.reservationEvent.create({
      data: {
        reservationId: current.id,
        at: req.now,
        fromStatus: current.status,
        toStatus: current.status,
        source: req.source,
        note: `changed from ${current.startAt.toISOString()} party ${current.partySize} at ${current.tableIds.join('+')}`,
      },
    });
    // Its own row: "the guest moved" and "the guest confirmed" are two facts.
    if (confirm?.ok) {
      await tx.reservationEvent.create({
        data: { reservationId: current.id, at: req.now, fromStatus: confirm.from, toStatus: confirm.to, source: req.source, note: 'confirmed by changing' },
      });
    }
    return { ok: true, reservation: updated, changed: true, was };
  }, { maxWait: 10_000, timeout: 10_000 });
}
