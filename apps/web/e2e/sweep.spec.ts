import { expect, test } from '@playwright/test';

// The cron route against the production build: wired, fails closed, idempotent.
const secret = process.env.CRON_SECRET ?? '';

test.beforeAll(() => expect(secret, 'CRON_SECRET must be set for e2e (.env.test / CI env)').not.toBe(''));

test('the sweep refuses a missing or wrong secret', async ({ request }) => {
  expect((await request.get('/api/cron/sweep')).status()).toBe(401);
  expect((await request.get('/api/cron/sweep', { headers: { authorization: `Bearer ${secret}x` } })).status()).toBe(401);
});

test('an authorised sweep runs, and running it again is harmless', async ({ request }) => {
  const run = () => request.get('/api/cron/sweep', { headers: { authorization: `Bearer ${secret}` } });
  const first = await run();
  expect(first.status()).toBe(200);
  expect(await first.json()).toMatchObject({ released: expect.any(Array), notices: expect.any(Number) });
  expect((await run()).status()).toBe(200);
});
