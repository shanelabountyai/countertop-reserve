'use server';

// The one guest write that creates something (P0-12). A plain form POST to a
// server action, so it works before hydration.
//
// This is a trust boundary: the form is convenience, not validation. Party
// size, day and minute-of-day are re-parsed here; the name, phone, note and
// tags go to `invalidGuestField`, which the database's CHECK constraints
// repeat underneath. A refusal travels back as a notice CODE in the URL and
// the page maps codes to fixed text, so a crafted link can never put words on
// a guest's screen.
import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { TAG_KINDS } from '@reserve/core';
import { placeReservation } from '@reserve/db/placement';
import { CONSENT, DAY, guestConfig, parseParty, parseSlot } from '@/lib/guest';
import { RESTAURANT } from '@/lib/restaurant';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const field = (f: FormData, name: string) => f.get(name)?.toString() ?? '';

export async function book(f: FormData): Promise<void> {
  const now = new Date();
  const party = parseParty(field(f, 'party'));
  const day = field(f, 'day');
  const back = (notice: string): never => {
    const q = new URLSearchParams({
      ...(party !== null && { party: String(party) }),
      ...(DAY.test(day) && { day }),
      ...(field(f, 'at') !== '' && { at: field(f, 'at') }),
      notice,
    });
    return redirect(`/book?${q}`);
  };

  if (party === null) return back('too_large');
  const startAt = parseSlot(day, field(f, 'at'), RESTAURANT.timezone);
  if (startAt === null) return back('closed');

  const result = await placeReservation(
    {
      idempotencyKey: UUID.test(field(f, 'key')) ? field(f, 'key') : randomUUID(),
      day,
      startAt,
      partySize: party,
      guestName: field(f, 'guestName').slice(0, 80),
      // Spacing and punctuation people type into a phone field; everything
      // else, including a missing "+", is a refusal, not a repair.
      guestPhone: field(f, 'guestPhone').replace(/[\s().-]/g, ''),
      note: field(f, 'note') || undefined,
      tags: f.getAll('tags').map(String).filter((t): t is (typeof TAG_KINDS)[number] => (TAG_KINDS as readonly string[]).includes(t)),
      source: 'guest_web',
      // Unticked = absent = no texts at all. The sentence is stored, not a boolean.
      smsConsent: f.get('consent') === 'on' ? CONSENT : undefined,
      now,
    },
    await guestConfig(),
  );

  if (!result.ok) return back(result.reason === 'invalid' ? `invalid_${result.field}` : result.reason);
  // The token IS the guest's credential. It reaches them here and in the
  // confirmation text, and nowhere else.
  redirect(`/m/${result.reservation.manageToken}?notice=booked`);
}
