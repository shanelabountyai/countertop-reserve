import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';

// The guest booking flow and the tokenized manage page (P0-12), against the
// production build. No passcode: this is the surface a stranger reaches, and
// the token in the URL is the whole of the authorisation.
//
// The tests run in order and build on one another — one booking is made, then
// changed, then cancelled — because that is the journey, and Playwright runs
// this file serially (workers: 1).
const db = new Client({ connectionString: process.env.DATABASE_URL });

// Thirty days out in RESTAURANT time — read from the database's own clock, so
// it is always inside the page's 60-day horizon and never already passed. A
// fixed calendar date would eventually fall outside the date input's `max`,
// and the browser would silently refuse to submit the day form.
const TZ = 'America/Los_Angeles'; // RESTAURANT.timezone
let DAY = '';

/** The token minted for the booking made in the first test, used by the rest. */
let token = '';

test.beforeAll(async () => {
  const host = new URL(process.env.DATABASE_URL ?? '').hostname;
  expect(['localhost', '127.0.0.1', '::1'], 'e2e seeds only a local database').toContain(host);
  await db.connect();
  await db.query(`TRUNCATE TABLE "OutboundMessage", "ReservationEvent", "InboundMessage", "SmsOptOut", "TableHold", "Reservation",
    "CombinationMember", "Combination", "DiningTable" RESTART IDENTITY CASCADE`);
  await db.query(`TRUNCATE TABLE "ServicePeriod", "Blackout"`);
  await db.query(`INSERT INTO "ServicePeriod" ("id", "weekday", "name", "openMinute", "closeMinute", "lastSeatingMinute", "pacingCap")
    SELECT gen_random_uuid(), d, 'Dinner', 1020, 1320, 1245, 20 FROM generate_series(0, 6) AS d`);
  // ONE two-top, so a second party of two at the same time has nowhere to go
  // and the flow has to say why. T2 seats 4 and refuses a party under 3.
  await db.query(`INSERT INTO "DiningTable" (id, seats, "minParty", section) VALUES ('T1', 2, 1, 'main'), ('T2', 4, 3, 'main')`);
  const { rows } = await db.query(`SELECT to_char((now() AT TIME ZONE $1)::date + 30, 'YYYY-MM-DD') AS day`, [TZ]);
  DAY = rows[0].day;
});

test.afterAll(() => db.end());

/** Party size, then date, then the 7:00 PM slot. */
async function pickSeven(page: Page, party = 2) {
  await page.goto('/book');
  await page.getByRole('link', { name: String(party), exact: true }).click();
  await page.locator('#day').fill(DAY);
  await page.getByRole('button', { name: 'See times' }).click();
  await page.getByRole('link', { name: '7:00 PM' }).click();
}

const messages = async (kind: string) =>
  (await db.query(`SELECT body, status FROM "OutboundMessage" WHERE kind = $1 ORDER BY "createdAt"`, [kind])).rows;

test('party size, then a date, then a time, then who you are — and the token lands you on your reservation', async ({ page }) => {
  await pickSeven(page);
  await expect(page.getByRole('heading', { name: new RegExp(`Party of 2 on ${DAY} at 7:00 PM`) })).toBeVisible();

  await page.getByLabel('Name').fill('Dana Reyes');
  await page.getByLabel('Mobile number').fill('+15035550123');
  await page.getByLabel('Anything we should know?').fill('Window table if you have one');
  await page.getByLabel('Allergy or dietary need').check();
  await page.getByLabel(/Text me about this reservation/).check();
  await page.getByRole('button', { name: 'Book this table' }).click();

  await expect(page).toHaveURL(/\/m\/[\w-]{22}\?notice=booked/);
  await expect(page.getByText("You're booked.")).toBeVisible();
  await expect(page.getByRole('heading', { name: / at 7:00 PM$/ })).toBeVisible();
  await expect(page.getByText('Party of 2 · Dana Reyes')).toBeVisible();
  await expect(page.getByText('Booked — not yet confirmed')).toBeVisible();
  await expect(page.getByText('Window table if you have one')).toBeVisible();

  // The confirmation text is the stored, rendered body — shown here verbatim.
  const [confirmation] = await messages('confirmation');
  await expect(page.getByText(confirmation.body)).toBeVisible();

  token = new URL(page.url()).pathname.split('/')[2] ?? '';
  expect(token).toMatch(/^[\w-]{22}$/);
});

test('an unavailable time is SHOWN with its reason, never hidden — and the page is axe-clean', async ({ page }) => {
  await page.goto(`/book?party=2&day=${DAY}`);

  // 7:00 is gone, and so is every slot the first party's 90-minute turn
  // covers. The times stay on screen with the reason beside them.
  const taken = page.getByRole('listitem').filter({ hasText: '7:00 PM' });
  await expect(taken.getByText('fully booked')).toBeVisible();
  await expect(page.getByRole('link', { name: '7:00 PM' })).toHaveCount(0);
  // Something later is still bookable, so the guest is not sent away.
  await expect(page.getByRole('link', { name: '8:45 PM' })).toBeVisible();
  // Past the 20:45 last seating: declared closed, not silently dropped.
  await expect(page.getByRole('listitem').filter({ hasText: '9:00 PM' }).getByText('not serving')).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('a party larger than any table is told so, rather than shown an empty day', async ({ page }) => {
  await page.goto(`/book?party=9&day=${DAY}`);
  await expect(page.getByText(/larger than any table or combination we have/)).toBeVisible();
});

test('the phone number is validated to E.164 by the browser before submit (P0-12)', async ({ page }) => {
  await pickSeven(page, 3); // T2 is free; a party of 3 has somewhere to go
  await page.getByLabel('Name').fill('Sam Nguyen');
  await page.getByLabel('Mobile number').fill('503-555-0199');
  await page.getByRole('button', { name: 'Book this table' }).click();

  // The browser refused it: no navigation, and the field reports itself invalid.
  await expect(page.getByLabel('Mobile number')).toHaveJSProperty('validity.patternMismatch', true);
  await expect(page).toHaveURL(/\/book\?/);

  // And the server does not trust that: the same number posted straight at
  // the action is refused by invalidGuestField, not by the form.
  await page.getByLabel('Mobile number').evaluate((el: HTMLInputElement) => el.removeAttribute('pattern'));
  await page.getByRole('button', { name: 'Book this table' }).click();
  await expect(page.getByText(/not one we can text/)).toBeVisible();
});

test('the manage page changes the booking through the same re-allocation the SMS keyword uses', async ({ page }) => {
  await page.goto(`/m/${token}`);
  await page.getByRole('link', { name: 'Pick a different time' }).click();
  await page.getByRole('link', { name: '8:45 PM' }).click();
  await page.getByRole('button', { name: 'Move my reservation' }).click();

  await expect(page.getByText('Your reservation has been moved.')).toBeVisible();
  await expect(page.getByRole('heading', { name: / at 8:45 PM$/ })).toBeVisible();
  // A guest-driven change counts as that guest's confirmation (V-008), or the
  // deadline sweep would release the table against the original deadline.
  await expect(page.getByText('Confirmed', { exact: true })).toBeVisible();

  const [a5] = await messages('change_confirmed');
  expect(a5.body).toContain('8:45 PM');
  expect(a5.body).toContain('previous 7:00 PM booking is released');
  // The newest text supersedes the confirmation on the page.
  await expect(page.getByText(a5.body)).toBeVisible();
});

test('a change that does not fit leaves the original booking exactly as it was', async ({ page }) => {
  // A party of 9 fits no table here, and 7:00 is free again since the move.
  await page.goto(`/m/${token}?change=1&party=9&day=${DAY}`);
  await expect(page.getByText(/larger than any table or combination we have/)).toBeVisible();
  // There is no slot to pick, so there is nothing to submit — the refusal
  // arrives before a write can be attempted.
  await expect(page.getByRole('button', { name: 'Move my reservation' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: / at 8:45 PM$/ })).toBeVisible();
});

test('cancelling hands the table straight back to inventory', async ({ page }) => {
  await page.goto(`/m/${token}`);
  await page.getByRole('button', { name: 'Cancel this reservation' }).click();
  await expect(page.getByText('Your reservation is cancelled.')).toBeVisible();
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel this reservation' })).toHaveCount(0);

  const [a7] = await messages('cancelled');
  expect(a7.body).toContain('/book');

  // Immediately real inventory: 8:45 is bookable again in the same session.
  await page.goto(`/book?party=2&day=${DAY}`);
  await expect(page.getByRole('link', { name: '8:45 PM' })).toBeVisible();
});

test('a token we could not have minted is a 404, the same as one that never existed', async ({ page }) => {
  expect((await page.goto('/m/AAAAAAAAAAAAAAAAAAAAAA'))?.status()).toBe(404);
  expect((await page.goto('/m/not-a-token'))?.status()).toBe(404);
});
