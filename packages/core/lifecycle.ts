// The ONE reservation lifecycle module (P0-4). Every reader — the
// availability engine's occupied set, host filters, message triggers,
// reports — derives its status list from TRAITS below. A new status fails to
// compile until it is classified here and given its edges.

export const STATUSES = [
  'waitlisted',
  'booked',
  'confirmed',
  'seated',
  'completed',
  'cancelled',
  'no_show',
  'released',
  'abandoned',
] as const;
export type Status = (typeof STATUSES)[number];

/** guest = web manage page or SMS reply; system = sweeps (auto-release). */
export type Actor = 'guest' | 'host' | 'system';

type Traits = {
  /** Owns TableHold rows: in the availability engine's occupied set. */
  holdsTables: boolean;
  /** Still ahead of the guest: reminders go out, an inbound reply can act on it. */
  upcoming: boolean;
  /** The party actually sat down — counts as covers in reports. */
  showed: boolean;
  terminal: boolean;
};

const TRAITS: Record<Status, Traits> = {
  waitlisted: { holdsTables: false, upcoming: false, showed: false, terminal: false },
  booked: { holdsTables: true, upcoming: true, showed: false, terminal: false },
  confirmed: { holdsTables: true, upcoming: true, showed: false, terminal: false },
  seated: { holdsTables: true, upcoming: false, showed: true, terminal: false },
  completed: { holdsTables: false, upcoming: false, showed: true, terminal: true },
  // Three different facts, never collapsed: the guest told us, the guest
  // didn't come, the guest never confirmed.
  cancelled: { holdsTables: false, upcoming: false, showed: false, terminal: true },
  no_show: { holdsTables: false, upcoming: false, showed: false, terminal: true },
  released: { holdsTables: false, upcoming: false, showed: false, terminal: true },
  abandoned: { holdsTables: false, upcoming: false, showed: false, terminal: true },
};

const where = (trait: keyof Traits) => STATUSES.filter((s) => TRAITS[s][trait]);
export const HOLDS_TABLES: readonly Status[] = where('holdsTables');
export const UPCOMING: readonly Status[] = where('upcoming');
export const SHOWED: readonly Status[] = where('showed');
export const TERMINAL: readonly Status[] = where('terminal');

export const holdsTables = (s: Status) => TRAITS[s].holdsTables;
export const isUpcoming = (s: Status) => TRAITS[s].upcoming;

/**
 * The transition table: from → to → who may drive it.
 *
 * `released` is `booked` only. The PRD's state line says booked|confirmed,
 * but P0-7 releases *unconfirmed* reservations — releasing a guest who
 * confirmed would be the defect (see PROGRESS, V-004).
 */
const EDGES: Record<Status, Partial<Record<Status, readonly Actor[]>>> = {
  waitlisted: { seated: ['host'], abandoned: ['host', 'system'] },
  booked: {
    confirmed: ['guest', 'host'],
    seated: ['host'],
    cancelled: ['guest', 'host'],
    no_show: ['host'],
    released: ['system'],
  },
  confirmed: { seated: ['host'], cancelled: ['guest', 'host'], no_show: ['host'] },
  seated: { completed: ['host'] },
  completed: {},
  cancelled: {},
  no_show: {},
  released: {},
  abandoned: {},
};

/**
 * Whether the table has an edge `from → to` for `actor` — what a screen asks
 * to decide which buttons a row gets. `transition` still has the final word
 * (grace period, start time).
 */
export const allows = (from: Status, to: Status, actor: Actor) => EDGES[from][to]?.includes(actor) ?? false;

export type LifecyclePolicy = {
  /** A no-show can be marked only this long after the reservation's start. */
  noShowGraceMinutes: number;
  /** A host action can be undone for this long (P0-9: 5s). */
  undoSeconds: number;
};
export const DEFAULT_POLICY: LifecyclePolicy = { noShowGraceMinutes: 15, undoSeconds: 5 };

export type Rejection =
  | 'no_change' // already in that status — e.g. a second "C" from the guest
  | 'terminal' // nothing leaves a terminal status except a logged revert
  | 'no_edge' // not in the transition table
  | 'actor' // edge exists, but not for this actor (a guest cannot seat themselves)
  | 'too_early' // no-show before the grace period has run
  | 'too_late' // guest confirm/cancel at or after the reservation's start
  | 'not_revertible' // the last event was not an undoable host action
  | 'undo_expired';

/**
 * What the caller must do to TableHold rows in the same transaction as the
 * event. `release` = delete them (V-003 decision); `acquire` = allocate under
 * the exclusion constraint, which can still refuse.
 */
export type TableEffect = 'keep' | 'release' | 'acquire' | 'none';

export type Decision =
  | { ok: true; from: Status; to: Status; tables: TableEffect }
  | { ok: false; reason: Rejection };

export type ReservationState = { status: Status; startAt: Date };

function tableEffect(from: Status, to: Status): TableEffect {
  const a = holdsTables(from);
  const b = holdsTables(to);
  return a && b ? 'keep' : a ? 'release' : b ? 'acquire' : 'none';
}

const minutes = (m: number) => m * 60_000;

export function transition(
  r: ReservationState,
  to: Status,
  actor: Actor,
  now: Date,
  policy: LifecyclePolicy = DEFAULT_POLICY,
): Decision {
  const from = r.status;
  if (from === to) return { ok: false, reason: 'no_change' };
  if (TRAITS[from].terminal) return { ok: false, reason: 'terminal' };
  const actors = EDGES[from][to];
  if (!actors) return { ok: false, reason: 'no_edge' };
  if (!actors.includes(actor)) return { ok: false, reason: 'actor' };
  if (to === 'no_show' && now.getTime() < r.startAt.getTime() + minutes(policy.noShowGraceMinutes)) {
    return { ok: false, reason: 'too_early' };
  }
  if (actor === 'guest' && now.getTime() >= r.startAt.getTime()) return { ok: false, reason: 'too_late' };
  return { ok: true, from, to, tables: tableEffect(from, to) };
}

/** The last event on the reservation, as stored in ReservationEvent. */
export type LastEvent = { fromStatus: Status | null; toStatus: Status; at: Date; actor: Actor };

// Only the host's one-tap actions carry an undo (P0-9): seat, no-show,
// cancel, and the floor's two housekeeping taps — clearing a finished table
// and removing a waitlisted party who left. A mis-tap on either frees or
// drops a real party, so it gets the same 5 seconds.
const REVERTIBLE: readonly Status[] = ['seated', 'no_show', 'cancelled', 'completed', 'abandoned'];

/**
 * Undo is a logged revert back to the previous status, appended as its own
 * event — never a delete. Reverting a no-show or cancel re-acquires tables,
 * which the constraint may refuse if the table was re-booked meanwhile.
 */
export function revert(
  r: ReservationState,
  last: LastEvent,
  now: Date,
  policy: LifecyclePolicy = DEFAULT_POLICY,
): Decision {
  if (
    last.actor !== 'host' ||
    last.toStatus !== r.status ||
    last.fromStatus === null ||
    !REVERTIBLE.includes(last.toStatus)
  ) {
    return { ok: false, reason: 'not_revertible' };
  }
  if (now.getTime() - last.at.getTime() > policy.undoSeconds * 1000) return { ok: false, reason: 'undo_expired' };
  return { ok: true, from: r.status, to: last.fromStatus, tables: tableEffect(r.status, last.fromStatus) };
}

/** `Reservation.status` is plain text in the DB; this is the only way in. */
export function parseStatus(s: string): Status {
  if ((STATUSES as readonly string[]).includes(s)) return s as Status;
  throw new Error(`unknown reservation status: ${JSON.stringify(s)}`);
}
