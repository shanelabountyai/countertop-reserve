// The inbound SMS webhook (P0-6): the first place a stranger can move state.
//
//   1. The HTTP route verifies the provider's signature over the raw body
//      (verifySignature) and parses the payload (parseInboundPayload) before
//      anything here runs.
//   2. handleInbound serializes on the sender's number (advisory lock), then
//      checks the provider's message id BEFORE any transition — a redelivered
//      webhook returns what the first delivery did and changes nothing. The
//      unique constraint on providerMessageId is the backstop.
//   3. The body is parsed to an allowlisted keyword in core; the transition,
//      the inbound row, the event and the queued reply commit together.

import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  DEFAULT_TEMPLATES,
  UPCOMING,
  decideInbound,
  isE164,
  parseReply,
  parseStatus,
  renderMessage,
  whenSlots,
  type InboundAction,
  type InboundOutcome,
  type LastInbound,
  type MessageKind,
  type Slots,
  type Templates,
} from '@reserve/core';
import { Prisma, prisma, type Reservation } from './index';

/** Hex HMAC-SHA256 of the raw request body — what the provider (or the mock poster) sends in the signature header. */
export const signBody = (raw: string, secret: string) => createHmac('sha256', secret).update(raw).digest('hex');

/**
 * Constant-time. The signature covers the body only; a replayed signed
 * request is harmless because handling is idempotent on the message id.
 */
export function verifySignature(raw: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const want = Buffer.from(signBody(raw, secret));
  const got = Buffer.from(signature);
  return got.length === want.length && timingSafeEqual(got, want);
}

export type InboundPayload = { providerMessageId: string; from: string; body: string };

/** The provider's JSON, or null. Nothing past this point sees an unvalidated field. */
export function parseInboundPayload(raw: string): InboundPayload | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const { providerMessageId, from, body } = v as Record<string, unknown>;
  if (typeof providerMessageId !== 'string' || !/^[\w.-]{1,128}$/.test(providerMessageId)) return null;
  if (typeof from !== 'string' || !isE164(from)) return null;
  if (typeof body !== 'string') return null;
  return { providerMessageId, from, body };
}

export type InboundConfig = {
  restaurant: string;
  timezone: string;
  /** The restaurant's number, for HELP and the STOP acknowledgement. */
  phone: string;
  /** The manage link is `${manageBaseUrl}/${token}`. */
  manageBaseUrl: string;
  bookUrl: string;
  templates?: Templates;
};

export type InboundResult = { replayed: boolean; outcome: InboundOutcome; reply: string | null };

const BODY_MAX = 1600;

export async function handleInbound(msg: InboundPayload, config: InboundConfig, now: Date): Promise<InboundResult> {
  const replay = async (): Promise<InboundResult | null> => {
    const row = await prisma.inboundMessage.findUnique({ where: { providerMessageId: msg.providerMessageId }, include: { reply: true } });
    return row && { replayed: true, outcome: row.outcome as InboundOutcome, reply: row.reply?.body ?? null };
  };
  try {
    return await prisma.$transaction(async (tx) => {
      // Two-key form: a key space disjoint from placement's single-key bucket locks.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1, hashtext(${msg.from}))`;
      const seen = await tx.inboundMessage.findUnique({ where: { providerMessageId: msg.providerMessageId }, include: { reply: true } });
      if (seen) return { replayed: true, outcome: seen.outcome as InboundOutcome, reply: seen.reply?.body ?? null };

      // Locked, so a host tapping "cancel" on the same row waits for this reply to land, and vice versa.
      const upcoming = await tx.$queryRaw<Reservation[]>`
        SELECT * FROM "Reservation"
        WHERE "guestPhone" = ${msg.from} AND status = ANY(${[...UPCOMING]}::text[]) AND "startAt" > ${now}
        ORDER BY "startAt", id FOR UPDATE`;
      const prev = await tx.inboundMessage.findFirst({ where: { fromPhone: msg.from }, orderBy: { id: 'desc' } });
      const last: LastInbound | null = prev && { ...prev, outcome: prev.outcome as InboundOutcome };
      const action = decideInbound(
        parseReply(msg.body),
        upcoming.map((r) => ({ id: r.id, status: parseStatus(r.status), startAt: r.startAt })),
        last,
        now,
      );

      const optedOut = (await tx.smsOptOut.findUnique({ where: { phone: msg.from } })) !== null;
      if (action.outcome === 'opted_out' && !optedOut) await tx.smsOptOut.create({ data: { phone: msg.from, at: now } });
      if (action.outcome === 'opted_in') await tx.smsOptOut.deleteMany({ where: { phone: msg.from } });

      const reservationId = 'reservationId' in action ? action.reservationId : null;
      const inbound = await tx.inboundMessage.create({
        data: {
          providerMessageId: msg.providerMessageId,
          fromPhone: msg.from,
          // Postgres text cannot hold NUL; a body that long is a flood, not a reply.
          body: [...msg.body.replace(/\0/g, '')].slice(0, BODY_MAX).join(''),
          receivedAt: now,
          outcome: action.outcome,
          reservationId,
          choices: action.outcome === 'choose' ? action.choices : [],
        },
      });

      if ((action.outcome === 'confirmed' || action.outcome === 'cancelled') && action.transition.from !== action.transition.to) {
        const { from, to, tables } = action.transition;
        await tx.reservation.update({ where: { id: action.reservationId }, data: { status: to, statusChangedAt: now } });
        // Released in the same transaction as the event: the table is real inventory the instant this commits.
        if (tables === 'release') await tx.tableHold.deleteMany({ where: { reservationId: action.reservationId } });
        await tx.reservationEvent.create({
          data: { reservationId: action.reservationId, at: now, fromStatus: from, toStatus: to, source: 'sms', inboundMessageId: inbound.id },
        });
      }

      // After STOP only the one acknowledgement goes out; opting back in is answered with HELP.
      const kind = replyKind(action, optedOut);
      if (!kind) return { replayed: false, outcome: action.outcome, reply: null };
      const body = renderMessage((config.templates ?? DEFAULT_TEMPLATES)[kind], slotsFor(action, upcoming, config));
      await tx.outboundMessage.create({
        data: { inboundMessageId: inbound.id, kind, toPhone: msg.from, body, status: 'queued', createdAt: now, statusChangedAt: now },
      });
      return { replayed: false, outcome: action.outcome, reply: body };
    });
  } catch (e) {
    // The same message id from a different number raced past the lock; the constraint caught it.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const r = await replay();
      if (r) return r;
    }
    throw e;
  }
}

/** Null = no reply: a selection waits for its C or X, a handoff waits for a human, a repeat STOP gets silence. */
function replyKind(action: InboundAction, optedOut: boolean): MessageKind | null {
  switch (action.outcome) {
    case 'selected':
    case 'handoff':
      return null;
    case 'opted_out':
      return optedOut ? null : 'opted_out';
    case 'opted_in':
      return 'help';
    default:
      // ponytail: opt-out is checked at queue time here; V-009 adds the
      // send-time check in dispatch (P0-8), which this does not replace.
      return optedOut ? null : action.outcome;
  }
}

function slotsFor(action: InboundAction, upcoming: readonly Reservation[], c: InboundConfig): Slots {
  const when = (r: Reservation) => whenSlots(r.startAt, c.timezone);
  const byId = (id: string) => upcoming.find((r) => r.id === id)!;
  const base = { restaurant: c.restaurant, phone: c.phone, bookLink: c.bookUrl };
  if (action.outcome === 'choose') {
    const choices = action.choices.map((id, i) => {
      const w = when(byId(id));
      return `${i + 1}) ${w.date} ${w.time}`;
    });
    return { ...base, count: String(choices.length), choices: choices.join(', ') };
  }
  if (!('reservationId' in action)) return base;
  const r = byId(action.reservationId);
  return { ...base, ...when(r), party: String(r.partySize), link: `${c.manageBaseUrl}/${r.manageToken}` };
}
