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
import { guestDayAvailability, loadManage } from '@reserve/db/guest';
import { Notice } from '../../notice';
import { SlotGrid } from '../../slot-grid';
import { cancel, change, confirm } from './actions';
import { isDay, MAX_PARTY, clock, guestConfig, parseParty, parseSlot } from '@/lib/guest';
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
  invalid_day: 'That is not a real date. Please pick again.',
  too_far: 'We are not taking bookings that far ahead yet. Please pick a nearer date.',
  pacing: 'The kitchen is at capacity then. Your original booking is unchanged.',
  closed: 'We are not serving at that time. Your original booking is unchanged.',
  past: 'That seating has already started. Your original booking is unchanged.',
  too_large: 'No table we have fits that party. Your original booking is unchanged — please call us.',
  too_small: 'That party is smaller than we can seat. Your original booking is unchanged.',
  not_changeable: 'This reservation can no longer be changed. Please call us.',
  too_late: 'It is too close to your seating to change this online. Please call us.',
  confirmed: 'Confirmed — thank you. We will hold your table.',
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

/** The chip agrees with the word; it never carries the meaning on its own. */
const STATUS_TONE: Record<string, string> = {
  booked: 'bg-amber-900',
  confirmed: 'bg-green-800',
  seated: 'bg-green-800',
  waitlisted: 'bg-sky-800',
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
  const day = isDay(get('day')) ? get('day') : r.businessDay;
  const at = picking ? parseSlot(day, get('at'), TZ) : null;

  return (
    <main className="mx-auto max-w-2xl bg-surface text-lg text-stone-900">
      <header className="bg-ink px-6 py-8 text-white">
        <p className="text-xs font-bold tracking-[0.18em] text-stone-300 uppercase">Your table · {RESTAURANT.restaurant}</p>
        <h1 className="mt-3 font-display text-4xl leading-tight font-bold">
          {fmt.format(r.startAt).replace(/ /g, ' ')}
        </h1>
        <p className="mt-2 text-stone-200">
          Party of {r.partySize} · {r.guestName}
        </p>
        <p className={`mt-4 inline-block px-3 py-1.5 text-base font-extrabold tracking-widest uppercase ${STATUS_TONE[r.status] ?? 'bg-stone-600'}`}>
          {STATUS_LABEL[r.status] ?? r.status}
        </p>
      </header>

      <div className="p-6">
      <div aria-live="polite" className="min-h-8">
        {notice ? <Notice>{notice}</Notice> : null}
      </div>

      <section aria-labelledby="details" className="border-2 border-stone-900 bg-white p-5">
        <h2 id="details" className="text-sm font-extrabold tracking-widest text-stone-600 uppercase">
          What we have
        </h2>
        {r.note ? <p className="mt-2">Note: {r.note}</p> : null}
        {r.tags.length > 0 ? <p className="mt-1">Tags: {r.tags.join(', ')}</p> : null}
        <p className="mt-2 text-stone-600">
          {r.texts ? 'Texts are on for this booking.' : 'You are not signed up for texts about this booking.'}
        </p>
      </section>

      {r.latestMessage ? (
        <section aria-labelledby="last-text" className="mt-6">
          <h2 id="last-text" className="text-sm font-extrabold tracking-widest text-stone-600 uppercase">
            Last text we sent you
          </h2>
          {/* The stored, rendered body — never re-rendered from a template
              (the snapshot rule). A change queues a newer one, and that newer
              row is what shows here from then on. */}
          <div className="mt-2 max-w-md border-2 border-stone-900 bg-white p-4">
            <p>{r.latestMessage.body}</p>
            {/* The delivery meta the canvas puts under every bubble: this is
                the stored body, not a re-render, and its length proves it. */}
            <p className="mt-2 border-t border-stone-300 pt-2 font-mono text-xs text-stone-600">
              {r.latestMessage.kind} · {r.latestMessage.body.length} chars · stored as sent
            </p>
          </div>
          {r.latestMessage.status === 'failed' ? (
            <p className="mt-2 font-bold text-red-700">We could not deliver this text, so treat this page as the record.</p>
          ) : null}
        </section>
      ) : null}

      {!r.actionable ? (
        <div className="mt-6">
          <Notice tone="quiet">There is nothing left to change here. Please call {RESTAURANT.phone} if you need us.</Notice>
        </div>
      ) : (
        <>
          {r.status === 'booked' ? (
            <section aria-labelledby="confirm" className="mt-6">
              <h2 id="confirm" className="font-display text-2xl font-bold">
                Confirm it
              </h2>
              {/* The confirmation path for a guest who declined texts: their
                  `C` reply cannot exist, because the request never went out.
                  No deadline is quoted here on purpose — the sweep releases
                  only bookings it actually asked, so quoting one to a guest
                  we never texted would be a threat we do not carry out. */}
              <p className="mt-1 text-stone-600">
                {r.texts
                  ? 'You can confirm here instead of replying to our text.'
                  : 'You asked us not to text you, so confirm here and we will know to expect you.'}
              </p>
              <form action={confirm} className="mt-2">
                <input type="hidden" name="token" value={r.token} />
                <button type="submit" className="min-h-12 bg-green-800 px-6 font-extrabold text-white">
                  Confirm this reservation
                </button>
              </form>
            </section>
          ) : null}

          <section aria-labelledby="change" className="mt-6">
            <h2 id="change" className="font-display text-2xl font-bold">
              Change it
            </h2>
            {picking ? (
              <>
                <form method="get" action={`/m/${r.token}`} className="mt-2 flex flex-wrap items-end gap-3">
                  <input type="hidden" name="change" value="1" />
                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-extrabold tracking-widest text-stone-600 uppercase">Party</span>
                    <select name="party" defaultValue={party} className="min-h-12 border-2 border-stone-900 bg-white px-3">
                      {Array.from({ length: MAX_PARTY }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-extrabold tracking-widest text-stone-600 uppercase">Day</span>
                    <input type="date" name="day" defaultValue={day} className="min-h-12 border-2 border-stone-900 bg-white px-3" />
                  </label>
                  <button type="submit" className="min-h-12 border-2 border-stone-600 bg-white px-6 font-bold">
                    See times
                  </button>
                </form>
                <div className="mt-4">
                  <SlotGrid
                    availability={await guestDayAvailability(r.token, { day, partySize: party, now }, config)}
                    day={day}
                    timezone={TZ}
                    href={(minute) => `/m/${r.token}?change=1&party=${party}&day=${day}&at=${minute}`}
                  />
                </div>
              </>
            ) : (
              <p className="mt-2">
                <a href={`/m/${r.token}?change=1`} className="inline-flex min-h-12 items-center border-2 border-stone-900 bg-white px-6 font-bold">
                  Pick a different time
                </a>
              </p>
            )}

            {at === null ? null : (
              <form action={change} className="mt-4 border-[3px] border-ink bg-white p-5">
                <input type="hidden" name="token" value={r.token} />
                <input type="hidden" name="party" value={party} />
                <input type="hidden" name="day" value={day} />
                <input type="hidden" name="at" value={get('at')} />
                <p className="font-semibold">
                  Move to party of {party} on {day} at {clock(Number(get('at')), TZ, day)}?
                </p>
                <p className="mt-1 text-stone-600">
                  Your current table is held until you submit. If the new time has gone by then, nothing changes.
                </p>
                <button type="submit" className="mt-3 min-h-12 bg-ink px-6 font-extrabold text-white">
                  Move my reservation
                </button>
              </form>
            )}
          </section>

          <section aria-labelledby="cancel" className="mt-8">
            <h2 id="cancel" className="font-display text-2xl font-bold">
              Cancel it
            </h2>
            <form action={cancel} className="mt-2">
              <input type="hidden" name="token" value={r.token} />
              <button type="submit" className="min-h-12 border-2 border-red-700 bg-white px-6 font-bold text-red-700">
                Cancel this reservation
              </button>
            </form>
          </section>
        </>
      )}
      </div>
    </main>
  );
}
