// Test-only helpers. Not imported by apps/web at runtime — only by specs.
// The identity rules live in ./identity (pure, Prisma-free) so the Playwright
// fixtures can share them; this file is the part that needs a client.
import type { Schedule } from '@reserve/core';
import { prisma } from '../index';
import { assertDisposableTestDatabase, demoResetPermitted, parseTarget } from './identity';

export {
  assertDisposableTestDatabase,
  demoResetPermitted,
  parseTarget,
  testResetPermitted,
  type Verdict,
} from './identity';

async function truncateAll(): Promise<void> {
  // TRUNCATE, not DELETE: the ReservationEvent append-only trigger refuses
  // DELETE by design, and TRUNCATE fires TRUNCATE triggers rather than row
  // triggers.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "OutboundMessage", "ReservationEvent", "InboundMessage", "SmsOptOut",
      "ServicePeriod", "Blackout",
      "TableHold", "Reservation",
      "CombinationMember", "Combination", "DiningTable"
    RESTART IDENTITY CASCADE
  `);
}

/**
 * Wipes every table. TEST SUITE ONLY — refuses anything but the database
 * TEST_DATABASE_NAME declares. `db:seed:demo` uses the sibling below.
 */
export async function resetDatabase(): Promise<void> {
  assertDisposableTestDatabase();
  await truncateAll();
}

/**
 * Wipes every table for `db:seed:demo`. Demo/dev databases only, which is
 * why it is a separate door: the test guard exists precisely to stop the
 * suite doing this, so the demo seed must not be able to borrow it.
 */
export async function resetDatabaseForDemoSeed(): Promise<void> {
  const { host } = parseTarget(process.env.DATABASE_URL ?? '');
  if (!demoResetPermitted(host, process.env.SEED_ALLOW_HOST)) {
    throw new Error(
      `db:seed:demo refuses to wipe non-local database host "${host}". ` +
        `Set SEED_ALLOW_HOST="${host}" to permit it deliberately.`,
    );
  }
  await truncateAll();
}

/**
 * Writes an in-memory `Schedule` into the tables it is normally READ from.
 *
 * `fit` reloads the schedule inside its own transaction now, so that a
 * booking and an hours edit share one boundary. A fixture that only passed a
 * Schedule object was therefore describing hours the database had never heard
 * of, and every slot came back `closed`. Seeding the rows keeps the fixture
 * honest: the test's hours are the ones the engine will actually load.
 */
export async function seedSchedule(schedule: Schedule): Promise<void> {
  const rows = [
    ...schedule.weekly.flatMap((periods, weekday) => periods.map((p) => ({ ...p, weekday, day: null }))),
    ...Object.entries(schedule.overrides).flatMap(([day, periods]) => periods.map((p) => ({ ...p, weekday: null, day }))),
  ];
  await prisma.servicePeriod.createMany({
    data: rows.map((p) => ({ ...p, lastSeatingMinute: p.lastSeatingMinute ?? null })),
  });
  if (schedule.blackouts.length > 0) {
    await prisma.blackout.createMany({ data: schedule.blackouts.map((day) => ({ day })) });
  }
}
