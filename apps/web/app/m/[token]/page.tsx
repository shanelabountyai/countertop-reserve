// The tokenized manage page (P0-12). The link the confirmation text carries,
// and where every `CHANGE` reply is bounced to.
//
// The token in the path is the whole of the authorisation, and it names
// exactly one reservation — there is no reservation id in any URL or form on
// this page, so a guest holding one token can do nothing to any other
// booking. A bad token is a 404, the same answer as a token that never
// existed: a guest guessing must not be able to tell the difference.
//
// Change and cancel are NOT a second code path. They call `guestChange` and
// `guestCancel`, which are `changeReservation` and the ONE lifecycle module —
// the same machinery the SMS keywords drive.
import { notFound } from 'next/navigation';
import { dayAvailability, loadManage } from '@reserve/db/guest';
import { SlotGrid } from '../../slot-grid';
import { cancel, change } from './actions';
import { DAY, MAX_PARTY, clock, guestConfig, parseParty, parseSlot } from '@/lib/guest';
import { RESTAURANT } from '@/lib/restaurant';

export const metadata = { title: 'Your reservation — Firebird Kitchen' };
export const dynamic = 'force-dynamic';

const TZ = RESTAURANT.timezone;

/** Fixed text per code: a URL can pick one, never write one. */
const NOTICES: Record<string, string> = {
  booked: "You're booked. We've texted you the details if you asked us to.",
  changed: 'Your reservation has been moved.',
  unchanged: 'That is already your reservation — nothing changed.',
  cancelled: 'Your reservation is cancelled.',
  no_longer_available: 'That time went while you were deciding. Your original booking is unchanged — pick another time.',
  full: 'That time is fully booked. Your original booking is unchanged.',
  pacing: 'The kitchen is at capacity then. Your original booking is unchanged.',
  closed: 'We are not serving at that time. Your original booking is unchanged.',
  past: 'That seating has already started. Your original booking is unchanged.',
  too_large: 'No table we have fits that party. Your original booking is unchanged — please call us.',
  too_small: 'That party is smaller than we can seat. Your original booking is unchanged.',
  not_changeable: 'This reservation can no longer be changed. Please call us.',
  too_late: 'It is too close to your seating to change this online. Please call us.',
  no_change: 'Nothing to do.',
  no_edge: 'This reservation can no longer be changed here. Please call us.',
  terminal: 'This reservation is already closed.',
  actor: 'Please call us to change this one.',
};

const STATUS_LABEL: Record<string, string> = {
  booked: 'Booked — not yet confirmed',
  confirmed: 'Confirmed',
  seated: 'Seated',
  completed: 'Finished',
  cancelled: 'Cancelled',
  no_show: 'Recorded as a no-show',
  released: 'Released — we did not hear back in time',
  waitlisted: 'On the waitlist',
  abandoned: 'Closed',
};

type Params = Record<string, string | string[] | undefined>;

export default async function ManagePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Params>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const get = (name: string) => {
    const v = query[name];
    return (Array.isArray(v) ? v[0] : v) ?? '';
  };

  const now = new Date();
  const r = await loadManage(token, now);
  if (!r) notFound();

  const notice = NOTICES[get('notice')];
  const config = await guestConfig();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  // The change picker, when the guest has opened it. Party and day default to
  // what they already have, so "same night, half an hour later" is two taps.
  const picking = get('change') === '1';
  const party = parseParty(get('party')) ?? r.partySize;
  const day = DAY.test(get('day')) ? get('day') : r.businessDay;
  const at = picking ? parseSlot(day, get('at'), TZ) : null;

  return (
    <main className="mx-auto max-w-2xl p-4 text-lg text-neutral-950">
      <header>
        <h1 className="text-3xl font-bold">Your reservation</h1>
        <p className="text-neutral-700">{RESTAURANT.restaurant}</p>
      </header>

      <div aria-live="polite" className="mt-3 min-h-8">
        {notice ? <p className="rounded-lg border-2 border-neutral-800 bg-yellow-100 px-4 py-2 font-semibold">{notice}</p> : null}
      </div>

      <section aria-labelledby="details" className="rounded-xl border-2 border-neutral-800 p-4">
        <h2 id="details" className="text-2xl font-bold">
          {fmt.format(r.startAt).replace(/ /g, ' ')}
        </h2>
        <p className="mt-1">
          Party of {r.partySize} · {r.guestName}
        </p>
        <p className="mt-1 font-semibold">{STATUS_LABEL[r.status] ?? r.status}</p>
        {r.note ? <p className="mt-2 text-neutral-700">Note: {r.note}</p> : null}
        {r.tags.length > 0 ? <p className="mt-1 text-neutral-700">Tags: {r.tags.join(', ')}</p> : null}
        {r.texts ? null : <p className="mt-2 text-neutral-700">You are not signed up for texts about this booking.</p>}
      </section>

      {r.latestMessage ? (
        <section aria-labelledby="last-text" className="mt-4">
          <h2 id="last-text" className="text-xl font-bold">
            Last text we sent you
          </h2>
          {/* The stored, rendered body — never re-rendered from a template
              (the snapshot rule). A change queues a newer one, and that newer
              row is what shows here from then on. */}
          <p className="mt-1 rounded-lg bg-neutral-100 px-4 py-3">{r.latestMessage.body}</p>
          {r.latestMessage.status === 'failed' ? (
            <p className="mt-1 font-semibold text-red-800">We could not deliver this text, so treat this page as the record.</p>
          ) : null}
        </section>
      ) : null}

      {!r.actionable ? (
        <p className="mt-6 rounded-lg border-2 border-neutral-400 bg-neutral-100 px-4 py-3">
          There is nothing left to change here. Please call {RESTAURANT.phone} if you need us.
        </p>
      ) : (
        <>
          <section aria-labelledby="change" className="mt-6">
            <h2 id="change" className="text-2xl font-bold">
              Change it
            </h2>
            {picking ? (
              <>
                <form method="get" action={`/m/${r.token}`} className="mt-2 flex flex-wrap items-end gap-3">
                  <input type="hidden" name="change" value="1" />
                  <label className="flex flex-col gap-1">
                    <span className="font-semibold">Party</span>
                    <select name="party" defaultValue={party} className="min-h-12 rounded-lg border-2 border-neutral-800 px-3">
                      {Array.from({ length: MAX_PARTY }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="font-semibold">Day</span>
                    <input type="date" name="day" defaultValue={day} className="min-h-12 rounded-lg border-2 border-neutral-800 px-3" />
                  </label>
                  <button type="submit" className="min-h-12 rounded-lg border-2 border-neutral-800 px-6 font-semibold">
                    See times
                  </button>
                </form>
                <div className="mt-4">
                  <SlotGrid
                    availability={await dayAvailability({ day, partySize: party, now }, config)}
                    day={day}
                    timezone={TZ}
                    href={(minute) => `/m/${r.token}?change=1&party=${party}&day=${day}&at=${minute}`}
                  />
                </div>
              </>
            ) : (
              <p className="mt-2">
                <a href={`/m/${r.token}?change=1`} className="inline-flex min-h-12 items-center rounded-lg border-2 border-neutral-800 px-6 font-semibold">
                  Pick a different time
                </a>
              </p>
            )}

            {at === null ? null : (
              <form action={change} className="mt-4 rounded-xl border-2 border-neutral-800 p-4">
                <input type="hidden" name="token" value={r.token} />
                <input type="hidden" name="party" value={party} />
                <input type="hidden" name="day" value={day} />
                <input type="hidden" name="at" value={get('at')} />
                <p className="font-semibold">
                  Move to party of {party} on {day} at {clock(Number(get('at')), TZ, day)}?
                </p>
                <p className="mt-1 text-neutral-700">
                  Your current table is held until you submit. If the new time has gone by then, nothing changes.
                </p>
                <button type="submit" className="mt-3 min-h-12 rounded-lg bg-neutral-900 px-6 font-semibold text-white">
                  Move my reservation
                </button>
              </form>
            )}
          </section>

          <section aria-labelledby="cancel" className="mt-8">
            <h2 id="cancel" className="text-2xl font-bold">
              Cancel it
            </h2>
            <form action={cancel} className="mt-2">
              <input type="hidden" name="token" value={r.token} />
              <button type="submit" className="min-h-12 rounded-lg border-2 border-red-800 px-6 font-semibold text-red-900">
                Cancel this reservation
              </button>
            </form>
          </section>
        </>
      )}
    </main>
  );
}
