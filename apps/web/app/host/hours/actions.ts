'use server';

// Editing the hours (P0-10). Same shape as the floor's taps: a plain form
// POST, behind the /host passcode gate (middleware.ts), with the outcome
// travelling back as a notice CODE so a crafted link cannot put words on the
// host's screen.
//
// The one difference: an edit that would strand already-booked reservations
// is NOT applied. It comes back as the same fields in the URL, and the page
// re-runs it in `check` mode to show who would be stranded before the host
// confirms. Nothing is written until they do.
import { redirect } from 'next/navigation';
import { editSchedule } from '@reserve/db/schedule';
import { RESTAURANT } from '@/lib/restaurant';
import { FIELDS, parseEdit } from './edit';

export async function edit(f: FormData): Promise<void> {
  const parsed = parseEdit((name) => f.get(name)?.toString() ?? '');
  if (!parsed) redirect('/host/hours?notice=invalid');

  const r = await editSchedule(parsed, RESTAURANT.timezone, new Date(), f.get('force') === '1' ? 'force' : 'apply');
  if (r.ok) redirect('/host/hours?notice=saved');
  if (r.reason !== 'strands') redirect(`/host/hours?notice=${r.reason}`);

  const q = new URLSearchParams({ confirm: '1' });
  for (const name of FIELDS) {
    const value = f.get(name)?.toString() ?? '';
    if (value !== '') q.set(name, value);
  }
  redirect(`/host/hours?${q}`);
}
