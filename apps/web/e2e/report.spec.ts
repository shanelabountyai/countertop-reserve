import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';

// The no-show & cover report (P1-1) against the production build.
//
// A fixed historical night, seeded straight into the local test database, so
// every number on the page is hand-tallied here and the spec does not depend
// on what hour it runs at. The range lives in the URL, which is the whole
// point of the page being a plain GET form.
const passcode = process.env.STAFF_PASSCODE ?? '';
const DAY = '2020-02-14';
const db = new Client({ connectionString: process.env.DATABASE_URL });

// Ana: confirmed, sat down. Bo: confirmed, never came. Cy: never replied, sat
// down anyway. So 12 covers on the book, 10 of them seated; one no-show in
// two confirmed parties, none in the one that never confirmed.
const PARTIES = [
  { key: 'rep-ana', name: 'Ana Attend', party: 4, minutes: 0, status: 'seated', history: ['booked', 'confirmed', 'seated'] },
  { key: 'rep-bo', name: 'Bo Absent', party: 2, minutes: 0, status: 'no_show', history: ['booked', 'confirmed', 'no_show'] },
  { key: 'rep-cy', name: 'Cy Quiet', party: 6, minutes: 15, status: 'seated', history: ['booked', 'seated'] },
];

test.beforeAll(async () => {
  expect(passcode, 'STAFF_PASSCODE must be set for e2e (.env.test / CI env)').not.toBe('');
  const host = new URL(process.env.DATABASE_URL ?? '').hostname;
  expect(['localhost', '127.0.0.1', '::1'], 'e2e seeds only a local database').toContain(host);
  await db.connect();
  await db.query(`TRUNCATE TABLE "OutboundMessage", "ReservationEvent", "InboundMessage", "SmsOptOut", "TableHold", "Reservation",
    "CombinationMember", "Combination", "DiningTable" RESTART IDENTITY CASCADE`);
  for (const p of PARTIES) {
    // 19:00 and 19:15 America/Los_Angeles, written as the instants they are.
    const { rows } = await db.query(
      `INSERT INTO "Reservation" (id, "idempotencyKey", "businessDay", "startAt", "partySize", "turnMinutes", "tableIds", "guestName",
         "guestPhone", tags, status, "createdAt", "statusChangedAt", "manageToken")
       VALUES (gen_random_uuid(), $1, $2, timestamptz '2020-02-14 19:00 America/Los_Angeles' + ($3 || ' minutes')::interval,
         $4, 90, ARRAY['T1'], $5, '+15035550100', ARRAY[]::text[], $6,
         timestamptz '2020-02-11 12:00 America/Los_Angeles', timestamptz '2020-02-14 20:00 America/Los_Angeles', $1)
       RETURNING id`,
      [p.key, DAY, String(p.minutes), p.party, p.name, p.status],
    );
    for (const [i, toStatus] of p.history.entries()) {
      await db.query(
        `INSERT INTO "ReservationEvent" ("reservationId", at, "fromStatus", "toStatus", source)
         VALUES ($1, timestamptz '2020-02-14 18:00 America/Los_Angeles' + ($2 || ' minutes')::interval, $3, $4, 'host')`,
        [rows[0].id, String(i * 10), i === 0 ? null : (p.history[i - 1] ?? null), toStatus],
      );
    }
  }
});

test.afterAll(() => db.end());

async function signIn(page: Page) {
  await page.goto(`/host/report?from=${DAY}`);
  await page.getByLabel('Passcode').fill(passcode);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'No-shows & covers' })).toBeVisible();
}

test('the report is behind the same passcode as the floor', async ({ page }) => {
  await page.goto(`/host/report?from=${DAY}`);
  await expect(page.getByLabel('Passcode')).toBeVisible();
  // Signing in returns to the report that was asked for, not to the floor.
  await page.getByLabel('Passcode').fill(passcode);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'No-shows & covers' })).toBeVisible();
  await expect(page.getByRole('heading', { name: DAY })).toBeVisible();
});

test('covers booked and covers seated are shown side by side, per 15-minute seating', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('term').filter({ hasText: 'Covers booked' }).locator('~ dd').first()).toHaveText('12');
  await expect(page.getByRole('term').filter({ hasText: 'Covers seated' }).locator('~ dd').first()).toHaveText('10');

  // 19:00: Ana (4, seated) and Bo (2, no-show). 19:15: Cy (6, seated).
  const covers = page.getByRole('table', { name: /Covers booked and covers seated/ });
  await expect(covers.getByRole('row').filter({ hasText: '19:00' })).toContainText('6');
  await expect(covers.getByRole('row').filter({ hasText: '19:15' })).toContainText('6');
});

test('the no-show split by confirmation state is on the page, and an empty rate says so', async ({ page }) => {
  await signIn(page);
  const predicts = page.getByRole('region', { name: 'Does confirming predict showing?' });
  await expect(predicts).toContainText('50% (1 of 2)'); // confirmed: Bo, of Ana and Bo
  await expect(predicts).toContainText('0% (0 of 1)'); // never confirmed: Cy alone
  // Nobody waited for a table that night, and the page says that rather than "0%".
  await expect(page.getByRole('region', { name: 'Released and waitlisted' })).toContainText('no data');
});

test('a day with nothing booked says so instead of showing an empty table', async ({ page }) => {
  await signIn(page);
  await page.goto('/host/report?from=2020-02-15');
  await expect(page.getByText('Nothing was booked in this range.')).toBeVisible();
});

test('the report has no accessibility violations', async ({ page }) => {
  await signIn(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations).toEqual([]);
});
