// The restaurant's facts, in one place for every route and page.
//
// What is NOT here: the service periods, overrides, blackouts and pacing caps
// (V-011). Those are rows the host edits — `loadSchedule` from @reserve/db is
// the only way to get a Schedule. The timezone stays here on purpose: the
// calendar every stored day is written in cannot be edited from a screen
// without rewriting every reservation (PRD, P0-11).
export const RESTAURANT = {
  restaurant: 'Firebird Kitchen',
  timezone: 'America/Los_Angeles',
  /** For HELP and the STOP acknowledgement. */
  phone: '+15035550199',
  overSeatCap: 2,
};
