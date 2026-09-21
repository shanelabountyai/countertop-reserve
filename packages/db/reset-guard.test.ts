// The guard that stops a fixture wiping a database it was never meant to
// touch. Pure — no database, no clock.
import { describe, expect, it } from 'vitest';
import {
  assertDisposableTestDatabase,
  demoResetPermitted,
  parseTarget,
  testResetPermitted,
} from './testing/identity';

const local = (name: string) => `postgresql://u:p@localhost:5432/${name}`;
const NEON_HOST = 'ep-demo-12345.us-west-2.aws.neon.tech';
const NEON = `postgresql://u:p@${NEON_HOST}/reserve_test?sslmode=require`;

describe('parseTarget', () => {
  it('splits host and database name', () => {
    expect(parseTarget(local('reserve_test'))).toEqual({ host: 'localhost', name: 'reserve_test' });
  });

  it('ignores the query string', () => {
    expect(parseTarget(`${local('reserve_test')}?connection_limit=10`).name).toBe('reserve_test');
  });

  it('does not throw on rubbish', () => {
    expect(parseTarget('not a url')).toEqual({ host: '<unparseable>', name: '<unparseable>' });
  });
});

describe('testResetPermitted', () => {
  it('permits the local database the environment declared', () => {
    expect(testResetPermitted(local('reserve_test'), 'reserve_test')).toEqual({ ok: true });
  });

  // The defect this guard exists for: reserve_dev is on localhost too, and
  // the test scripts fall back to .env.local when .env.test does not load.
  it('refuses the demo database even though it is local', () => {
    const v = testResetPermitted(local('reserve_dev'), 'reserve_test');
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toContain('reserve_dev');
  });

  it('refuses when nothing declared a disposable database', () => {
    for (const declared of [undefined, '']) {
      const v = testResetPermitted(local('reserve_test'), declared);
      expect(v.ok).toBe(false);
      expect(v.ok === false && v.reason).toContain('TEST_DATABASE_NAME');
    }
  });

  it('refuses a remote host even when the name matches', () => {
    expect(testResetPermitted(NEON, 'reserve_test').ok).toBe(false);
  });

  it('refuses an unparseable url', () => {
    expect(testResetPermitted('', 'reserve_test').ok).toBe(false);
  });

  // Each of these is a way the gate could open by accident if the check were
  // sloppier than an equality test on the database NAME.
  it.each([
    ['a prefix', 'reserve'],
    ['a suffix', '_test'],
    ['a wildcard', '*'],
    ['whitespace around it', ' reserve_test '],
    ['a different case', 'RESERVE_TEST'],
    ['a truthy but unrelated value', 'true'],
  ])('refuses when the declaration is %s', (_label, declared) => {
    expect(testResetPermitted(local('reserve_test'), declared).ok).toBe(false);
  });

  it('accepts CI’s throwaway database when CI declares it', () => {
    expect(testResetPermitted(local('reserve_ci'), 'reserve_ci')).toEqual({ ok: true });
  });
});

describe('assertDisposableTestDatabase', () => {
  it('throws on a mismatch and names the database it refused', () => {
    expect(() =>
      assertDisposableTestDatabase({ DATABASE_URL: local('reserve_dev'), TEST_DATABASE_NAME: 'reserve_test' }),
    ).toThrow(/reserve_dev/);
  });

  it('passes when the declaration matches', () => {
    expect(() =>
      assertDisposableTestDatabase({ DATABASE_URL: local('reserve_test'), TEST_DATABASE_NAME: 'reserve_test' }),
    ).not.toThrow();
  });

  it('is what the suite itself runs under', () => {
    expect(() => assertDisposableTestDatabase()).not.toThrow();
  });
});

// The demo seed keeps the OLD rule deliberately: wiping reserve_dev is the
// point of `db:seed:demo`, so it must not depend on the test-only guard.
describe('demoResetPermitted', () => {
  it('permits every local host with no opt-in', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', '[::1]']) {
      expect(demoResetPermitted(host, undefined)).toBe(true);
    }
  });

  it('refuses a remote host with no opt-in', () => {
    expect(demoResetPermitted(NEON_HOST, undefined)).toBe(false);
  });

  it('permits a remote host the opt-in names exactly', () => {
    expect(demoResetPermitted(NEON_HOST, NEON_HOST)).toBe(true);
  });

  it.each([
    ['a different host', 'ep-other-99999.us-west-2.aws.neon.tech'],
    ['a wildcard', '*'],
    ['an empty string', ''],
    ['a prefix of the host', 'ep-demo-12345'],
    ['a suffix of the host', 'neon.tech'],
    ['the host with whitespace', ` ${NEON_HOST} `],
    ['a truthy but unrelated value', 'true'],
    ['a different case', NEON_HOST.toUpperCase()],
  ])('refuses a remote host when the opt-in is %s', (_label, allowHost) => {
    expect(demoResetPermitted(NEON_HOST, allowHost)).toBe(false);
  });
});
