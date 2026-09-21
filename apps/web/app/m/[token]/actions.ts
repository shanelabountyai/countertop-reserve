'use server';

// The manage page's three writes (P0-12). Each takes the token from the form
// and nothing else that names a reservation: a guest can only ever act on the
// one booking their link is for.
//
// None of them is a second code path. `guestChange` is `changeReservation` —
// the same re-allocation the SMS `CHANGE` keyword bounces here for — and
// `guestCancel`/`guestConfirm` are the ONE lifecycle module with `guest` as
// the actor, which is exactly what an inbound `X` or `C` does.
import { redirect } from 'next/navigation';
import { guestCancel, guestChange, guestConfirm } from '@reserve/db/guest';
import { guestConfig, parseParty, parseSlot } from '@/lib/guest';
import { RESTAURANT } from '@/lib/restaurant';

const TOKEN = /^[\w-]{22}$/;
const field = (f: FormData, name: string) => f.get(name)?.toString() ?? '';

/** The token, or straight to the 404 the page gives an unknown one. */
function tokenOf(f: FormData): string {
  const token = field(f, 'token');
  if (!TOKEN.test(token)) redirect('/book');
  return token;
}

export async function change(f: FormData): Promise<void> {
  const token = tokenOf(f);
  const now = new Date();
  const day = field(f, 'day');
  const party = parseParty(field(f, 'party'));
  const startAt = parseSlot(day, field(f, 'at'), RESTAURANT.timezone);
  const back = (notice: string): never => redirect(`/m/${token}?notice=${notice}`);
  if (party === null || startAt === null) return back('closed');

  const result = await guestChange(token, { day, startAt, partySize: party, now }, await guestConfig());
  if (!result.ok) return back(result.reason === 'not_found' ? 'not_changeable' : result.reason);
  return back(result.changed ? 'changed' : 'unchanged');
}

export async function cancel(f: FormData): Promise<void> {
  const token = tokenOf(f);
  const result = await guestCancel(token, new Date(), await guestConfig());
  redirect(`/m/${token}?notice=${result.ok ? 'cancelled' : result.reason}`);
}

/**
 * The guest confirms. The token is the credential, exactly as for cancel —
 * and this is the ONLY way to confirm for a guest who declined texts, whose
 * `C` reply does not exist because the confirmation request never went out.
 */
export async function confirm(f: FormData): Promise<void> {
  const token = tokenOf(f);
  const result = await guestConfirm(token, new Date(), await guestConfig());
  redirect(`/m/${token}?notice=${result.ok ? 'confirmed' : result.reason}`);
}
