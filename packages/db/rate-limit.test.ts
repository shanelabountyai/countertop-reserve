// The Postgres-backed limiter (scorecard K5 / SEC-01).
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './index';
import { clientKey, hit, spent, sweepRateLimits, type Limit } from './rate-limit';
import { resetDatabase } from './testing/index';

const LIMIT: Limit = { limit: 3, windowMs: 15 * 60_000 };
const NOW = new Date(Date.UTC(2026, 9, 2, 19, 1)); // inside the 19:00–19:15 window

beforeEach(resetDatabase);

describe('rate limiting', () => {
  it('allows `limit` hits per window, refuses the next, and keys are independent', async () => {
    const a = clientKey('test', '203.0.113.7');
    const b = clientKey('test', '203.0.113.8');
    expect(await Promise.all([1, 2, 3].map(() => hit(a, LIMIT, NOW)))).toEqual([true, true, true]);
    expect(await hit(a, LIMIT, NOW)).toBe(false);
    expect(await spent(a, LIMIT, NOW)).toBe(true);
    expect(await hit(b, LIMIT, NOW)).toBe(true);
    expect(await spent(b, LIMIT, NOW)).toBe(false);
  });

  it('counts concurrent hits exactly (one atomic upsert, no read-then-write)', async () => {
    const k = clientKey('race', '203.0.113.9');
    const results = await Promise.all(Array.from({ length: 10 }, () => hit(k, LIMIT, NOW)));
    expect(results.filter(Boolean)).toHaveLength(3);
    expect((await prisma.rateLimit.findFirstOrThrow({ where: { key: k } })).count).toBe(10);
  });

  it('starts fresh in the next window', async () => {
    const k = clientKey('test', '203.0.113.7');
    for (let i = 0; i < 4; i += 1) await hit(k, LIMIT, NOW);
    const next = new Date(Date.UTC(2026, 9, 2, 19, 15));
    expect(await spent(k, LIMIT, next)).toBe(false);
    expect(await hit(k, LIMIT, next)).toBe(true);
  });

  it('never stores the client address, only a hash of it', async () => {
    await hit(clientKey('test', '198.51.100.23'), LIMIT, NOW);
    const [row] = await prisma.rateLimit.findMany();
    expect(row!.key).not.toContain('198.51.100.23');
    expect(row!.key).toMatch(/^test:[0-9a-f]{32}$/);
  });

  it('the sweep deletes only counters whose window ended over a day ago', async () => {
    const k = clientKey('test', '203.0.113.7');
    await hit(k, LIMIT, new Date(Date.UTC(2026, 8, 30, 10)));
    await hit(k, LIMIT, NOW);
    expect(await sweepRateLimits(NOW)).toBe(1);
    expect(await prisma.rateLimit.count()).toBe(1);
  });
});
