// Every host entry point checks for staff ITSELF, not only through the
// middleware (scorecard K3, SEC-07's acceptance test). Source-level, because
// the guard reads cookies() and that needs a request: a new 'use server'
// export under app/host, or a new host page, that forgets requireStaff()
// fails here.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const host = join(__dirname, '..', 'app', 'host');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const files = walk(host).filter((p) => /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p));

/** The body of each exported async function, up to the next top-level export. */
function exportedBodies(src: string): { name: string; body: string }[] {
  const starts = [...src.matchAll(/^export (?:default )?async function (\w+)/gm)];
  return starts.map((m, i) => ({ name: m[1]!, body: src.slice(m.index, starts[i + 1]?.index ?? src.length) }));
}

// Public by design: the sign-in itself (attempt-limited instead, K5).
const PUBLIC_ACTIONS = new Set(['login/actions.ts']);
// No private data: the static design reference renders fixed sample rows.
const PUBLIC_PAGES = new Set(['login/page.tsx', 'design/page.tsx']);

describe('host entry points guard themselves', () => {
  const actionFiles = files.filter((p) => readFileSync(p, 'utf8').startsWith("'use server'"));

  it('finds the host server actions', () => {
    expect(actionFiles.map((p) => relative(host, p)).sort()).toEqual(['actions.ts', 'hours/actions.ts', 'login/actions.ts']);
  });

  for (const p of actionFiles.filter((f) => !PUBLIC_ACTIONS.has(relative(host, f)))) {
    it(`every export in ${relative(host, p)} calls requireStaff() first`, () => {
      const bodies = exportedBodies(readFileSync(p, 'utf8'));
      expect(bodies.length).toBeGreaterThan(0);
      for (const { name, body } of bodies) {
        const firstStatement = body.slice(body.indexOf('{') + 1).trim();
        expect(firstStatement.startsWith('await requireStaff();'), `${name} must call requireStaff() before anything else`).toBe(true);
      }
    });
  }

  for (const p of files.filter((f) => f.endsWith('page.tsx') && !PUBLIC_PAGES.has(relative(host, f)))) {
    it(`${relative(host, p)} calls requireStaff()`, () => {
      const [page] = exportedBodies(readFileSync(p, 'utf8'));
      expect(page?.body).toContain('await requireStaff();');
    });
  }
});
