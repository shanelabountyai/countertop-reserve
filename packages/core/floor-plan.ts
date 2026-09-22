// Floor plan & capacity model (P0-1).
//
// A "unit" is what a party is seated at: one table, or a declared
// combination of tables. A combination is inventory — it consumes EVERY member
// table for the turn — so a unit carries the table ids it occupies, and the
// availability engine checks occupancy per table, never per unit.

export type Table = {
  id: string;
  seats: number;
  /** Smallest party this table may seat — blocks a deuce at an 8-top. */
  minParty: number;
  section: string;
};

/** Declared, never inferred: `[T4, T5] → 4 seats`. */
export type Combination = {
  id: string;
  tableIds: readonly string[];
  seats: number;
  minParty: number;
};

export type FloorPlan = {
  tables: readonly Table[];
  combinations: readonly Combination[];
  /** Max empty seats allowed when over-seating (PRD Open Questions: default 2). */
  overSeatCap: number;
};

export type Unit = { id: string; tableIds: readonly string[]; seats: number; combination: boolean };

/** A unit plus the fields only selection and grouping need. */
export type PlanUnit = Unit & { minParty: number; section: string };

/**
 * EVERY unit on the plan, tables then combinations — the board's inventory
 * list (P0-13) and the set `fittingUnits` filters. A combination takes its
 * section from its first member table; a combination spanning two sections
 * is a floor-plan error, not a case to model.
 */
export function allUnits(plan: FloorPlan): PlanUnit[] {
  const sectionOf = (tableId: string | undefined) => plan.tables.find((t) => t.id === tableId)?.section ?? 'unassigned';
  return [
    ...plan.tables.map((t) => ({ id: t.id, tableIds: [t.id], seats: t.seats, combination: false, minParty: t.minParty, section: t.section })),
    ...plan.combinations.map((c) => ({ id: c.id, tableIds: c.tableIds, seats: c.seats, combination: true, minParty: c.minParty, section: sectionOf(c.tableIds[0]) })),
  ];
}

/** Turn length bands, ascending by `upToParty`; the last band covers every larger party. */
export type TurnBands = readonly { upToParty: number; minutes: number }[];

export const DEFAULT_TURN_BANDS: TurnBands = [
  { upToParty: 2, minutes: 75 },
  { upToParty: 4, minutes: 90 },
  { upToParty: Infinity, minutes: 120 },
];

/** THE turn time for a party size. No caller computes its own. */
export function turnMinutes(partySize: number, bands: TurnBands = DEFAULT_TURN_BANDS): number {
  const band = bands.find((b) => partySize <= b.upToParty) ?? bands.at(-1);
  if (!band) throw new Error('No turn bands configured');
  return band.minutes;
}

/**
 * Every unit that may legally seat `partySize`, best first: least waste, then
 * a single table before a combination (a combination ties up two tables),
 * then id for a stable order.
 */
export function fittingUnits(plan: FloorPlan, partySize: number): Unit[] {
  return allUnits(plan)
    .filter((u) => partySize <= u.seats && partySize >= u.minParty && u.seats - partySize <= plan.overSeatCap)
    .sort(
      (a, b) =>
        a.seats - b.seats ||
        Number(a.combination) - Number(b.combination) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map(({ id, tableIds, seats, combination }) => ({ id, tableIds, seats, combination }));
}

/** The largest party any unit can seat. */
export function largestUnitSeats(plan: FloorPlan): number {
  return Math.max(0, ...plan.tables.map((t) => t.seats), ...plan.combinations.map((c) => c.seats));
}
