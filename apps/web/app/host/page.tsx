// The host floor view (P0-9): tonight's book at arm's length.
//
// A server component — the one renderer for a row. LiveUpdates asks the
// server whether anything moved and re-runs this; nothing about a row is
// re-derived on the client. Which buttons a row gets comes from the lifecycle
// module's edge table (`allows`), never from a status list kept here.
import { randomUUID } from 'node:crypto';
import { allows, dayOf, minuteOfDay, periodAt, periodsFor, whenSlots, type Status } from '@reserve/core';
import { floorCursor, loadFloor, WAITLIST_CONSENT, type FloorRow } from '@reserve/db/floor';
import { loadSchedule } from '@reserve/db/schedule';
import { RESTAURANT } from '@/lib/restaurant';
import { move, ready, undo, walkIn } from './actions';
import { Expiring } from './expiring';
import { LiveUpdates } from './live-updates';

export const metadata = { title: 'Floor — Firebird Kitchen' };
export const dynamic = 'force-dynamic';

const TZ = RESTAURANT.timezone;

/** Every status must be named here — a new one fails to compile until it is. */
const STATUS_LABEL: Record<Status, string> = {
  waitlisted: 'Waiting',
  booked: 'Unconfirmed',
  confirmed: 'Confirmed',
  seated: 'Seated',
  completed: 'Done',
  cancelled: 'Cancelled',
  no_show: 'No-show',
  released: 'Released',
  abandoned: 'Left',
};

/** Fixed text per code: a URL can pick one, never write one. */
const NOTICES: Record<string, string> = {
  undone: 'Undone.',
  walkin_seated: 'Walk-in seated — see their row.',
  walkin_waitlisted: 'No table free — added to the waitlist with a quoted range.',
  ready_sent: '"Table ready" text sent.',
  ready_not_sent: '"Table ready" was not sent — see the row for why.',
  too_early: 'Too early for a no-show: the 15-minute grace period has not run.',
  undo_expired: 'Too late to undo — the 5 seconds have passed.',
  not_revertible: 'Nothing to undo on that row.',
  table_taken: "Can't undo: that table has been given to someone else.",
  no_table: 'No table fits that party yet.',
  no_longer_available: 'That table was just taken — try again.',
  too_large: 'No table or combination seats a party that large.',
  too_small: 'No table takes a party that small.',
  no_consent: 'That guest did not agree to a text.',
  invalid_guestPhone: 'That phone number is not valid — and a text needs one.',
  invalid_guestName: 'Enter a name.',
  invalid_party: 'Enter a party size.',
};

// Distinct by kind, in text and shape as well as colour (P0-9): an allergy is
// the loudest thing on the row, never styled like a birthday.
const TAG: Record<string, { label: string; className: string }> = {
  allergy: { label: '⚠ ALLERGY', className: 'border-2 border-red-900 bg-red-700 font-bold text-white' },
  accessibility: { label: '♿ Accessibility', className: 'border-2 border-blue-800 bg-blue-50 font-semibold text-blue-900' },
  occasion: { label: '✦ Occasion', className: 'border border-amber-700 bg-amber-50 text-amber-950' },
};

const FAILURE: Record<string, string> = { opted_out: 'guest opted out of texts', rate_limited: 'daily text limit reached' };
const KIND: Record<string, string> = { confirmation: 'Confirmation', reminder: 'Reminder', table_ready: '"Table ready"', released: 'Release notice' };

const minutesSince = (from: Date, now: Date) => Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
const time = (at: Date) => whenSlots(at, TZ).time;

export default async function HostPage({ searchParams }: { searchParams: Promise<{ day?: string; notice?: string }> }) {
  const { day: dayParam, notice } = await searchParams;
  const now = new Date();
  const today = dayOf(now, TZ);
  const day = dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : today;
  const [rows, cursor, schedule] = await Promise.all([loadFloor(day, now), floorCursor(), loadSchedule(TZ)]);

  const periods = [...periodsFor(schedule, day)].sort((a, b) => a.openMinute - b.openMinute);
  const periodOf = (r: FloorRow) => periodAt(periods, minuteOfDay(r.startAt, TZ))?.name ?? 'Outside service hours';
  const waitlist = rows.filter((r) => r.status === 'waitlisted');
  const book = rows.filter((r) => r.status !== 'waitlisted');
  const groups = [...periods.map((p) => p.name), 'Outside service hours']
    .map((name) => ({ name, rows: book.filter((r) => periodOf(r) === name) }))
    .filter((g) => g.rows.length > 0);

  return (
    <main className="mx-auto max-w-5xl p-4 text-lg text-neutral-950">
      <LiveUpdates cursor={cursor} />
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-3xl font-bold">Floor</h1>
        <p>
          {day === today ? 'Tonight' : day} · {RESTAURANT.restaurant} ·{' '}
          <a href="/host/hours" className="underline">
            Hours
          </a>{' '}
          ·{' '}
          <a href="/host/report" className="underline">
            Report
          </a>
        </p>
      </header>

      <div aria-live="polite" className="mt-3 min-h-8">
        {notice && NOTICES[notice] ? <p className="rounded-lg border-2 border-neutral-800 bg-yellow-100 px-4 py-2 font-semibold">{NOTICES[notice]}</p> : null}
      </div>

      <WalkInForm />

      <section aria-labelledby="waitlist" className="mt-6">
        <h2 id="waitlist" className="text-2xl font-bold">
          Waitlist <span className="font-normal">({waitlist.length})</span>
        </h2>
        {waitlist.length === 0 ? <p className="mt-2 text-neutral-700">Nobody waiting.</p> : <ul className="mt-2 flex flex-col gap-3">{waitlist.map((r) => <Row key={r.id} r={r} day={day} now={now} />)}</ul>}
      </section>

      {groups.length === 0 ? <p className="mt-6">No reservations on this day.</p> : null}
      {groups.map((g, i) => (
        <section key={g.name} aria-labelledby={`period-${i}`} className="mt-6">
          <h2 id={`period-${i}`} className="text-2xl font-bold">
            {g.name}
          </h2>
          <ul className="mt-2 flex flex-col gap-3">
            {g.rows.map((r) => (
              <Row key={r.id} r={r} day={day} now={now} />
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}

function Row({ r, day, now }: { r: FloorRow; day: string; now: Date }) {
  const done = !allows(r.status, 'seated', 'host') && !allows(r.status, 'completed', 'host');
  const readyText = r.messages.find((m) => m.kind === 'table_ready');
  const failed = r.messages.filter((m) => m.status === 'failed');
  const confirmation = r.messages.find((m) => m.kind === 'confirmation');

  let state = STATUS_LABEL[r.status];
  if (r.status === 'seated' && r.seatedAt) state += ` · ${minutesSince(r.seatedAt, now)} min`;
  if (r.status === 'waitlisted') state += ` · ${minutesSince(r.startAt, now)} min`;

  return (
    <li data-testid="floor-row" className={`flex flex-wrap items-center gap-3 rounded-xl border-2 p-3 ${done ? 'border-neutral-300 bg-neutral-100' : 'border-neutral-400 bg-white'}`}>
      <div className="w-24 text-xl font-bold tabular-nums">{time(r.startAt)}</div>
      <div className="min-w-48 flex-1">
        <p className="text-xl font-semibold">{r.guestName}</p>
        <p>
          Party of {r.partySize}
          {r.tableIds.length > 0 ? ` · ${r.tableIds.join('+')}` : ''}
          {r.quotedWait ? ` · quoted ${r.quotedWait}` : ''}
        </p>
        {r.tags.length > 0 || r.note ? (
          <p className="mt-1 flex flex-wrap items-center gap-2">
            {r.tags.map((t) => (
              <span key={t} className={`rounded-md px-2 py-0.5 ${TAG[t]?.className ?? 'border'}`}>
                {TAG[t]?.label ?? t}
              </span>
            ))}
            {r.note ? <span className="italic">“{r.note}”</span> : null}
          </p>
        ) : null}
        {/* A guest who never got the text must not look confirmed by silence (P0-5). */}
        {failed.map((m) => (
          <p key={m.kind} className="mt-1 font-semibold text-red-800">
            ✕ {KIND[m.kind] ?? 'A'} text failed: {FAILURE[m.failureReason ?? ''] ?? 'not delivered'}
          </p>
        ))}
        {r.status === 'booked' && !r.texts ? <p className="mt-1 text-neutral-800">No texts — confirm by phone.</p> : null}
        {r.status === 'booked' && confirmation?.status === 'queued' ? <p className="mt-1 text-neutral-800">Confirmation text not sent yet.</p> : null}
        {readyText && readyText.status !== 'failed' ? <p className="mt-1 text-neutral-800">&quot;Table ready&quot; texted.</p> : null}
      </div>
      <p className="w-44 font-semibold">{state}</p>
      <div className="flex flex-wrap items-center gap-2">
        {r.undoUntil ? (
          <Expiring key={r.undoUntil.getTime()} ms={r.undoUntil.getTime() - now.getTime()}>
            <Tap action={undo} id={r.id} day={day} label="Undo" className="border-2 border-neutral-900 bg-yellow-300" />
          </Expiring>
        ) : null}
        {allows(r.status, 'seated', 'host') ? (
          // The largest thing on the row (P0-9).
          <Tap action={move} id={r.id} day={day} to="seated" label="Seat" className="min-h-16 min-w-32 bg-green-800 text-xl font-bold text-white" />
        ) : null}
        {r.status === 'waitlisted' && r.texts && !readyText ? <Tap action={ready} id={r.id} day={day} label="Text: table ready" className="border-2 border-neutral-800 bg-white" /> : null}
        {allows(r.status, 'completed', 'host') ? <Tap action={move} id={r.id} day={day} to="completed" label="Clear table" className="border-2 border-neutral-800 bg-white" /> : null}
        {allows(r.status, 'no_show', 'host') ? <Tap action={move} id={r.id} day={day} to="no_show" label="No-show" className="border-2 border-neutral-800 bg-white" /> : null}
        {allows(r.status, 'cancelled', 'host') ? <Tap action={move} id={r.id} day={day} to="cancelled" label="Cancel" className="border-2 border-red-800 bg-white text-red-800" /> : null}
        {allows(r.status, 'abandoned', 'host') ? <Tap action={move} id={r.id} day={day} to="abandoned" label="Remove" className="border-2 border-red-800 bg-white text-red-800" /> : null}
      </div>
    </li>
  );
}

/** One tap: a form with one button, ≥48px (P0-9). */
function Tap({ action, id, day, to, label, className }: { action: (f: FormData) => Promise<void>; id: string; day: string; to?: Status; label: string; className: string }) {
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="day" value={day} />
      {to ? <input type="hidden" name="to" value={to} /> : null}
      <button type="submit" className={`min-h-12 min-w-12 rounded-lg px-4 font-semibold ${className}`}>
        {label}
      </button>
    </form>
  );
}

function WalkInForm() {
  return (
    <section aria-labelledby="walkin" className="mt-4 rounded-xl border-2 border-neutral-400 p-4">
      <h2 id="walkin" className="text-2xl font-bold">
        Walk-in
      </h2>
      <p className="text-neutral-800">Seats them now if a table is free for their whole turn; otherwise adds them to the waitlist with a quoted range.</p>
      <form action={walkIn} className="mt-3 flex flex-wrap items-end gap-3">
        {/* Minted per render: a double-tapped submit is one party. */}
        <input type="hidden" name="key" value={randomUUID()} />
        <label className="flex flex-col">
          Party
          <input name="partySize" type="number" min={1} max={50} defaultValue={2} required className="min-h-12 w-24 rounded-lg border-2 border-neutral-500 px-3" />
        </label>
        <label className="flex flex-col">
          Name
          <input name="guestName" defaultValue="Walk-in" maxLength={80} className="min-h-12 rounded-lg border-2 border-neutral-500 px-3" />
        </label>
        <label className="flex flex-col">
          Mobile (optional)
          <input name="guestPhone" type="tel" placeholder="+15035550123" className="min-h-12 rounded-lg border-2 border-neutral-500 px-3" />
        </label>
        <label className="flex min-h-12 items-center gap-2">
          <input name="textWhenReady" type="checkbox" className="h-6 w-6" />
          Guest agreed: “{WAITLIST_CONSENT}”
        </label>
        <button type="submit" className="min-h-12 rounded-lg bg-neutral-900 px-6 font-semibold text-white">
          Seat or waitlist
        </button>
      </form>
    </section>
  );
}
