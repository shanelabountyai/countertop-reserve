// Availability engine (P0-2) — pure, `now` is a parameter.
//
// ONE function answers "is this party/time bookable?" for the guest flow, the
// host floor view and change requests (CLAUDE.md). A time is bookable only if
// some unit is free for the FULL turn AND the pacing cap for its 15-minute
// bucket has room. Every non-bookable slot carries a reason, and so does an
// empty day — the UI has to say something true.

import { fittingUnits, largestUnitSeats, turnMinutes, DEFAULT_TURN_BANDS, type FloorPlan, type TurnBands, type Unit } from './floor-plan';
import { weekdayOf, zonedTimeToInstant } from './time';

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
 * ponytail: the caller decides which reservations hold tables. V-004's status
 * module becomes the one source of that list.
 */
export type HeldReservation = {
  start: Date;
  partySize: number;
  turnMinutes: number;
  tableIds: readonly string[];
};

export type SlotReason = 'past' | 'closed' | 'full' | 'pacing';
export type DayReason = SlotReason | 'too_large' | 'too_small';

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

      const withinSeating =
        period.lastSeatingMinute === undefined
          ? minute + turnMs / 60_000 <= period.closeMinute
          : minute <= period.lastSeatingMinute;

      let reason: SlotReason | null = null;
      let free: Unit[] = [];
      if (s <= now.getTime()) reason = 'past';
      else if (!withinSeating) reason = 'closed';
      else {
        // Half-open [start, start + turn): a table freed at 19:00 seats a 19:00 party.
        const busy = new Set(
          reservations
            .filter((r) => r.start.getTime() < s + turnMs && s < r.start.getTime() + r.turnMinutes * 60_000)
            .flatMap((r) => r.tableIds),
        );
        free = units.filter((u) => u.tableIds.every((t) => !busy.has(t)));
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
