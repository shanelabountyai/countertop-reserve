// Service periods, overrides, blackouts and pacing, read from the database
// (P0-10). The availability engine still takes a plain `Schedule`; this is
// the only place that builds one.
//
// Every edit runs through ONE function. It applies the change, reloads the
// schedule, and asks the engine which upcoming reservations the new hours
// would strand — inside the transaction, so a warning rolls the change back
// untouched. Simulating the edit in memory instead would give the host a
// warning computed by different code than the one that ends up stored; this
// way the diff is against the real rows, and the exclusion constraints get
// their say in the same breath.

import { outsideHours, UPCOMING, type HoursConflict, type Schedule, type ServicePeriod } from '@reserve/core';
import { Prisma, prisma } from './index';

/** A stranded reservation, as the host screen names it. */
export type StrandedRow = { id: string; guestName: string; businessDay: string; startAt: Date; partySize: number; turnMinutes: number };

export type ScheduleEdit =
  | { kind: 'addPeriod'; period: { weekday: number | null; day: string | null; name: string; openMinute: number; closeMinute: number; lastSeatingMinute: number | null; pacingCap: number } }
  | { kind: 'removePeriod'; id: string }
  | { kind: 'addBlackout'; day: string; reason: string | null }
  | { kind: 'removeBlackout'; day: string };

export type EditResult =
  | { ok: true }
  /** The edit is sound but would strand these — re-submit with `force` to go ahead. */
  | { ok: false; reason: 'strands'; conflicts: HoursConflict<StrandedRow>[] }
  | { ok: false; reason: 'overlap' | 'invalid' | 'not_found' };

/** The schedule as the engine wants it. `timezone` stays app config (PRD, P0-11). */
export async function loadSchedule(timezone: string, tx: Prisma.TransactionClient = prisma): Promise<Schedule> {
  const [rows, blackouts] = await Promise.all([tx.servicePeriod.findMany({ orderBy: { openMinute: 'asc' } }), tx.blackout.findMany({ orderBy: { day: 'asc' } })]);
  const weekly: ServicePeriod[][] = Array.from({ length: 7 }, () => []);
  const overrides: Record<string, ServicePeriod[]> = {};
  for (const r of rows) {
    // null → absent: `lastSeatingMinute?: number` is what the engine branches on.
    const period: ServicePeriod = {
      name: r.name,
      openMinute: r.openMinute,
      closeMinute: r.closeMinute,
      pacingCap: r.pacingCap,
      ...(r.lastSeatingMinute !== null && { lastSeatingMinute: r.lastSeatingMinute }),
    };
    if (r.day !== null) (overrides[r.day] ??= []).push(period);
    else if (r.weekday !== null) weekly[r.weekday]?.push(period);
  }
  return { timezone, weekly, overrides, blackouts: blackouts.map((b) => b.day) };
}

/** Everything the host screen shows, in one read. */
export async function loadScheduleRows() {
  const [periods, blackouts] = await Promise.all([
    prisma.servicePeriod.findMany({ orderBy: [{ weekday: 'asc' }, { day: 'asc' }, { openMinute: 'asc' }] }),
    prisma.blackout.findMany({ orderBy: { day: 'asc' } }),
  ]);
  return { periods, blackouts };
}

const OVERLAP = /service_period_(weekly|override)_no_overlap/;
const CHECK = /violates check constraint/;
/** Thrown to roll the applied edit back once we have seen what it would do. */
const ROLL_BACK = Symbol('rollBack');

/**
 * `check` never commits — it is how the host screen shows the diff before
 * asking. `apply` commits unless something would be stranded; `force` commits
 * anyway, which is the host saying they know.
 */
export type EditMode = 'check' | 'apply' | 'force';

export async function editSchedule(edit: ScheduleEdit, timezone: string, now: Date, mode: EditMode = 'apply'): Promise<EditResult> {
  let conflicts: HoursConflict<StrandedRow>[] = [];
  try {
    await prisma.$transaction(async (tx) => {
      await apply(tx, edit);
      const schedule = await loadSchedule(timezone, tx);
      const rows = await tx.reservation.findMany({
        where: { status: { in: [...UPCOMING] }, startAt: { gte: now } },
        select: { id: true, guestName: true, businessDay: true, startAt: true, partySize: true, turnMinutes: true },
        orderBy: { startAt: 'asc' },
      });
      conflicts = outsideHours(schedule, rows);
      if (mode === 'check' || (conflicts.length > 0 && mode !== 'force')) throw ROLL_BACK;
    });
  } catch (e) {
    if (e === ROLL_BACK) return conflicts.length > 0 ? { ok: false, reason: 'strands', conflicts } : { ok: true };
    const text = String(e);
    if (OVERLAP.test(text)) return { ok: false, reason: 'overlap' };
    if (CHECK.test(text)) return { ok: false, reason: 'invalid' };
    // A row already deleted by the other host on the pass — not an error.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') return { ok: false, reason: 'not_found' };
    throw e;
  }
  return { ok: true };
}

async function apply(tx: Prisma.TransactionClient, edit: ScheduleEdit): Promise<void> {
  switch (edit.kind) {
    case 'addPeriod':
      await tx.servicePeriod.create({ data: edit.period });
      return;
    case 'removePeriod':
      await tx.servicePeriod.delete({ where: { id: edit.id } });
      return;
    case 'addBlackout':
      // Re-blacking-out a date is not an error: the reason is whatever was said last.
      await tx.blackout.upsert({ where: { day: edit.day }, create: { day: edit.day, reason: edit.reason }, update: { reason: edit.reason } });
      return;
    case 'removeBlackout':
      await tx.blackout.delete({ where: { day: edit.day } });
  }
}
