import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';

import { assertDisposableTestDatabase } from '@reserve/db/testing/identity';

// Manual assignment against the production build (P0-14). The host names a
// table and the same transaction decides — so what this spec proves is that
// the screen carries the decision through honestly: the table changes when
// the engine agrees, and when it refuses the host is told WHICH rule said no
// and the party has not moved.
//
// Seatings are anchored to 19:00 on the database's own current date rather
// than to `now()`, so the spec holds at any hour without a reservation
// sliding across a day boundary.
const passcode = process.env.STAFF_PASSCODE ?? '';
const TZ = 'America/Los_Angeles'; // RESTAURANT.timezone
const db = new Client({ connectionString: process.env.DATABASE_URL });
let day = '';

test.beforeAll(async () => {
  expect(passcode, 'STAFF_PASSCODE must be set for e2e (.env.test / CI env)').not.toBe('');
  assertDisposableTestDatabase();
  await db.connect();
  await db.query(`TRUNCATE TABLE "OutboundMessage", "ReservationEvent", "InboundMessage", "SmsOptOut", "TableHold", "Reservation",
    "CombinationMember", "Combination", "DiningTable" RESTART IDENTITY CASCADE`);
  await db.query(`TRUNCATE TABLE "ServicePeriod", "Blackout"`);
  // Dinner 17:00–22:00 with a cap high enough that pacing is never the thing
  // under test here — the engine's asymmetry is asserted in the db suite.
  await db.query(`INSERT INTO "ServicePeriod" ("id", "weekday", "name", "openMinute", "closeMinute", "lastSeatingMinute", "pacingCap")
    SELECT gen_random_uuid(), d, 'Dinner', 1020, 1320, 1245, 200 FROM generate_series(0, 6) AS d`);
  // Two deuces that combine into a four, a four-top, and a six-top on the
  // patio that no deuce may have (minParty 3) — the refusal this spec shows.
  await db.query(`INSERT INTO "DiningTable" (id, seats, "minParty", section) VALUES
    ('T1', 2, 1, 'main'), ('T2', 2, 1, 'main'), ('T3', 4, 2, 'main'), ('T4', 6, 3, 'patio')`);
  await db.query(`INSERT INTO "Combination" (id, seats, "minParty") VALUES ('C12', 4, 3)`);
  await db.query(`INSERT INTO "CombinationMember" ("combinationId", "tableId") VALUES ('C12', 'T1'), ('C12', 'T2')`);

  // Ana is booked on T1 for 19:00; Bo is already seated on T2.
  const { rows } = await db.query(
    `WITH s AS (SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') AS d),
     r AS (
       INSERT INTO "Reservation" (id, "idempotencyKey", "businessDay", "startAt", "partySize", "turnMinutes", "tableIds", "guestName", "guestPhone",
         note, tags, status, "createdAt", "statusChangedAt", "manageToken", "smsConsent")
       SELECT gen_random_uuid(), k, s.d, (s.d || ' 19:00')::timestamp AT TIME ZONE $1, 2, 75, ARRAY[t], n, p, NULL, ARRAY[]::text[], st,
              now() - interval '1 day', now() - interval '1 day', k, 'Text me.'
       FROM s, (VALUES ('e2e-assign-ana', 'T1', 'Ana Assign', '+15035550111', 'booked'),
                       ('e2e-assign-bo', 'T2', 'Bo Seated', '+15035550112', 'seated')) v(k, t, n, p, st)
       RETURNING *)
     SELECT * FROM r`,
    [TZ],
  );
  day = rows[0].businessDay;
  for (const r of rows) {
    await db.query(`INSERT INTO "TableHold" VALUES ($1, $2, $3, $3::timestamptz + interval '75 minutes')`, [r.id, r.tableIds[0], r.startAt]);
    await db.query(`INSERT INTO "ReservationEvent" ("reservationId", at, "fromStatus", "toStatus", source) VALUES ($1, $2, NULL, $3, 'guest_web')`, [r.id, r.createdAt, r.status]);
  }
});

test.afterAll(() => db.end());

async function signIn(page: Page) {
  await page.goto(`/host?day=${day}`);
  await page.getByLabel('Passcode').fill(passcode);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Floor' })).toBeVisible();
}
const row = (page: Page, name: string) => page.getByTestId('floor-row').filter({ hasText: name });

test('the host names a table and the party moves onto it', async ({ page }) => {
  await signIn(page);
  await expect(row(page, 'Ana Assign')).toContainText('· T1');

  await page.getByLabel('Table for Ana Assign').selectOption('T3');
  await row(page, 'Ana Assign').getByRole('button', { name: 'Move' }).click();

  await expect(page.getByText('Moved.', { exact: true })).toBeVisible();
  await expect(row(page, 'Ana Assign')).toContainText('· T3');
});

test('a refused table names the rule that said no, and the party has not moved', async ({ page }) => {
  await signIn(page);
  // T4 seats six and takes no party under three. The picker offered it
  // anyway — the transaction is what refuses, and it says why.
  await page.getByLabel('Table for Ana Assign').selectOption('T4');
  await row(page, 'Ana Assign').getByRole('button', { name: 'Move' }).click();

  await expect(page.getByText('That table is too big for a party that small.')).toBeVisible();
  await expect(row(page, 'Ana Assign')).toContainText('· T3');
  // The refusal is the engine's, not the screen's: nothing was written.
  const { rows } = await db.query(`SELECT "tableIds" FROM "Reservation" WHERE "idempotencyKey" = 'e2e-assign-ana'`);
  expect(rows[0].tableIds).toEqual(['T3']);
});

test('moving a seated party frees their old table on the board at once', async ({ page }) => {
  await signIn(page);
  await page.getByLabel('Table for Bo Seated').selectOption('T1');
  await row(page, 'Bo Seated').getByRole('button', { name: 'Move' }).click();
  await expect(page.getByText('Moved.', { exact: true })).toBeVisible();

  // The board is the cross-check: the vacated table is real inventory now,
  // not a flag something sweeps later.
  await page.goto('/host/board');
  await expect(page.locator('[data-unit="T1"]')).toHaveAttribute('data-state', 'occupied');
  await expect(page.locator('[data-unit="T2"]')).toHaveAttribute('data-state', 'free');
  await expect(page.locator('[data-unit="T1"]')).toContainText('Bo Seated');
});

test('the picker offers every unit on the plan, and the row stays accessible', async ({ page }) => {
  await signIn(page);
  const picker = page.getByLabel('Table for Ana Assign');
  // Deliberately unfiltered: a host learns the rule from a named refusal, and
  // learns nothing at all from an option that silently was not there.
  await expect(picker.locator('option')).toHaveText([/T1/, /T2/, /T3/, /C12/, /T4/]);
  // The combination names the tables it consumes — it is inventory, not decoration.
  await expect(picker.locator('option', { hasText: 'C12' })).toContainText('T1+T2');

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations).toEqual([]);
});
