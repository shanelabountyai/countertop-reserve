// Test-only helpers. Not imported by apps/web.
import { prisma } from '../index';

/**
 * Wipes every table. TRUNCATE, not DELETE: the ReservationEvent append-only
 * trigger refuses DELETE by design, and TRUNCATE fires TRUNCATE triggers
 * rather than row triggers.
 *
 * Refuses anything but a local database — tests never point at a remote one.
 */
export async function resetDatabase(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  const host = URL.canParse(url) ? new URL(url).hostname : '<unparseable>';
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error(`resetDatabase() refuses to wipe non-local database host "${host}"`);
  }
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "OutboundMessage", "ReservationEvent", "InboundMessage", "SmsOptOut",
      "TableHold", "Reservation",
      "CombinationMember", "Combination", "DiningTable"
    RESTART IDENTITY CASCADE
  `);
}
