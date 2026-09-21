// The capstone (V-013): one seeded service, asserted.
//
// The PRD's lagging metric in full — "a seeded service (60 covers across a
// dinner period) runs with zero double-seated tables and zero stranded
// parties, AND includes the ugly cases". Each ugly case is checked against
// the PRD's own words; then the two service-wide invariants; then the message
// reconciliation; then the report, hand-tallied against the script.
//
// When this file fails, read `capstone.ts` first: the table each party sits
// at is hand-calculated from the booking order, and a change there moves
// parties between tables.

import { beforeAll, describe, expect, it } from 'vitest';
import { HOLDS_TABLES, outsideHours, plusMs, SHOWED, parseStatus, type Status } from '@reserve/core';
import { capstoneConfig, runSeededService, SERVICE_DAY, type ServiceLedger } from './capstone';
import { prisma } from './index';
import { mockProvider } from './messages';
import { loadReport } from './report';
import { loadSchedule } from './schedule';
import { resetDatabase } from './testing/index';

let ledger: ServiceLedger;
/** The service booked every name below; a miss is a drifted fixture, so say so here rather than three queries later. */
const id = (key: string): string => {
  const found = ledger.ids[key];
  if (!found) throw new Error(`the seeded service booked no "${key}" — the fixture has drifted`);
  return found;
};
let sent: ReturnType<typeof mockProvider>['sent'];

// One run, shared by every assertion below: the service is the fixture, and
// re-running it per test would be the same service twenty times over.
beforeAll(async () => {
  await resetDatabase();
  const mock = mockProvider();
  sent = mock.sent;
  ledger = await runSeededService(mock.provider);
}, 120_000);

describe('the ugly cases (PRD, Success Metrics)', () => {
  it('UGLY 1 — a change into a party size no table can take refuses, and leaves the original intact', () => {
    const { refusal, before, after } = ledger.ugly.changeIntoTooBig;
    // T18 is the only unit that seats eight, and it is held until 20:15.
    expect(refusal).toBe('full');
    // Not "mostly intact": the same row, byte for byte, holds included.
    expect(after).toEqual(before);
    expect(after.partySize).toBe(2);
  });

  it('UGLY 2 — a change to an unavailable time refuses, and leaves the original intact', () => {
    const { refusal, before, after } = ledger.ugly.changeToUnavailableTime;
    expect(refusal).toBe('closed'); // the blackout date
    expect(after).toEqual(before);
    expect(after.holds).toHaveLength(1);
  });

  it('a refused change still tells the guest, and never re-texts the old booking as if it moved', async () => {
    const failed = await prisma.outboundMessage.findMany({ where: { kind: 'change_failed' }, orderBy: { createdAt: 'asc' } });
    expect(failed).toHaveLength(2);
    expect(failed.every((m) => m.body.includes('unchanged'))).toBe(true);
    expect(await prisma.outboundMessage.count({ where: { kind: 'change_confirmed' } })).toBe(0);
  });

  it('UGLY 3 — two simultaneous bookings for the last table make exactly one reservation and zero orphan holds', async () => {
    const { booked, refusals, holds } = ledger.ugly.lastTableRace;
    expect(booked).toBe(1);
    // A clean refusal, with a reason the guest can be told. Same-bucket
    // bookings serialize on the pacing lock, so the loser's read already sees
    // the winner; the constraint catches the cross-bucket case instead, and
    // `placement.test.ts` proves that one maps to `no_longer_available`.
    expect(refusals).toEqual(['full']);
    // A combination is inventory: the winner holds BOTH halves of C2, and the
    // loser holds nothing at all.
    expect(holds).toEqual(['T16', 'T17']);
    expect(await prisma.reservation.count({ where: { partySize: 10, status: { not: 'abandoned' }, businessDay: SERVICE_DAY } })).toBe(2); // the winner and the walk-in
  });

  it('UGLY 4 — STOP is honoured on the next send attempt, and does not cancel the table', () => {
    const { status, optedOut, dropped } = ledger.ugly.stopMidThread;
    expect(optedOut).toBe(true);
    // Opting out of texts and giving up a table are different guest intents.
    expect(status).toBe('seated');
    // The reminder was queued BEFORE the STOP and dropped at the send
    // attempt — with a reason, never silently.
    expect(dropped).toEqual([{ kind: 'reminder', reason: 'opted_out' }]);
  });

  it('UGLY 5 — an inbound from a number with two upcoming reservations acts on exactly one', () => {
    const { outcomes, offered, confirmed, untouched } = ledger.ugly.twoUpcoming;
    expect(outcomes).toEqual(['choose', 'selected', 'confirmed']);
    expect(offered).toBe(2);
    expect(confirmed).toBe('seated'); // confirmed, then seated
    // The second booking was never touched by a reply meant for the first.
    expect(untouched).toBe('seated');
  });

  it('UGLY 5 — the ambiguous reply itself changes no state', async () => {
    const choose = await prisma.inboundMessage.findFirstOrThrow({ where: { outcome: 'choose' } });
    expect(choose.reservationId).toBeNull();
    expect(await prisma.reservationEvent.count({ where: { inboundMessageId: choose.id } })).toBe(0);
  });

  it('UGLY 6 — a redelivered webhook causes exactly one transition and one reply', () => {
    const { replayed, transitions, replies } = ledger.ugly.webhookRedelivery;
    expect(replayed).toEqual([false, true]);
    expect(transitions).toBe(1);
    expect(replies).toBe(1);
  });

  it('UGLY 6 — the redelivery stored one inbound row, not two', async () => {
    expect(await prisma.inboundMessage.count({ where: { providerMessageId: 'provider-redelivered' } })).toBe(1);
  });

  it('UGLY 7 — a walk-in is seated into the table a no-show just freed, in the same session', async () => {
    const { heldBefore, freedTable, walkInTables } = ledger.ugly.walkInIntoNoShow;
    expect(heldBefore).toEqual(['T16']);
    // C2 is T16+T17 and is the only unit that seats ten, so this party could
    // be seated at all ONLY because the no-show released T16 five minutes ago.
    expect(walkInTables).toEqual(['T16', 'T17']);
    expect(walkInTables).toContain(freedTable);
    // The no-show kept its own snapshot of where it would have sat, and holds nothing.
    const iqbal = await prisma.reservation.findUniqueOrThrow({ where: { id: id('Iqbal Nasser') } });
    expect(iqbal.tableIds).toEqual(['T16']);
    expect(await prisma.tableHold.count({ where: { reservationId: iqbal.id } })).toBe(0);
  });
});

describe('the service invariants', () => {
  it('zero double-seated tables: no two live holds overlap on one table', async () => {
    const clashes = await prisma.$queryRaw<{ tableId: string }[]>`
      SELECT a."tableId" FROM "TableHold" a JOIN "TableHold" b
        ON a."tableId" = b."tableId" AND a."reservationId" < b."reservationId"
      WHERE a."startAt" < b."endAt" AND b."startAt" < a."endAt"`;
    expect(clashes).toEqual([]);
  });

  it('zero double-seated tables: no two parties occupied one table at the same time all night', async () => {
    // The live holds only prove the end state. This replays the whole
    // service: every party that held a table or sat down, over the window it
    // actually occupied — bounded by when the host cleared the table, since a
    // table cleared early is genuinely free before its turn is up.
    const rows = await prisma.reservation.findMany({
      where: { status: { in: [...HOLDS_TABLES, ...SHOWED] } },
      select: { id: true, guestName: true, businessDay: true, startAt: true, turnMinutes: true, tableIds: true, status: true, events: { select: { toStatus: true, at: true } } },
    });

    // PHYSICAL occupancy, which is not the same as the booked window.
    //
    // This used to end every party at `min(scheduled turn end, cleared)`, so a
    // party that sat down and was never cleared counted as having left when
    // their turn was up. A table can be physically occupied long past its
    // turn — that is what an over-running party IS — and seating someone else
    // into it is exactly the double-seating this test exists to catch, so the
    // assertion could not have caught it.
    //
    //   from: when they actually sat, or their booked start if they have not
    //         sat yet (a held table is not available to anyone else either).
    //   to:   when the host actually cleared them; if they are still `seated`
    //         at the end of the service, they never left — so the window runs
    //         to STILL_THERE and any later party on that table is a clash.
    const STILL_THERE = Number.POSITIVE_INFINITY;
    const occupancy = rows.flatMap((r) => {
      const seated = r.events.filter((e) => e.toStatus === 'seated').at(-1)?.at;
      const cleared = r.events.filter((e) => e.toStatus === 'completed').at(-1)?.at;
      const to = cleared ? cleared.getTime() : r.status === 'seated' ? STILL_THERE : plusMs(r.startAt, r.turnMinutes * 60_000).getTime();
      return r.tableIds.map((tableId) => ({
        who: r.guestName,
        tableId,
        day: r.businessDay,
        from: (seated ?? r.startAt).getTime(),
        to,
      }));
    });
    // Within one service day. A party still `seated` when the night ends has
    // no clear event to bound them, and the restaurant does not keep them
    // overnight — so STILL_THERE must not reach across into tomorrow's book.
    const clashes = occupancy.flatMap((a, i) =>
      occupancy
        .slice(i + 1)
        .filter((b) => a.tableId === b.tableId && a.day === b.day && a.from < b.to && b.from < a.to)
        .map((b) => `${a.tableId}: ${a.who} / ${b.who}`),
    );
    expect(clashes).toEqual([]);
    // A real service, not three rows that trivially cannot clash.
    expect(occupancy.length).toBeGreaterThan(15);
  });

  it('zero stranded parties: nothing upcoming sits outside the hours the restaurant keeps', async () => {
    const schedule = await loadSchedule((await capstoneConfig()).timezone);
    const upcoming = await prisma.reservation.findMany({
      where: { status: { in: [...HOLDS_TABLES] } },
      select: { guestName: true, businessDay: true, startAt: true, turnMinutes: true },
    });
    expect(outsideHours(schedule, upcoming)).toEqual([]);
  });

  it('zero stranded parties: every party holding a table holds exactly the tables it was given', async () => {
    const rows = await prisma.reservation.findMany({ include: { holds: { orderBy: { tableId: 'asc' } } } });
    const wrong = rows
      .filter((r) => {
        const held = r.holds.map((h) => h.tableId);
        const want = HOLDS_TABLES.includes(parseStatus(r.status)) ? [...r.tableIds].sort() : [];
        return JSON.stringify(held) !== JSON.stringify(want);
      })
      .map((r) => `${r.guestName} (${r.status}): holds ${r.holds.map((h) => h.tableId).join('+') || 'nothing'}, booked ${r.tableIds.join('+') || 'nothing'}`);
    expect(wrong).toEqual([]);
  });

  it('every table a released, cancelled or no-showed party had is back in inventory', async () => {
    const gone = await prisma.reservation.findMany({ where: { status: { in: ['released', 'cancelled', 'no_show'] } }, include: { holds: true } });
    expect(gone.length).toBeGreaterThan(0);
    expect(gone.flatMap((r) => r.holds)).toEqual([]);
    // …and their own snapshot of where they would have sat is untouched.
    expect(gone.every((r) => r.tableIds.length > 0)).toBe(true);
  });
});

describe('message reconciliation (PRD: queued = sent + deferred + dropped)', () => {
  it('reconciles exactly, with a reason on every drop', () => {
    const { queued, sent: ok, deferred, dropped, drops } = ledger.messages;
    expect(ok + deferred + dropped).toBe(queued);
    expect(drops).toHaveLength(dropped);
    expect(drops.every((d) => d.reason !== '')).toBe(true);
  });

  it('includes a real deferral and a real drop — not a night where everything happened to send', () => {
    expect(ledger.messages.deferred).toBeGreaterThan(0);
    expect(ledger.messages.dropped).toBeGreaterThan(0);
    expect(ledger.messages.sent).toBeGreaterThan(10);
  });

  it("the deferred message is tomorrow's, held back by quiet hours rather than dropped", async () => {
    const waiting = await prisma.outboundMessage.findMany({ where: { status: 'queued' }, include: { reservation: true } });
    expect(waiting.map((m) => m.kind)).toEqual(['reminder']);
    // Tonight's tables are never deferred — only what can wait for morning.
    expect(waiting[0]?.reservation?.businessDay).toBe('2026-10-03');
  });

  it('every message the provider accepted was sent exactly once', () => {
    expect(new Set(sent.map((m) => m.id)).size).toBe(sent.length);
    expect(sent.length).toBe(ledger.messages.sent);
  });

  it('nothing was texted to the number that opted out after its STOP was acknowledged', () => {
    const novak = sent.filter((m) => m.to === '+15035550110');
    // The booking confirmation, the reply to their "C", and the STOP
    // acknowledgement — and then nothing. The reminder was already queued and
    // is dropped instead of sent.
    expect(novak.map((m) => m.body.slice(0, 9))).toEqual(['Firebird ', 'Confirmed', "You're op"]);
  });
});

describe('the report hand-tallies against the seed (P1-1)', () => {
  it('counts the covers on the book and the covers that sat down', async () => {
    const r = await loadReport({ from: SERVICE_DAY, to: SERVICE_DAY }, (await capstoneConfig()).timezone);
    // 60 covers booked in advance + 10 (the race winner) + 10 and 8 (two
    // walk-ins who got tables) = 88. Wren's party of ten walked off the
    // waitlist and was never on the book for a time.
    expect(r.totals.booked).toBe(88);
    // …less Chen (2, released), Ellis (2, cancelled), Iqbal (6, no-show) and
    // Maren (2, no-show) = 76.
    expect(r.totals.seated).toBe(76);
    expect(r.totals).toEqual({ booked: 88, seated: 76, noShow: 2, cancelled: 1, released: 1 });
  });

  it('buckets covers by 15-minute seating time in the restaurant timezone', async () => {
    const r = await loadReport({ from: SERVICE_DAY, to: SERVICE_DAY }, (await capstoneConfig()).timezone);
    const bucket = (minute: number) => r.covers.find((c) => c.minute === minute);
    // 17:00: Quinn (6, seated) + Alvarez (2, completed).
    expect(bucket(17 * 60)).toEqual({ day: SERVICE_DAY, minute: 17 * 60, booked: 8, seated: 8 });
    // 17:30: Duarte (6, completed) + Chen (2, released and never seated).
    expect(bucket(17 * 60 + 30)).toEqual({ day: SERVICE_DAY, minute: 17 * 60 + 30, booked: 8, seated: 6 });
    // 17:45: Iqbal alone, a no-show — the gap between the two numbers IS the loss.
    expect(bucket(17 * 60 + 45)).toEqual({ day: SERVICE_DAY, minute: 17 * 60 + 45, booked: 6, seated: 0 });
    expect(r.covers.every((c) => c.day === SERVICE_DAY)).toBe(true);
  });

  it('answers the question it exists for: confirming predicts showing', async () => {
    const r = await loadReport({ from: SERVICE_DAY, to: SERVICE_DAY }, (await capstoneConfig()).timezone);
    // Ten confirmed parties reached service; Iqbal was the only one who did not come.
    expect(r.noShowByConfirmation.confirmed).toEqual({ of: 10, count: 1, rate: 0.1 });
    // Four never replied; Maren was the one who did not come.
    expect(r.noShowByConfirmation.unconfirmed).toEqual({ of: 4, count: 1, rate: 0.25 });
    expect(r.noShow).toEqual({ of: 14, count: 2, rate: 1 / 7 });
  });

  it('counts a no-show that HAD confirmed as confirmed — the ending status cannot say so', async () => {
    const iqbal = await prisma.reservationEvent.findMany({ where: { reservationId: id('Iqbal Nasser') }, orderBy: { id: 'asc' } });
    expect(iqbal.map((e) => e.toStatus)).toEqual(['booked', 'confirmed', 'no_show']);
  });

  it('reports the release rate and the waitlist conversion', async () => {
    const r = await loadReport({ from: SERVICE_DAY, to: SERVICE_DAY }, (await capstoneConfig()).timezone);
    // Chen, of sixteen advance bookings. Walk-ins were never at risk of a release.
    expect(r.release).toEqual({ of: 16, count: 1, rate: 1 / 16 });
    // Vance got a table; Wren gave up waiting.
    expect(r.waitlist).toEqual({ of: 2, count: 1, rate: 0.5 });
  });

  it('splits no-shows by how far ahead the booking was made', async () => {
    const r = await loadReport({ from: SERVICE_DAY, to: SERVICE_DAY }, (await capstoneConfig()).timezone);
    const band = (label: string) => r.noShowByLead.find((b) => b.label === label)?.rate;
    // Maren booked at 15:00 for 19:30 — 4.5 hours out, and did not come.
    expect(band('4-24h')).toEqual({ of: 2, count: 1, rate: 0.5 });
    // Everyone else booked three days out.
    expect(band('3+ days')?.of).toBe(12);
  });

  it('leaves the next day out of the day it was asked for', async () => {
    const tz = (await capstoneConfig()).timezone;
    const oneDay = await loadReport({ from: SERVICE_DAY, to: SERVICE_DAY }, tz);
    const both = await loadReport({ from: SERVICE_DAY, to: '2026-10-03' }, tz);
    expect(both.totals.booked).toBe(oneDay.totals.booked + 4); // Yardley
  });
});

it('every status the service produced is one the lifecycle module knows', async () => {
  const rows = await prisma.reservation.findMany({ select: { status: true } });
  const statuses = new Set<Status>(rows.map((r) => parseStatus(r.status)));
  // The service is only a demo if it exercises the interesting ones.
  for (const s of ['seated', 'completed', 'cancelled', 'no_show', 'released', 'abandoned', 'booked'] satisfies Status[]) {
    expect([...statuses]).toContain(s);
  }
});
