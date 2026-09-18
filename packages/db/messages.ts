// Outbound delivery (P0-5). Rows are queued by placement, inside the booking
// transaction; this module sends them and records what the provider says.
//
// A row is sent at most once: dispatch claims `queued` rows with FOR UPDATE
// SKIP LOCKED, so two dispatchers never pick up the same row, and a row that
// has left `queued` is never picked up again.

import { randomBytes } from 'node:crypto';
import { DEFAULT_SEND, dayStart, sendDecision, type MessageKind, type SendPolicy } from '@reserve/core';
import { prisma, type OutboundMessage } from './index';

export type SendResult = { ok: true; providerMessageId: string } | { ok: false; reason: string };

/** The carrier seam. v1 ships the mock; Twilio/Sinch is a swap (P2). */
export interface MessageProvider {
  send(msg: { id: string; to: string; body: string }): Promise<SendResult>;
}

/** Records every send; numbers in `reject` are refused the way a carrier refuses a landline. */
export function mockProvider(reject: ReadonlySet<string> = new Set()) {
  const sent: { id: string; to: string; body: string; providerMessageId: string }[] = [];
  const provider: MessageProvider = {
    async send(msg) {
      if (reject.has(msg.to)) return { ok: false, reason: 'unreachable' };
      const providerMessageId = `mock-${randomBytes(8).toString('hex')}`;
      sent.push({ ...msg, providerMessageId });
      return { ok: true, providerMessageId };
    },
  };
  return { provider, sent };
}

/** 128 random bits, base64url (22 chars) — the manage link's credential. */
export const newManageToken = () => randomBytes(16).toString('base64url');

/**
 * Sends up to `limit` queued messages, oldest first, each only if P0-8 allows
 * it NOW: opt-out, quiet hours and the daily limit are read at send time, not
 * trusted from queue time. A deferred row stays `queued` for a later sweep and
 * does not count toward `limit`; a dropped one goes `failed` with the reason
 * (`opted_out` | `rate_limited`) — that row is the drop's log. Returns the rows
 * it moved.
 *
 * ponytail: the provider call runs inside the claiming transaction, holding
 * the row lock across a network round trip. Fine for a mock and one
 * restaurant; claim-then-send with a `sending` state if a real carrier's
 * latency ever stalls the pool.
 * ponytail: claims every queued row (no SQL LIMIT) so deferred rows can't
 * starve the ones behind them. Fine at one restaurant's queue; add a
 * `notBefore` column and filter on it if the queue ever grows large.
 */
export async function dispatchQueued(
  provider: MessageProvider,
  now: Date,
  config: { timezone: string; send?: SendPolicy },
  limit = 50,
): Promise<OutboundMessage[]> {
  const policy = config.send ?? DEFAULT_SEND;
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.$queryRaw<(OutboundMessage & { startAt: Date | null; optedOut: boolean })[]>`
      SELECT m.*, r."startAt", EXISTS (SELECT 1 FROM "SmsOptOut" o WHERE o.phone = m."toPhone") AS "optedOut"
      FROM "OutboundMessage" m LEFT JOIN "Reservation" r ON r.id = m."reservationId"
      WHERE m.status = 'queued'
      ORDER BY m."createdAt", m.id FOR UPDATE OF m SKIP LOCKED`;
    // Accepted by the provider today (a provider id), per number.
    const counts = await tx.$queryRaw<{ toPhone: string; n: number }[]>`
      SELECT "toPhone", count(*)::int AS n FROM "OutboundMessage"
      WHERE "toPhone" = ANY(${[...new Set(claimed.map((m) => m.toPhone))]}::text[])
        AND "providerMessageId" IS NOT NULL AND "statusChangedAt" >= ${dayStart(now, config.timezone)}
      GROUP BY "toPhone"`;
    const sentToday = new Map(counts.map((c) => [c.toPhone, c.n]));

    const moved: OutboundMessage[] = [];
    for (const { startAt, optedOut, ...m } of claimed) {
      if (moved.length >= limit) break;
      const decision = sendDecision(
        { kind: m.kind as MessageKind, isReply: m.inboundMessageId !== null, startAt, optedOut, sentToday: sentToday.get(m.toPhone) ?? 0 },
        now,
        config.timezone,
        policy,
      );
      if (decision === 'defer') continue;
      const r: SendResult = decision === 'send' ? await provider.send({ id: m.id, to: m.toPhone, body: m.body }) : { ok: false, reason: decision };
      if (r.ok) sentToday.set(m.toPhone, (sentToday.get(m.toPhone) ?? 0) + 1);
      moved.push(
        await tx.outboundMessage.update({
          where: { id: m.id },
          data: r.ok
            ? { status: 'sent', providerMessageId: r.providerMessageId, statusChangedAt: now }
            : { status: 'failed', failureReason: r.reason, statusChangedAt: now },
        }),
      );
    }
    return moved;
  }, { timeout: 30_000 });
}

/**
 * The provider's delivery callback. Idempotent: a redelivered callback, or
 * one for a row already delivered/failed, changes nothing and returns false.
 */
export async function recordDelivery(
  providerMessageId: string,
  outcome: { status: 'delivered' } | { status: 'failed'; reason: string },
  now: Date,
): Promise<boolean> {
  // `sent` is the only status a callback may move (canDeliver in core).
  const { count } = await prisma.outboundMessage.updateMany({
    where: { providerMessageId, status: 'sent' },
    data: { status: outcome.status, failureReason: outcome.status === 'failed' ? outcome.reason : null, statusChangedAt: now },
  });
  return count === 1;
}
