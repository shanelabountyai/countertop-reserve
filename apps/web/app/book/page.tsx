// The guest booking flow (P0-12): party size → date → time → details.
//
// A server component with plain links and one form, like the host screens.
// Each step is a query parameter, so every state has a URL a guest can
// reload, share or come back to, and the whole flow works before hydration.
//
// Nothing here is authorisation. The page shows what the availability engine
// says right now; `placeReservation` asks the engine AGAIN under the bucket
// lock and the exclusion constraint, and its answer is the one that counts. A
// slot that goes on screen bookable and is refused at submit is the system
// working, not failing.
import { dayOf, plusMs } from '@reserve/core';
import { dayAvailability } from '@reserve/db/guest';
import { NOTE_MAX, TAG_KINDS } from '@reserve/core';
import { book } from './actions';
import { SlotGrid } from '../slot-grid';
import { CONSENT, DAY, MAX_PARTY, clock, guestConfig, parseParty, parseSlot } from '@/lib/guest';
import { RESTAURANT } from '@/lib/restaurant';

export const metadata = { title: 'Book a table — Firebird Kitchen' };
export const dynamic = 'force-dynamic';

const TZ = RESTAURANT.timezone;
/** How far ahead a guest may book. Beyond this the floor plan is guesswork. */
const HORIZON_DAYS = 60;

/** Fixed text per code: a URL can pick one, never write one. */
const NOTICES: Record<string, string> = {
  no_longer_available: 'That table went while you were filling this in. Please pick another time.',
  full: 'That time filled up. Please pick another.',
  pacing: 'The kitchen is at capacity for that time. Please pick another.',
  closed: 'We are not serving at that time.',
  past: 'That seating has already started.',
  too_large: 'That party is larger than any table we have. Please call us.',
  too_small: 'That party is smaller than we can seat.',
  invalid_guestName: 'Please give a name for the booking.',
  invalid_guestPhone: 'That phone number is not one we can text. Use the full international form, like +15035550123.',
  invalid_note: `Notes are limited to ${NOTE_MAX} characters.`,
  invalid_tags: 'That is not a tag we recognise.',
};

const TAG_LABEL: Record<(typeof TAG_KINDS)[number], string> = {
  allergy: 'Allergy or dietary need',
  occasion: 'Special occasion',
  accessibility: 'Accessibility need',
};

type Params = Record<string, string | string[] | undefined>;

export default async function BookPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const get = (name: string) => {
    const v = params[name];
    return (Array.isArray(v) ? v[0] : v) ?? '';
  };

  const now = new Date();
  const today = dayOf(now, TZ);
  const notice = NOTICES[get('notice')];
  const party = parseParty(get('party'));
  const day = DAY.test(get('day')) && get('day') >= today ? get('day') : '';
  const at = party !== null && day !== '' ? parseSlot(day, get('at'), TZ) : null;
  const config = await guestConfig();

  const step = (n: number, label: string, done: boolean) => (
    <li className={done ? 'font-semibold text-neutral-950' : 'text-neutral-500'}>
      {n}. {label}
    </li>
  );

  return (
    <main className="mx-auto max-w-2xl p-4 text-lg text-neutral-950">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-3xl font-bold">Book a table</h1>
        <p className="text-neutral-700">{RESTAURANT.restaurant}</p>
      </header>
      <ol className="mt-2 flex gap-4 text-sm">
        {step(1, 'Party', party !== null)}
        {step(2, 'Date', day !== '')}
        {step(3, 'Time', at !== null)}
      </ol>

      <div aria-live="polite" className="mt-3 min-h-8">
        {notice ? <p className="rounded-lg border-2 border-neutral-800 bg-yellow-100 px-4 py-2 font-semibold">{notice}</p> : null}
      </div>

      <section aria-labelledby="party" className="mt-2">
        <h2 id="party" className="text-2xl font-bold">
          How many people?
        </h2>
        <ul className="mt-2 flex flex-wrap gap-2">
          {Array.from({ length: MAX_PARTY }, (_, i) => i + 1).map((n) => (
            <li key={n}>
              {/* Changing the party size drops the time: a slot that fit two need not fit six. */}
              <a
                href={`/book?party=${n}${day === '' ? '' : `&day=${day}`}`}
                aria-current={n === party ? 'true' : undefined}
                className={`flex min-h-12 min-w-12 items-center justify-center rounded-lg px-3 font-semibold tabular-nums ${
                  n === party ? 'bg-neutral-900 text-white' : 'border-2 border-neutral-800'
                }`}
              >
                {n}
              </a>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-sm text-neutral-700">Parties over {MAX_PARTY}: please call {RESTAURANT.phone}.</p>
      </section>

      {party === null ? null : (
        <section aria-labelledby="date" className="mt-6">
          <h2 id="date" className="text-2xl font-bold">
            Which day?
          </h2>
          {/* Native date input: the platform's own calendar, keyboard and locale. */}
          <form method="get" action="/book" className="mt-2 flex flex-wrap items-center gap-2">
            <input type="hidden" name="party" value={party} />
            <label htmlFor="day" className="sr-only">
              Date
            </label>
            <input
              id="day"
              name="day"
              type="date"
              required
              defaultValue={day || today}
              min={today}
              max={dayOf(plusMs(now, HORIZON_DAYS * 86_400_000), TZ)}
              className="min-h-12 rounded-lg border-2 border-neutral-800 px-3"
            />
            <button type="submit" className="min-h-12 rounded-lg bg-neutral-900 px-6 font-semibold text-white">
              See times
            </button>
          </form>
        </section>
      )}

      {party === null || day === '' ? null : (
        <section aria-labelledby="time" className="mt-6">
          <h2 id="time" className="text-2xl font-bold">
            What time?
          </h2>
          <div className="mt-2">
            <SlotGrid
              availability={await dayAvailability({ day, partySize: party, now }, config)}
              day={day}
              timezone={TZ}
              href={(minute) => `/book?party=${party}&day=${day}&at=${minute}`}
            />
          </div>
        </section>
      )}

      {at === null || party === null ? null : (
        <section aria-labelledby="who" className="mt-8 rounded-xl border-2 border-neutral-800 p-4">
          <h2 id="who" className="text-2xl font-bold">
            Party of {party} on {day} at {clock(Number(get('at')), TZ, day)}
          </h2>
          <form action={book} className="mt-3 flex flex-col gap-4">
            <input type="hidden" name="party" value={party} />
            <input type="hidden" name="day" value={day} />
            <input type="hidden" name="at" value={get('at')} />
            {/* Minted when the form rendered, so a double-tapped submit is one booking. */}
            <input type="hidden" name="key" value={crypto.randomUUID()} />

            <label className="flex flex-col gap-1">
              <span className="font-semibold">Name</span>
              <input name="guestName" required maxLength={80} autoComplete="name" className="min-h-12 rounded-lg border-2 border-neutral-800 px-3" />
            </label>

            <label className="flex flex-col gap-1">
              <span className="font-semibold">Mobile number</span>
              {/* E.164 validated BEFORE submit by the browser itself (P0-12),
                  and again by invalidGuestField on the server, which is the
                  one that decides. The pattern is isE164's, spelled for HTML. */}
              <input
                name="guestPhone"
                type="tel"
                required
                inputMode="tel"
                autoComplete="tel"
                pattern="\+[1-9][0-9]{1,14}"
                placeholder="+15035550123"
                title="Include the country code, like +15035550123"
                className="min-h-12 rounded-lg border-2 border-neutral-800 px-3"
              />
              <span className="text-sm text-neutral-700">Full international form, starting with +.</span>
            </label>

            <label className="flex flex-col gap-1">
              <span className="font-semibold">
                Anything we should know? <span className="font-normal text-neutral-700">(optional)</span>
              </span>
              <textarea name="note" maxLength={NOTE_MAX} rows={2} className="rounded-lg border-2 border-neutral-800 px-3 py-2" />
              <span className="text-sm text-neutral-700">Up to {NOTE_MAX} characters.</span>
            </label>

            <fieldset className="flex flex-col gap-2">
              <legend className="font-semibold">Tags (optional)</legend>
              {TAG_KINDS.map((tag) => (
                <label key={tag} className="flex min-h-12 items-center gap-3">
                  <input type="checkbox" name="tags" value={tag} className="size-6" />
                  {TAG_LABEL[tag]}
                </label>
              ))}
            </fieldset>

            <label className="flex min-h-12 items-start gap-3">
              {/* Unticked by default, and the wording is stored verbatim with
                  the booking (P0-8) — a later edit to this sentence cannot
                  rewrite what this guest agreed to. */}
              <input type="checkbox" name="consent" className="mt-1 size-6" />
              <span>{CONSENT}</span>
            </label>

            <button type="submit" className="min-h-12 rounded-lg bg-neutral-900 px-6 font-semibold text-white">
              Book this table
            </button>
          </form>
        </section>
      )}
    </main>
  );
}
