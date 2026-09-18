// Outbound delivery (P0-5). Rows are queued by placement, inside the booking
// transaction; this module sends them and records what the provider says.
//
// A row is sent at most once: dispatch claims `queued` rows with FOR UPDATE
// SKIP LOCKED, so two dispatchers never pick up the same row, and a row that
// has left `queued` is never picked up again.

import { randomBytes } from 'node:crypto';
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
 * Sends up to `limit` queued messages, oldest first. Returns the rows it moved.
 *
 * ponytail: the provider call runs inside the claiming transaction, holding
 * the row lock across a network round trip. Fine for a mock and one
 * restaurant; claim-then-send with a `sending` state if a real carrier's
 * latency ever stalls the pool.
 */
export async function dispatchQueued(provider: MessageProvider, now: Date, limit = 50): Promise<OutboundMessage[]> {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.$queryRaw<OutboundMessage[]>`
      SELECT * FROM "OutboundMessage" WHERE status = 'queued'
      ORDER BY "createdAt", id LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
    const moved: OutboundMessage[] = [];
    for (const m of claimed) {
      const r = await provider.send({ id: m.id, to: m.toPhone, body: m.body });
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
