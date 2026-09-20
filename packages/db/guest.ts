// The guest-facing reads and writes (P0-12): the booking flow's slot list,
// the tokenized manage page, and the two things a guest may do to their own
// reservation.
//
// The manage page is NOT a second code path. A change goes through
// `changeReservation` — the same re-allocation the PRD's CHANGE keyword
// bounces here for — and a cancel goes through the ONE lifecycle module with
// the actor `guest`, exactly as the inbound handler's `X` does. What is new
// here is only the credential: the manage token stands in for the phone
// number the webhook authenticates by.
//
// The token is the whole of the authorisation. There is no reservation id in
// any guest URL or form: a token names exactly one reservation, and a guest
// holding one can do nothing to any other.

import {
  DEFAULT_TEMPLATES,
  DEFAULT_TURN_BANDS,
  HOLDS_TABLES,
  availability,
  dayOf,
  parseStatus,
  renderMessage,
  transition,
  whenSlots,
  type Availability,
  type MessageKind,
  type Rejection,
  type Status,
} from '@reserve/core';
import { prisma, type Prisma, type Reservation } from './index';
import { changeReservation, loadPlan, type Change, type PlacementConfig } from './placement';

export type GuestConfig = PlacementConfig & {
  /** Where "book again" points, for the cancellation text. */
  bookUrl: string;
};

/**
 * One day's slots for one party size, every slot carrying its reason (P0-12:
 * unavailable times are shown as unavailable WITH the reason, never hidden).
 *
 * Read-only and outside any transaction: this is what the guest sees, not
 * what they get. The allocation decision is `placeReservation`'s, taken
 * again under the lock and the constraint — a slot shown bookable here can
 * still be refused at submit, and that refusal is the honest answer.
 */
export async function dayAvailability(
  q: { day: string; partySize: number; now: Date },
  config: PlacementConfig,
): Promise<Availability> {
  const plan = await loadPlan(prisma, config.overSeatCap);
  const held = await prisma.reservation.findMany({
    where: { businessDay: q.day, status: { in: [...HOLDS_TABLES] } },
    select: { startAt: true, partySize: true, turnMinutes: true, tableIds: true },
  });
  return availability({
    day: q.day,
    partySize: q.partySize,
    plan,
    schedule: config.schedule,
    reservations: held.map((r) => ({ ...r, start: r.startAt })),
    now: q.now,
    turnBands: config.turnBands ?? DEFAULT_TURN_BANDS,
  });
}

/** What the manage page shows. Live — the reservation as it stands right now. */
export type ManageView = {
  token: string;
  status: Status;
  startAt: Date;
  businessDay: string;
  partySize: number;
  guestName: string;
  note: string | null;
  tags: string[];
  texts: boolean;
  /** Whether the guest may still act: upcoming, and not yet started. */
  actionable: boolean;
  /**
   * The newest message queued or sent to this guest. A change re-texts the
   * new details and SUPERSEDES the previous message here (P0-12) — superseded
   * by being older, not by being deleted: every row stays as the delivery log.
   */
  latestMessage: { kind: MessageKind; body: string; status: string; failureReason: string | null } | null;
};

/** 128 bits, base64url — what `newManageToken` mints. Anything else never reaches the database. */
const TOKEN = /^[\w-]{22}$/;

export async function loadManage(token: string, now: Date): Promise<ManageView | null> {
  if (!TOKEN.test(token)) return null;
  const r = await prisma.reservation.findUnique({
    where: { manageToken: token },
    include: { messages: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 } },
  });
  return r && view(r, r.messages[0] ?? null, now);
}

function view(r: Reservation, m: { kind: string; body: string; status: string; failureReason: string | null } | null, now: Date): ManageView {
  const status = parseStatus(r.status);
  return {
    token: r.manageToken,
    status,
    startAt: r.startAt,
    businessDay: r.businessDay,
    partySize: r.partySize,
    guestName: r.guestName,
    note: r.note,
    tags: r.tags,
    texts: r.smsConsent !== null,
    // `transition` has the final word on both; this is what decides whether
    // the page renders the forms at all.
    actionable: transition({ status, startAt: r.startAt }, 'cancelled', 'guest', now).ok,
    latestMessage: m && { ...m, kind: m.kind as MessageKind },
  };
}

export type GuestRefusal = Rejection | 'not_found';

/** The reservation this token names, locked, or null. */
const byToken = async (tx: Prisma.TransactionClient, token: string) =>
  TOKEN.test(token) ? (await tx.$queryRaw<Reservation[]>`SELECT * FROM "Reservation" WHERE "manageToken" = ${token} FOR UPDATE`)[0] : undefined;

export type GuestChange = Change | { ok: false; reason: 'not_found' };

/**
 * The guest moves their own booking. `changeReservation` does the
 * re-allocation and the confirmation-by-changing (V-008); this adds the
 * token lookup and the A5/A6 text.
 *
 * The text is queued AFTER the change commits, not inside it. A change that
 * succeeded is not undone by a message that could not be rendered, and a
 * refusal has no transaction to ride on in the first place — which is the
 * opposite of a booking, where there must be no reservation without its
 * confirmation.
 */
export async function guestChange(
  token: string,
  req: { day: string; startAt: Date; partySize: number; now: Date },
  config: GuestConfig,
): Promise<GuestChange> {
  if (!TOKEN.test(token)) return { ok: false, reason: 'not_found' };
  const current = await prisma.reservation.findUnique({ where: { manageToken: token } });
  if (!current) return { ok: false, reason: 'not_found' };
  const result = await changeReservation({ ...req, reservationId: current.id, source: 'guest_web' }, config);

  // Nothing moved, or there was nothing to move: only a real change or a real
  // refusal is worth a text. A double-submitted form is silent.
  if (result.ok && !result.changed) return result;
  if (!result.ok && result.reason === 'not_changeable') return result;

  const was = result.ok ? result.was.startAt : current.startAt;
  await queue(result.ok ? 'change_confirmed' : 'change_failed', current, {
    ...whenSlots(req.startAt, config.schedule.timezone),
    // The party size ASKED for, either way: "7:30 isn't available for 4" is
    // about the 4 the guest just typed, not the 2 they had booked.
    party: String(req.partySize),
    was: wasSlot(was, req.startAt, config.schedule.timezone),
    link: `${config.manageBaseUrl}/${current.manageToken}`,
  }, config, req.now);
  return result;
}

/**
 * The booking as it stood, for `{was}`: the time alone when the guest stayed
 * on the same day, the date with it when they moved days — "your previous
 * 7:00 booking" is a lie about a booking that was last Tuesday.
 */
function wasSlot(was: Date, now: Date, timezone: string): string {
  const w = whenSlots(was, timezone);
  return dayOf(was, timezone) === dayOf(now, timezone) ? w.time : `${w.date} ${w.time}`;
}

export type GuestCancel = { ok: true; status: Status } | { ok: false; reason: GuestRefusal };

/**
 * The guest cancels their own booking — the same transition the inbound `X`
 * drives, with `guest` as the actor and the token as the credential. The
 * tables go back to inventory in the same transaction as the event, so a
 * walk-in can be seated into them the moment this commits.
 */
export async function guestCancel(token: string, now: Date, config: GuestConfig): Promise<GuestCancel> {
  const done = await prisma.$transaction(async (tx): Promise<GuestCancel & { reservation?: Reservation }> => {
    const r = await byToken(tx, token);
    if (!r) return { ok: false, reason: 'not_found' };
    const d = transition({ status: parseStatus(r.status), startAt: r.startAt }, 'cancelled', 'guest', now);
    if (!d.ok) return d;
    if (d.tables === 'release') await tx.tableHold.deleteMany({ where: { reservationId: r.id } });
    await tx.reservation.update({ where: { id: r.id }, data: { status: d.to, statusChangedAt: now } });
    await tx.reservationEvent.create({
      data: { reservationId: r.id, at: now, fromStatus: d.from, toStatus: d.to, source: 'guest_web' },
    });
    return { ok: true, status: d.to, reservation: r };
  }, { maxWait: 10_000, timeout: 10_000 });

  const { reservation, ...result } = done;
  if (reservation) {
    await queue('cancelled', reservation, { ...whenSlots(reservation.startAt, config.schedule.timezone), bookLink: config.bookUrl }, config, now);
  }
  return result;
}

/**
 * Renders and queues one reservation-owned message. No consent, no text
 * (P0-8) — and no number to text either. The dispatch sweep applies STOP,
 * quiet hours and the daily limit at send time; this only decides that
 * something happened worth telling the guest about.
 */
async function queue(
  kind: MessageKind,
  r: Reservation,
  slots: Parameters<typeof renderMessage>[1],
  config: GuestConfig,
  now: Date,
): Promise<void> {
  if (r.smsConsent === null || r.guestPhone === null) return;
  const body = renderMessage((config.templates ?? DEFAULT_TEMPLATES)[kind], { restaurant: config.restaurant, ...slots });
  await prisma.outboundMessage.create({
    data: { reservationId: r.id, kind, toPhone: r.guestPhone, body, status: 'queued', createdAt: now, statusChangedAt: now },
  });
}
