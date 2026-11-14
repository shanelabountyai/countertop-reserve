// Rate limiting for unauthenticated writes and token reads (scorecard K5,
// SEC-01), from the foundation's shape: fixed-window counters in Postgres, so
// a limit holds across every serverless instance and survives a cold start.
// One atomic upsert per hit — no read-then-write race.
//
// Takes `now` like everything else in this package; nothing here reads the
// clock. Keys never contain a raw client address: `clientKey` hashes it.
//
// ponytail: a fixed window allows up to 2x the limit across a window edge.
// Switch to a sliding window if that burst ever matters.

import { createHash } from 'node:crypto';
import { plusMs } from '@reserve/core';
import { prisma } from './index';

export type Limit = { limit: number; windowMs: number };

export const LIMITS = {
  /** WRONG staff passcodes per address. Counted on failure only, so a tablet signing in is never throttled. */
  staffSignInPerIp: { limit: 10, windowMs: 15 * 60_000 },
  /** Guest booking submissions per address. A party books once; a script books hundreds. */
  bookPerIp: { limit: 20, windowMs: 15 * 60_000 },
  /** Manage-link page views and writes per address. Generous for a person, tight for a token guesser. */
  managePerIp: { limit: 60, windowMs: 15 * 60_000 },
} as const satisfies Record<string, Limit>;

/** The start of the fixed window `now` falls in — epoch arithmetic, never a parse. */
const windowOf = (now: Date, windowMs: number) => plusMs(now, -(now.getTime() % windowMs));

/** `scope:` + a truncated SHA-256 of the address — counts per client without storing who the client was. */
export const clientKey = (scope: string, ip: string) => `${scope}:${createHash('sha256').update(ip).digest('hex').slice(0, 32)}`;

/** Counts one hit against `key`. True when the hit is within the limit. */
export async function hit(key: string, { limit, windowMs }: Limit, now: Date): Promise<boolean> {
  const windowStart = windowOf(now, windowMs);
  const [row] = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimit" ("key", "windowStart", "count") VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT ("key", "windowStart") DO UPDATE SET "count" = "RateLimit"."count" + 1
    RETURNING "count"`;
  return row!.count <= limit;
}

/** True when `key` has already used its whole limit in this window. Counts nothing. */
export async function spent(key: string, { limit, windowMs }: Limit, now: Date): Promise<boolean> {
  const row = await prisma.rateLimit.findUnique({ where: { key_windowStart: { key, windowStart: windowOf(now, windowMs) } } });
  return row !== null && row.count >= limit;
}

/** Deletes counters whose window ended over a day ago; nothing reads them once the window passes. */
export async function sweepRateLimits(now: Date): Promise<number> {
  const { count } = await prisma.rateLimit.deleteMany({ where: { windowStart: { lt: plusMs(now, -86_400_000) } } });
  return count;
}
