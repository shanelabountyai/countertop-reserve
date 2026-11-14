// Every environment variable this repo reads, validated once at server boot
// (instrumentation.ts) — scorecard K11. `.env.example` must name exactly
// these (lib/env.test.ts enforces both directions), and none may be a
// NEXT_PUBLIC_ secret.
//
// Deliberately permissive about the secrets: each one is OPTIONAL because
// unset already means a closed door (STAFF_PASSCODE, SMS_WEBHOOK_SECRET,
// CRON_SECRET) or, for the demo gate, no gate. What this adds is that a
// malformed value — a DATABASE_URL that is not a Postgres URL, a PORT that is
// not a port — stops the server at boot instead of surfacing as a 500 on the
// first request that needs it. Hand-written rather than a schema library: ten
// keys do not justify a dependency.

type Check = (value: string) => boolean;

const nonEmpty: Check = (v) => v.length > 0;
const postgresUrl: Check = (v) => URL.canParse(v) && /^postgres(ql)?:$/.test(new URL(v).protocol);
const oneOf =
  (...allowed: string[]): Check =>
  (v) => allowed.includes(v);

/** Read by the app at runtime. `required` = the server cannot start without it. */
export const APP_ENV = {
  NODE_ENV: { required: false, check: oneOf('development', 'test', 'production') },
  DATABASE_URL: { required: true, check: postgresUrl },
  DIRECT_URL: { required: false, check: postgresUrl }, // migrations (schema.prisma directUrl)
  PORT: { required: false, check: (v: string) => /^\d{1,5}$/.test(v) && Number(v) > 0 && Number(v) < 65536 },
  STAFF_PASSCODE: { required: false, check: nonEmpty }, // unset = /host locked
  SMS_WEBHOOK_SECRET: { required: false, check: nonEmpty }, // unset = webhook 503
  CRON_SECRET: { required: false, check: nonEmpty }, // unset = sweep 503
  DEMO_ACCESS_PASSWORD: { required: false, check: nonEmpty }, // unset = no demo gate
} as const satisfies Record<string, { required: boolean; check: Check }>;

/** Read only by tooling (tests, e2e, the demo seed), never by the running app. Listed in .env.example too. */
export const TOOLING_ENV = ['TEST_DATABASE_NAME', 'SEED_ALLOW_HOST', 'E2E_DEV', 'E2E_REUSE_SERVER', 'CI'] as const;

export type AppEnv = { -readonly [K in keyof typeof APP_ENV]?: string };

/** Throws naming the bad keys — never their values. An empty `NAME=` line counts as unset. */
export function parseEnv(source: Record<string, string | undefined>): AppEnv {
  const out: AppEnv = {};
  const bad: string[] = [];
  for (const [key, rule] of Object.entries(APP_ENV) as [keyof typeof APP_ENV, (typeof APP_ENV)[keyof typeof APP_ENV]][]) {
    const value = source[key];
    if (value === undefined || value === '') {
      if (rule.required) bad.push(`${key} (required)`);
      continue;
    }
    if (!rule.check(value)) bad.push(key);
    else out[key] = value;
  }
  if (bad.length > 0) throw new Error(`Invalid environment: ${bad.join(', ')}`);
  return out;
}
