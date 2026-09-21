// The seeded service (V-013) — the capstone demo AND the regression fixture.
//
// One scripted Friday dinner at Firebird Kitchen, driven through the SAME
// entry points the app uses: `placeReservation`, `handleInbound`,
// `guestChange`, `sweep`, `hostMove`, `addWalkIn`. Nothing here reaches past
// them into the tables, because a demo that writes its own rows proves
// nothing about the code that ships.
//
// It runs twice: `capstone.test.ts` asserts the invariants against the ledger
// it returns, and `npm run db:seed:demo` runs it against the dev database so
// the floor view at :3500 has a real service on it.
//
// Every one of the PRD's seven ugly cases is scripted here, each marked
// `UGLY n`. The list is quoted verbatim from the PRD's Success Metrics:
//
//   1. a guest changing party size by text into a table that no longer fits
//   2. a change request for an unavailable time (original must survive intact)
//   3. two simultaneous bookings for the last table
//   4. a STOP mid-thread
//   5. an inbound from a number with two upcoming reservations
//   6. a webhook redelivery
//   7. a walk-in seated into a released no-show's table
//
// THE FIXTURE IS HAND-CALCULATED, and the table each party lands on is part
// of it. `fittingUnits` orders candidates least-waste, single tables before
// combinations, then by id, and `firstUnit` takes the first that clears the
// exclusion constraint — so the assignments below are determined by the
// booking ORDER in `ADVANCE`. Re-ordering that list moves parties between
// tables and will fail the ugly cases that depend on a table being busy.

import {
  dayOf,
  parseStatus,
  zonedTimeToInstant,
  type Status,
} from '@reserve/core';
import { addWalkIn, hostMove, type FloorConfig } from './floor';
import { guestChange, type GuestConfig } from './guest';
import { handleInbound, type InboundConfig } from './inbound';
import { prisma } from './index';
import { dispatchQueued, type MessageProvider } from './messages';
import { placeReservation, type PlaceRequest } from './placement';
import { loadSchedule } from './schedule';
import { sweep, type SweepConfig } from './sweep';

export const TIMEZONE = 'America/Los_Angeles';
/** The service. A Friday. */
export const SERVICE_DAY = '2026-10-02';
/** Tomorrow — one booking lives here so the last sweep has a reminder to defer. */
const NEXT_DAY = '2026-10-03';
/** The one blackout date the PRD's measurement method asks for. */
export const BLACKOUT_DAY = '2026-10-05';

const CONSENT = 'Text me about this reservation. Reply STOP to opt out.';
const at = (h: number, m = 0, day = SERVICE_DAY) => zonedTimeToInstant(day, h * 60 + m, TIMEZONE);

// ─── The floor plan: 18 tables, two legal combination sets (PRD).

/** `[id, seats, minParty, section]`. */
const TABLES: [string, number, number, string][] = [
  ...(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'] as const).map((id, i): [string, number, number, string] => [id, 2, 1, i < 4 ? 'window' : 'bar']),
  ...(['T9', 'T10', 'T11', 'T12', 'T13'] as const).map((id): [string, number, number, string] => [id, 4, 2, 'main']),
  ...(['T14', 'T15', 'T16', 'T17'] as const).map((id): [string, number, number, string] => [id, 6, 4, 'main']),
  ['T18', 8, 6, 'private'],
];

/**
 * Declared, never inferred. `C2` is the only unit in the house that seats a
 * party of ten, which is what makes UGLY 3 and UGLY 7 provable: contention
 * for it is contention for the last table, and it consumes BOTH halves.
 */
const COMBINATIONS: { id: string; seats: number; minParty: number; tableIds: string[] }[] = [
  { id: 'C1', seats: 4, minParty: 3, tableIds: ['T1', 'T2'] },
  { id: 'C2', seats: 12, minParty: 10, tableIds: ['T16', 'T17'] },
];

/** Two service periods, every weekday. Dinner declares an explicit last seating. */
const PERIODS = [
  { name: 'Lunch', openMinute: 11 * 60 + 30, closeMinute: 14 * 60, lastSeatingMinute: null, pacingCap: 20 },
  { name: 'Dinner', openMinute: 17 * 60, closeMinute: 22 * 60, lastSeatingMinute: 21 * 60, pacingCap: 24 },
];

export async function seedRestaurant(): Promise<void> {
  await prisma.diningTable.createMany({ data: TABLES.map(([id, seats, minParty, section]) => ({ id, seats, minParty, section })) });
  for (const c of COMBINATIONS) {
    await prisma.combination.create({
      data: { id: c.id, seats: c.seats, minParty: c.minParty, members: { create: c.tableIds.map((tableId) => ({ tableId })) } },
    });
  }
  await prisma.servicePeriod.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => PERIODS.map((p) => ({ ...p, weekday, day: null }))),
  });
  await prisma.blackout.create({ data: { day: BLACKOUT_DAY, reason: 'Annual deep clean' } });
}

// ─── The cast. 60 covers on the book in advance, before walk-ins.

type Guest = { name: string; phone: string; party: number; hour: number; minute: number; day?: string };

/**
 * Booked three days out, IN THIS ORDER — the order decides which table each
 * party gets. The six large parties are booked first so the four six-tops and
 * the eight-top are assigned before the small parties fill in around them.
 */
const ADVANCE: Guest[] = [
  // Large parties first: these are the ones whose tables the ugly cases need.
  { name: 'Quinn Alaba', phone: '+15035550101', party: 6, hour: 17, minute: 0 }, // → T14
  { name: 'Duarte Okonjo', phone: '+15035550102', party: 6, hour: 17, minute: 30 }, // → T15
  { name: 'Iqbal Nasser', phone: '+15035550103', party: 6, hour: 17, minute: 45 }, // → T16 (the no-show, UGLY 7)
  { name: 'Sun Park', phone: '+15035550104', party: 6, hour: 20, minute: 45 }, // → T14
  { name: 'Lowe Bertram', phone: '+15035550105', party: 6, hour: 20, minute: 15 }, // → T15
  { name: 'Greaves Mutombo', phone: '+15035550106', party: 8, hour: 18, minute: 15 }, // → T18, the only eight-top
  // The rest: deuces and four-tops, where there is no scarcity to reason about.
  { name: 'Alvarez Pena', phone: '+15035550107', party: 2, hour: 17, minute: 0 },
  { name: 'Chen Wu', phone: '+15035550108', party: 2, hour: 17, minute: 30 }, // never replies → released
  { name: 'Ellis Bright', phone: '+15035550109', party: 2, hour: 18, minute: 0 }, // cancels by text
  { name: 'Novak Petrov', phone: '+15035550110', party: 4, hour: 19, minute: 30 }, // UGLY 4
  { name: 'Okafor Diallo', phone: '+15035550111', party: 2, hour: 19, minute: 45 }, // UGLY 5, first
  { name: 'Okafor Diallo', phone: '+15035550111', party: 4, hour: 20, minute: 30 }, // UGLY 5, second — SAME number
  { name: 'Pryce Hammond', phone: '+15035550112', party: 2, hour: 20, minute: 0 }, // UGLY 1
  { name: 'Reyes Molina', phone: '+15035550113', party: 2, hour: 20, minute: 15 }, // UGLY 6
  // Tomorrow. Its reminder is what the last sweep defers into quiet hours.
  { name: 'Yardley Cole', phone: '+15035550114', party: 4, hour: 19, minute: 0, day: NEXT_DAY },
];

/** Booked on the day, after the release deadline sweep has already run. */
const SAME_DAY: Guest = { name: 'Maren Holt', phone: '+15035550115', party: 2, hour: 19, minute: 30 };

// ─── What the run reports back.

export type Snapshot = {
  status: Status;
  startAt: Date;
  partySize: number;
  tableIds: string[];
  holds: { tableId: string; startAt: Date; endAt: Date }[];
};

export type ServiceLedger = {
  day: string;
  /** Every reservation the service created, by the guest's name. */
  ids: Record<string, string>;
  ugly: {
    /** UGLY 1: party size grows into a size no table can take at that time. */
    changeIntoTooBig: { refusal: string; before: Snapshot; after: Snapshot };
    /** UGLY 2: a change to a time the restaurant is not open. */
    changeToUnavailableTime: { refusal: string; before: Snapshot; after: Snapshot };
    /** UGLY 3: two bookings, at once, for the only unit that fits them. */
    lastTableRace: { booked: number; refusals: string[]; holds: string[] };
    /** UGLY 4: STOP between a message being queued and its send attempt. */
    stopMidThread: { status: Status; optedOut: boolean; dropped: { kind: string; reason: string }[] };
    /** UGLY 5: one number, two upcoming reservations. */
    twoUpcoming: { outcomes: string[]; offered: number; confirmed: Status; untouched: Status };
    /** UGLY 6: the provider delivers the same message id twice. */
    webhookRedelivery: { replayed: boolean[]; transitions: number; replies: number };
    /** UGLY 7: the table a no-show just freed, seated the same session. */
    walkInIntoNoShow: { heldBefore: string[]; freedTable: string; walkInTables: string[] };
  };
  /** queued = sent + deferred + dropped, with a reason on every drop (PRD). */
  messages: { queued: number; sent: number; deferred: number; dropped: number; drops: { kind: string; reason: string }[] };
};

// ─── The run.

type Config = GuestConfig & FloorConfig & InboundConfig & SweepConfig;

export async function capstoneConfig(): Promise<Config> {
  return {
    schedule: await loadSchedule(TIMEZONE),
    timezone: TIMEZONE,
    restaurant: 'Firebird Kitchen',
    phone: '+15035550199',
    overSeatCap: 2,
    manageBaseUrl: 'https://firebird.example/m',
    bookUrl: 'https://firebird.example/book',
  };
}

export async function runSeededService(provider: MessageProvider): Promise<ServiceLedger> {
  await seedRestaurant();
  const config = await capstoneConfig();
  const ids: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  /** A name the script did not book is a typo in the script, not a null id. */
  const id = (key: string): string => ids[key] ?? raise(`seed: no reservation for ${key}`);
  const token = (key: string): string => tokens[key] ?? raise(`seed: no manage token for ${key}`);
  let sms = 0;

  const book = async (g: Guest, now: Date, key = g.name): Promise<string> => {
    const day = g.day ?? SERVICE_DAY;
    const req: PlaceRequest = {
      idempotencyKey: `seed-${key}`,
      day,
      startAt: at(g.hour, g.minute, day),
      partySize: g.party,
      guestName: g.name,
      guestPhone: g.phone,
      source: 'guest_web',
      smsConsent: CONSENT,
      now,
    };
    const r = await placeReservation(req, config);
    if (!r.ok) throw new Error(`seed: ${g.name} could not book (${r.reason}) — the hand-calculated fixture has drifted`);
    ids[key] = r.reservation.id;
    tokens[key] = r.reservation.manageToken;
    return r.reservation.id;
  };

  /** One inbound text, through the webhook handler the provider posts to. */
  const text = (phone: string, body: string, now: Date, providerMessageId = `sms-${(sms += 1)}`) =>
    handleInbound({ providerMessageId, from: phone, body }, config, now);

  /** A cron tick that only sends: the sweep's fourth pass on its own. */
  const tick = (now: Date) => dispatchQueued(provider, now, config);

  // ── Three days out: the book fills.
  const BOOKED_AT = at(12, 0, '2026-09-29');
  for (const [i, g] of ADVANCE.entries()) await book(g, BOOKED_AT, `${g.name}${i === 11 ? ' (2nd)' : ''}`);
  // The next cron tick after the bookings. Each confirmation was queued inside
  // its own booking's transaction; this is what sends them. Without it the
  // whole book would sit queued until the first sweep three days later, and
  // the demo would be testing a cron that never ran.
  await tick(at(12, 5, '2026-09-29'));

  // ── The night before, 21:30. Reminders are queued and every one of them
  // DEFERS: it is inside quiet hours and none of these tables is tonight's.
  await sweep(provider, config, at(21, 30, '2026-10-01'));

  // UGLY 4. Novak confirms, is answered, and only THEN opts out — after the
  // reminder is already queued and before it is ever sent. Both replies go out
  // despite the hour: a reply to the guest's own text is never held back, and
  // the STOP acknowledgement is never held back by anything.
  await text('+15035550110', 'C', at(22, 0, '2026-10-01'));
  await tick(at(22, 1, '2026-10-01'));
  await text('+15035550110', 'STOP', at(22, 5, '2026-10-01'));
  // The reminder sitting in the queue meets the opt-out at its send attempt
  // and is dropped with a reason — STOP is read at send time, never trusted
  // from queue time.
  await tick(at(22, 10, '2026-10-01'));

  // ── 09:00, quiet hours over. The rest of the deferred reminders go out.
  await tick(at(9, 0));

  // ── Late morning: the guests reply.
  for (const phone of ['+15035550101', '+15035550102', '+15035550103', '+15035550104', '+15035550105', '+15035550106', '+15035550107']) {
    await text(phone, 'C', at(10, 0));
  }
  await text('+15035550109', 'X', at(10, 5)); // Ellis cancels

  // UGLY 5: one number, two upcoming reservations. A bare "C" is ambiguous,
  // so the guest is asked which — and the answer acts on exactly one.
  const okaforOutcomes: string[] = [];
  const ask = await text('+15035550111', 'C', at(10, 10));
  okaforOutcomes.push(ask.outcome);
  okaforOutcomes.push((await text('+15035550111', '1', at(10, 11))).outcome);
  okaforOutcomes.push((await text('+15035550111', 'C', at(10, 12))).outcome);
  const offered = (await prisma.inboundMessage.findFirst({ where: { fromPhone: '+15035550111', outcome: 'choose' } }))?.choices.length ?? 0;

  // UGLY 6: the provider delivers the same message id twice. The second
  // delivery must change nothing — not the status, not the event log, not the
  // reply queue.
  const first = await text('+15035550113', 'C', at(10, 15), 'provider-redelivered');
  const again = await text('+15035550113', 'C', at(10, 15), 'provider-redelivered');
  const redelivery = {
    replayed: [first.replayed, again.replayed],
    transitions: await prisma.reservationEvent.count({ where: { reservationId: id('Reyes Molina'), toStatus: 'confirmed' } }),
    replies: await prisma.outboundMessage.count({ where: { reservationId: null, toPhone: '+15035550113' } }),
  };
  await tick(at(10, 30));

  // ── 15:00. A same-day booking, past the point the deadline sweep can reach.
  await book(SAME_DAY, at(15, 0));

  // UGLY 3: two parties of ten, submitted at the same instant, for C2 — the
  // only unit in the house that seats ten.
  //
  // Both want the SAME 15-minute bucket, so they serialize on the pacing
  // advisory lock and the loser's read — taken after the lock, on a fresh
  // READ COMMITTED snapshot — already shows the winner's booking. It is
  // refused `full` by the engine rather than `no_longer_available` by the
  // constraint. The constraint is what catches the cross-bucket case, where
  // two different buckets both read a free table: `placement.test.ts` and
  // `constraints.test.ts` hold that one. Both paths are a clean refusal with
  // no orphan hold, which is what the PRD asks for.
  const race = await Promise.all(
    ['race-a', 'race-b'].map((key) =>
      placeReservation(
        {
          idempotencyKey: key,
          day: SERVICE_DAY,
          startAt: at(21, 0),
          partySize: 10,
          guestName: `Table Ten ${key === 'race-a' ? 'A' : 'B'}`,
          guestPhone: key === 'race-a' ? '+15035550116' : '+15035550117',
          source: 'guest_web',
          smsConsent: CONSENT,
          now: at(15, 0),
        },
        config,
      ),
    ),
  );
  const won = race.find((r) => r.ok);
  if (!won?.ok) throw new Error('seed: neither party of ten got the last table');
  ids['Table Ten'] = won.reservation.id;
  const lastTableRace = {
    booked: race.filter((r) => r.ok).length,
    refusals: race.flatMap((r) => (r.ok ? [] : [r.reason])),
    holds: (await prisma.tableHold.findMany({ where: { startAt: at(21, 0) }, orderBy: { tableId: 'asc' } })).map((h) => h.tableId),
  };

  // ── 16:00. The deadline sweep: whoever never replied loses the table, and
  // the table is inventory again the instant that commits.
  await sweep(provider, config, at(16, 0));

  // UGLY 2 and UGLY 1: both guests text CHANGE first — the keyword never
  // parses a time, it always bounces to the tokenized manage link — and then
  // ask for something that cannot be given. Both refusals must leave the
  // original booking exactly as it was.
  await text('+15035550101', 'CHANGE', at(16, 32));
  const quinnBefore = await snapshot(id('Quinn Alaba'));
  const quinnChange = await guestChange(
    token('Quinn Alaba'),
    { day: BLACKOUT_DAY, startAt: at(19, 0, BLACKOUT_DAY), partySize: 6, now: at(16, 33) },
    config,
  );
  const changeToUnavailableTime = {
    refusal: quinnChange.ok ? 'CHANGED — the fixture has drifted' : quinnChange.reason,
    before: quinnBefore,
    after: await snapshot(id('Quinn Alaba')),
  };

  await text('+15035550112', 'CHANGE', at(16, 35));
  const pryceBefore = await snapshot(id('Pryce Hammond'));
  // A party of two becomes a party of eight at the same time. The only unit
  // that seats eight is T18, and Greaves has it until 20:15.
  const pryceChange = await guestChange(token('Pryce Hammond'), { day: SERVICE_DAY, startAt: at(20, 0), partySize: 8, now: at(16, 36) }, config);
  const changeIntoTooBig = {
    refusal: pryceChange.ok ? 'CHANGED — the fixture has drifted' : pryceChange.reason,
    before: pryceBefore,
    after: await snapshot(id('Pryce Hammond')),
  };
  await tick(at(16, 40));

  // ── Service. 17:00.
  await seat('Quinn Alaba', at(17, 0));
  await seat('Alvarez Pena', at(17, 0));
  await seat('Duarte Okonjo', at(17, 30));

  // UGLY 7. Iqbal never arrives. The grace period runs, the host marks the
  // no-show, and the six-top is real inventory that second — not a flag for
  // someone to sweep up later.
  const heldBefore = (await prisma.tableHold.findMany({ where: { reservationId: id('Iqbal Nasser') }, orderBy: { tableId: 'asc' } })).map((h) => h.tableId);
  await host('Iqbal Nasser', 'no_show', at(18, 5));
  // A party of ten at the door. C2 (T16+T17) is the only unit that seats
  // them, and T16 is the table Iqbal just gave up — so this walk-in is
  // seatable only because that no-show freed it one minute ago.
  const osei = await addWalkIn(
    { idempotencyKey: 'walkin-osei', day: SERVICE_DAY, partySize: 10, guestName: 'Osei Mensah', guestPhone: '+15035550118', textWhenReady: false, now: at(18, 10) },
    config,
  );
  if (!osei.ok || osei.reservation.status !== 'seated') throw new Error('seed: the walk-in was not seated into the no-show table');
  ids['Osei Mensah'] = osei.reservation.id;
  const walkInIntoNoShow = { heldBefore, freedTable: heldBefore[0] ?? '', walkInTables: [...osei.reservation.tableIds].sort() };

  await seat('Greaves Mutombo', at(18, 15));

  // A party of eight with no table: T18 is the only one that fits and Greaves
  // has it. Waitlisted with the quote said aloud, and seated later when the
  // host clears that table — the waitlist conversion the report counts.
  const vance = await addWalkIn(
    { idempotencyKey: 'walkin-vance', day: SERVICE_DAY, partySize: 8, guestName: 'Vance Iyer', guestPhone: '+15035550119', textWhenReady: true, now: at(18, 30) },
    config,
  );
  if (!vance.ok || vance.reservation.status !== 'waitlisted') throw new Error('seed: the party of eight should have been waitlisted');
  ids['Vance Iyer'] = vance.reservation.id;

  await seat('Novak Petrov', at(19, 30));

  // A second party of ten, with C2 taken by the walk-in: waits, then leaves.
  const wren = await addWalkIn(
    { idempotencyKey: 'walkin-wren', day: SERVICE_DAY, partySize: 10, guestName: 'Wren Adeyemi', guestPhone: '+15035550120', textWhenReady: true, now: at(19, 30) },
    config,
  );
  if (!wren.ok || wren.reservation.status !== 'waitlisted') throw new Error('seed: the second party of ten should have been waitlisted');
  ids['Wren Adeyemi'] = wren.reservation.id;

  // T1 is bussed BEFORE it is given to the next party. Alvarez sat at 17:00
  // on a 75-minute turn; clearing them at 20:50, after Okafor had been seated
  // at the same table at 19:45, described an hour in which two parties were
  // physically at T1 — which the capstone's occupancy assertion now catches.
  await host('Alvarez Pena', 'completed', at(19, 40));
  await seat('Okafor Diallo', at(19, 45));
  // Maren never confirmed and never came. The unconfirmed half of the
  // report's central question.
  await host(SAME_DAY.name, 'no_show', at(19, 50));
  await seat('Pryce Hammond', at(20, 0));
  await host('Duarte Okonjo', 'completed', at(20, 5));
  await seat('Lowe Bertram', at(20, 15));
  await seat('Reyes Molina', at(20, 15));
  await host('Greaves Mutombo', 'completed', at(20, 16));
  // The waitlisted party of eight gets the table that just cleared.
  await host('Vance Iyer', 'seated', at(20, 20));
  await host('Wren Adeyemi', 'abandoned', at(20, 25)); // gave up waiting
  await seat('Okafor Diallo (2nd)', at(20, 30));
  // Same for T14: Quinn sat at 17:00 on a 120-minute turn and is cleared
  // before Sun Park is seated there.
  await host('Quinn Alaba', 'completed', at(20, 40));
  await seat('Sun Park', at(20, 45));
  // C2 (T16+T17) is bussed before the last party of ten is seated into it.
  await host('Osei Mensah', 'completed', at(20, 55));
  await seat('Table Ten', at(21, 0));
  await tick(at(21, 0));

  // ── 21:30. The last sweep of the night. Tomorrow's reminder is queued and
  // DEFERRED: it can wait for 09:00, which is the whole point of quiet hours
  // holding messages and never state.
  await sweep(provider, config, at(21, 30));

  return {
    day: SERVICE_DAY,
    ids,
    ugly: {
      changeIntoTooBig,
      changeToUnavailableTime,
      lastTableRace,
      stopMidThread: {
        status: parseStatus((await prisma.reservation.findUniqueOrThrow({ where: { id: id('Novak Petrov') } })).status),
        optedOut: (await prisma.smsOptOut.findUnique({ where: { phone: '+15035550110' } })) !== null,
        dropped: (await prisma.outboundMessage.findMany({ where: { toPhone: '+15035550110', status: 'failed' }, orderBy: { createdAt: 'asc' } })).map((m) => ({
          kind: m.kind,
          reason: m.failureReason ?? '',
        })),
      },
      twoUpcoming: {
        outcomes: okaforOutcomes,
        offered,
        confirmed: parseStatus((await prisma.reservation.findUniqueOrThrow({ where: { id: id('Okafor Diallo') } })).status),
        untouched: parseStatus((await prisma.reservation.findUniqueOrThrow({ where: { id: id('Okafor Diallo (2nd)') } })).status),
      },
      webhookRedelivery: redelivery,
      walkInIntoNoShow,
    },
    messages: await reconcile(),
  };

  async function seat(key: string, now: Date) {
    return host(key, 'seated', now);
  }

  async function host(key: string, to: Status, now: Date) {
    const r = await hostMove(id(key), to, config, now);
    if (!r.ok) throw new Error(`seed: ${key} could not go to ${to} (${r.reason})`);
    return r;
  }
}

async function snapshot(id: string): Promise<Snapshot> {
  const r = await prisma.reservation.findUniqueOrThrow({ where: { id } });
  return {
    status: parseStatus(r.status),
    startAt: r.startAt,
    partySize: r.partySize,
    tableIds: [...r.tableIds].sort(),
    holds: (await prisma.tableHold.findMany({ where: { reservationId: id }, orderBy: { tableId: 'asc' } })).map((h) => ({
      tableId: h.tableId,
      startAt: h.startAt,
      endAt: h.endAt,
    })),
  };
}

/**
 * Every message the service queued, split the way the PRD asks for it:
 * queued = sent + deferred + dropped. A row still `queued` at the end is
 * deferred — waiting for a window in which it may be sent — and a `failed`
 * row is a drop, which must carry the reason it was dropped for.
 */
async function reconcile(): Promise<ServiceLedger['messages']> {
  const rows = await prisma.outboundMessage.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const failed = rows.filter((m) => m.status === 'failed');
  return {
    queued: rows.length,
    sent: rows.filter((m) => m.status === 'sent' || m.status === 'delivered').length,
    deferred: rows.filter((m) => m.status === 'queued').length,
    dropped: failed.length,
    drops: failed.map((m) => ({ kind: m.kind, reason: m.failureReason ?? '' })),
  };
}

/** Throws in expression position, so a lookup can stay one line. */
function raise(message: string): never {
  throw new Error(message);
}

/** The restaurant day the demo's service falls on, for a script that prints it. */
export const serviceDayOf = (instant: Date) => dayOf(instant, TIMEZONE);
