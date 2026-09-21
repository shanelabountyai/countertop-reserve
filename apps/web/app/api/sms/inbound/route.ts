// The provider's inbound-SMS webhook (P0-6). Everything a stranger sends
// crosses here: size cap, then signature over the raw body, then payload
// validation — and only then does the handler see it.

import { handleInbound, parseInboundPayload, verifySignature } from '@reserve/db/inbound';
import { RESTAURANT } from '@/lib/restaurant';

const MAX_BYTES = 16_384;

/**
 * The body, or null if it is bigger than `max` BYTES.
 *
 * `req.text()` buffers the whole thing first and only then lets you measure
 * it, so the cap it was checked against protected nothing: a body with no
 * `Content-Length` (chunked, or a client that simply omits the header) was
 * read into memory in full before anything objected. This counts as it reads
 * and cancels the stream the moment the limit is passed, so the header is a
 * courtesy rather than the control.
 *
 * Bytes, not characters. `raw.length` counted UTF-16 code units, so a body of
 * multi-byte characters could be well over the byte cap and still measure
 * under it.
 */
async function readBounded(req: Request, max: number): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.byteLength;
  }
  // The exact bytes the provider signed, decoded once. Everything downstream
  // — the signature check and the parse — sees this same string.
  return new TextDecoder().decode(joined);
}

export async function POST(req: Request) {
  // Fail closed: an unset secret must never mean "accept unsigned".
  const secret = process.env.SMS_WEBHOOK_SECRET;
  if (!secret) return new Response('webhook not configured', { status: 503 });
  // A declared over-size body is refused without reading a byte; an undeclared
  // one is refused by the bounded read below.
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BYTES) return new Response('too large', { status: 413 });

  const raw = await readBounded(req, MAX_BYTES);
  if (raw === null) return new Response('too large', { status: 413 });
  if (!verifySignature(raw, req.headers.get('x-signature'), secret)) return new Response('bad signature', { status: 401 });
  const msg = parseInboundPayload(raw);
  if (!msg) return new Response('bad payload', { status: 400 });

  // The origin is the one the provider signed a request to; links in replies point back at it.
  const origin = new URL(req.url).origin;
  const result = await handleInbound(msg, { ...RESTAURANT, manageBaseUrl: `${origin}/m`, bookUrl: `${origin}/book` }, new Date());
  return Response.json(result);
}
