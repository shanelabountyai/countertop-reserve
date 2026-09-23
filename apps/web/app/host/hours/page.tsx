// Service hours, overrides and blackouts (P0-10) — the schedule the
// availability engine reads, edited where the host already signs in.
//
// A server component with plain forms, like the floor view: no hydration, no
// client state. The one stateful-looking thing — "this would strand three
// reservations, save anyway?" — is the pending edit round-tripping through
// the URL and being re-checked against the live rows on the way back.
import { minuteOfDay } from '@reserve/core';
import { editSchedule, loadScheduleRows } from '@reserve/db/schedule';
import { RESTAURANT } from '@/lib/restaurant';
import { Notice } from '../../notice';
import { edit } from './actions';
import { Chrome } from '../chrome';
import { DAYS, FIELDS, hhmm, parseEdit } from './edit';

export const metadata = { title: 'Hours — Firebird Kitchen' };
export const dynamic = 'force-dynamic';

const TZ = RESTAURANT.timezone;

/** Fixed text per code: a URL can pick one, never write one. */
const NOTICES: Record<string, string> = {
  saved: 'Hours updated.',
  invalid: 'That is not a complete period — check the name, times and cover cap.',
  overlap: 'That overlaps a period already set for the same day.',
  not_found: 'That period is already gone.',
};

type Params = Record<string, string | string[] | undefined>;

export default async function HoursPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const get = (name: string) => {
    const v = params[name];
    return (Array.isArray(v) ? v[0] : v) ?? '';
  };
  const notice = NOTICES[get('notice')];

  const { periods, blackouts } = await loadScheduleRows();
  // The pending edit is re-parsed and re-checked, never trusted from the URL.
  const pending = get('confirm') === '1' ? parseEdit(get) : null;
  const preview = pending ? await editSchedule(pending, TZ, new Date(), 'check') : null;
  const conflicts = preview && !preview.ok && preview.reason === 'strands' ? preview.conflicts : [];

  const weekly = DAYS.map((label, weekday) => ({ label, rows: periods.filter((p) => p.weekday === weekday) }));
  const overrideDays = [...new Set(periods.filter((p) => p.day !== null).map((p) => p.day as string))].sort();

  return (
    <>
      <Chrome active="Hours" />
      <main className="mx-auto max-w-3xl bg-surface p-6 text-lg text-stone-900">
      <h1 className="font-display text-4xl font-bold">Hours</h1>

      <div aria-live="polite" className="mt-4 min-h-8">
        {notice ? <Notice>{notice}</Notice> : null}
      </div>

      {conflicts.length > 0 ? (
        <section aria-labelledby="strands" className="border-[3px] border-red-700 bg-red-50 p-5">
          <h2 id="strands" className="text-2xl font-extrabold text-red-900">
            {conflicts.length} booked {conflicts.length === 1 ? 'reservation falls' : 'reservations fall'} outside the new hours
          </h2>
          <p className="mt-1">Nothing has been changed yet. Saving anyway leaves these parties booked at a time the restaurant is not serving.</p>
          <ul className="mt-3 flex flex-col gap-2">
            {conflicts.map(({ row, reason }) => (
              <li key={row.id} className="border-2 border-red-700 bg-white px-3 py-2">
                <span className="font-semibold tabular-nums">
                  {row.businessDay} {hhmm(minuteOfDay(row.startAt, TZ))}
                </span>{' '}
                · {row.guestName} · party of {row.partySize} ·{' '}
                {reason === 'closed' ? 'the restaurant would be closed' : `the ${row.turnMinutes}-minute turn runs past the last seating`}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <form action={edit}>
              {FIELDS.map((name) => (get(name) === '' ? null : <input key={name} type="hidden" name={name} value={get(name)} />))}
              <input type="hidden" name="force" value="1" />
              <button type="submit" className="min-h-12 bg-red-700 px-6 font-extrabold text-white">
                Save anyway
              </button>
            </form>
            <a href="/host/hours" className="min-h-12 content-center underline">
              Cancel
            </a>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="weekly" className="mt-6">
        <h2 id="weekly" className="border-b-[3px] border-ink pb-2 text-2xl font-extrabold">
          Every week
        </h2>
        <ul className="mt-2 flex flex-col gap-2">
          {weekly.map(({ label, rows }) => (
            <li key={label} className="border-[3px] border-ink bg-white p-4">
              <p className="font-semibold">{label}</p>
              {rows.length === 0 ? (
                <p className="text-stone-600">Closed.</p>
              ) : (
                <ul className="mt-1 flex flex-col gap-2">
                  {rows.map((p) => (
                    <PeriodRow key={p.id} p={p} />
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="overrides" className="mt-6">
        <h2 id="overrides" className="border-b-[3px] border-ink pb-2 text-2xl font-extrabold">
          Single dates
        </h2>
        <p className="text-stone-600">A date listed here replaces that weekday&rsquo;s periods entirely.</p>
        {overrideDays.length === 0 ? (
          <p className="mt-2">No date is set differently.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {overrideDays.map((day) => (
              <li key={day} className="border-[3px] border-ink bg-white p-4">
                <p className="font-semibold tabular-nums">{day}</p>
                <ul className="mt-1 flex flex-col gap-2">
                  {periods
                    .filter((p) => p.day === day)
                    .map((p) => (
                      <PeriodRow key={p.id} p={p} />
                    ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AddPeriodForm />

      <section aria-labelledby="blackouts" className="mt-6">
        <h2 id="blackouts" className="border-b-[3px] border-ink pb-2 text-2xl font-extrabold">
          Closed dates
        </h2>
        {blackouts.length === 0 ? (
          <p className="mt-2">None.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {blackouts.map((b) => (
              <li key={b.day} className="flex flex-wrap items-center gap-3 border-[3px] border-ink bg-white p-4">
                <span className="font-semibold tabular-nums">{b.day}</span>
                <span className="flex-1">{b.reason ?? 'Closed'}</span>
                <form action={edit}>
                  <input type="hidden" name="kind" value="removeBlackout" />
                  <input type="hidden" name="day" value={b.day} />
                  <button type="submit" className="min-h-12 border-2 border-stone-600 bg-white px-4 font-bold">
                    Reopen <span className="sr-only">{b.day}</span>
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <form action={edit} className="mt-3 flex flex-wrap items-end gap-3 border-[3px] border-ink bg-stone-50 p-4">
          <input type="hidden" name="kind" value="addBlackout" />
          <Field label="Date" name="day" type="date" required />
          <Field label="Reason" name="reason" type="text" />
          <button type="submit" className="min-h-12 bg-ink px-6 font-extrabold text-white">
            Close this date
          </button>
        </form>
      </section>
      </main>
    </>
  );
}

function PeriodRow({ p }: { p: { id: string; name: string; openMinute: number; closeMinute: number; lastSeatingMinute: number | null; pacingCap: number } }) {
  return (
    <li className="flex flex-wrap items-center gap-3 border-t border-stone-300 pt-2">
      <span className="min-w-24 font-semibold">{p.name}</span>
      <span className="tabular-nums">
        {hhmm(p.openMinute)}–{hhmm(p.closeMinute)}
      </span>
      <span className="flex-1 text-stone-600">
        {p.lastSeatingMinute === null ? 'no last seating' : `last seating ${hhmm(p.lastSeatingMinute)}`} · {p.pacingCap} covers per 15 min
      </span>
      <form action={edit}>
        <input type="hidden" name="kind" value="removePeriod" />
        <input type="hidden" name="id" value={p.id} />
        <button type="submit" className="min-h-12 border-2 border-stone-600 bg-white px-4 font-bold">
          Remove <span className="sr-only">{`${p.name} ${hhmm(p.openMinute)}`}</span>
        </button>
      </form>
    </li>
  );
}

function AddPeriodForm() {
  return (
    <section aria-labelledby="add" className="mt-6">
      <h2 id="add" className="border-b-[3px] border-ink pb-2 text-2xl font-extrabold">
        Add a period
      </h2>
      <form action={edit} className="mt-2 flex flex-wrap items-end gap-3 border-[3px] border-ink bg-stone-50 p-4">
        <input type="hidden" name="kind" value="addPeriod" />
        <label className="flex flex-col gap-1">
          <span className="text-sm font-extrabold tracking-widest text-stone-600 uppercase">Applies to</span>
          <select name="scope" defaultValue="weekly" className="min-h-12 border-2 border-stone-600 bg-white px-3">
            <option value="weekly">Every week</option>
            <option value="date">One date</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-extrabold tracking-widest text-stone-600 uppercase">Weekday</span>
          <select name="weekday" defaultValue="5" className="min-h-12 border-2 border-stone-600 bg-white px-3">
            {DAYS.map((label, i) => (
              <option key={label} value={i}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <Field label="Or date" name="day" type="date" />
        <Field label="Name" name="name" type="text" required />
        <Field label="Opens" name="open" type="time" step={900} required />
        <CloseField />
        <Field label="Last seating" name="last" type="time" step={900} />
        <Field label="Covers per 15 min" name="cap" type="number" defaultValue="20" required />
        <button type="submit" className="min-h-12 bg-ink px-6 font-extrabold text-white">
          Add
        </button>
      </form>
      <p className="mt-1 text-stone-600">Times sit on the 15-minute grid. Leave the last seating empty to make every turn finish by closing.</p>
    </section>
  );
}

/**
 * Closing time as a list, not an `<input type="time">`.
 *
 * A native time input cannot express midnight-as-end-of-day: browsers cap it
 * at 23:59, so a kitchen closing at midnight could not be entered even though
 * the schema stores it (minute 1440) and the hours table renders it. A list of
 * the 15-minute grid can say "24:00" plainly, and it is the one field where
 * that value means anything.
 */
function CloseField() {
  const options = Array.from({ length: 96 }, (_, i) => hhmm((i + 1) * 15));
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-extrabold tracking-widest text-stone-600 uppercase">Closes</span>
      <select name="close" required defaultValue="22:00" className="min-h-12 border-2 border-stone-600 bg-white px-3">
        {options.map((t) => (
          <option key={t} value={t}>
            {t === '24:00' ? '24:00 (midnight)' : t}
          </option>
        ))}
      </select>
    </label>
  );
}

function Field({ label, name, type, required, step, defaultValue }: { label: string; name: string; type: string; required?: boolean; step?: number; defaultValue?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-extrabold tracking-widest text-stone-600 uppercase">{label}</span>
      <input type={type} name={name} required={required} step={step} defaultValue={defaultValue} min={type === 'number' ? 1 : undefined} className="min-h-12 border-2 border-stone-600 bg-white px-3" />
    </label>
  );
}
