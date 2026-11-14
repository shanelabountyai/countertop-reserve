// The staff sign-in is attempt-limited in Postgres (scorecard K5, SEC-01's
// acceptance test): 10 wrong passcodes from one address lock that address out,
// the right passcode included; another address is unaffected.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '@reserve/db/testing';
import { decideStaffSignIn } from './staff-signin';
import { staffToken } from './staff-auth';

const NOW = new Date(Date.UTC(2026, 9, 2, 19, 1));
const RIGHT = 'correct-horse-battery';
let saved: string | undefined;

beforeAll(() => {
  saved = process.env.STAFF_PASSCODE;
  process.env.STAFF_PASSCODE = RIGHT;
});
afterAll(() => {
  if (saved === undefined) delete process.env.STAFF_PASSCODE;
  else process.env.STAFF_PASSCODE = saved;
});
beforeEach(resetDatabase);

describe('decideStaffSignIn', () => {
  it('signs in with the right passcode, and right passcodes are never counted', async () => {
    for (let i = 0; i < 15; i += 1) {
      expect(await decideStaffSignIn(RIGHT, '203.0.113.7', NOW)).toEqual({ ok: true, token: await staffToken(RIGHT) });
    }
  });

  it('locks an address out after 10 wrong passcodes, even for the right one; another address is unaffected', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect(await decideStaffSignIn(`guess-${i}`, '203.0.113.7', NOW)).toEqual({ ok: false, reason: 'wrong' });
    }
    expect(await decideStaffSignIn(RIGHT, '203.0.113.7', NOW)).toEqual({ ok: false, reason: 'throttled' });
    expect(await decideStaffSignIn(RIGHT, '203.0.113.8', NOW)).toMatchObject({ ok: true });
    // The window turns: the address may try again.
    expect(await decideStaffSignIn(RIGHT, '203.0.113.7', new Date(Date.UTC(2026, 9, 2, 19, 15)))).toMatchObject({ ok: true });
  });

  it('says so when no passcode is configured, without counting anything', async () => {
    process.env.STAFF_PASSCODE = '';
    try {
      expect(await decideStaffSignIn('', '203.0.113.7', NOW)).toEqual({ ok: false, reason: 'unset' });
    } finally {
      process.env.STAFF_PASSCODE = RIGHT;
    }
  });
});
