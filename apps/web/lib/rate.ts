// Per-client limits on the guest surfaces nobody signs in to (scorecard K5,
// SEC-01): the booking form and the manage link. Counters live in Postgres
// (@reserve/db/rate-limit), so they hold across serverless instances.
import { headers } from 'next/headers';
import { clientKey, hit, LIMITS } from '@reserve/db/rate-limit';

/**
 * The caller's address. On Vercel `x-forwarded-for` is set by the platform
 * (a client-supplied one is overwritten), first entry = the client. Off
 * Vercel, behind no proxy, every request shares one bucket — the failure is
 * "too strict", never "unlimited".
 */
export async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip')?.trim() || 'unknown';
}

const SCOPES = { book: LIMITS.bookPerIp, manage: LIMITS.managePerIp } as const;

/** Counts one hit for this client on `scope`. False = over the limit; refuse. */
export async function allow(scope: keyof typeof SCOPES, now: Date): Promise<boolean> {
  return hit(clientKey(scope, await clientIp()), SCOPES[scope], now);
}
