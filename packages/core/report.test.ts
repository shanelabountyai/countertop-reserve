import { describe, expect, it } from 'vitest';
import { LEAD_BANDS, report, type ReportRow } from './report';
import { zonedTimeToInstant } from './time';
import type { Status } from './lifecycle';

// Friday 2026-10-02, America/Los_Angeles. Every fixture below is hand-tallied
// in its own test — no helper computes the expected number.
const DAY = '2026-10-02';
const TZ = 'America/Los_Angeles';
const at = (h: number, m = 0, day = DAY) => zonedTimeToInstant(day, h * 60 + m, TZ);

/** `history` defaults to the ordinary path into `status`, which is what most rows are. */
function row(over: Partial<ReportRow> & { status: Status }): ReportRow {
  const history: Status[] = over.history ? [...over.history] : ['booked', ...(over.status === 'booked' ? [] : [over.status])];
  return { businessDay: DAY, startAt: at(19), partySize: 2, createdAt: at(12, 0, '2026-09-28'), history, ...over };
}

describe('cover buckets', () => {
  it('sums covers into 15-minute seating buckets, in the restaurant timezone', () => {
    const r = report(
      [
        row({ status: 'completed', startAt: at(19, 0), partySize: 2 }),
        row({ status: 'seated', startAt: at(19, 10), partySize: 4 }), // same bucket: 19:00
        row({ status: 'seated', startAt: at(19, 15), partySize: 6 }),
      ],
      TZ,
    );
    expect(r.covers).toEqual([
      { day: DAY, minute: 19 * 60, booked: 6, seated: 6 },
      { day: DAY, minute: 19 * 60 + 15, booked: 6, seated: 6 },
    ]);
  });

  it('keeps a loss on the book so the gap between booked and seated IS the loss', () => {
    const r = report(
      [
        row({ status: 'seated', partySize: 2 }),
        row({ status: 'cancelled', partySize: 4 }),
        row({ status: 'no_show', partySize: 3 }),
        row({ status: 'released', partySize: 5 }),
      ],
      TZ,
    );
    expect(r.covers).toEqual([{ day: DAY, minute: 19 * 60, booked: 14, seated: 2 }]);
    expect(r.totals).toEqual({ booked: 14, seated: 2, noShow: 1, cancelled: 1, released: 1 });
  });

  it('leaves out a waitlisted party who walked off — they were never on the book for a time', () => {
    const r = report([row({ status: 'abandoned', partySize: 4, history: ['waitlisted', 'abandoned'] }), row({ status: 'seated', partySize: 2 })], TZ);
    expect(r.covers).toEqual([{ day: DAY, minute: 19 * 60, booked: 2, seated: 2 }]);
  });

  it('buckets by the restaurant day, not the UTC one: a 9pm PT seating is already tomorrow in UTC', () => {
    const r = report([row({ status: 'seated', startAt: at(21, 0), partySize: 2 })], TZ);
    expect(r.covers).toEqual([{ day: DAY, minute: 21 * 60, booked: 2, seated: 2 }]);
  });
});

describe('no-show rate by confirmation state', () => {
  // The question P1-1 exists to answer. A reservation that confirmed and then
  // no-showed ends as plain `no_show`, so the split has to come from history.
  it('reads confirmation from the event history, not the ending status', () => {
    const r = report(
      [
        row({ status: 'no_show', history: ['booked', 'confirmed', 'no_show'] }),
        row({ status: 'completed', history: ['booked', 'confirmed', 'seated', 'completed'] }),
        row({ status: 'seated', history: ['booked', 'confirmed', 'seated'] }),
        row({ status: 'seated', history: ['booked', 'confirmed', 'seated'] }),
        row({ status: 'no_show', history: ['booked', 'no_show'] }),
        row({ status: 'no_show', history: ['booked', 'no_show'] }),
        row({ status: 'seated', history: ['booked', 'seated'] }),
      ],
      TZ,
    );
    // Confirmed: 4 judged, 1 no-show. Unconfirmed: 3 judged, 2 no-shows.
    expect(r.noShowByConfirmation.confirmed).toEqual({ of: 4, count: 1, rate: 0.25 });
    expect(r.noShowByConfirmation.unconfirmed).toEqual({ of: 3, count: 2, rate: 2 / 3 });
    expect(r.noShow).toEqual({ of: 7, count: 3, rate: 3 / 7 });
  });

  it('leaves cancelled and released out of the denominator — neither is a guest who failed to turn up', () => {
    const r = report([row({ status: 'seated' }), row({ status: 'no_show' }), row({ status: 'cancelled' }), row({ status: 'released' })], TZ);
    expect(r.noShow).toEqual({ of: 2, count: 1, rate: 0.5 });
  });

  it('reports no rate at all rather than 0% when nothing is in the denominator', () => {
    const r = report([row({ status: 'cancelled' })], TZ);
    expect(r.noShow).toEqual({ of: 0, count: 0, rate: null });
    expect(r.noShowByConfirmation.confirmed.rate).toBeNull();
    expect(r.waitlist.rate).toBeNull();
  });
});

describe('no-show rate by lead time', () => {
  it('bands a reservation by how long before its seating it was made', () => {
    const r = report(
      [
        // Booked 2h ahead, no-showed.
        row({ status: 'no_show', createdAt: at(17) }),
        // Booked 7h ahead, sat down.
        row({ status: 'seated', createdAt: at(12) }),
        // Booked two days ahead, no-showed.
        row({ status: 'no_show', createdAt: at(19, 0, '2026-09-30') }),
        // Booked a week ahead, sat down.
        row({ status: 'seated', createdAt: at(19, 0, '2026-09-25') }),
      ],
      TZ,
    );
    expect(r.noShowByLead).toEqual([
      { label: 'under 4h', rate: { of: 1, count: 1, rate: 1 } },
      { label: '4-24h', rate: { of: 1, count: 0, rate: 0 } },
      { label: '1-3 days', rate: { of: 1, count: 1, rate: 1 } },
      { label: '3+ days', rate: { of: 1, count: 0, rate: 0 } },
    ]);
    // Every band is reported, always, so a missing row reads as "none", not as absent.
    expect(r.noShowByLead.map((b) => b.label)).toEqual(LEAD_BANDS.map((b) => b.label));
  });
});

describe('release rate and waitlist conversion', () => {
  it('measures releases against advance bookings only — a walk-in was never at risk of one', () => {
    const r = report(
      [
        row({ status: 'released' }),
        row({ status: 'seated' }),
        row({ status: 'seated' }),
        row({ status: 'completed', history: ['seated', 'completed'] }), // a walk-in: never `booked`
      ],
      TZ,
    );
    expect(r.release).toEqual({ of: 3, count: 1, rate: 1 / 3 });
  });

  it('counts a waitlisted party as converted once they reach a table', () => {
    const r = report(
      [
        row({ status: 'completed', history: ['waitlisted', 'seated', 'completed'] }),
        row({ status: 'seated', history: ['waitlisted', 'seated'] }),
        row({ status: 'abandoned', history: ['waitlisted', 'abandoned'] }),
        row({ status: 'seated' }), // an advance booking, not a waitlist entry
      ],
      TZ,
    );
    expect(r.waitlist).toEqual({ of: 3, count: 2, rate: 2 / 3 });
  });
});

it('gives identical numbers whatever the process timezone is', () => {
  const rows = [row({ status: 'seated', startAt: at(19, 30) }), row({ status: 'no_show', startAt: at(21, 0) })];
  // The rows are instants; only the restaurant's timezone decides the bucket.
  expect(report(rows, TZ).covers.map((c) => c.minute)).toEqual([19 * 60 + 30, 21 * 60]);
  expect(report(rows, 'UTC').covers.map((c) => c.minute)).not.toEqual([19 * 60 + 30, 21 * 60]);
});
