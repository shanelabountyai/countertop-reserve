import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';

// Shared with the Vitest fixtures: a local hostname is not enough, the test
// environment has to NAME the disposable database (TEST_DATABASE_NAME).
import { assertDisposableTestDatabase } from '@reserve/db/testing/identity';

// Service hours, overrides and blackouts (P0-10) against the production
// build. The spec seeds the weekly periods itself rather than trusting the
// migration's: the unit suite truncates every table, and it runs first.
const passcode = process.env.STAFF_PASSCODE ?? '';
const db = new Client({ connectionString: process.env.DATABASE_URL });

// A fixed future date, so `startAt >= now` holds whenever the suite runs.
const DAY = '2027-03-05';

test.beforeAll(async () => {
  expect(passcode, 'STAFF_PASSCODE must be set for e2e (.env.test / CI env)').not.toBe('');
  assertDisposableTestDatabase();
  await db.connect();
});

test.beforeEach(async () => {
  await db.query(`TRUNCATE TABLE "OutboundMessage", "ReservationEvent", "InboundMessage", "SmsOptOut", "TableHold", "Reservation" RESTART IDENTITY CASCADE`);
  await db.query(`TRUNCATE TABLE "ServicePeriod", "Blackout"`);
  // Firebird's own hours, as the migration seeds them: Lunch every day, and a
  // Dinner that declares an explicit last seating.
  await db.query(`INSERT INTO "ServicePeriod" ("id", "weekday", "name", "openMinute", "closeMinute", "lastSeatingMinute", "pacingCap")
    SELECT gen_random_uuid(), d, 'Lunch', 690, 870, NULL, 12 FROM generate_series(0, 6) AS d`);
  await db.query(`INSERT INTO "ServicePeriod" ("id", "weekday", "name", "openMinute", "closeMinute", "lastSeatingMinute", "pacingCap")
    SELECT gen_random_uuid(), d, 'Dinner', 1020, 1320, 1245, 20 FROM generate_series(0, 6) AS d`);
});

test.afterAll(() => db.end());

/** A booked party on DAY at 19:00 restaurant time, holding no table it needs to own. */
async function book(guestName: string) {
  await db.query(
    `INSERT INTO "Reservation" (id, "idempotencyKey", "businessDay", "startAt", "partySize", "turnMinutes", "tableIds", "guestName", "guestPhone",
       status, "createdAt", "statusChangedAt", "manageToken")
     VALUES (gen_random_uuid(), $1, $2, ($2 || ' 19:00')::timestamp AT TIME ZONE 'America/Los_Angeles', 2, 75, ARRAY['T1'], $1, '+15035550101',
       'booked', now(), now(), $1)`,
    [guestName, DAY],
  );
}

async function signIn(page: Page) {
  await page.goto('/host/hours');
  await page.getByLabel('Passcode').fill(passcode);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Hours', level: 1 })).toBeVisible();
}

test('the weekly periods are shown with their last seating and pacing cap, and pass axe', async ({ page }) => {
  await signIn(page);
  const friday = page.getByRole('listitem').filter({ hasText: 'Friday' }).first();
  await expect(friday).toContainText('Dinner');
  await expect(friday).toContainText('17:00–22:00');
  await expect(friday).toContainText('last seating 20:45');
  await expect(friday).toContainText('20 covers per 15 min');

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('a blackout on a date nobody booked saves straight away', async ({ page }) => {
  await signIn(page);
  await page.getByLabel('Date', { exact: true }).fill(DAY);
  await page.getByLabel('Reason').fill('Private hire');
  await page.getByRole('button', { name: 'Close this date' }).click();

  await expect(page.getByText('Hours updated.')).toBeVisible();
  const closed = page.getByRole('listitem').filter({ hasText: 'Private hire' });
  await expect(closed).toContainText(DAY);
  expect((await db.query(`SELECT * FROM "Blackout"`)).rowCount).toBe(1);
});

test('a blackout over a booked date warns first, names the party, and writes nothing until confirmed', async ({ page }) => {
  await book('Stranded Sam');
  await signIn(page);
  await page.getByLabel('Date', { exact: true }).fill(DAY);
  await page.getByRole('button', { name: 'Close this date' }).click();

  const warning = page.getByRole('region', { name: /falls outside the new hours/ });
  await expect(warning).toContainText('Stranded Sam');
  await expect(warning).toContainText('the restaurant would be closed');
  expect((await db.query(`SELECT * FROM "Blackout"`)).rowCount, 'the edit must not have been applied').toBe(0);

  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations).toEqual([]);

  // Cancel leaves it unapplied; saving anyway applies it and leaves the party booked.
  await page.getByRole('link', { name: 'Cancel' }).click();
  await expect(warning).toHaveCount(0);
  expect((await db.query(`SELECT * FROM "Blackout"`)).rowCount).toBe(0);

  await page.getByLabel('Date', { exact: true }).fill(DAY);
  await page.getByRole('button', { name: 'Close this date' }).click();
  await page.getByRole('button', { name: 'Save anyway' }).click();
  await expect(page.getByText('Hours updated.')).toBeVisible();
  expect((await db.query(`SELECT * FROM "Blackout"`)).rowCount).toBe(1);
  expect((await db.query(`SELECT status FROM "Reservation"`)).rows[0].status).toBe('booked');
});

test('an added period that overlaps the weekday’s own hours is refused by the constraint', async ({ page }) => {
  await signIn(page);
  await page.getByLabel('Applies to').selectOption('weekly');
  await page.getByLabel('Weekday').selectOption('5');
  await page.getByLabel('Name').fill('Late');
  await page.getByLabel('Opens').fill('21:00');
  await page.getByLabel('Closes').selectOption('23:00');
  await page.getByLabel('Covers per 15 min').fill('10');
  await page.getByRole('button', { name: 'Add' }).click();

  await expect(page.getByText('That overlaps a period already set for the same day.')).toBeVisible();
});

test('a single-date override replaces that day’s periods on the floor view', async ({ page }) => {
  await book('Override Olive');
  await signIn(page);
  await page.getByLabel('Applies to').selectOption('date');
  await page.getByLabel('Or date').fill(DAY);
  await page.getByLabel('Name').fill('Wine dinner');
  await page.getByLabel('Opens').fill('18:00');
  await page.getByLabel('Closes').selectOption('21:00');
  await page.getByLabel('Covers per 15 min').fill('10');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('Hours updated.')).toBeVisible();

  // The floor groups the 19:00 party under the override's name, not Dinner.
  await page.goto(`/host?day=${DAY}`);
  const section = page.getByRole('region', { name: 'Wine dinner' });
  await expect(section).toContainText('Override Olive');
});

// The schema has allowed a close at minute 1440 since the service-schedule
// migration, but a native `<input type="time">` caps at 23:59, so a kitchen
// closing at midnight could not be entered at all and the form rejected the
// whole edit. The Closes control is a list for exactly this value.
test('a period closing at midnight can be entered and is stored as 24:00', async ({ page }) => {
  await signIn(page);
  await page.getByLabel('Applies to').selectOption('weekly');
  await page.getByLabel('Weekday').selectOption('3'); // Wednesday, untouched by the other specs
  await page.getByLabel('Name').fill('Late supper');
  // Dinner runs 17:00–22:00 every day here, so the late period starts where
  // that one ends.
  await page.getByLabel('Opens').fill('22:00');
  await page.getByLabel('Closes').selectOption('24:00');
  await page.getByLabel('Covers per 15 min').fill('8');
  await page.getByRole('button', { name: 'Add' }).click();

  await expect(page.getByText('Hours updated.')).toBeVisible();
  const { rows } = await db.query(`SELECT "closeMinute" FROM "ServicePeriod" WHERE name = 'Late supper'`);
  expect(rows).toHaveLength(1);
  expect(rows[0].closeMinute).toBe(1440);
});
