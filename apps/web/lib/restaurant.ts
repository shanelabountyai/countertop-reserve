// The restaurant's facts, in one place for every route and page.
// ponytail: inline until V-011 moves service periods and pacing into the database.
import type { Schedule } from '@reserve/core';

const DINNER = { name: 'Dinner', openMinute: 17 * 60, closeMinute: 22 * 60, pacingCap: 20 };
const LUNCH = { name: 'Lunch', openMinute: 11 * 60 + 30, closeMinute: 14 * 60 + 30, pacingCap: 12 };

export const RESTAURANT = {
  restaurant: 'Firebird Kitchen',
  timezone: 'America/Los_Angeles',
  /** For HELP and the STOP acknowledgement. */
  phone: '+15035550199',
  overSeatCap: 2,
  schedule: {
    timezone: 'America/Los_Angeles',
    weekly: Array.from({ length: 7 }, () => [LUNCH, DINNER]),
    overrides: {},
    blackouts: [],
  } satisfies Schedule,
};
