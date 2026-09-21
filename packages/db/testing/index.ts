// Test-only helpers. Not imported by apps/web.
import { prisma } from '../index';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

/**
 * Whether resetDatabase() may TRUNCATE `host`.
 *
 * Local hosts are always permitted — that is where the suite runs. Anything
 * else requires SEED_ALLOW_HOST to name the host EXACTLY (V-014, seeding the
 * hosted demo). Naming it is the deliberate act: a truthy-but-wrong value
 * does not open the gate, and neither does a wildcard, because there is no
 * wildcard to match on.
 *
 * Exported so the decision is testable without a database.
 */
export function resetPermitted(host: string, allowHost: string | undefined): boolean {
  if (LOCAL_HOSTS.includes(host)) return true;
  return typeof allowHost === 'string' && allowHost !== '' && allowHost === host;
}

/**
 * Wipes every table. TRUNCATE, not DELETE: the ReservationEvent append-only
 * trigger refuses DELETE by design, and TRUNCATE fires TRUNCATE triggers
 * rather than row triggers.
 *
 * Refuses anything but a local database, unless SEED_ALLOW_HOST names the
 * host exactly — tests never point at a remote one.
 */
export async function resetDatabase(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  const host = URL.canParse(url) ? new URL(url).hostname : '<unparseable>';
  if (!resetPermitted(host, process.env.SEED_ALLOW_HOST)) {
    throw new Error(
      `resetDatabase() refuses to wipe non-local database host "${host}". ` +
        `Set SEED_ALLOW_HOST="${host}" to permit it deliberately.`,
    );
  }
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "OutboundMessage", "ReservationEvent", "InboundMessage", "SmsOptOut",
      "ServicePeriod", "Blackout",
      "TableHold", "Reservation",
      "CombinationMember", "Combination", "DiningTable"
    RESTART IDENTITY CASCADE
  `);
}
