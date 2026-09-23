// The no-show & cover report (P1-1). A server component with a plain GET
// form: the date range is the URL, so a manager can bookmark a night.
//
// Every number on this page comes from `loadReport`, which is `report` in
// @reserve/core over rows read once. Nothing is re-derived here — a second
// tally in a template is a second source of truth.
import { dayOf, isCalendarDay, LEAD_BANDS, type Rate } from '@reserve/core';
import { loadReport } from '@reserve/db/report';
import { RESTAURANT } from '@/lib/restaurant';
import { Chrome } from '../chrome';
import { hhmm } from '../hours/edit';

export const metadata = { title: 'Report — Firebird Kitchen' };
export const dynamic = 'force-dynamic';

const TZ = RESTAURANT.timezone;


/** A rate with nothing in its denominator is shown as such, never as 0%. */
function Percent({ rate }: { rate: Rate }) {
  return (
    <span className="tabular-nums">
      {rate.rate === null ? <span className="text-stone-600">no data</span> : <strong>{Math.round(rate.rate * 100)}%</strong>}
      <span className="text-stone-600">
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
    return isCalendarDay(s) ? s : '';
  };
  const today = dayOf(new Date(), TZ);
  const from = get('from') || today;
  const to = get('to') || from;
  const r = await loadReport({ from, to }, TZ);
  const peak = Math.max(1, ...r.covers.map((c) => c.booked));

  return (
    <>
      <Chrome active="Report" />
      <main className="mx-auto max-w-3xl bg-surface p-6 text-lg text-stone-900">
      <h1 className="font-display text-4xl font-bold">No-shows &amp; covers</h1>

      <form className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col">
          <span className="text-sm font-extrabold tracking-widest text-stone-600 uppercase">From</span>
          <input type="date" name="from" defaultValue={from} className="min-h-12 border-2 border-stone-600 bg-white px-3" />
        </label>
        <label className="flex flex-col">
          <span className="text-sm font-extrabold tracking-widest text-stone-600 uppercase">To</span>
          <input type="date" name="to" defaultValue={to} className="min-h-12 border-2 border-stone-600 bg-white px-3" />
        </label>
        <button type="submit" className="min-h-12 bg-ink px-6 font-extrabold text-white">
          Show
        </button>
      </form>

      <section aria-labelledby="totals" className="mt-6">
        <h2 id="totals" className="text-2xl font-extrabold">
          {from === to ? from : `${from} to ${to}`}
        </h2>
        <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ['Covers booked', r.totals.booked],
            ['Covers seated', r.totals.seated],
            ['No-shows', r.totals.noShow],
            ['Cancelled', r.totals.cancelled],
          ].map(([label, value]) => (
            <div key={String(label)} className="border-[3px] border-ink bg-white p-4">
              <dt className="text-base">{label}</dt>
              <dd className="text-3xl font-extrabold tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="predicts" className="mt-6 border-[3px] border-ink bg-white p-5">
        <h2 id="predicts" className="text-2xl font-extrabold">
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
          <div className="flex flex-wrap justify-between gap-2 border-t-2 border-stone-300 pt-1">
            <dt className="font-semibold">Overall</dt>
            <dd>
              <Percent rate={r.noShow} />
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="lead" className="mt-6 border-[3px] border-ink bg-white p-5">
        <h2 id="lead" className="text-2xl font-extrabold">
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
        <p className="mt-2 text-base text-stone-600">Bands: {LEAD_BANDS.map((b) => b.label).join(', ')}.</p>
      </section>

      <section aria-labelledby="other" className="mt-6 border-[3px] border-ink bg-white p-5">
        <h2 id="other" className="text-2xl font-extrabold">
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
        <h2 id="covers" className="text-2xl font-extrabold">
          Covers by seating time
        </h2>
        {r.covers.length === 0 ? (
          <p className="mt-2">Nothing was booked in this range.</p>
        ) : (
          <table className="mt-2 w-full border-collapse">
            <caption className="sr-only">Covers booked and covers seated, per 15-minute seating time</caption>
            <thead>
              <tr className="border-b-[3px] border-ink text-left">
                {['Day', 'Time', 'Booked', 'Seated', ''].map((h) => (
                  <th key={h} scope="col" className="py-1 pr-3">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.covers.map((c) => (
                <tr key={`${c.day} ${c.minute}`} className="border-b border-stone-300">
                  <td className="py-1 pr-3 tabular-nums">{c.day}</td>
                  <td className="py-1 pr-3 font-semibold tabular-nums">{hhmm(c.minute)}</td>
                  <td className="py-1 pr-3 tabular-nums">{c.booked}</td>
                  <td className="py-1 pr-3 tabular-nums">{c.seated}</td>
                  {/* The gap between the two bars IS the loss — the point of the report. */}
                  <td className="w-1/3 py-1">
                    <span className="flex h-4 items-center gap-px" aria-hidden="true">
                      <span className="h-4 bg-ink" style={{ width: `${(c.seated / peak) * 100}%` }} />
                      <span className="h-4 bg-red-700/30" style={{ width: `${((c.booked - c.seated) / peak) * 100}%` }} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      </main>
    </>
  );
}
