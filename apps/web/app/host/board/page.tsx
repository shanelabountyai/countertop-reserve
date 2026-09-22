// The table board (P0-13): table-major, read-only.
//
// `/host` is the book — reservation-major, one row per party. This is the
// floor — one row per unit of inventory, answering "what can I seat this
// walk-in on". No write path: every button on this page is a link back to the
// book. It reuses P0-9's 10s cursor rather than adding a second poll.
//
// The one requirement that carries the item: a `free` table always states how
// long it is free for. A bare green dot is the defect this page exists to
// prevent.
import { dayOf, DEFAULT_BOARD_HORIZON_MINUTES, whenSlots, type TableState, type TableStateRow } from '@reserve/core';
import { floorCursor, loadBoard } from '@reserve/db/floor';
import { RESTAURANT } from '@/lib/restaurant';
import { LiveUpdates } from '../live-updates';

export const metadata = { title: 'Tables — Firebird Kitchen' };
export const dynamic = 'force-dynamic';

const TZ = RESTAURANT.timezone;
const time = (at: Date) => whenSlots(at, TZ).time;
const minutesSince = (from: Date, now: Date) => Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));

/** Every state must be named here — a fifth one fails to compile until it is. */
const STATE: Record<TableState, { label: string; className: string }> = {
  free: { label: 'Free', className: 'border-green-800 bg-green-50' },
  occupied: { label: 'Occupied', className: 'border-neutral-500 bg-neutral-100' },
  reserved_soon: { label: 'Reserved', className: 'border-amber-700 bg-amber-50' },
  blocked: { label: 'Blocked', className: 'border-neutral-400 bg-neutral-200' },
};

export default async function BoardPage() {
  const now = new Date();
  const day = dayOf(now, TZ);
  const [rows, cursor] = await Promise.all([loadBoard(day, RESTAURANT, now), floorCursor()]);

  const sections = [...new Set(rows.map((r) => r.section))].sort();
  const freeNow = rows.filter((r) => r.state === 'free').length;

  return (
    <main className="mx-auto max-w-5xl p-4 text-lg text-neutral-950">
      <LiveUpdates cursor={cursor} />
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-3xl font-bold">Tables</h1>
        <p>
          {time(now)} · {freeNow} of {rows.length} free ·{' '}
          <a href="/host" className="underline">
            Book
          </a>
        </p>
      </header>
      <p className="mt-2 text-neutral-800">
        Read-only. A free table states how long it is free for — check that window against the party&apos;s turn before you seat them. Holds
        starting within {DEFAULT_BOARD_HORIZON_MINUTES} minutes read as reserved, not free.
      </p>

      {rows.length === 0 ? <p className="mt-6">No tables on the floor plan.</p> : null}
      {sections.map((section, i) => (
        <section key={section} aria-labelledby={`section-${i}`} className="mt-6">
          <h2 id={`section-${i}`} className="text-2xl font-bold capitalize">
            {section}
          </h2>
          <ul className="mt-2 flex flex-col gap-3">
            {rows
              .filter((r) => r.section === section)
              .map((r) => (
                <Unit key={r.unit.id} r={r} now={now} />
              ))}
          </ul>
        </section>
      ))}
    </main>
  );
}

function Unit({ r, now }: { r: TableStateRow; now: Date }) {
  const state = STATE[r.state];
  return (
    <li data-testid="board-unit" data-unit={r.unit.id} data-state={r.state} className={`flex flex-wrap items-center gap-3 rounded-xl border-2 p-3 ${state.className}`}>
      <div className="w-28">
        <p className="text-xl font-bold">{r.unit.id}</p>
        <p className="text-base text-neutral-800">
          {r.unit.seats} seats{r.unit.combination ? ` · ${r.unit.tableIds.join('+')}` : ''}
        </p>
      </div>
      <p className="w-32 font-semibold">{state.label}</p>
      <p className="min-w-56 flex-1">
        <Detail r={r} now={now} />
      </p>
    </li>
  );
}

/** The payload half. One branch per state, exhaustive by the compiler. */
function Detail({ r, now }: { r: TableStateRow; now: Date }) {
  switch (r.state) {
    case 'free':
      // The requirement: never a bare "free". Either a window in minutes, or
      // the explicit claim that nothing else is booked on it tonight.
      return r.freeUntil === null ? (
        <>Free for the rest of service.</>
      ) : (
        <>
          Free for <strong data-testid="free-minutes">{r.freeMinutes} min</strong> — held from {time(r.freeUntil)}.
        </>
      );
    case 'occupied':
      return (
        <>
          {r.party.guestName}, party of {r.party.partySize} · sat {minutesSince(r.since, now)} min ago ·{' '}
          {r.overdue ? <strong className="text-red-800">due back {time(r.expectedClear)}</strong> : <>due back {time(r.expectedClear)}</>}
        </>
      );
    case 'reserved_soon':
      return (
        <>
          {r.party.guestName}, party of {r.party.partySize} at {time(r.start)}
          {r.inMinutes < 0 ? <strong className="text-red-800"> · {-r.inMinutes} min late, not seated</strong> : ` · in ${r.inMinutes} min`}
        </>
      );
    case 'blocked':
      return <>Taken by {r.by.join(', ')}.</>;
    default: {
      const unreachable: never = r;
      return unreachable;
    }
  }
}
