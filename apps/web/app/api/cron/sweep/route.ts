// The deadline sweep's trigger (P0-7). A scheduler calls this every few
// minutes with `Authorization: Bearer $CRON_SECRET` — Vercel Cron's
// convention, hence GET. Idempotent: an extra or overlapping call is harmless.

import { timingSafeEqual } from 'node:crypto';
import { mockProvider } from '@reserve/db/messages';
import { sweepRateLimits } from '@reserve/db/rate-limit';
import { sweep } from '@reserve/db/sweep';
import { RESTAURANT } from '@/lib/restaurant';

export async function GET(req: Request) {
  // Fail closed: an unset secret must never mean "anyone may sweep".
  const secret = process.env.CRON_SECRET;
  if (!secret) return new Response('sweep not configured', { status: 503 });
  const got = Buffer.from(req.headers.get('authorization') ?? '');
  const want = Buffer.from(`Bearer ${secret}`);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return new Response('unauthorized', { status: 401 });

  const origin = new URL(req.url).origin;
  // ponytail: the mock carrier (P0-5 "mock in v1"); a real one is a swap behind MessageProvider.
  const now = new Date();
  const result = await sweep(mockProvider().provider, { ...RESTAURANT, manageBaseUrl: `${origin}/m`, bookUrl: `${origin}/book` }, now);
  // Rate-limit counters (K5) whose window ended over a day ago. Not in the response: its shape is the sweep's.
  await sweepRateLimits(now);
  return Response.json(result);
}
