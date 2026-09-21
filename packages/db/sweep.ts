// The deadline sweep (P0-7 auto-release, P0-5 reminders), run on a schedule
// by the cron route. Four passes, each committed on its own, in this order:
//
//   1. Release. Unconfirmed bookings past their deadline go `booked →
//      released` through the lifecycle module, and their TableHold rows are
//      deleted in the same transaction — the table is real inventory the
//      instant it commits.
//   2. Release notices. A SEPARATE pass over released reservations with no
//      notice yet: the inventory decision never waits on (or rolls back
//      with) a message, and a crash between the two passes heals on the
//      next sweep. Quiet hours defer the send (in dispatch), never the release.
//   3. Reminders, one per reservation.
//   4. Dispatch everything queued — confirmations and inbound replies too.
//
// Rows are claimed FOR UPDATE SKIP LOCKED, so two overlapping sweeps split
// the work, and a row an inbound reply or a change holds is left for the
// next sweep rather than waited on. Messages are one per (reservation, kind)
// by constraint; skipDuplicates makes a concurrent pass a no-op, not an error.

import {
  DEFAULT_SWEEP,
  DEFAULT_TEMPLATES,
  UPCOMING,
  parseStatus,
  plusMs,
  renderMessage,
  shouldRelease,
  shouldRemind,
  transition,
  whenSlots,
  type MessageKind,
  type SendPolicy,
  type Status,
  type SweepPolicy,
  type Templates,
} from '@reserve/core';
import { prisma, type Reservation } from './index';
import { dispatchQueued, type MessageProvider } from './messages';

export type SweepConfig = {
  restaurant: string;
  timezone: string;
  send?: SendPolicy;
  /** The manage link is `${manageBaseUrl}/${token}`. */
  manageBaseUrl: string;
  bookUrl: string;
  templates?: Templates;
  policy?: SweepPolicy;
};

export type SweepResult = { released: string[]; notices: number; reminders: number; sent: number };

const RELEASED: Status = 'released';

/**
 * `confirmationSentAt` has no default on purpose. It is what decides whether
 * a booking may be auto-released at all, so a caller that forgets it must
 * fail to compile rather than quietly pick a policy.
 */
const toRow = (r: Reservation, confirmationSentAt: Date | null) => ({
  ...r,
  status: parseStatus(r.status),
  confirmationSentAt,
});

export async function sweep(provider: MessageProvider, config: SweepConfig, now: Date): Promise<SweepResult> {
  const p = config.policy ?? DEFAULT_SWEEP;
  const within = (...leads: number[]) => plusMs(now, Math.max(...leads) * 60_000);
  const released = p.releaseLead === 0 ? [] : await releaseDue(within(p.releaseLead, p.sameDayReleaseLead), config, now, p);
  const notices = await queue('released', [RELEASED], within(p.releaseLead, p.sameDayReleaseLead), config, now, () => true);
  const reminders = await queue('reminder', UPCOMING, within(p.reminderLead, p.lateReminderLead), config, now, (r) => shouldRemind(toRow(r, null), now, p));
  const sent = await dispatchQueued(provider, now, config);
  return { released, notices, reminders, sent: sent.length };
}

async function releaseDue(horizon: Date, config: SweepConfig, now: Date, p: SweepPolicy): Promise<string[]> {
  return prisma.$transaction(async (tx) => {
    // The confirmation REQUEST's send time, joined rather than denormalised:
    // one fact, in the messages table that already owns it, so it cannot
    // drift from what was actually sent.
    const candidates = await tx.$queryRaw<(Reservation & { confirmationSentAt: Date | null })[]>`
      SELECT r.*, (
        SELECT MIN(m."statusChangedAt") FROM "OutboundMessage" m
        WHERE m."reservationId" = r.id AND m.kind = 'confirmation' AND m.status IN ('sent', 'delivered')
      ) AS "confirmationSentAt"
      FROM "Reservation" r
      WHERE r.status = ANY(${[...UPCOMING]}::text[]) AND r."startAt" > ${now} AND r."startAt" <= ${horizon}
      ORDER BY r."startAt", r.id FOR UPDATE SKIP LOCKED`;
    const released: string[] = [];
    for (const r of candidates) {
      const row = toRow(r, r.confirmationSentAt);
      if (!shouldRelease(row, now, config.timezone, p)) continue;
      const d = transition(row, 'released', 'system', now);
      if (!d.ok) continue;
      await tx.reservation.update({ where: { id: r.id }, data: { status: d.to, statusChangedAt: now } });
      if (d.tables === 'release') await tx.tableHold.deleteMany({ where: { reservationId: r.id } });
      await tx.reservationEvent.create({
        data: { reservationId: r.id, at: now, fromStatus: d.from, toStatus: d.to, source: 'system', note: 'unconfirmed at the deadline' },
      });
      released.push(r.id);
    }
    return released;
  }, { timeout: 30_000 });
}

/**
 * Queues one `kind` message for each reservation in `statuses`, starting
 * before `horizon`, that `due` picks, that consented to texts, and that has
 * none yet. A number that texted STOP is skipped here too; dispatch checks
 * again at send time, which covers rows queued before the STOP.
 *
 * ponytail: read-then-insert, unlocked. A guest who cancels in the
 * milliseconds between can still be queued a reminder; move the status
 * check into an INSERT … SELECT if that ever shows up in the log.
 */
async function queue(
  kind: MessageKind,
  statuses: readonly Status[],
  horizon: Date,
  config: SweepConfig,
  now: Date,
  due: (r: Reservation) => boolean,
): Promise<number> {
  const candidates = await prisma.$queryRaw<Reservation[]>`
    SELECT r.* FROM "Reservation" r
    WHERE r.status = ANY(${[...statuses]}::text[]) AND r."startAt" > ${now} AND r."startAt" <= ${horizon}
      AND NOT EXISTS (SELECT 1 FROM "OutboundMessage" m WHERE m."reservationId" = r.id AND m.kind = ${kind})
      AND r."smsConsent" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "SmsOptOut" o WHERE o.phone = r."guestPhone")
    ORDER BY r."startAt", r.id`;
  const template = (config.templates ?? DEFAULT_TEMPLATES)[kind];
  // The SQL's consent filter already implies a number (CHECK); this says so to the type.
  const reachable = candidates.filter((r): r is Reservation & { guestPhone: string } => r.guestPhone !== null);
  const data = reachable.filter(due).map((r) => ({
    reservationId: r.id,
    kind,
    toPhone: r.guestPhone,
    body: renderMessage(template, {
      restaurant: config.restaurant,
      ...whenSlots(r.startAt, config.timezone),
      party: String(r.partySize),
      link: `${config.manageBaseUrl}/${r.manageToken}`,
      bookLink: config.bookUrl,
    }),
    status: 'queued',
    createdAt: now,
    statusChangedAt: now,
  }));
  const { count } = await prisma.outboundMessage.createMany({ data, skipDuplicates: true });
  return count;
}
