// The host floor view (P0-9): tonight's book at arm's length.
//
// A server component — the one renderer for a row. LiveUpdates asks the
// server whether anything moved and re-runs this; nothing about a row is
// re-derived on the client. Which buttons a row gets comes from the lifecycle
// module's edge table (`allows`), never from a status list kept here.
import { randomUUID } from 'node:crypto';
import { allows, dayOf, holdsTables, isCalendarDay, minuteOfDay, periodAt, periodsFor, whenSlots, type PlanUnit, type Status } from '@reserve/core';
import { floorCursor, loadFloor, loadUnits, WAITLIST_CONSENT, type FloorRow } from '@reserve/db/floor';
import { loadSchedule } from '@reserve/db/schedule';
import { RESTAURANT } from '@/lib/restaurant';
import { Notice } from '../notice';
import { assign, move, ready, undo, walkIn } from './actions';
import { Chrome } from './chrome';
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
  // Manual assignment (P0-14). Each refusal names the rule that said no: the
  // host is choosing an input to allocation, so "no" on its own is useless.
  assigned: 'Seated at the table you picked.',
  moved: 'Moved.',
  assign_too_large: 'That table does not seat a party that large.',
  assign_too_small: 'That table is too big for a party that small.',
  assign_over_seat_cap: 'That would leave too many empty seats — pick something smaller.',
  assign_unit_held: 'That table is held for part of the time they need.',
  assign_outside_hours: 'That seating is outside service hours.',
  assign_over_pacing_cap: 'The kitchen is at its cap for that 15 minutes.',
  assign_unknown_unit: 'No such table on the floor plan.',
  assign_no_longer_available: 'That table was just taken — try again.',
  assign_not_assignable: 'That party cannot be given a table.',
  assign_not_found: 'That party is no longer on the floor.',
};

/** A host who taps and sees nothing has been lied to; an unmapped refusal still says something true. */
const noticeText = (notice: string | undefined) =>
  notice ? (NOTICES[notice] ?? (notice.startsWith('assign_') ? 'That table could not be given to this party.' : null)) : null;

// Distinct by kind, in text and shape as well as colour (P0-9): an allergy is
// the loudest thing on the row, never styled like a birthday.
const TAG: Record<string, { label: string; className: string }> = {
  allergy: { label: '⚠ ALLERGY', className: 'border-2 border-red-900 bg-red-700 font-extrabold tracking-wide text-white' },
  accessibility: { label: '♿ Accessibility', className: 'border-2 border-sky-800 bg-sky-50 font-bold text-sky-900' },
  occasion: { label: '✦ Occasion', className: 'border border-amber-800 bg-amber-50 text-amber-900' },
};

const FAILURE: Record<string, string> = { opted_out: 'guest opted out of texts', rate_limited: 'daily text limit reached' };
const KIND: Record<string, string> = { confirmation: 'Confirmation', reminder: 'Reminder', table_ready: '"Table ready"', released: 'Release notice' };

const minutesSince = (from: Date, now: Date) => Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
const time = (at: Date) => whenSlots(at, TZ).time;

export default async function HostPage({ searchParams }: { searchParams: Promise<{ day?: string; notice?: string }> }) {
  const { day: dayParam, notice } = await searchParams;
  const now = new Date();
  const today = dayOf(now, TZ);
  const day = dayParam && isCalendarDay(dayParam) ? dayParam : today;
  const [rows, cursor, schedule, units] = await Promise.all([loadFloor(day, now), floorCursor(), loadSchedule(TZ), loadUnits(RESTAURANT)]);

  const periods = [...periodsFor(schedule, day)].sort((a, b) => a.openMinute - b.openMinute);
  const periodOf = (r: FloorRow) => periodAt(periods, minuteOfDay(r.startAt, TZ))?.name ?? 'Outside service hours';
  const waitlist = rows.filter((r) => r.status === 'waitlisted');
  const book = rows.filter((r) => r.status !== 'waitlisted');
  const unconfirmed = rows.filter((r) => r.status === 'booked').length;
  const groups = [...periods.map((p) => p.name), 'Outside service hours']
    .map((name) => ({ name, rows: book.filter((r) => periodOf(r) === name) }))
    .filter((g) => g.rows.length > 0);

  return (
    <>
      <Chrome active="Book" status={unconfirmed > 0 ? <span className="text-sky-300">{unconfirmed} UNCONFIRMED</span> : null} clock={time(now)} />
      <main className="mx-auto max-w-5xl bg-surface p-6 text-lg text-stone-900">
      <LiveUpdates cursor={cursor} />
      <div className="flex flex-wrap items-baseline gap-4">
        {/* The screen keeps its name. The canvas's "Tonight" is the meta line
            beside it — renaming a screen is not a restyle. */}
        <h1 className="font-display text-4xl font-bold">Floor</h1>
        <p className="font-bold text-stone-600">
          {day === today ? 'Tonight' : day} · {RESTAURANT.restaurant} · {book.length} booked · {waitlist.length} waiting
        </p>
      </div>

      <div aria-live="polite" className="mt-4 min-h-8">
        {noticeText(notice) ? <Notice>{noticeText(notice)}</Notice> : null}
      </div>

      <WalkInForm />

      <section aria-labelledby="waitlist" className="mt-6">
        <h2 id="waitlist" className="border-b-[3px] border-ink pb-2 text-2xl font-extrabold">
          Waitlist <span className="font-semibold text-stone-600">({waitlist.length})</span>
        </h2>
        {waitlist.length === 0 ? <p className="mt-2 text-stone-700">Nobody waiting.</p> : <ul className="mt-2 flex flex-col gap-3">{waitlist.map((r) => <Row key={r.id} r={r} day={day} now={now} units={units} />)}</ul>}
      </section>

      {groups.length === 0 ? <p className="mt-6">No reservations on this day.</p> : null}
      {groups.map((g, i) => (
        <section key={g.name} aria-labelledby={`period-${i}`} className="mt-6">
          <h2 id={`period-${i}`} className="border-b-[3px] border-ink pb-2 text-2xl font-extrabold">
            {g.name}
          </h2>
          <ul className="mt-2 flex flex-col gap-3">
            {g.rows.map((r) => (
              <Row key={r.id} r={r} day={day} now={now} units={units} />
            ))}
          </ul>
        </section>
      ))}
      </main>
    </>
  );
}

function Row({ r, day, now, units }: { r: FloorRow; day: string; now: Date; units: PlanUnit[] }) {
  const done = !allows(r.status, 'seated', 'host') && !allows(r.status, 'completed', 'host');
  const readyText = r.messages.find((m) => m.kind === 'table_ready');
  const failed = r.messages.filter((m) => m.status === 'failed');
  const confirmation = r.messages.find((m) => m.kind === 'confirmation');

  let state = STATUS_LABEL[r.status];
  if (r.status === 'seated' && r.seatedAt) state += ` · ${minutesSince(r.seatedAt, now)} min`;
  if (r.status === 'waitlisted') state += ` · ${minutesSince(r.startAt, now)} min`;

  return (
    <li data-testid="floor-row" className={`flex flex-wrap items-center gap-4 border-[3px] p-4 ${done ? 'border-stone-300 bg-stone-50' : 'border-ink bg-white'}`}>
      <div className="w-24 text-[22px] font-extrabold tabular-nums">{time(r.startAt)}</div>
      <div className="min-w-48 flex-1">
        <p className="text-xl font-bold">{r.guestName}</p>
        <p>
          Party of {r.partySize}
          {r.tableIds.length > 0 ? ` · ${r.tableIds.join('+')}` : ''}
          {r.quotedWait ? ` · quoted ${r.quotedWait}` : ''}
        </p>
        {r.tags.length > 0 || r.note ? (
          <p className="mt-1 flex flex-wrap items-center gap-2">
            {r.tags.map((t) => (
              <span key={t} className={`px-2 py-0.5 ${TAG[t]?.className ?? 'border'}`}>
                {TAG[t]?.label ?? t}
              </span>
            ))}
            {r.note ? <span className="italic">“{r.note}”</span> : null}
          </p>
        ) : null}
        {/* A guest who never got the text must not look confirmed by silence (P0-5). */}
        {failed.map((m) => (
          <p key={m.kind} className="mt-1 font-bold text-red-700">
            ✕ {KIND[m.kind] ?? 'A'} text failed: {FAILURE[m.failureReason ?? ''] ?? 'not delivered'}
          </p>
        ))}
        {r.status === 'booked' && !r.texts ? <p className="mt-1 text-stone-800">No texts — confirm by phone.</p> : null}
        {r.status === 'booked' && confirmation?.status === 'queued' ? <p className="mt-1 text-stone-800">Confirmation text not sent yet.</p> : null}
        {readyText && readyText.status !== 'failed' ? <p className="mt-1 text-stone-800">&quot;Table ready&quot; texted.</p> : null}
      </div>
      <p className="w-44 font-extrabold">{state}</p>
      <div className="flex flex-wrap items-center gap-2">
        {r.undoUntil ? (
          <Expiring key={r.undoUntil.getTime()} ms={r.undoUntil.getTime() - now.getTime()}>
            <Tap action={undo} id={r.id} day={day} label="Undo" className="border-2 border-ink bg-amber-400 font-extrabold" />
          </Expiring>
        ) : null}
        {/* Staff confirmation: the guest rang, or told the host at the door.
            No new action — `move` drives every host transition, and the edge
            booked → confirmed already lists `host`. It matters most for a
            guest who declined texts, whose booking the sweep will never
            auto-release, so the host is the one who marks them expected. */}
        {allows(r.status, 'confirmed', 'host') ? (
          <Tap action={move} id={r.id} day={day} to="confirmed" label="Confirm" className="border-2 border-stone-600 bg-white" />
        ) : null}
        {allows(r.status, 'seated', 'host') ? (
          // The largest thing on the row (P0-9).
          <Tap action={move} id={r.id} day={day} to="seated" label="Seat" className="min-h-16 min-w-32 bg-green-800 text-xl font-extrabold text-white" />
        ) : null}
        {r.status === 'waitlisted' && r.texts && !readyText ? <Tap action={ready} id={r.id} day={day} label="Text: table ready" className="border-2 border-stone-600 bg-white" /> : null}
        {allows(r.status, 'completed', 'host') ? <Tap action={move} id={r.id} day={day} to="completed" label="Clear table" className="border-2 border-stone-600 bg-white" /> : null}
        {allows(r.status, 'no_show', 'host') ? <Tap action={move} id={r.id} day={day} to="no_show" label="No-show" className="border-2 border-stone-600 bg-white" /> : null}
        {allows(r.status, 'cancelled', 'host') ? <Tap action={move} id={r.id} day={day} to="cancelled" label="Cancel" className="border-2 border-red-700 bg-white text-red-700" /> : null}
        {allows(r.status, 'abandoned', 'host') ? <Tap action={move} id={r.id} day={day} to="abandoned" label="Remove" className="border-2 border-red-700 bg-white text-red-700" /> : null}
        <AssignForm r={r} day={day} units={units} />
      </div>
    </li>
  );
}

/**
 * Manual assignment (P0-14). Every unit on the plan is offered, not just the
 * ones that fit: the server re-reads the plan and names the rule that
 * refused, so a host learns why T4 is wrong for a deuce instead of hunting
 * for an option that was silently missing. The picker is a suggestion; the
 * transaction decides.
 */
function AssignForm({ r, day, units }: { r: FloorRow; day: string; units: PlanUnit[] }) {
  // A waitlisted party holds no table precisely because it is waiting for one.
  if (!(r.status === 'waitlisted' || holdsTables(r.status))) return null;
  const key = (ids: readonly string[]) => [...ids].sort().join('|');
  const current = units.find((u) => key(u.tableIds) === key(r.tableIds))?.id;
  const sections = [...new Set(units.map((u) => u.section))].sort();

  return (
    <form action={assign} className="flex items-center gap-2">
      <input type="hidden" name="id" value={r.id} />
      <input type="hidden" name="day" value={day} />
      <select
        name="unit"
        defaultValue={current ?? ''}
        aria-label={`Table for ${r.guestName}`}
        className="min-h-12 border-2 border-stone-600 bg-white px-2 text-lg"
      >
        {current ? null : <option value="">Pick a table…</option>}
        {sections.map((section) => (
          <optgroup key={section} label={section}>
            {units
              .filter((u) => u.section === section)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.id} · {u.seats} seats{u.combination ? ` (${u.tableIds.join('+')})` : ''}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      <button type="submit" className="min-h-12 min-w-12 border-2 border-stone-600 bg-white px-4 font-bold">
        {r.tableIds.length === 0 ? 'Seat here' : 'Move'}
      </button>
    </form>
  );
}

/** One tap: a form with one button, ≥48px (P0-9). */
function Tap({ action, id, day, to, label, className }: { action: (f: FormData) => Promise<void>; id: string; day: string; to?: Status; label: string; className: string }) {
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="day" value={day} />
      {to ? <input type="hidden" name="to" value={to} /> : null}
      <button type="submit" className={`min-h-12 min-w-12 px-4 font-bold ${className}`}>
        {label}
      </button>
    </form>
  );
}

function WalkInForm() {
  return (
    <section aria-labelledby="walkin" className="mt-6 border-[3px] border-ink bg-white p-5">
      <h2 id="walkin" className="text-2xl font-extrabold">
        Walk-in
      </h2>
      <p className="text-stone-600">Seats them now if a table is free for their whole turn; otherwise adds them to the waitlist with a quoted range.</p>
      <form action={walkIn} className="mt-3 flex flex-wrap items-end gap-3">
        {/* Minted per render: a double-tapped submit is one party. */}
        <input type="hidden" name="key" value={randomUUID()} />
        <label className="flex flex-col gap-1 text-sm font-extrabold tracking-widest text-stone-600 uppercase">
          Party
          <input name="partySize" type="number" min={1} max={50} defaultValue={2} required className="min-h-12 w-24 border-2 border-stone-600 bg-white px-3 text-lg font-bold tabular-nums text-stone-900" />
        </label>
        <label className="flex flex-col gap-1 text-sm font-extrabold tracking-widest text-stone-600 uppercase">
          Name
          <input name="guestName" defaultValue="Walk-in" maxLength={80} className="min-h-12 border-2 border-stone-600 bg-white px-3 text-lg font-normal text-stone-900" />
        </label>
        <label className="flex flex-col gap-1 text-sm font-extrabold tracking-widest text-stone-600 uppercase">
          Mobile (optional)
          <input name="guestPhone" type="tel" placeholder="+15035550123" className="min-h-12 border-2 border-stone-600 bg-white px-3 text-lg font-normal text-stone-900" />
        </label>
        <label className="flex min-h-12 max-w-xs items-center gap-3">
          <input name="textWhenReady" type="checkbox" className="h-6 w-6 shrink-0 accent-red-700" />
          Guest agreed: “{WAITLIST_CONSENT}”
        </label>
        <button type="submit" className="min-h-12 bg-ink px-6 font-extrabold text-white">
          Seat or waitlist
        </button>
      </form>
    </section>
  );
}
