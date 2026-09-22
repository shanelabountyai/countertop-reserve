import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';

import { assertDisposableTestDatabase } from '@reserve/db/testing/identity';

// The table board against the production build (P0-13). Read-only, so this
// spec seeds and reads — it never taps. Times are relative to the database's
// own clock so the spec holds at any hour, and the floor plan carries a
// declared combination because a combination is inventory, not decoration.
//
// The assertion the item exists for: a `free` table states its window in
// minutes. A green row with no number is the defect.
const passcode = process.env.STAFF_PASSCODE ?? '';
const TZ = 'America/Los_Angeles'; // RESTAURANT.timezone
const db = new Client({ connectionString: process.env.DATABASE_URL });

test.beforeAll(async () => {
  expect(passcode, 'STAFF_PASSCODE must be set for e2e (.env.test / CI env)').not.toBe('');
  assertDisposableTestDatabase();
  await db.connect();
  await db.query(`TRUNCATE TABLE "OutboundMessage", "ReservationEvent", "InboundMessage", "SmsOptOut", "TableHold", "Reservation",
    "CombinationMember", "Combination", "DiningTable" RESTART IDENTITY CASCADE`);
  // Two deuces in `window` that combine into a four; a four-top in `main`.
  await db.query(`INSERT INTO "DiningTable" (id, seats, "minParty", section) VALUES ('T1', 2, 1, 'window'), ('T2', 2, 1, 'window'), ('T3', 4, 2, 'main')`);
  await db.query(`INSERT INTO "Combination" (id, seats, "minParty") VALUES ('C12', 4, 3)`);
  await db.query(`INSERT INTO "CombinationMember" ("combinationId", "tableId") VALUES ('C12', 'T1'), ('C12', 'T2')`);

  // Dana is seated on T1 as of 20 minutes ago, on a 75-minute turn: due back
  // in 55. Erik is booked on T3 in 40 minutes — beyond the 30-minute horizon,
  // so T3 must read free for 40 minutes, not reserved.
  await seed('e2e-board-dana', 'T1', 'Dana Seated', 2, 75, '-20 minutes', 'seated');
  await seed('e2e-board-erik', 'T3', 'Erik Later', 4, 90, '40 minutes', 'booked');
});

/** One reservation, its hold and its event, at `offset` from the database's clock. */
async function seed(key: string, table: string, name: string, party: number, turn: number, offset: string, status: string) {
  const { rows } = await db.query(
    `WITH s AS (SELECT date_trunc('minute', now()) + $6::interval AS at)
     INSERT INTO "Reservation" (id, "idempotencyKey", "businessDay", "startAt", "partySize", "turnMinutes", "tableIds", "guestName", "guestPhone",
       tags, status, "createdAt", "statusChangedAt", "manageToken")
     SELECT gen_random_uuid(), $1, to_char(s.at AT TIME ZONE $2, 'YYYY-MM-DD'), s.at, $3, $4, ARRAY[$5], $7, '+15035550188',
       ARRAY[]::text[], $8, s.at - interval '1 day', s.at, $1
     FROM s RETURNING *`,
    [key, TZ, party, turn, table, offset, name, status],
  );
  const r = rows[0];
  await db.query(`INSERT INTO "TableHold" VALUES ($1, $2, $3, $3::timestamptz + ($4 || ' minutes')::interval)`, [r.id, table, r.startAt, turn]);
  await db.query(`INSERT INTO "ReservationEvent" ("reservationId", at, "fromStatus", "toStatus", source) VALUES ($1, $2, NULL, $3, 'host')`, [r.id, r.startAt, status]);
  return r;
}

test.afterAll(() => db.end());

const unit = (page: Page, id: string) => page.getByTestId('board-unit').filter({ has: page.locator(`[data-unit="${id}"]`) }).or(page.locator(`[data-unit="${id}"]`)).first();

async function signIn(page: Page) {
  await page.goto('/host/board');
  await page.getByLabel('Passcode').fill(passcode);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
}

test('the board is behind the same passcode as the book', async ({ page }) => {
  await page.goto('/host/board');
  await expect(page).toHaveURL(/\/host\/login\?next=%2Fhost%2Fboard/);
});

test('every free table states its window in minutes — never a bare green row', async ({ page }) => {
  await signIn(page);

  // T3: Erik is 40 minutes out, past the horizon. Free, WITH the number.
  // 39 or 40: the seed is truncated to the minute and `freeMinutes` FLOORS,
  // so the seconds that elapse before the page renders take it to 39. That
  // rounding direction is deliberate — a 39½-minute window must never read as
  // 40 to someone deciding whether a 40-minute turn fits — so the test allows
  // the drift rather than the board losing the floor.
  const t3 = unit(page, 'T3');
  await expect(t3).toHaveAttribute('data-state', 'free');
  await expect(t3).toContainText(/Free for (39|40) min/);

  // T2: nothing booked on it at all — free for the rest of service, said so.
  const t2 = unit(page, 'T2');
  await expect(t2).toHaveAttribute('data-state', 'free');
  await expect(t2).toContainText('Free for the rest of service');

  // Not one free row without either a window or that claim (the defect).
  for (const row of await page.locator('[data-state="free"]').all()) {
    await expect(row).toContainText(/Free for (\d+ min|the rest of service)/);
  }
});

test('a combination is an inventory row: its member occupied, it reads blocked and names the member', async ({ page }) => {
  await signIn(page);

  const t1 = unit(page, 'T1');
  await expect(t1).toHaveAttribute('data-state', 'occupied');
  await expect(t1).toContainText('Dana Seated');
  await expect(t1).toContainText('sat 20 min ago');

  // C12 cannot read free while T1 is sat at, and the board says what took it.
  const c12 = unit(page, 'C12');
  await expect(c12).toHaveAttribute('data-state', 'blocked');
  await expect(c12).toContainText('Taken by T1');
  await expect(c12).toContainText('T1+T2');
});

test('the board groups by section, counts what is free, and is axe-clean', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'window' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'main' })).toBeVisible();
  // T2 and T3 free of T1/T2/T3/C12.
  await expect(page.getByRole('banner').or(page.locator('header'))).toContainText('2 of 4 free');

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations).toEqual([]);
});
