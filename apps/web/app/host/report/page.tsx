// The no-show & cover report (P1-1). A server component with a plain GET
// form: the date range is the URL, so a manager can bookmark a night.
//
// Every number on this page comes from `loadReport`, which is `report` in
// @reserve/core over rows read once. Nothing is re-derived here — a second
// tally in a template is a second source of truth.
import { dayOf, LEAD_BANDS, type Rate } from '@reserve/core';
import { loadReport } from '@reserve/db/report';
import { RESTAURANT } from '@/lib/restaurant';
import { hhmm } from '../hours/edit';

export const metadata = { title: 'Report — Firebird Kitchen' };
export const dynamic = 'force-dynamic';

const TZ = RESTAURANT.timezone;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A rate with nothing in its denominator is shown as such, never as 0%. */
function Percent({ rate }: { rate: Rate }) {
  return (
    <span className="tabular-nums">
      {rate.rate === null ? <span className="text-neutral-600">no data</span> : <strong>{Math.round(rate.rate * 100)}%</strong>}
      <span className="text-neutral-700">
        {' '}
        ({rate.count} of {rate.of})
      </span>
    </span>
  );
}

type Params = Record<string, string | string[] | undefined>;

export default async function ReportPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const get = (name: string) => {
    const v = params[name];
    const s = (Array.isArray(v) ? v[0] : v) ?? '';
    // A malformed day in the URL falls back to today rather than reaching the query.
    return DAY.test(s) ? s : '';
  };
  const today = dayOf(new Date(), TZ);
  const from = get('from') || today;
  const to = get('to') || from;
  const r = await loadReport({ from, to }, TZ);
  const peak = Math.max(1, ...r.covers.map((c) => c.booked));

  return (
    <main className="mx-auto max-w-3xl p-4 text-lg text-neutral-950">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-3xl font-bold">No-shows &amp; covers</h1>
        <a href="/host" className="underline">
          Back to the floor
        </a>
      </header>

      <form className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col">
          <span className="text-base font-semibold">From</span>
          <input type="date" name="from" defaultValue={from} className="min-h-12 rounded-lg border-2 border-neutral-800 px-3" />
        </label>
        <label className="flex flex-col">
          <span className="text-base font-semibold">To</span>
          <input type="date" name="to" defaultValue={to} className="min-h-12 rounded-lg border-2 border-neutral-800 px-3" />
        </label>
        <button type="submit" className="min-h-12 rounded-lg bg-neutral-900 px-6 font-semibold text-white">
          Show
        </button>
      </form>

      <section aria-labelledby="totals" className="mt-6">
        <h2 id="totals" className="text-2xl font-bold">
          {from === to ? from : `${from} to ${to}`}
        </h2>
        <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ['Covers booked', r.totals.booked],
            ['Covers seated', r.totals.seated],
            ['No-shows', r.totals.noShow],
            ['Cancelled', r.totals.cancelled],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-xl border-2 border-neutral-800 p-3">
              <dt className="text-base">{label}</dt>
              <dd className="text-3xl font-bold tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="predicts" className="mt-6 rounded-xl border-2 border-neutral-800 p-4">
        <h2 id="predicts" className="text-2xl font-bold">
          Does confirming predict showing?
        </h2>
        <dl className="mt-2 flex flex-col gap-1">
          <div className="flex flex-wrap justify-between gap-2">
            <dt>No-show rate, confirmed</dt>
            <dd>
              <Percent rate={r.noShowByConfirmation.confirmed} />
            </dd>
          </div>
          <div className="flex flex-wrap justify-between gap-2">
            <dt>No-show rate, never confirmed</dt>
            <dd>
              <Percent rate={r.noShowByConfirmation.unconfirmed} />
            </dd>
          </div>
          <div className="flex flex-wrap justify-between gap-2 border-t border-neutral-400 pt-1">
            <dt className="font-semibold">Overall</dt>
            <dd>
              <Percent rate={r.noShow} />
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="lead" className="mt-6 rounded-xl border-2 border-neutral-800 p-4">
        <h2 id="lead" className="text-2xl font-bold">
          No-shows by how far ahead the booking was made
        </h2>
        <dl className="mt-2 flex flex-col gap-1">
          {r.noShowByLead.map((band) => (
            <div key={band.label} className="flex flex-wrap justify-between gap-2">
              <dt>{band.label}</dt>
              <dd>
                <Percent rate={band.rate} />
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-base text-neutral-700">Bands: {LEAD_BANDS.map((b) => b.label).join(', ')}.</p>
      </section>

      <section aria-labelledby="other" className="mt-6 rounded-xl border-2 border-neutral-800 p-4">
        <h2 id="other" className="text-2xl font-bold">
          Released and waitlisted
        </h2>
        <dl className="mt-2 flex flex-col gap-1">
          <div className="flex flex-wrap justify-between gap-2">
            <dt>Released at the confirmation deadline</dt>
            <dd>
              <Percent rate={r.release} />
            </dd>
          </div>
          <div className="flex flex-wrap justify-between gap-2">
            <dt>Waitlisted parties who got a table</dt>
            <dd>
              <Percent rate={r.waitlist} />
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="covers" className="mt-6">
        <h2 id="covers" className="text-2xl font-bold">
          Covers by seating time
        </h2>
        {r.covers.length === 0 ? (
          <p className="mt-2">Nothing was booked in this range.</p>
        ) : (
          <table className="mt-2 w-full border-collapse">
            <caption className="sr-only">Covers booked and covers seated, per 15-minute seating time</caption>
            <thead>
              <tr className="border-b-2 border-neutral-800 text-left">
                {['Day', 'Time', 'Booked', 'Seated', ''].map((h) => (
                  <th key={h} scope="col" className="py-1 pr-3">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.covers.map((c) => (
                <tr key={`${c.day} ${c.minute}`} className="border-b border-neutral-300">
                  <td className="py-1 pr-3 tabular-nums">{c.day}</td>
                  <td className="py-1 pr-3 font-semibold tabular-nums">{hhmm(c.minute)}</td>
                  <td className="py-1 pr-3 tabular-nums">{c.booked}</td>
                  <td className="py-1 pr-3 tabular-nums">{c.seated}</td>
                  {/* The gap between the two bars IS the loss — the point of the report. */}
                  <td className="w-1/3 py-1">
                    <span className="flex h-4 items-center gap-px" aria-hidden="true">
                      <span className="h-4 bg-neutral-900" style={{ width: `${(c.seated / peak) * 100}%` }} />
                      <span className="h-4 bg-red-300" style={{ width: `${((c.booked - c.seated) / peak) * 100}%` }} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
