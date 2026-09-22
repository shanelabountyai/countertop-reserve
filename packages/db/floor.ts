// The host floor view's reads and writes (P0-9).
//
// Every host tap is a transition through the ONE lifecycle module, with the
// actor `host`, and its table effect applied in the same transaction as the
// event — the same shape as the sweep's release and the inbound handler's
// cancel. Undo is `revert` on the last event, appended as its own event.
// Anything that takes a table (a walk-in, seating a waitlisted party, undoing
// a no-show) goes through the exclusion constraint, and a lost race is a
// clean refusal, never an error.

import {
  allUnits,
  DEFAULT_POLICY,
  DEFAULT_TEMPLATES,
  DEFAULT_TURN_BANDS,
  HOLDS_TABLES,
  holdsTables,
  invalidGuestField,
  parseStatus,
  plusMs,
  renderMessage,
  revert,
  revertTables,
  SLOT_MINUTES,
  tableStates,
  transition,
  turnMinutes,
  unitMisfit,
  walkIn,
  type Actor,
  type Decision,
  type GuestFields,
  type InvalidField,
  type MessageKind,
  type PlanUnit,
  type Rejection,
  type SendPolicy,
  type Status,
  type TableStateRow,
  type Templates,
  type TurnBands,
  type UnitMisfit,
} from '@reserve/core';
import { Prisma, prisma, type Reservation } from './index';
import { dispatchQueued, newManageToken, type MessageProvider } from './messages';
import { fit, firstUnit, loadPlan } from './placement';

export type FloorConfig = {
  restaurant: string;
  timezone: string;
  overSeatCap: number;
  turnBands?: TurnBands;
  templates?: Templates;
  send?: SendPolicy;
};

/**
 * What the host reads aloud before ticking the box, stored verbatim as the
 * waitlisted party's consent (P0-8) — it covers the one text and nothing else.
 */
export const WAITLIST_CONSENT = 'Text me once, when my table is ready.';

export type FloorRow = {
  id: string;
  status: Status;
  startAt: Date;
  partySize: number;
  tableIds: string[];
  guestName: string;
  note: string | null;
  tags: string[];
  quotedWait: string | null;
  /** Consented to texts — a row that did not must not read as "confirmed by silence". */
  texts: boolean;
  /** When the party sat down (the latest seat event), for elapsed-since-seated. */
  seatedAt: Date | null;
  /** When the last host tap stops being undoable; null when there is nothing to undo. */
  undoUntil: Date | null;
  messages: { kind: MessageKind; status: string; failureReason: string | null }[];
};

const actorOf = (source: string): Actor => (source === 'host' ? 'host' : source === 'system' ? 'system' : 'guest');

/** One restaurant day's book, every status, in time order. */
export async function loadFloor(day: string, now: Date): Promise<FloorRow[]> {
  const rows = await prisma.reservation.findMany({
    where: { businessDay: day },
    orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
    include: {
      events: { orderBy: { id: 'asc' } },
      messages: { select: { kind: true, status: true, failureReason: true }, orderBy: { createdAt: 'asc' } },
    },
  });
  return rows.map((r) => {
    const status = parseStatus(r.status);
    const last = r.events.at(-1);
    // A move (P0-14) reverts tables, everything else reverts a status — the
    // row only needs to know whether the five seconds are still running.
    const undo =
      last &&
      (last.fromTableIds.length > 0
        ? revertTables({ at: last.at, actor: actorOf(last.source) }, now)
        : revert({ status, startAt: r.startAt }, { fromStatus: last.fromStatus === null ? null : parseStatus(last.fromStatus), toStatus: parseStatus(last.toStatus), at: last.at, actor: actorOf(last.source) }, now));
    return {
      id: r.id,
      status,
      startAt: r.startAt,
      partySize: r.partySize,
      tableIds: r.tableIds,
      guestName: r.guestName,
      note: r.note,
      tags: r.tags,
      quotedWait: r.quotedWait,
      texts: r.smsConsent !== null,
      seatedAt: status === 'seated' ? (r.events.filter((e) => e.toStatus === 'seated').at(-1)?.at ?? null) : null,
      undoUntil: undo?.ok && last ? plusMs(last.at, DEFAULT_POLICY.undoSeconds * 1000) : null,
      messages: r.messages.map((m) => ({ ...m, kind: m.kind as MessageKind })),
    };
  });
}

/**
 * The table board's rows (P0-13): the floor plan, plus everything that holds
 * a table in this service, handed to the ONE pure function. Table-major, so
 * it reads nothing `loadFloor` derives and derives nothing `loadFloor` reads.
 *
 * The window is deliberately *this* service, not ±24 hours: a `free` whose
 * free-until is tomorrow's dinner is noise, and the spec's "null for the rest
 * of service" is what the host actually needs. A party still `seated` past
 * midnight is kept whatever business day they were booked on — their table is
 * not free because the date rolled over.
 */
export async function loadBoard(day: string, config: FloorConfig, now: Date, horizonMinutes?: number): Promise<TableStateRow[]> {
  const [plan, held] = await Promise.all([
    loadPlan(prisma, config.overSeatCap),
    prisma.reservation.findMany({
      where: {
        status: { in: [...HOLDS_TABLES] },
        startAt: { gt: plusMs(now, -86_400_000) },
        OR: [{ businessDay: day }, { status: 'seated' }],
      },
      select: {
        id: true,
        startAt: true,
        partySize: true,
        turnMinutes: true,
        tableIds: true,
        guestName: true,
        status: true,
        events: { where: { toStatus: 'seated' }, orderBy: { id: 'desc' }, take: 1, select: { at: true } },
      },
    }),
  ]);
  return tableStates(
    plan,
    held.map((r) => ({ ...r, start: r.startAt, seated: r.status === 'seated', seatedAt: r.events[0]?.at ?? null })),
    now,
    horizonMinutes,
  );
}

/**
 * The server-issued polling cursor (P0-9) — Countertop's C-013 shape. It is
 * the TIP of what can change the screen, not a position to read forward
 * from: the client echoes it and asks "still the same?". Every reservation
 * change appends an event (append-only, so the count only grows); a message's
 * row count and its non-queued and failed counts only grow too, since no
 * status returns to `queued` and `failed` is final. An out-of-order commit
 * still moves a count, so there is no lost-update window.
 *
 * ponytail: three whole-table counts per poll. Fine for one restaurant at a
 * 10s interval; a sequence column if the tables ever get large.
 */
export async function floorCursor(): Promise<string> {
  const [c] = await prisma.$queryRaw<{ cursor: string }[]>`
    SELECT concat_ws('.',
      (SELECT count(*) FROM "ReservationEvent"),
      count(*), count(*) FILTER (WHERE status <> 'queued'), count(*) FILTER (WHERE status = 'failed')) AS cursor
    FROM "OutboundMessage"`;
  return c!.cursor;
}

export type HostRefusal =
  | Rejection
  | 'not_found'
  /** Undo would re-take a table someone else now holds. */
  | 'table_taken'
  /** Seating a waitlisted party: nothing fits them right now. */
  | 'no_table';
export type HostResult = { ok: true; status: Status } | { ok: false; reason: HostRefusal };

const locked = async (tx: Prisma.TransactionClient, id: string) =>
  (await tx.$queryRaw<Reservation[]>`SELECT * FROM "Reservation" WHERE id = ${id}::uuid FOR UPDATE`)[0];

const TX = { maxWait: 10_000, timeout: 10_000 };

/** A one-tap host action: seat, no-show, cancel, clear (`completed`), or remove a waitlisted party (`abandoned`). */
export async function hostMove(id: string, to: Status, config: FloorConfig, now: Date): Promise<HostResult> {
  return prisma.$transaction(async (tx) => {
    const r = await locked(tx, id);
    if (!r) return { ok: false, reason: 'not_found' };
    const d = transition({ status: parseStatus(r.status), startAt: r.startAt }, to, 'host', now);
    return apply(tx, r, d, config, now, null);
  }, TX);
}

/** Undo the last host tap on this row, inside its 5 seconds: a logged revert, never a delete. */
export async function undoLast(id: string, config: FloorConfig, now: Date): Promise<HostResult> {
  return prisma.$transaction(async (tx) => {
    const r = await locked(tx, id);
    if (!r) return { ok: false, reason: 'not_found' };
    const last = await tx.reservationEvent.findFirst({ where: { reservationId: id }, orderBy: { id: 'desc' } });
    if (!last) return { ok: false, reason: 'not_revertible' };
    // A move (P0-14) changed tables and no status, so there is no edge for
    // `revert` to grip: the undo re-acquires the tables the log says they
    // came off, over the window the current holds cover. It is an allocation
    // like any other and the constraint can still refuse it — a table given
    // away in those five seconds is not taken back.
    if (last.fromTableIds.length > 0) {
      const d = revertTables({ at: last.at, actor: actorOf(last.source) }, now);
      if (!d.ok) return d;
      const [hold] = await tx.tableHold.findMany({ where: { reservationId: id }, take: 1 });
      if (!hold) return { ok: false, reason: 'not_revertible' };
      const back = await firstUnit(tx, [{ tableIds: last.fromTableIds }], async (tableIds) => {
        await tx.tableHold.deleteMany({ where: { reservationId: id } });
        await tx.tableHold.createMany({ data: tableIds.map((tableId) => ({ reservationId: id, tableId, startAt: hold.startAt, endAt: hold.endAt })) });
        return tableIds;
      });
      if (!back) return { ok: false, reason: 'table_taken' };
      await tx.reservation.update({ where: { id }, data: { tableIds: back } });
      // The undo event carries NO `fromTableIds`, which is what makes an undo
      // structurally un-undoable: otherwise a host could toggle a party
      // between two tables indefinitely, each tap rolling the window forward.
      await tx.reservationEvent.create({
        data: { reservationId: id, at: now, fromStatus: r.status, toStatus: r.status, source: 'host', note: `undo: back to ${back.join('+')}` },
      });
      return { ok: true, status: parseStatus(r.status) };
    }
    const d = revert(
      { status: parseStatus(r.status), startAt: r.startAt },
      { fromStatus: last.fromStatus === null ? null : parseStatus(last.fromStatus), toStatus: parseStatus(last.toStatus), at: last.at, actor: actorOf(last.source) },
      now,
    );
    return apply(tx, r, d, config, now, 'undo');
  }, TX);
}

/** The decision's table effect, the status and the event — one transaction, the caller's. */
async function apply(tx: Prisma.TransactionClient, r: Reservation, d: Decision, config: FloorConfig, now: Date, note: string | null): Promise<HostResult> {
  if (!d.ok) return d;
  let seat: Prisma.ReservationUpdateInput = {};
  if (d.tables === 'release') {
    await tx.tableHold.deleteMany({ where: { reservationId: r.id } });
    // Undoing a waitlisted party's seat hands the table back entirely.
    if (d.to === 'waitlisted') seat = { tableIds: [] };
  } else if (d.tables === 'acquire' && d.from === 'waitlisted') {
    // Seated from the waitlist: a fresh allocation at this instant, like a walk-in.
    const turn = turnMinutes(r.partySize, config.turnBands ?? DEFAULT_TURN_BANDS);
    const fit = await fitNow(tx, r.partySize, config, now);
    if (!fit.seatable) return { ok: false, reason: 'no_table' };
    const tableIds = await firstUnit(tx, fit.units, async (tableIds) => {
      await tx.tableHold.createMany({ data: tableIds.map((tableId) => ({ reservationId: r.id, tableId, startAt: now, endAt: plusMs(now, turn * 60_000) })) });
      return tableIds;
    });
    if (!tableIds) return { ok: false, reason: 'no_table' };
    seat = { tableIds, startAt: now, turnMinutes: turn };
  } else if (d.tables === 'acquire') {
    // Undoing a no-show, cancel or clear: the SAME tables and window as booked,
    // which the constraint refuses if someone was seated there meanwhile.
    const back = await firstUnit(tx, [{ tableIds: r.tableIds }], (tableIds) =>
      tx.tableHold.createMany({ data: tableIds.map((tableId) => ({ reservationId: r.id, tableId, startAt: r.startAt, endAt: plusMs(r.startAt, r.turnMinutes * 60_000) })) }),
    );
    if (!back) return { ok: false, reason: 'table_taken' };
  }
  await tx.reservation.update({ where: { id: r.id }, data: { ...seat, status: d.to, statusChangedAt: now } });
  await tx.reservationEvent.create({ data: { reservationId: r.id, at: now, fromStatus: d.from, toStatus: d.to, source: 'host', note } });
  return { ok: true, status: d.to };
}

/**
 * The walk-in engine fed from what holds tables around `now`, read inside the
 * transaction.
 *
 * `windowMinutes` checks a window other than a fresh turn — the remainder of
 * a seated party's turn, when a host moves them (P0-14). `except` leaves one
 * reservation out of the occupied set, so a party being moved does not block
 * their own move by holding the table they are sitting at.
 */
async function fitNow(tx: Prisma.TransactionClient, partySize: number, config: FloorConfig, now: Date, windowMinutes?: number, except?: string) {
  const plan = await loadPlan(tx, config.overSeatCap);
  const day = 24 * 3_600_000;
  const held = await tx.reservation.findMany({
    where: { status: { in: [...HOLDS_TABLES] }, startAt: { gt: plusMs(now, -day), lt: plusMs(now, day) }, ...(except && { id: { not: except } }) },
    select: { startAt: true, partySize: true, turnMinutes: true, tableIds: true, status: true },
  });
  return walkIn({
    partySize,
    plan,
    reservations: held.map((r) => ({ ...r, start: r.startAt, seated: r.status === 'seated' })),
    now,
    turnBands: config.turnBands ?? DEFAULT_TURN_BANDS,
    windowMinutes,
  });
}

// ─── Manual assignment (P0-14) ──────────────────────────────────────────────
//
// The host names the unit; the transaction still decides. This is the most
// dangerous feature in the product because it invites exactly the
// check-then-write the project exists to avoid, so the rule is narrow: a
// host-named unit is an INPUT to the same allocation, never a bypass of it.
// `firstUnit(units)` becomes "this unit, if it is in `units`" and nothing
// else changes — same advisory lock, same schedule re-read under the lock,
// same exclusion constraint. If the board says free and the constraint
// disagrees, the constraint is right.

/** `unit_held`: the unit fits, but someone else has it for the window. */
export type AssignRefusal = UnitMisfit | Rejection | 'not_found' | 'not_assignable' | 'unit_held' | 'outside_hours' | 'over_pacing_cap' | 'no_longer_available';

export type AssignResult = { ok: true; status: Status; tableIds: string[]; from: string[] } | { ok: false; reason: AssignRefusal };

/**
 * Whether a host may name a table for this status. Derived from the ONE
 * lifecycle module plus the one status that is deliberately not in it:
 * `waitlisted` holds no tables precisely because it is waiting for one, and
 * naming it a table is how it stops waiting. Everything terminal is out.
 */
const assignable = (s: Status) => s === 'waitlisted' || holdsTables(s);

/** The engine's refusal, in the host's vocabulary. */
function assignReason(reason: string): AssignRefusal {
  switch (reason) {
    case 'closed':
    case 'past':
      return 'outside_hours';
    case 'pacing':
      return 'over_pacing_cap';
    case 'full':
      return 'unit_held';
    case 'too_large':
    case 'too_small':
      return reason;
    // `invalid_day` and `too_far` are facts about a request; a stored
    // reservation's day was validated when it was booked.
    default:
      return 'not_assignable';
  }
}

/**
 * Put this party on this unit. An assignment and a move are the same
 * operation — the difference is only whether the party already had a table.
 *
 * Which engine answers depends on where the party IS, not on what the host
 * tapped. A future reservation goes through `fit`: inventory planning, so
 * the pacing cap applies. A party already in the building — seated, or
 * waitlisted at the stand — goes through `walkIn`: no pacing and no service
 * period, matching v1's "walk-ins skip pacing". The asymmetry is deliberate.
 */
/**
 * Every unit a host may name. The picker offers them ALL, deliberately: the
 * engine's fitting set is not a filter on the menu, because `too_small` on a
 * table a host expected to work teaches them the rule, and a silently missing
 * option teaches them nothing. Same reasoning as the PRD's "a greyed-out slot
 * is just UX" — the transaction is what refuses.
 */
export const loadUnits = async (config: FloorConfig): Promise<PlanUnit[]> => allUnits(await loadPlan(prisma, config.overSeatCap));

export async function assignUnit(id: string, unitId: string, config: FloorConfig, now: Date): Promise<AssignResult> {
  return prisma.$transaction(async (tx): Promise<AssignResult> => {
    const r = await locked(tx, id);
    if (!r) return { ok: false, reason: 'not_found' };
    const status = parseStatus(r.status);
    if (!assignable(status)) return { ok: false, reason: 'not_assignable' };

    const plan = await loadPlan(tx, config.overSeatCap);
    // The floor-plan rules first, and one at a time: they depend on nothing
    // that can change under us, and naming the rule that refused is the whole
    // point of the item. A host hears "T4 seats six, they are three" — never
    // a bare no, and never a silently forced seat.
    const misfit = unitMisfit(plan, unitId, r.partySize);
    if (misfit) return { ok: false, reason: misfit };
    const unit = allUnits(plan).find((u) => u.id === unitId)!;

    const bands = config.turnBands ?? DEFAULT_TURN_BANDS;
    const inBuilding = status === 'seated' || status === 'waitlisted';

    // The window being taken. A seated party's turn is anchored to the seat
    // event they already had and does NOT restart because the table did: a
    // party seated 19:00 on a 90-minute turn ends 20:30 whether or not they
    // move at 19:20, so the new unit must be free for the remainder only.
    // Restarting it would silently extend the new table's occupancy past the
    // free-until the board displayed a moment earlier.
    const turn = status === 'waitlisted' ? turnMinutes(r.partySize, bands) : r.turnMinutes;
    const anchor = status === 'waitlisted' ? now : r.startAt;
    const holdStart = inBuilding ? now : r.startAt;
    // A lingering party is past their window but still holds the table. They
    // borrow `walkIn`'s own assumption — gone within one slot — rather than
    // inventing a second one, and a CHECK refuses a zero-length hold anyway.
    const floor = plusMs(now, SLOT_MINUTES * 60_000);
    const turnEnd = plusMs(anchor, turn * 60_000);
    const holdEnd = !inBuilding || turnEnd.getTime() > floor.getTime() ? turnEnd : floor;

    let free: readonly { id: string }[];
    if (inBuilding) {
      const fitted = await fitNow(tx, r.partySize, config, now, Math.round((holdEnd.getTime() - now.getTime()) / 60_000), id);
      if (!fitted.seatable) return { ok: false, reason: fitted.reason === 'wait' ? 'unit_held' : fitted.reason };
      free = fitted.units;
    } else {
      // `fit` is asked which units fit a window this reservation ALREADY
      // owns, so its past-slot gate is stepped behind the seating rather than
      // applied: a host assigning a table to a party ten minutes late is the
      // ordinary case, and refusing it would make the feature useless in
      // service. Everything else about `fit` is untouched — the schedule
      // lock, the re-read under it, the bucket lock and the pacing cap.
      const asOf = now.getTime() < r.startAt.getTime() ? now : plusMs(r.startAt, -1);
      const f = await fit(tx, { day: r.businessDay, startAt: r.startAt, partySize: r.partySize, now: asOf }, config, id);
      if (!f.ok) return { ok: false, reason: assignReason(f.reason) };
      free = f.units;
    }
    if (!free.some((u) => u.id === unitId)) return { ok: false, reason: 'unit_held' };

    // Seating a waitlisted party is a status change and goes through the ONE
    // lifecycle module; moving an already-seated or booked party is not.
    const seat = status === 'waitlisted' ? transition({ status, startAt: r.startAt }, 'seated', 'host', now) : null;
    if (seat && !seat.ok) return seat;

    // The old holds are deleted and the new ones inserted INSIDE the
    // savepoint, so a refusal restores the old ones with it: there is no
    // moment, committed or not, where the party holds nothing. Delete-first
    // rather than the spec's acquire-first because within one savepoint they
    // are the same guarantee, and this order also handles a move onto a unit
    // that shares a table with the current one.
    const taken = await firstUnit(tx, [unit], async (tableIds) => {
      await tx.tableHold.deleteMany({ where: { reservationId: r.id } });
      await tx.tableHold.createMany({ data: tableIds.map((tableId) => ({ reservationId: r.id, tableId, startAt: holdStart, endAt: holdEnd })) });
      return tableIds;
    });
    if (!taken) return { ok: false, reason: 'no_longer_available' };

    await tx.reservation.update({
      where: { id: r.id },
      data: { tableIds: taken, ...(seat?.ok && { status: seat.to, statusChangedAt: now, startAt: now, turnMinutes: turn }) },
    });
    await tx.reservationEvent.create({
      data: {
        reservationId: r.id,
        at: now,
        fromStatus: status,
        toStatus: seat?.ok ? seat.to : status,
        source: 'host',
        note: r.tableIds.length === 0 ? `seated at ${unitId}` : `moved from ${r.tableIds.join('+')} to ${unitId}`,
        // Non-empty is what marks a move for `undoLast`: its undo puts TABLES
        // back, not a status. A waitlisted party had none, and their undo is
        // the ordinary status revert.
        fromTableIds: r.tableIds,
      },
    });
    return { ok: true, status: seat?.ok ? seat.to : status, tableIds: taken, from: r.tableIds };
  }, TX);
}

export type WalkInRequest = GuestFields & {
  idempotencyKey: string;
  /** The restaurant day the party is standing in. */
  day: string;
  partySize: number;
  /** The guest agreed to WAITLIST_CONSENT. Needs a number. */
  textWhenReady: boolean;
  now: Date;
};

export type WalkInResult =
  | { ok: true; reservation: Reservation; replayed: boolean }
  | { ok: false; reason: 'invalid'; field: InvalidField }
  | { ok: false; reason: 'too_large' | 'too_small' | 'no_longer_available' };

/**
 * A party at the stand (P0-9): seated now if a table is free for their whole
 * turn, otherwise waitlisted with the quoted range stored as said. Walk-ins
 * skip pacing — see `walkIn` in core.
 */
export async function addWalkIn(req: WalkInRequest, config: FloorConfig): Promise<WalkInResult> {
  const replay = async (): Promise<WalkInResult | null> => {
    const existing = await prisma.reservation.findUnique({ where: { idempotencyKey: req.idempotencyKey } });
    return existing && { ok: true, reservation: existing, replayed: true };
  };

  // Same shape as `placeReservation`, and for the same reasons — this path
  // had neither half of it. `fitNow` takes no bucket lock, so two taps of one
  // walk-in form could both reach `create` and the loser's P2002 escaped as
  // an unhandled rejection instead of a result; and a loser that stopped at
  // `fitNow` instead was told `no_longer_available` for a party its own twin
  // had already seated.
  const first = await replay();
  if (first) return first;

  const field = invalidGuestField(req) ?? (req.textWhenReady && req.guestPhone === null ? 'guestPhone' : null);
  if (field) return { ok: false, reason: 'invalid', field };

  try {
    const result = await walkInTx(req, config);
    return result.ok ? result : ((await replay()) ?? result);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const r = await replay();
      if (r) return r;
    }
    throw e;
  }
}

function walkInTx(req: WalkInRequest, config: FloorConfig): Promise<WalkInResult> {
  return prisma.$transaction(async (tx): Promise<WalkInResult> => {
    const fit = await fitNow(tx, req.partySize, config, req.now);
    if (!fit.seatable && fit.reason !== 'wait') return { ok: false, reason: fit.reason };
    const turn = turnMinutes(req.partySize, config.turnBands ?? DEFAULT_TURN_BANDS);
    const base = {
      idempotencyKey: req.idempotencyKey,
      businessDay: req.day,
      startAt: req.now,
      partySize: req.partySize,
      turnMinutes: turn,
      guestName: req.guestName.trim(),
      guestPhone: req.guestPhone,
      note: req.note || null,
      tags: [...(req.tags ?? [])],
      createdAt: req.now,
      statusChangedAt: req.now,
      manageToken: newManageToken(),
    };
    const create = async (data: Prisma.ReservationCreateInput) => {
      const reservation = await tx.reservation.create({ data });
      await tx.reservationEvent.create({ data: { reservationId: reservation.id, at: req.now, fromStatus: null, toStatus: reservation.status, source: 'host', note: 'walk-in' } });
      return reservation;
    };

    if (fit.seatable) {
      const reservation = await firstUnit(tx, fit.units, (tableIds) =>
        create({ ...base, status: 'seated', tableIds, holds: { create: tableIds.map((tableId) => ({ tableId, startAt: req.now, endAt: plusMs(req.now, turn * 60_000) })) } }),
      );
      return reservation ? { ok: true, reservation, replayed: false } : { ok: false, reason: 'no_longer_available' };
    }
    const reservation = await create({
      ...base,
      status: 'waitlisted',
      tableIds: [],
      quotedWait: `${fit.wait.fromMinutes}-${fit.wait.toMinutes} min`,
      smsConsent: req.textWhenReady ? WAITLIST_CONSENT : null,
    });
    return { ok: true, reservation, replayed: false };
  }, TX);
}

export type ReadyResult = { ok: true; sent: boolean } | { ok: false; reason: 'not_found' | 'not_waitlisted' | 'no_consent' };

/**
 * "Your table is ready" (A12) to a waitlisted party, sent now rather than on
 * the next sweep — a text that arrives five minutes late is no text. Quiet
 * hours never hold it (compliance.ts); STOP and the daily limit still do, and
 * a drop shows on the row as a failed text. One per party, by constraint: a
 * second tap sends nothing.
 */
export async function tableReady(id: string, provider: MessageProvider, config: FloorConfig, now: Date): Promise<ReadyResult> {
  const r = await prisma.reservation.findUnique({ where: { id } });
  if (!r) return { ok: false, reason: 'not_found' };
  if (r.status !== 'waitlisted') return { ok: false, reason: 'not_waitlisted' };
  if (!r.smsConsent || !r.guestPhone) return { ok: false, reason: 'no_consent' };
  const body = renderMessage((config.templates ?? DEFAULT_TEMPLATES).table_ready, { restaurant: config.restaurant });
  await prisma.outboundMessage.createMany({
    data: [{ reservationId: id, kind: 'table_ready', toPhone: r.guestPhone, body, status: 'queued', createdAt: now, statusChangedAt: now }],
    skipDuplicates: true,
  });
  const moved = await dispatchQueued(provider, now, config);
  return { ok: true, sent: moved.some((m) => m.reservationId === id && m.kind === 'table_ready' && m.status === 'sent') };
}
