// Scorecard K11: the env schema, and the invariant that it, the code and
// .env.example agree.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ENV, parseEnv, TOOLING_ENV } from './env';

const root = join(__dirname, '..', '..', '..');
const DB = 'postgresql://u:p@localhost:5432/reserve_dev';

describe('parseEnv', () => {
  it('accepts a minimal environment and an empty line as unset', () => {
    expect(parseEnv({ DATABASE_URL: DB, STAFF_PASSCODE: '' })).toEqual({ DATABASE_URL: DB });
  });

  it('requires a Postgres DATABASE_URL', () => {
    expect(() => parseEnv({})).toThrow('DATABASE_URL (required)');
    expect(() => parseEnv({ DATABASE_URL: 'mysql://x/y' })).toThrow('DATABASE_URL');
    expect(() => parseEnv({ DATABASE_URL: 'not a url' })).toThrow('DATABASE_URL');
  });

  it('refuses malformed optional values, naming the key and never the value', () => {
    const secret = 'postgres-but-wrong-scheme://hunter2@db';
    try {
      parseEnv({ DATABASE_URL: DB, DIRECT_URL: secret, PORT: '99999', NODE_ENV: 'prod' });
      expect.unreachable();
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain('DIRECT_URL');
      expect(message).toContain('PORT');
      expect(message).toContain('NODE_ENV');
      expect(message).not.toContain('hunter2');
    }
  });
});

describe('the env invariant', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      if (name === 'node_modules' || name === '.next' || name.startsWith('.')) return [];
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|mjs)$/.test(name) ? [p] : [];
    });
  const sources = [...walk(join(root, 'apps')), ...walk(join(root, 'packages'))].filter((p) => !p.endsWith('env.test.ts'));
  const read = new Set(sources.flatMap((p) => [...readFileSync(p, 'utf8').matchAll(/(?:process\.)?env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]!)));
  const prisma = [...readFileSync(join(root, 'packages/db/prisma/schema.prisma'), 'utf8').matchAll(/env\("([A-Z0-9_]+)"\)/g)].map((m) => m[1]!);
  const known = new Set<string>([...Object.keys(APP_ENV), ...TOOLING_ENV, 'NEXT_RUNTIME']); // NEXT_RUNTIME is set by Next itself
  const example = new Set([...readFileSync(join(root, '.env.example'), 'utf8').matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!));

  it('every variable the code or schema.prisma reads is declared in lib/env.ts', () => {
    expect(read).toContain('STAFF_PASSCODE'); // the scan is finding reads at all
    expect(prisma).toEqual(['DATABASE_URL', 'DIRECT_URL']);
    expect([...read, ...prisma].filter((k) => !known.has(k))).toEqual([]);
  });

  it('.env.example names every declared variable, and nothing else', () => {
    const declared = [...Object.keys(APP_ENV), ...TOOLING_ENV].filter((k) => k !== 'NODE_ENV' && k !== 'CI');
    expect(declared.filter((k) => !example.has(k))).toEqual([]);
    expect([...example].filter((k) => !declared.includes(k))).toEqual([]);
  });

  it('no NEXT_PUBLIC_ variable exists (nothing here is meant for the browser)', () => {
    expect([...read].filter((k) => k.startsWith('NEXT_PUBLIC_'))).toEqual([]);
  });
});
