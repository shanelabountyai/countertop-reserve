// The token and primitive sheet (V-018).
//
// Not a picture of the design system — the system itself, rendered from the
// objects the screens import. The nine statuses come from the lifecycle
// module, so a tenth appears here the day it compiles; the four table states
// come from the board's own map, so a drifted colour shows up on this page
// rather than being argued about in a review.
import { holdsTables, STATUSES } from '@reserve/core';
import { Notice } from '../../notice';
import { Chrome } from '../chrome';
import { STATE, TABLE_STATES } from '../table-state';

export const metadata = { title: 'Design — Firebird Kitchen' };

/** The five roles. Each is a meaning first and a colour second. */
const ROLES = [
  { token: 'danger', swatch: 'bg-red-700', use: 'refusals, destructive taps, no-show' },
  { token: 'attention', swatch: 'bg-amber-500', use: 'deadlines, unconfirmed, deferred' },
  { token: 'fresh', swatch: 'bg-sky-700', use: 'new inbound, unacknowledged' },
  { token: 'settled', swatch: 'bg-green-800', use: 'confirmed, free, seated fine' },
  { token: 'hairline', swatch: 'bg-stone-300', use: 'structure, rules, borders' },
];

const RAMP = [
  { name: 'display / slab', className: 'font-display text-4xl font-bold', sample: 'Firebird Kitchen' },
  { name: 'unit / 30', className: 'text-3xl font-extrabold tabular-nums', sample: 'W1+W2' },
  { name: 'time / 22', className: 'text-[22px] font-extrabold tabular-nums', sample: '7:15 PM · party of 4' },
  { name: 'floor / 18', className: 'text-lg font-semibold', sample: '18px is the floor on every staff screen, asserted' },
  { name: 'meta / caps', className: 'text-sm font-extrabold tracking-widest text-stone-600 uppercase', sample: 'Section label' },
];

const LABEL = 'text-sm font-extrabold tracking-widest text-stone-600 uppercase';

export default function DesignPage() {
  return (
    <>
      <Chrome active="Design" />
      <main className="mx-auto max-w-5xl bg-surface p-6 text-lg text-stone-900">
        <h1 className="font-display text-4xl font-bold">Design</h1>
        <p className="mt-2 max-w-3xl text-stone-600">
          Every token and primitive, rendered from the same objects the screens use. Nothing on this page is a copy.
        </p>

        <section aria-labelledby="colour" className="mt-8">
          <h2 id="colour" className={LABEL}>
            Semantic colour
          </h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-5">
            {ROLES.map((r) => (
              <li key={r.token} className="border-2 border-stone-300">
                <span className={`block h-14 ${r.swatch}`} />
                <span className="block p-3">
                  <span className="block font-mono text-xs font-bold">{r.token}</span>
                  <span className="mt-1 block text-base text-stone-600">{r.use}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="type" className="mt-8">
          <h2 id="type" className={LABEL}>
            Type ramp
          </h2>
          <dl className="mt-3 flex flex-col gap-2">
            {RAMP.map((t) => (
              <div key={t.name} className="flex flex-wrap items-baseline gap-4">
                <dt className="w-40 shrink-0 font-mono text-xs text-stone-600">{t.name}</dt>
                <dd className={t.className}>{t.sample}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section aria-labelledby="status" className="mt-8">
          <h2 id="status" className={LABEL}>
            Reservation status — all {STATUSES.length}, from the one module
          </h2>
          <p className="mt-1 text-base text-stone-600">A tenth fails to compile until it is classified and given its edges.</p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {STATUSES.map((s) => (
              <li
                key={s}
                className={`px-3 py-2 ${holdsTables(s) ? 'border-[3px] border-ink bg-white' : 'border-2 border-stone-300 bg-stone-50 text-stone-700'}`}
              >
                <span className="block font-extrabold">{s}</span>
                <span className="block text-xs font-bold tracking-wider uppercase">{holdsTables(s) ? 'holds a table' : 'holds nothing'}</span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="states" className="mt-8">
          <h2 id="states" className={LABEL}>
            Table state — the four the board renders
          </h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {TABLE_STATES.map((k) => (
              <li key={k} className={`border-[3px] p-4 ${STATE[k].className}`}>
                <span className={`inline-block px-2 py-1 text-base font-extrabold tracking-widest uppercase ${STATE[k].badge}`}>{STATE[k].label}</span>
                <span className="mt-2 block font-semibold text-stone-700">{STATE[k].carries}</span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="buttons" className="mt-8">
          <h2 id="buttons" className={LABEL}>
            Button — 48px is the floor, Seat is the exception upward
          </h2>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="button" className="min-h-16 min-w-32 bg-green-800 px-6 text-xl font-extrabold text-white">
              Seat
            </button>
            <button type="button" className="min-h-12 min-w-12 bg-ink px-6 font-extrabold text-white">
              Primary
            </button>
            <button type="button" className="min-h-12 min-w-12 border-2 border-stone-600 bg-white px-4 font-bold">
              Secondary
            </button>
            <button type="button" className="min-h-12 min-w-12 border-2 border-red-700 bg-white px-4 font-bold text-red-700">
              Danger
            </button>
            <button type="button" className="min-h-12 min-w-12 border-2 border-ink bg-amber-400 px-4 font-extrabold">
              Undo
            </button>
          </div>
        </section>

        <section aria-labelledby="badges" className="mt-8">
          <h2 id="badges" className={LABEL}>
            Badge — distinct in words and shape, never colour alone
          </h2>
          <ul className="mt-3 flex flex-wrap items-center gap-2">
            <li className="border-2 border-red-900 bg-red-700 px-2 py-0.5 font-extrabold tracking-wide text-white">⚠ ALLERGY</li>
            <li className="border-2 border-sky-800 bg-sky-50 px-2 py-0.5 font-bold text-sky-900">♿ Accessibility</li>
            <li className="border border-amber-800 bg-amber-50 px-2 py-0.5 text-amber-900">✦ Occasion</li>
          </ul>
        </section>

        <section aria-labelledby="callouts" className="mt-8">
          <h2 id="callouts" className={LABEL}>
            Callout
          </h2>
          <div className="mt-3 flex flex-col gap-2">
            <Notice>Confirm by 5:00 PM — unconfirmed tables are released.</Notice>
            <Notice tone="danger">Refused — M3 is held from 8:00 PM and the turn would overhang.</Notice>
            <Notice tone="fresh">New inbound reply, unread by the host.</Notice>
            <Notice tone="quiet">Every seating today has already started.</Notice>
          </div>
        </section>
      </main>
    </>
  );
}
