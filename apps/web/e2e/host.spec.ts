import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';

// Shared with the Vitest fixtures: a local hostname is not enough, the test
// environment has to NAME the disposable database (TEST_DATABASE_NAME).
import { assertDisposableTestDatabase } from '@reserve/db/testing/identity';

// The host floor view against the production build (P0-9). Seeded straight
// into the local test database — the spec plays the restaurant's past, the
// app plays tonight. Times are relative to the database's own clock and the
// day is read back from it, so the spec holds at any hour.
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
  await db.query(`INSERT INTO "DiningTable" (id, seats, "minParty", section) VALUES ('T1', 2, 1, 'main'), ('T2', 2, 1, 'main'), ('T3', 4, 2, 'main')`);
  // Two parties for 30 minutes ago: Ana (allergy, unconfirmed) on T1, Bo
  // (occasion, confirmed, but the confirmation never reached them) on T2.
  const { rows } = await db.query(
    `WITH s AS (SELECT date_trunc('minute', now()) - interval '30 minutes' AS at),
     r AS (
       INSERT INTO "Reservation" (id, "idempotencyKey", "businessDay", "startAt", "partySize", "turnMinutes", "tableIds", "guestName", "guestPhone",
         note, tags, status, "createdAt", "statusChangedAt", "manageToken", "smsConsent")
       SELECT gen_random_uuid(), k, to_char(s.at AT TIME ZONE $1, 'YYYY-MM-DD'), s.at, 2, 75, ARRAY[t], n, p, note, tags, st, s.at - interval '1 day', s.at - interval '1 day', k, 'Text me.'
       FROM s, (VALUES ('e2e-ana', 'T1', 'Ana Allergy', '+15035550101', 'shellfish', ARRAY['allergy'], 'booked'),
                       ('e2e-bo', 'T2', 'Bo Birthday', '+15035550102', NULL, ARRAY['occasion'], 'confirmed')) v(k, t, n, p, note, tags, st)
       RETURNING *)
     SELECT * FROM r`,
    [TZ],
  );
  day = rows[0].businessDay;
  for (const r of rows) {
    await db.query(`INSERT INTO "TableHold" VALUES ($1, $2, $3, $3::timestamptz + interval '75 minutes')`, [r.id, r.tableIds[0], r.startAt]);
    await db.query(`INSERT INTO "ReservationEvent" ("reservationId", at, "fromStatus", "toStatus", source) VALUES ($1, $2, NULL, $3, 'guest_web')`, [r.id, r.createdAt, r.status]);
  }
  const bo = rows.find((r) => r.guestName === 'Bo Birthday');
  await db.query(
    `INSERT INTO "OutboundMessage" (id, "reservationId", kind, "toPhone", body, status, "failureReason", "createdAt", "statusChangedAt")
     VALUES (gen_random_uuid(), $1, 'confirmation', $2, 'x', 'failed', 'opted_out', now(), now())`,
    [bo.id, bo.guestPhone],
  );
});

test.afterAll(() => db.end());

async function signIn(page: Page) {
  await page.goto(`/host?day=${day}`);
  await page.getByLabel('Passcode').fill(passcode);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Floor' })).toBeVisible();
}
const row = (page: Page, name: string) => page.getByTestId('floor-row').filter({ hasText: name });

test('the floor is behind the passcode: a GET is sent to sign in, a POST is refused, a wrong passcode is told so', async ({ page, request }) => {
  await page.goto('/host');
  await expect(page).toHaveURL(/\/host\/login\?next=%2Fhost/);
  expect((await request.post('/host', { data: '', maxRedirects: 0 })).status()).toBe(401);
  await page.getByLabel('Passcode').fill(`${passcode}-wrong`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'passcode' })).toHaveText('That passcode is not right.');
});

test('rows read at arm\'s length: ≥48px targets, ≥18px text, Seat the largest, tags distinct by kind, a failed text shown — and axe-clean', async ({ page }) => {
  await signIn(page);
  const ana = row(page, 'Ana Allergy');
  const bo = row(page, 'Bo Birthday');
  await expect(ana).toContainText('Unconfirmed');
  await expect(bo).toContainText('Confirmation text failed: guest opted out of texts');

  // An allergy never looks like a birthday: different words, different fill.
  const allergy = ana.getByText('⚠ ALLERGY', { exact: true });
  const occasion = bo.getByText('✦ Occasion', { exact: true });
  const bg = (l: typeof allergy) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await bg(allergy)).not.toBe(await bg(occasion));

  for (const b of await page.getByRole('main').getByRole('button').all()) {
    const box = (await b.boundingBox())!;
    expect(box.height, `${await b.textContent()} height`).toBeGreaterThanOrEqual(48);
    expect(box.width, `${await b.textContent()} width`).toBeGreaterThanOrEqual(48);
  }
  for (const r of await page.getByTestId('floor-row').all()) {
    expect(parseFloat(await r.evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(18);
  }
  const area = async (name: string) => {
    const box = (await ana.getByRole('button', { name, exact: true }).boundingBox())!;
    return box.width * box.height;
  };
  const seat = await area('Seat');
  for (const other of ['No-show', 'Cancel']) expect(seat).toBeGreaterThan(await area(other));

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations).toEqual([]);
});

test('seat is one tap with a 5-second undo; the undo disappears when the window closes', async ({ page }) => {
  await signIn(page);
  const ana = row(page, 'Ana Allergy');
  await ana.getByRole('button', { name: 'Seat', exact: true }).click();
  await expect(ana).toContainText('Seated · 0 min');
  await ana.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('Undone.')).toBeVisible();
  await expect(ana).toContainText('Unconfirmed');

  await ana.getByRole('button', { name: 'Seat', exact: true }).click();
  const undo = ana.getByRole('button', { name: 'Undo' });
  await expect(undo).toBeVisible();
  await expect(undo).toBeHidden({ timeout: 7_000 });
  await expect(ana).toContainText('Seated');
});

test('walk-ins from the same screen: seated when a table is free, waitlisted with a range when not, then texted "table ready"', async ({ page }) => {
  await signIn(page);
  const form = page.getByRole('region', { name: 'Walk-in' });
  await form.getByLabel('Party').fill('4');
  await form.getByLabel('Name').fill('Four Top');
  await form.getByRole('button', { name: 'Seat or waitlist' }).click();
  await expect(page.getByText('Walk-in seated')).toBeVisible();

  // T1 seated, T2 held, T3 just taken: a two-top waits.
  await form.getByLabel('Party').fill('2');
  await form.getByLabel('Name').fill('Kim Waiting');
  await form.getByLabel('Mobile (optional)').fill('+15035550177');
  await form.getByLabel(/Guest agreed/).check();
  await form.getByRole('button', { name: 'Seat or waitlist' }).click();
  await expect(page.getByText('added to the waitlist')).toBeVisible();
  const kim = page.getByRole('region', { name: /Waitlist/ }).getByTestId('floor-row').filter({ hasText: 'Kim Waiting' });
  await expect(kim).toContainText(/quoted \d+-\d+ min/);

  await kim.getByRole('button', { name: 'Text: table ready' }).click();
  await expect(page.getByText('"Table ready" text sent.')).toBeVisible();
  await expect(kim).toContainText('"Table ready" texted.');
  await expect(kim.getByRole('button', { name: 'Text: table ready' })).toHaveCount(0);
});
