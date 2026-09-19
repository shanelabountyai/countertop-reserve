// The provider's inbound-SMS webhook (P0-6). Everything a stranger sends
// crosses here: size cap, then signature over the raw body, then payload
// validation — and only then does the handler see it.

import { handleInbound, parseInboundPayload, verifySignature } from '@reserve/db/inbound';
import { RESTAURANT } from '@/lib/restaurant';

const MAX_BYTES = 16_384;

export async function POST(req: Request) {
  // Fail closed: an unset secret must never mean "accept unsigned".
  const secret = process.env.SMS_WEBHOOK_SECRET;
  if (!secret) return new Response('webhook not configured', { status: 503 });
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BYTES) return new Response('too large', { status: 413 });

  const raw = await req.text();
  if (raw.length > MAX_BYTES) return new Response('too large', { status: 413 });
  if (!verifySignature(raw, req.headers.get('x-signature'), secret)) return new Response('bad signature', { status: 401 });
  const msg = parseInboundPayload(raw);
  if (!msg) return new Response('bad payload', { status: 400 });

  // The origin is the one the provider signed a request to; links in replies point back at it.
  const origin = new URL(req.url).origin;
  const result = await handleInbound(msg, { ...RESTAURANT, manageBaseUrl: `${origin}/m`, bookUrl: `${origin}/book` }, new Date());
  return Response.json(result);
}
