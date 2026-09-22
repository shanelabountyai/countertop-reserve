// Availability engine (P0-2) — pure, `now` is a parameter.
//
// ONE function answers "is this party/time bookable?" for the guest flow, the
// host floor view and change requests (CLAUDE.md). A time is bookable only if
// some unit is free for the FULL turn AND the pacing cap for its 15-minute
// bucket has room. Every non-bookable slot carries a reason, and so does an
// empty day — the UI has to say something true.

import { fittingUnits, largestUnitSeats, turnMinutes, DEFAULT_TURN_BANDS, type FloorPlan, type TurnBands, type Unit } from './floor-plan';
import { dayOf, minuteOfDay, plusMs, weekdayOf, zonedTimeToInstant } from './time';

export const SLOT_MINUTES = 15;

export type ServicePeriod = {
  name: string;
  /** Local minutes since midnight. Close is exclusive. */
  openMinute: number;
  closeMinute: number;
  /**
   * Explicit "last seating" (P0-10). When set, starts up to and including it
   * are offered even if the turn overhangs close. When absent, a turn must
   * end by close.
   */
  lastSeatingMinute?: number;
  /** Max covers whose seating starts in one 15-minute bucket. */
  pacingCap: number;
};

export type Schedule = {
  timezone: string;
  /** Indexed by weekday, 0 = Sunday. */
  weekly: readonly (readonly ServicePeriod[])[];
  /** Per-date replacement for the weekly periods, keyed "YYYY-MM-DD". */
  overrides: Readonly<Record<string, readonly ServicePeriod[]>>;
  blackouts: readonly string[];
};

/**
 * A reservation that currently holds tables. Uses the reservation's OWN
 * snapshotted tables and turn — never recomputed from today's floor plan or
 * turn bands (snapshot rule).
 *
 * The caller passes only reservations whose status is in `HOLDS_TABLES`
 * (lifecycle.ts) — the one source of the occupied set.
 */
export type HeldReservation = {
  start: Date;
  partySize: number;
  turnMinutes: number;
  tableIds: readonly string[];
};

export type SlotReason = 'past' | 'closed' | 'full' | 'pacing';
export type DayReason = SlotReason | 'too_large' | 'too_small';

/**
 * How far ahead a table can be booked. Lived only in the booking page's
 * `<input max>` — a hint a client edits away — so the server took a booking
 * for any date the weekly schedule happened to be open on. Both the new
 * booking and the guest change now refuse past it, and the input's `max`
 * reads from here so the two cannot drift.
 */
export const BOOKING_HORIZON_DAYS = 60;

/**
 * The last restaurant-calendar day bookable at `now`. Compared as DAYS, not
 * instants: the horizon names a date, so a 22:00 slot on the last day is not
 * "too far" merely because the sweep happens to run at 09:00.
 */
export const lastBookableDay = (now: Date, timezone: string): string =>
  dayOf(plusMs(now, BOOKING_HORIZON_DAYS * 86_400_000), timezone);

export type Slot = { minute: number; start: Date; period: string } & (
  | { bookable: true; units: Unit[] }
  | { bookable: false; reason: SlotReason }
);

export type Availability = {
  slots: Slot[];
  /** Null iff at least one slot is bookable. */
  reason: DayReason | null;
};

export type AvailabilityInput = {
  day: string;
  partySize: number;
  plan: FloorPlan;
  schedule: Schedule;
  reservations: readonly HeldReservation[];
  now: Date;
  turnBands?: TurnBands;
};

/** When nothing is bookable, the reason a guest should hear first. */
const REASON_PRIORITY: readonly SlotReason[] = ['full', 'pacing', 'closed', 'past'];

export function periodsFor(schedule: Schedule, day: string): readonly ServicePeriod[] {
  if (schedule.blackouts.includes(day)) return [];
  return schedule.overrides[day] ?? schedule.weekly[weekdayOf(day)] ?? [];
}

/** The period a local minute-of-day falls in. Close is exclusive; periods never overlap (DB exclusion constraint). */
export function periodAt(periods: readonly ServicePeriod[], minute: number): ServicePeriod | undefined {
  return periods.find((p) => minute >= p.openMinute && minute < p.closeMinute);
}

/**
 * Does a turn starting at `minute` seat within this period (P0-10)? An
 * explicit last seating replaces the overhang rule rather than adding to it:
 * that is the whole point of declaring one.
 */
export function withinSeating(period: ServicePeriod, minute: number, turn: number): boolean {
  return period.lastSeatingMinute === undefined ? minute + turn <= period.closeMinute : minute <= period.lastSeatingMinute;
}

export type HoursConflict<T> = { row: T; reason: 'closed' | 'overhang' };

/**
 * The hours-edit diff warning (P0-10): which already-booked reservations a
 * schedule would strand. Pure — the caller passes the upcoming rows and the
 * schedule as it WOULD be, and decides whether to go ahead anyway.
 *
 * `closed` = no period contains the seating at all (including a blackout);
 * `overhang` = inside a period but starting after its last seating, or a turn
 * that now runs past close.
 */
export function outsideHours<T extends { businessDay: string; startAt: Date; turnMinutes: number }>(
  schedule: Schedule,
  rows: readonly T[],
): HoursConflict<T>[] {
  return rows.flatMap((row): HoursConflict<T>[] => {
    const minute = minuteOfDay(row.startAt, schedule.timezone);
    const period = periodAt(periodsFor(schedule, row.businessDay), minute);
    if (!period) return [{ row, reason: 'closed' as const }];
    return withinSeating(period, minute, row.turnMinutes) ? [] : [{ row, reason: 'overhang' as const }];
  });
}

export function availability(input: AvailabilityInput): Availability {
  const { day, partySize, plan, schedule, reservations, now } = input;
  if (!Number.isInteger(partySize) || partySize < 1) throw new Error(`Invalid party size: ${partySize}`);

  const units = fittingUnits(plan, partySize);
  if (units.length === 0) {
    return { slots: [], reason: partySize > largestUnitSeats(plan) ? 'too_large' : 'too_small' };
  }

  const periods = periodsFor(schedule, day);
  if (periods.length === 0) return { slots: [], reason: 'closed' };

  const turnMs = turnMinutes(partySize, input.turnBands ?? DEFAULT_TURN_BANDS) * 60_000;
  const slotMs = SLOT_MINUTES * 60_000;
  const slots: Slot[] = [];

  for (const period of periods) {
    for (let minute = period.openMinute; minute < period.closeMinute; minute += SLOT_MINUTES) {
      const start = zonedTimeToInstant(day, minute, schedule.timezone);
      const s = start.getTime();
      const base = { minute, start, period: period.name };

      let reason: SlotReason | null = null;
      let free: Unit[] = [];
      if (s <= now.getTime()) reason = 'past';
      else if (!withinSeating(period, minute, turnMs / 60_000)) reason = 'closed';
      else {
        free = freeUnits(units, reservations, s, turnMs);
        const bucketCovers = reservations
          .filter((r) => r.start.getTime() >= s && r.start.getTime() < s + slotMs)
          .reduce((sum, r) => sum + r.partySize, 0);
        if (free.length === 0) reason = 'full';
        else if (bucketCovers + partySize > period.pacingCap) reason = 'pacing';
      }

      slots.push(reason === null ? { ...base, bookable: true, units: free } : { ...base, bookable: false, reason });
    }
  }

  if (slots.some((slot) => slot.bookable)) return { slots, reason: null };
  const present = new Set(slots.map((slot) => (slot.bookable ? null : slot.reason)));
  return { slots, reason: REASON_PRIORITY.find((r) => present.has(r)) ?? 'closed' };
}

/** The units free for the whole of [start, start + turn). Half-open: a table freed at 19:00 seats a 19:00 party. */
function freeUnits(units: readonly Unit[], reservations: readonly HeldReservation[], startMs: number, turnMs: number): Unit[] {
  const busy = new Set(
    reservations
      .filter((r) => r.start.getTime() < startMs + turnMs && startMs < r.start.getTime() + r.turnMinutes * 60_000)
      .flatMap((r) => r.tableIds),
  );
  return units.filter((u) => u.tableIds.every((t) => !busy.has(t)));
}

/** A quoted wait is a RANGE, never a point (P0-9): the low end, then this much on top. */
export const QUOTE_SPREAD_MINUTES = 15;
const QUOTE_STEP_MINUTES = 5;

export type WalkInInput = {
  partySize: number;
  plan: FloorPlan;
  /** Held reservations, as for `availability`; `seated` marks a party physically at the table. */
  reservations: readonly (HeldReservation & { seated?: boolean })[];
  now: Date;
  turnBands?: TurnBands;
  /**
   * Check this window instead of a fresh turn (P0-14). Set only when moving
   * an already-seated party: their window is anchored to the seat event they
   * already had, so the new table must be free for the REMAINDER — a party
   * seated 19:00 on a 90-minute turn who moves at 19:20 needs 19:20–20:30,
   * not a fresh 90 minutes. Restarting the turn would silently extend the
   * new table's occupancy past the free-until the board showed a moment ago.
   */
  windowMinutes?: number | undefined;
};

export type WalkIn =
  | { seatable: true; units: Unit[] }
  | { seatable: false; reason: 'too_large' | 'too_small' }
  /** In whole minutes from now. */
  | { seatable: false; reason: 'wait'; wait: { fromMinutes: number; toMinutes: number } };

/**
 * A party at the host stand NOW (P0-9): the table half of `availability` at an
 * arbitrary instant, off the 15-minute grid. No pacing and no service-period
 * check — the party is already here, and seating them past a pacing cap is
 * the host's call to make, not the app's to refuse.
 *
 * A seated party still at the table after its booked turn is assumed to
 * leave within one slot, so its table is never offered as free while they
 * sit there.
 *
 * ponytail: the quote ignores parties already waitlisted ahead, so a second
 * waiting two-top is quoted the same table as the first. P1-2 (measured turn
 * times) is where quoting gets honest; queue position belongs with it.
 */
export function walkIn(input: WalkInInput): WalkIn {
  const { partySize, plan, now } = input;
  if (!Number.isInteger(partySize) || partySize < 1) throw new Error(`Invalid party size: ${partySize}`);
  const units = fittingUnits(plan, partySize);
  if (units.length === 0) return { seatable: false, reason: partySize > largestUnitSeats(plan) ? 'too_large' : 'too_small' };

  const n = now.getTime();
  const slotMs = SLOT_MINUTES * 60_000;
  const held = input.reservations.map((r) => {
    const end = r.start.getTime() + r.turnMinutes * 60_000;
    return r.seated && end < n + slotMs ? { ...r, turnMinutes: (n + slotMs - r.start.getTime()) / 60_000 } : r;
  });
  const turnMs = (input.windowMinutes ?? turnMinutes(partySize, input.turnBands ?? DEFAULT_TURN_BANDS)) * 60_000;

  const free = freeUnits(units, held, n, turnMs);
  if (free.length > 0) return { seatable: true, units: free };

  // A unit can only come free when some hold ends: try each end in order.
  // After the last one nothing is held, so the fallback is never a guess.
  const ends = [...new Set(held.map((r) => r.start.getTime() + r.turnMinutes * 60_000))].filter((e) => e > n).sort((a, b) => a - b);
  const first = ends.find((e) => freeUnits(units, held, e, turnMs).length > 0) ?? Math.max(n, ...ends);
  const fromMinutes = Math.ceil((first - n) / 60_000 / QUOTE_STEP_MINUTES) * QUOTE_STEP_MINUTES;
  return { seatable: false, reason: 'wait', wait: { fromMinutes, toMinutes: fromMinutes + QUOTE_SPREAD_MINUTES } };
}
