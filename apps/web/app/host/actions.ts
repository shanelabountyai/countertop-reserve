'use server';

// The host's taps (P0-9). Each is a plain form POST to a server action, so it
// works before hydration and sits behind the /host passcode gate
// (middleware.ts). The outcome travels back as a notice CODE in the URL; the
// page maps codes to fixed text, so a crafted link can never put words on
// the host's screen.
import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { dayOf, isCalendarDay, STATUSES, type Status } from '@reserve/core';
import { addWalkIn, assignUnit, hostMove, tableReady, undoLast } from '@reserve/db/floor';
import { mockProvider } from '@reserve/db/messages';
import { RESTAURANT } from '@/lib/restaurant';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;


const field = (f: FormData, name: string) => f.get(name)?.toString() ?? '';
const back = (f: FormData, notice?: string): never => {
  const day = field(f, 'day');
  const q = new URLSearchParams({ ...(isCalendarDay(day) && { day }), ...(notice && { notice }) }).toString();
  return redirect(q ? `/host?${q}` : '/host');
};
/** The row id, or back to the floor: Postgres would 500 on a bad uuid cast. */
const rowId = (f: FormData) => {
  const id = field(f, 'id');
  return UUID.test(id) ? id : back(f, 'not_found');
};

export async function move(f: FormData): Promise<void> {
  const id = rowId(f);
  const to = field(f, 'to');
  if (!(STATUSES as readonly string[]).includes(to)) back(f, 'no_edge');
  const r = await hostMove(id, to as Status, RESTAURANT, new Date());
  back(f, r.ok ? undefined : r.reason);
}

/**
 * The host names a table (P0-14). The unit id is NOT validated against the
 * floor plan here: `assignUnit` re-reads the plan inside its transaction and
 * answers `unknown_unit`, so a stale picker and a crafted POST get the same
 * honest refusal rather than two different ones.
 */
export async function assign(f: FormData): Promise<void> {
  const id = rowId(f);
  const unit = field(f, 'unit');
  const r = await assignUnit(id, unit, RESTAURANT, new Date());
  back(f, r.ok ? (r.from.length === 0 ? 'assigned' : 'moved') : `assign_${r.reason}`);
}

export async function undo(f: FormData): Promise<void> {
  const r = await undoLast(rowId(f), RESTAURANT, new Date());
  back(f, r.ok ? 'undone' : r.reason);
}

export async function ready(f: FormData): Promise<void> {
  // ponytail: the mock carrier (P0-5 "mock in v1"), same as the sweep route.
  const r = await tableReady(rowId(f), mockProvider().provider, RESTAURANT, new Date());
  back(f, r.ok ? (r.sent ? 'ready_sent' : 'ready_not_sent') : r.reason);
}

export async function walkIn(f: FormData): Promise<void> {
  const now = new Date();
  const partySize = Number(field(f, 'partySize'));
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 50) back(f, 'invalid_party');
  const phone = field(f, 'guestPhone').replace(/[\s().-]/g, '');
  const r = await addWalkIn(
    {
      // Minted when the form rendered, so a double-tapped submit is one party.
      idempotencyKey: UUID.test(field(f, 'key')) ? field(f, 'key') : randomUUID(),
      day: dayOf(now, RESTAURANT.timezone),
      partySize,
      guestName: field(f, 'guestName').slice(0, 80) || 'Walk-in',
      guestPhone: phone === '' ? null : phone,
      textWhenReady: f.get('textWhenReady') === 'on',
      now,
    },
    RESTAURANT,
  );
  if (!r.ok) back(f, r.reason === 'invalid' ? `invalid_${r.field}` : r.reason);
  else back(f, r.reservation.status === 'seated' ? 'walkin_seated' : 'walkin_waitlisted');
}
