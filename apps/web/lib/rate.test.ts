// Source-level check that every unauthenticated guest write and the manage
// page count against a Postgres-backed limit before doing anything else
// (scorecard K5). The limiter itself is tested in packages/db/rate-limit.test.ts;
// these surfaces need a request scope (next/headers), so the wiring is asserted
// from source, the same way the host guard is.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const app = join(__dirname, '..', 'app');
const src = (rel: string) => readFileSync(join(app, rel), 'utf8');

describe('rate-limited guest surfaces', () => {
  it('the booking action counts a hit before placing anything', () => {
    const s = src('book/actions.ts');
    expect(s.indexOf("allow('book'")).toBeGreaterThan(-1);
    expect(s.indexOf("allow('book'")).toBeLessThan(s.indexOf('placeReservation('));
  });

  it('every manage-link write goes through the counted tokenOf', () => {
    const s = src('m/[token]/actions.ts');
    expect(s).toContain("allow('manage'");
    const exports = [...s.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
    expect(exports).toEqual(['change', 'cancel', 'confirm']);
    expect(s.match(/await tokenOf\(f\)/g)).toHaveLength(exports.length);
  });

  it('the manage page counts a hit before looking the token up', () => {
    const s = src('m/[token]/page.tsx');
    expect(s.indexOf("allow('manage'")).toBeGreaterThan(-1);
    expect(s.indexOf("allow('manage'")).toBeLessThan(s.indexOf('loadManage(token'));
  });

  it('the staff sign-in goes through the attempt-limited decision', () => {
    expect(src('host/login/actions.ts')).toContain('decideStaffSignIn(');
  });
});
