// The demo gate decides whether a request gets challenged. Pure — no request
// object, no env.
import { describe, expect, it } from 'vitest';
import { demoChallenge } from './demo-gate';

const PASSWORD = 'firebird-demo';
const basic = (user: string, pass: string) => `Basic ${btoa(`${user}:${pass}`)}`;

describe('demoChallenge', () => {
  it('lets everything through when no password is set', () => {
    expect(demoChallenge('/book', null, undefined)).toBeNull();
    expect(demoChallenge('/host', null, '')).toBeNull();
  });

  it('challenges an unauthenticated request once a password is set', () => {
    const challenge = demoChallenge('/book', null, PASSWORD);
    expect(challenge?.status).toBe(401);
    expect(challenge?.headers['WWW-Authenticate']).toContain('Basic');
  });

  it('never indexes or caches a challenge', () => {
    const challenge = demoChallenge('/book', null, PASSWORD);
    expect(challenge?.headers['X-Robots-Tag']).toBe('noindex, nofollow');
    expect(challenge?.headers['Cache-Control']).toBe('no-store');
  });

  it('accepts the right password, whatever the username', () => {
    expect(demoChallenge('/book', basic('demo', PASSWORD), PASSWORD)).toBeNull();
    expect(demoChallenge('/book', basic('', PASSWORD), PASSWORD)).toBeNull();
  });

  it('gates the staff sign-in page too', () => {
    expect(demoChallenge('/host/login', null, PASSWORD)?.status).toBe(401);
  });

  // The routes that carry their own authentication. Gating these would break
  // the live-SMS demo and any real carrier delivery.
  it.each(['/api/sms/inbound', '/api/cron/sweep'])('leaves %s to its own auth', (path) => {
    expect(demoChallenge(path, null, PASSWORD)).toBeNull();
  });

  it.each([
    ['the wrong password', basic('demo', 'wrong')],
    ['a password that is a prefix', basic('demo', PASSWORD.slice(0, -1))],
    ['a password with trailing space', basic('demo', `${PASSWORD} `)],
    ['no colon in the decoded pair', `Basic ${btoa(PASSWORD)}`],
    ['undecodable base64', 'Basic !!!not-base64!!!'],
    ['a bearer token carrying the password', `Bearer ${PASSWORD}`],
    ['an empty header', ''],
  ])('challenges %s', (_label, authorization) => {
    expect(demoChallenge('/book', authorization, PASSWORD)?.status).toBe(401);
  });

  it('accepts a password containing a colon', () => {
    const withColon = 'a:b:c';
    expect(demoChallenge('/book', basic('demo', withColon), withColon)).toBeNull();
  });
});
