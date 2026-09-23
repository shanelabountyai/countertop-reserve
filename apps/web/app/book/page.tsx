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
import { dayOf, lastBookableDay } from '@reserve/core';
import { dayAvailability } from '@reserve/db/guest';
import { NOTE_MAX, TAG_KINDS } from '@reserve/core';
import { Notice } from '../notice';
import { book } from './actions';
import { SlotGrid } from '../slot-grid';
import { CONSENT, isDay, MAX_PARTY, clock, guestConfig, parseParty, parseSlot } from '@/lib/guest';
import { RESTAURANT } from '@/lib/restaurant';

export const metadata = { title: 'Book a table — Firebird Kitchen' };
export const dynamic = 'force-dynamic';

const TZ = RESTAURANT.timezone;

/** Fixed text per code: a URL can pick one, never write one. */
const NOTICES: Record<string, string> = {
  no_longer_available: 'That table went while you were filling this in. Please pick another time.',
  full: 'That time filled up. Please pick another.',
  invalid_day: 'That is not a real date. Please pick again.',
  too_far: 'We are not taking bookings that far ahead yet. Please pick a nearer date.',
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
  const day = isDay(get('day')) && get('day') >= today ? get('day') : '';
  const at = party !== null && day !== '' ? parseSlot(day, get('at'), TZ) : null;
  const config = await guestConfig();

  const step = (n: number, label: string, done: boolean) => (
    <li className={done ? 'font-extrabold text-stone-900' : 'text-stone-600'}>
      {n}. {label}
    </li>
  );

  return (
    <main className="mx-auto max-w-2xl bg-surface text-lg text-stone-900">
      <header className="bg-ink px-6 py-8 text-white">
        <p className="text-xs font-bold tracking-[0.18em] text-stone-300 uppercase">{RESTAURANT.restaurant} · {RESTAURANT.phone}</p>
        <h1 className="mt-3 font-display text-4xl leading-tight font-bold">Book a table.</h1>
        <p className="mt-3 text-stone-200">We hold it for the whole turn and text you to confirm. Reply C and you&rsquo;re set.</p>
      </header>

      <div className="p-6">
      <ol className="flex gap-4 text-sm font-bold tracking-widest uppercase">
        {step(1, 'Party', party !== null)}
        {step(2, 'Date', day !== '')}
        {step(3, 'Time', at !== null)}
      </ol>

      <div aria-live="polite" className="mt-3 min-h-8">
        {notice ? <Notice tone="danger">{notice}</Notice> : null}
      </div>

      <section aria-labelledby="party" className="mt-2">
        <h2 id="party" className="font-display text-2xl font-bold">
          How many people?
        </h2>
        <ul className="mt-2 flex flex-wrap gap-2">
          {Array.from({ length: MAX_PARTY }, (_, i) => i + 1).map((n) => (
            <li key={n}>
              {/* Changing the party size drops the time: a slot that fit two need not fit six. */}
              <a
                href={`/book?party=${n}${day === '' ? '' : `&day=${day}`}`}
                aria-current={n === party ? 'true' : undefined}
                className={`flex min-h-12 min-w-12 items-center justify-center px-3 font-bold tabular-nums ${
                  n === party ? 'bg-ink text-white' : 'border-2 border-stone-900 bg-white'
                }`}
              >
                {n}
              </a>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-base text-stone-600">Parties over {MAX_PARTY}: please call {RESTAURANT.phone}.</p>
      </section>

      {party === null ? null : (
        <section aria-labelledby="date" className="mt-6">
          <h2 id="date" className="font-display text-2xl font-bold">
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
              max={lastBookableDay(now, TZ)}
              className="min-h-12 border-2 border-stone-900 bg-white px-3"
            />
            <button type="submit" className="min-h-12 bg-red-700 px-6 font-extrabold text-white">
              See times
            </button>
          </form>
        </section>
      )}

      {party === null || day === '' ? null : (
        <section aria-labelledby="time" className="mt-6">
          <h2 id="time" className="font-display text-2xl font-bold">
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
        <section aria-labelledby="who" className="mt-8 border-[3px] border-ink bg-white p-5">
          <h2 id="who" className="font-display text-2xl font-bold">
            Party of {party} on {day} at {clock(Number(get('at')), TZ, day)}
          </h2>
          <form action={book} className="mt-3 flex flex-col gap-4">
            <input type="hidden" name="party" value={party} />
            <input type="hidden" name="day" value={day} />
            <input type="hidden" name="at" value={get('at')} />
            {/* Minted when the form rendered, so a double-tapped submit is one booking. */}
            <input type="hidden" name="key" value={crypto.randomUUID()} />

            <label className="flex flex-col gap-1">
              <span className="text-sm font-extrabold tracking-widest text-stone-600 uppercase">Name</span>
              <input name="guestName" required maxLength={80} autoComplete="name" className="min-h-12 border-2 border-stone-900 bg-white px-3" />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-extrabold tracking-widest text-stone-600 uppercase">Mobile number</span>
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
                className="min-h-12 border-2 border-stone-900 bg-white px-3"
              />
              <span className="text-base text-stone-600">Full international form, starting with +.</span>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-extrabold tracking-widest text-stone-600 uppercase">
                Anything we should know? <span className="font-semibold">(optional)</span>
              </span>
              <textarea name="note" maxLength={NOTE_MAX} rows={2} className="border-2 border-stone-900 bg-white px-3 py-2" />
              <span className="text-base text-stone-600">Up to {NOTE_MAX} characters.</span>
            </label>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-extrabold tracking-widest text-stone-600 uppercase">Tags (optional)</legend>
              {TAG_KINDS.map((tag) => (
                <label key={tag} className="flex min-h-12 items-center gap-3">
                  <input type="checkbox" name="tags" value={tag} className="size-6 accent-red-700" />
                  {TAG_LABEL[tag]}
                </label>
              ))}
            </fieldset>

            <label className="flex min-h-12 items-start gap-3 border-2 border-stone-900 p-3">
              {/* Unticked by default, and the wording is stored verbatim with
                  the booking (P0-8) — a later edit to this sentence cannot
                  rewrite what this guest agreed to. */}
              <input type="checkbox" name="consent" className="mt-1 size-6 accent-red-700" />
              <span>{CONSENT}</span>
            </label>

            <button type="submit" className="min-h-12 bg-red-700 px-6 font-extrabold text-white">
              Book this table
            </button>
          </form>
        </section>
      )}
      </div>
    </main>
  );
}
