// Which database a destructive test fixture is allowed to wipe. Pure — no
// Prisma, no database, no clock — so the Playwright specs (which talk to
// Postgres through `pg`, not Prisma) can share it instead of re-deriving a
// weaker guard of their own.

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

export type Verdict = { ok: true } | { ok: false; reason: string };

/** `postgresql://u:p@host/name?x=1` -> `{ host, name }`. Never throws. */
export function parseTarget(url: string): { host: string; name: string } {
  if (!URL.canParse(url)) return { host: '<unparseable>', name: '<unparseable>' };
  const u = new URL(url);
  return { host: u.hostname, name: decodeURIComponent(u.pathname.replace(/^\//, '')) };
}

/**
 * Whether the TEST suite may TRUNCATE the database in `url`.
 *
 * A local hostname is NOT sufficient. `reserve_dev` — the demo database the
 * floor view and `db:seed:demo` share — lives on localhost too, and the test
 * scripts chain `.env.test` ahead of `.env.local`, so a missing or malformed
 * `.env.test` silently falls back to it. A hostname-only guard waves that
 * through and the demo is gone.
 *
 * So the caller must DECLARE which database is disposable, by name, in
 * TEST_DATABASE_NAME, and DATABASE_URL must resolve to exactly that one. The
 * declaration lives in the npm test scripts and in CI — never in an env
 * file, because the whole point is that it cannot travel with a stale
 * DATABASE_URL. Unset means refuse: running `vitest` bare wipes nothing.
 */
export function testResetPermitted(url: string, declaredName: string | undefined): Verdict {
  const { host, name } = parseTarget(url);
  if (!LOCAL_HOSTS.includes(host)) {
    return { ok: false, reason: `database host "${host}" is not local; tests never touch a remote database` };
  }
  if (typeof declaredName !== 'string' || declaredName === '') {
    return {
      ok: false,
      reason:
        'TEST_DATABASE_NAME is unset. Run the suite through `npm test` / `npm run test:e2e`, ' +
        'which declare the disposable database by name.',
    };
  }
  if (name !== declaredName) {
    return {
      ok: false,
      reason:
        `DATABASE_URL points at "${name}" but TEST_DATABASE_NAME declares "${declaredName}". ` +
        'Refusing to wipe a database the test environment did not name — check that .env.test loaded.',
    };
  }
  return { ok: true };
}

/**
 * Whether `db:seed:demo` may TRUNCATE the database in `url`.
 *
 * Deliberately NOT the test rule: wiping the demo database is the entire
 * point of the demo seed, so it is the one caller allowed to name a database
 * that is not disposable-by-convention. Local hosts pass; anything else
 * needs SEED_ALLOW_HOST to name the host EXACTLY (V-014, seeding the hosted
 * demo). A truthy-but-wrong value does not open the gate, and neither does a
 * wildcard, because there is no wildcard to match on.
 */
export function demoResetPermitted(host: string, allowHost: string | undefined): boolean {
  if (LOCAL_HOSTS.includes(host)) return true;
  return typeof allowHost === 'string' && allowHost !== '' && allowHost === host;
}

/**
 * Throws unless the current DATABASE_URL is the declared disposable test
 * database. Every destructive fixture calls this before its first TRUNCATE.
 */
export function assertDisposableTestDatabase(env: NodeJS.ProcessEnv = process.env): void {
  const verdict = testResetPermitted(env.DATABASE_URL ?? '', env.TEST_DATABASE_NAME);
  if (!verdict.ok) throw new Error(`Refusing to run destructive tests: ${verdict.reason}`);
}
