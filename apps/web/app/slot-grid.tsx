// The time picker, shared by the booking flow and the manage page (P0-12).
//
// Unavailable times are SHOWN, with the reason — never hidden. A guest who
// cannot see 7:00 at all learns nothing; a guest who sees "7:00 — fully
// booked" learns that the restaurant exists at 7:00 and is worth trying
// another night. Both callers pick a slot by restaurant-local minute-of-day,
// and both land on a confirm step before anything is written.
import type { Availability, DayReason, SlotReason } from '@reserve/core';
import { Notice } from './notice';
import { clock } from '@/lib/guest';

const SLOT_REASON: Record<SlotReason, string> = {
  past: 'already passed',
  closed: 'not serving',
  full: 'fully booked',
  pacing: 'kitchen at capacity',
};

/** Why a whole day came back with nothing, in the guest's words. */
export const DAY_REASON: Record<DayReason, string> = {
  ...SLOT_REASON,
  past: 'Every seating today has already started.',
  closed: 'The restaurant is not serving that day.',
  full: 'Every table is booked that day.',
  pacing: 'The kitchen is at capacity for every seating that day.',
  too_large: 'That party is larger than any table or combination we have. Please call us.',
  too_small: 'That party is smaller than we can seat.',
};

export function SlotGrid({
  availability,
  day,
  timezone,
  href,
}: {
  availability: Availability;
  day: string;
  timezone: string;
  /** Where picking this minute-of-day goes. */
  href: (minute: number) => string;
}) {
  // No slots at all: the party does not fit any table, or the restaurant is
  // shut that day. There is nothing to show but the reason.
  if (availability.slots.length === 0) {
    return <Notice tone="quiet">{DAY_REASON[availability.reason ?? 'closed']}</Notice>;
  }
  const periods = [...new Set(availability.slots.map((s) => s.period))];
  return (
    <div className="flex flex-col gap-5">
      {/* Every seating is taken, but the times themselves still go on screen. */}
      {availability.reason === null ? null : (
        <Notice tone="quiet">{DAY_REASON[availability.reason]}</Notice>
      )}
      {periods.map((period) => (
        <section key={period} aria-labelledby={`period-${period}`}>
          <h3 id={`period-${period}`} className="font-display text-2xl font-bold">
            {period}
          </h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {availability.slots
              .filter((s) => s.period === period)
              .map((s) => (
                <li key={s.minute}>
                  {s.bookable ? (
                    <a
                      href={href(s.minute)}
                      className="flex min-h-14 min-w-24 items-center justify-center border-2 border-stone-900 bg-white px-4 font-bold tabular-nums text-stone-900 hover:bg-stone-900 hover:text-white"
                    >
                      {clock(s.minute, timezone, day)}
                    </a>
                  ) : (
                    // Not a disabled <button>: there is no form here, and the
                    // reason has to reach a screen reader, not just an eye.
                    <span className="flex min-h-14 min-w-24 flex-col items-center justify-center border border-stone-300 bg-stone-100 px-4 text-stone-600">
                      <span className="font-bold tabular-nums line-through">{clock(s.minute, timezone, day)}</span>
                      <span className="text-xs font-extrabold tracking-wider uppercase">{SLOT_REASON[s.reason]}</span>
                    </span>
                  )}
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
