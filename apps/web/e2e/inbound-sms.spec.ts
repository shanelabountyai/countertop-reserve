import { createHmac, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';

// The webhook against the production build: the route is wired, fails
// closed, and a redelivery replays. The provider's signing is re-implemented
// here on purpose — the spec plays the provider, not the app.
const secret = process.env.SMS_WEBHOOK_SECRET ?? '';
const sign = (raw: string) => createHmac('sha256', secret).update(raw).digest('hex');
const payload = (body: string) =>
  JSON.stringify({ providerMessageId: `SMe2e${randomBytes(6).toString('hex')}`, from: '+15035550987', body });

test.beforeAll(() => expect(secret, 'SMS_WEBHOOK_SECRET must be set for e2e (.env.test / CI env)').not.toBe(''));

test('an unsigned or mis-signed inbound is refused before anything runs', async ({ request }) => {
  const raw = payload('X');
  expect((await request.post('/api/sms/inbound', { data: raw, headers: { 'content-type': 'application/json' } })).status()).toBe(401);
  expect((await request.post('/api/sms/inbound', { data: raw, headers: { 'x-signature': sign(raw + ' ') } })).status()).toBe(401);
});

test('a signed but malformed payload is a 400', async ({ request }) => {
  const raw = JSON.stringify({ providerMessageId: 'SMbad', from: 'not-a-phone', body: 'C' });
  expect((await request.post('/api/sms/inbound', { data: raw, headers: { 'x-signature': sign(raw) } })).status()).toBe(400);
});

test('a signed inbound is handled once; its redelivery replays the same answer', async ({ request }) => {
  const raw = payload('C');
  const post = () => request.post('/api/sms/inbound', { data: raw, headers: { 'x-signature': sign(raw), 'content-type': 'application/json' } });
  const first = await post();
  expect(first.status()).toBe(200);
  const body = await first.json();
  expect(body).toMatchObject({ replayed: false, outcome: 'no_reservation', reply: expect.stringContaining('/book') });
  expect(await (await post()).json()).toEqual({ ...body, replayed: true });
});
