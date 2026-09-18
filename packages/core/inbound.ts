// The inbound SMS grammar and what a reply does (P0-6, PRD Appendix B). Pure:
// the caller supplies the number's upcoming reservations, the last inbound
// from that number, and `now`.
//
// The body is hostile. It is never interpolated into a reply or a query; it
// maps onto a closed set of keywords, and anything else is `unknown`. Free-text
// time parsing is out of scope — CHANGE always bounces to the manage link.

import { transition, type Decision, type Status } from './lifecycle';

export type Keyword = 'stop' | 'start' | 'help' | 'confirm' | 'cancel' | 'change';
export type Intent = { keyword: Keyword } | { choice: number } | { unknown: true };

// Appendix B's table, in its precedence order (STOP first, so an opt-out works
// whatever else is going on).
const KEYWORDS: [Keyword, readonly string[]][] = [
  ['stop', ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'UNSUB', 'CANCELALL', 'QUIT', 'END']],
  ['start', ['START', 'UNSTOP']],
  ['help', ['HELP', 'INFO']],
  ['confirm', ['C', 'Y', 'YES', 'CONFIRM', 'OK']],
  ['cancel', ['X', 'N', 'NO', 'CANCEL']],
  ['change', ['CHANGE', 'RESCHEDULE', 'MOVE']],
];

/** Case-, whitespace- and punctuation-insensitive; NFKC folds full-width "ＳＴＯＰ" to STOP. */
export function parseReply(body: string): Intent {
  const word = body.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();
  for (const [keyword, words] of KEYWORDS) if (words.includes(word)) return { keyword };
  if (/^[1-9]$/.test(word)) return { choice: Number(word) };
  return { unknown: true };
}

/** What happened with an inbound message — stored on its row, and the thread's state. */
export const INBOUND_OUTCOMES = [
  'opted_out',
  'opted_in',
  'help',
  'confirmed',
  'cancelled',
  'change_link',
  'choose',
  'selected',
  'no_reservation',
  'unrecognised',
  'handoff',
] as const;
export type InboundOutcome = (typeof INBOUND_OUTCOMES)[number];

/** A disambiguation, and the selection that answers it, last this long. */
export const CHOICE_WINDOW_MS = 5 * 60_000;
/** Digits 1–9 are the only selectors, so at most nine choices are offered. */
export const MAX_CHOICES = 9;

/** The previous inbound from the same number, as stored. */
export type LastInbound = { outcome: InboundOutcome; receivedAt: Date; reservationId: string | null; choices: readonly string[] };
export type UpcomingReservation = { id: string; status: Status; startAt: Date };

export type InboundAction =
  | { outcome: 'opted_out' | 'opted_in' | 'help' | 'no_reservation' | 'unrecognised' | 'handoff' }
  | { outcome: 'choose'; choices: string[] }
  | { outcome: 'selected' | 'change_link'; reservationId: string }
  /** `transition` may be `no_change` (a second "C"); the reply is the same. */
  | { outcome: 'confirmed' | 'cancelled'; reservationId: string; transition: Decision & { ok: true } };

/**
 * `upcoming` is the number's reservations still ahead of the guest (UPCOMING
 * statuses, start after `now`), earliest first.
 */
export function decideInbound(
  intent: Intent,
  upcoming: readonly UpcomingReservation[],
  last: LastInbound | null,
  now: Date,
): InboundAction {
  const within = (l: LastInbound | null, outcome: InboundOutcome): l is LastInbound =>
    l?.outcome === outcome && now.getTime() - l.receivedAt.getTime() <= CHOICE_WINDOW_MS;

  const picked = 'choice' in intent && within(last, 'choose') ? last.choices[intent.choice - 1] : undefined;
  if (picked) return { outcome: 'selected', reservationId: picked };
  if (!('keyword' in intent)) {
    // One clarifying reply, then a human — never a bot looping at a guest.
    return { outcome: last?.outcome === 'unrecognised' || last?.outcome === 'handoff' ? 'handoff' : 'unrecognised' };
  }

  const { keyword } = intent;
  if (keyword === 'stop') return { outcome: 'opted_out' };
  if (keyword === 'start') return { outcome: 'opted_in' };
  if (keyword === 'help') return { outcome: 'help' };

  // A selection answers the next message only, and only while it is still upcoming.
  const selected = within(last, 'selected') ? upcoming.find((r) => r.id === last.reservationId) : undefined;
  const target = selected ?? (upcoming.length === 1 ? upcoming[0] : undefined);
  if (!target) {
    if (upcoming.length === 0) return { outcome: 'no_reservation' };
    return { outcome: 'choose', choices: upcoming.slice(0, MAX_CHOICES).map((r) => r.id) };
  }

  if (keyword === 'change') return { outcome: 'change_link', reservationId: target.id };
  const to = keyword === 'confirm' ? 'confirmed' : 'cancelled';
  const d = transition(target, to, 'guest', now);
  if (d.ok) return { outcome: to, reservationId: target.id, transition: d };
  if (d.reason === 'no_change') return { outcome: to, reservationId: target.id, transition: { ok: true, from: to, to, tables: 'keep' } };
  // Unreachable for an upcoming reservation before its start; if the lifecycle
  // grows a rule that refuses it, the guest hears "nothing to act on", not a 500.
  return { outcome: 'no_reservation' };
}
