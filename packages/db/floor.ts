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
  DEFAULT_POLICY,
  DEFAULT_TEMPLATES,
  DEFAULT_TURN_BANDS,
  HOLDS_TABLES,
  invalidGuestField,
  parseStatus,
  plusMs,
  renderMessage,
  revert,
  transition,
  turnMinutes,
  walkIn,
  type Actor,
  type Decision,
  type GuestFields,
  type InvalidField,
  type MessageKind,
  type Rejection,
  type SendPolicy,
  type Status,
  type Templates,
  type TurnBands,
} from '@reserve/core';
import { Prisma, prisma, type Reservation } from './index';
import { dispatchQueued, newManageToken, type MessageProvider } from './messages';
import { firstUnit, loadPlan } from './placement';

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
    const undo =
      last &&
      revert({ status, startAt: r.startAt }, { fromStatus: last.fromStatus === null ? null : parseStatus(last.fromStatus), toStatus: parseStatus(last.toStatus), at: last.at, actor: actorOf(last.source) }, now);
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

/** The walk-in engine fed from what holds tables around `now`, read inside the transaction. */
async function fitNow(tx: Prisma.TransactionClient, partySize: number, config: FloorConfig, now: Date) {
  const plan = await loadPlan(tx, config.overSeatCap);
  const day = 24 * 3_600_000;
  const held = await tx.reservation.findMany({
    where: { status: { in: [...HOLDS_TABLES] }, startAt: { gt: plusMs(now, -day), lt: plusMs(now, day) } },
    select: { startAt: true, partySize: true, turnMinutes: true, tableIds: true, status: true },
  });
  return walkIn({
    partySize,
    plan,
    reservations: held.map((r) => ({ ...r, start: r.startAt, seated: r.status === 'seated' })),
    now,
    turnBands: config.turnBands ?? DEFAULT_TURN_BANDS,
  });
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
