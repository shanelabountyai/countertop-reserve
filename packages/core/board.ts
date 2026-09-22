// The table board (P0-13) — table-major, pure, `now` is a parameter.
//
// `availability()` answers "when can a party of N sit"; this answers "what is
// THIS table doing". Neither is implemented in terms of the other's output
// shape, but both take their occupancy from the same `HOLDS_TABLES` list
// (lifecycle.ts): the caller filters by status, this function never guesses.
//
// The requirement the item exists for: **every `free` carries its
// free-until**. A table free now but held in 40 minutes is not free for a
// 90-minute walk-in, and a bare green dot is the defect.
//
// A combination is a unit of inventory, not a display detail. It gets its own
// row; committing it puts every member table into `blocked` naming the
// combination, and committing a member puts the combination into `blocked`
// naming the member. A combination whose member is committed can never read
// `free`.

import type { HeldReservation } from './availability';
import { allUnits, type FloorPlan, type Unit } from './floor-plan';
import { plusMs } from './time';

/**
 * How soon a hold has to start before its unit stops reading `free`. Past
 * this, `free` is honest as long as it carries the free-until.
 */
export const DEFAULT_BOARD_HORIZON_MINUTES = 30;

/**
 * A reservation that holds tables, for the board. Same snapshot rule as
 * `HeldReservation`: its OWN tables and turn, never recomputed from today's
 * floor plan or turn bands.
 */
export type BoardReservation = HeldReservation & {
  id: string;
  guestName: string;
  /** Status is `seated`: they hold the table until the host clears it, even past their turn. */
  seated: boolean;
  /** The seat event's instant, for "since". Falls back to the booked start. */
  seatedAt?: Date | null;
};

export type BoardParty = { reservationId: string; guestName: string; partySize: number };

export type TableStateRow = { unit: Unit; section: string } & (
  /** `freeUntil` null = free for the rest of what was passed in. */
  | { state: 'free'; freeUntil: Date | null; freeMinutes: number | null }
  | { state: 'occupied'; party: BoardParty; since: Date; expectedClear: Date; overdue: boolean }
  /** `inMinutes` is signed: a negative value is a party who is late, not an error. */
  | { state: 'reserved_soon'; party: BoardParty; start: Date; inMinutes: number }
  /** `by`: the unit ids that took this one — its combination, or its committed members. */
  | { state: 'blocked'; by: readonly string[] }
);

/** Every state the board must render. A fifth one fails to compile at each reader. */
export type TableState = TableStateRow['state'];

const key = (tableIds: readonly string[]) => [...tableIds].sort().join('|');
const endMs = (r: BoardReservation) => r.start.getTime() + r.turnMinutes * 60_000;
const partyOf = (r: BoardReservation): BoardParty => ({ reservationId: r.id, guestName: r.guestName, partySize: r.partySize });

export function tableStates(
  plan: FloorPlan,
  reservations: readonly BoardReservation[],
  now: Date,
  horizonMinutes: number = DEFAULT_BOARD_HORIZON_MINUTES,
): TableStateRow[] {
  const n = now.getTime();
  const horizonEnd = n + horizonMinutes * 60_000;
  const units = allUnits(plan);
  const named = new Map(units.map((u) => [key(u.tableIds), u.id]));
  // An undeclared set of tables is named by its tables rather than dropped:
  // it still takes the inventory, so the board still has to say what took it.
  const nameFor = (tableIds: readonly string[]) => named.get(key(tableIds)) ?? [...tableIds].join('+');

  // A seated party holds the table until cleared — a long turn past its
  // expected clear reads `occupied`, never `free`.
  const committedNow = (r: BoardReservation) => r.seated || (r.start.getTime() <= n && n < endMs(r));
  const imminent = (r: BoardReservation) => r.start.getTime() > n && r.start.getTime() <= horizonEnd;

  return units.map((u): TableStateRow => {
    const base = { unit: { id: u.id, tableIds: u.tableIds, seats: u.seats, combination: u.combination } satisfies Unit, section: u.section };
    const touching = reservations.filter((r) => r.tableIds.some((t) => u.tableIds.includes(t)));
    // `own` = a hold on exactly this unit's tables. Anything else touching a
    // member is a different unit's commitment, and blocks this one.
    const mine = key(u.tableIds);
    const own = touching.filter((r) => key(r.tableIds) === mine);
    const foreign = touching.filter((r) => key(r.tableIds) !== mine);

    const sitting = own.find((r) => r.seated);
    if (sitting) {
      const expectedClear = plusMs(sitting.start, sitting.turnMinutes * 60_000);
      return { ...base, state: 'occupied', party: partyOf(sitting), since: sitting.seatedAt ?? sitting.start, expectedClear, overdue: expectedClear.getTime() <= n };
    }

    const soon = own.find((r) => committedNow(r) || imminent(r));
    if (soon) return { ...base, state: 'reserved_soon', party: partyOf(soon), start: soon.start, inMinutes: Math.round((soon.start.getTime() - n) / 60_000) };

    const blockers = foreign.filter((r) => committedNow(r) || imminent(r));
    if (blockers.length > 0) return { ...base, state: 'blocked', by: [...new Set(blockers.map((r) => nameFor(r.tableIds)))] };

    // Free-until is the next hold on ANY member table, this unit's or not: a
    // combination booked at 19:40 ends its deuces' free windows too. Floor,
    // never round — a 39½-minute window must not read as 40.
    const next = touching.filter((r) => r.start.getTime() > n).sort((a, b) => a.start.getTime() - b.start.getTime())[0];
    if (!next) return { ...base, state: 'free', freeUntil: null, freeMinutes: null };
    return { ...base, state: 'free', freeUntil: next.start, freeMinutes: Math.floor((next.start.getTime() - n) / 60_000) };
  });
}
