// Outbound message templating and delivery state (P0-5). Pure: the caller
// supplies the instant, the timezone, the token-bearing link and the template.
//
// The rendered body is what gets stored and sent — the snapshot rule extends
// to messages (CLAUDE.md). Nothing re-renders a stored message from a
// template, so a template edit after booking can never rewrite history.

/**
 * `confirmation` is sent on booking, one per reservation. The rest are
 * replies to an inbound text (P0-6, Appendix A), one per inbound message.
 */
export const MESSAGE_KINDS = [
  'confirmation',
  'confirmed',
  'cancelled',
  'change_link',
  'choose',
  'no_reservation',
  'unrecognised',
  'help',
  'opted_out',
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** `queued → sent → delivered | failed`; a send the provider refuses outright goes `queued → failed`. */
export const DELIVERY_STATUSES = ['queued', 'sent', 'delivered', 'failed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

const NEXT: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  queued: ['sent', 'failed'],
  sent: ['delivered', 'failed'],
  delivered: [],
  failed: [],
};
export const canDeliver = (from: DeliveryStatus, to: DeliveryStatus) => NEXT[from].includes(to);

/** Documented in the outgoing text itself (P0-6). V-007 parses exactly these. */
export const REPLY_KEYS = 'Reply C to confirm, X to cancel, CHANGE to change.';

export const SLOTS = ['restaurant', 'date', 'time', 'party', 'link', 'replyKeys', 'bookLink', 'phone', 'count', 'choices'] as const;
export type Slots = Partial<Record<(typeof SLOTS)[number], string>>;
export type Templates = Record<MessageKind, string>;

// Hyphens, not the PRD's em dashes: one "—" turns the whole text UCS-2 and
// shrinks a segment from 160 characters to 70.
export const DEFAULT_TEMPLATES: Templates = {
  confirmation: '{restaurant}: table for {party} on {date} at {time}. {replyKeys} Manage: {link}',
  confirmed: 'Confirmed - {party} on {date} at {time}. See you then. Reply X to cancel or CHANGE to reschedule.',
  cancelled: 'Cancelled - {date} at {time}. Thanks for letting us know. Book again anytime: {bookLink}',
  change_link: 'Change your {date} {time} booking here: {link} - your current table is held until you submit.',
  choose: 'You have {count} upcoming: {choices}. Reply with the number, then C or X.',
  no_reservation: "We don't see an upcoming reservation for this number. Book here: {bookLink}",
  unrecognised: 'Sorry - I only understand C (confirm), X (cancel), CHANGE, or HELP.',
  help: '{restaurant} reservations. Reply C to confirm, X to cancel, CHANGE to reschedule, STOP to opt out. Call {phone}.',
  opted_out: "You're opted out and won't get more texts. Your booking is unchanged - call {phone} to change it.",
};

/**
 * Fills `{slot}`s. An unknown or unsupplied slot is a template bug and throws
 * rather than sending a literal "{tiem}" or "undefined".
 */
export function render(template: string, slots: Slots): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = (SLOTS as readonly string[]).includes(name) ? slots[name as keyof Slots] : undefined;
    if (value === undefined) throw new Error(`Unknown template slot {${name}}`);
    return value;
  });
}

// GSM 03.38. Anything outside these two sets forces the whole message to UCS-2.
const GSM_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
const GSM_EXTENDED = new Set('\f^{}\\[~]|€'); // escape + char: two septets each

export const MAX_SEGMENTS = 2;
export const MAX_CHARS = 320;

/** SMS segments: GSM-7 is 160 septets alone or 153 per part; UCS-2 is 70 UTF-16 units alone or 67 per part. */
export function segments(body: string): number {
  const chars = [...body];
  const gsm = chars.every((c) => GSM_BASIC.has(c) || GSM_EXTENDED.has(c));
  const units = gsm ? chars.reduce((n, c) => n + (GSM_EXTENDED.has(c) ? 2 : 1), 0) : body.length;
  const [single, part] = gsm ? [160, 153] : [70, 67];
  return units <= single ? 1 : Math.ceil(units / part);
}

/** `date` and `time` slots for an instant, in the restaurant's timezone. */
export function whenSlots(startAt: Date, timezone: string): { date: string; time: string } {
  const fmt = (o: Intl.DateTimeFormatOptions) =>
    // ICU ≥72 puts U+202F before AM/PM, which is not GSM-7 and would halve the segment size.
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, ...o }).format(startAt).replace(/\u202f/g, ' ');
  return { date: fmt({ weekday: 'short', month: 'short', day: 'numeric' }), time: fmt({ hour: 'numeric', minute: '2-digit' }) };
}

/** Renders, then refuses anything over 2 segments / 320 chars rather than sending a third. */
export function renderMessage(template: string, slots: Slots): string {
  const body = render(template, slots);
  if ([...body].length > MAX_CHARS || segments(body) > MAX_SEGMENTS) {
    throw new Error(`Message is ${segments(body)} segments / ${[...body].length} chars; max ${MAX_SEGMENTS} / ${MAX_CHARS}`);
  }
  return body;
}

export type ConfirmationInput = {
  template: string;
  restaurant: string;
  timezone: string;
  startAt: Date;
  partySize: number;
  /** The tokenized manage URL — the caller mints the token. */
  link: string;
};

/**
 * The confirmation body, or a throw if it would exceed 2 segments / 320
 * chars. Throwing inside placement rolls the booking back: a restaurant name
 * or template too long to text is a config error to fix, not a booking that
 * silently goes unconfirmed.
 */
export function confirmationBody(i: ConfirmationInput): string {
  return renderMessage(i.template, {
    restaurant: i.restaurant,
    ...whenSlots(i.startAt, i.timezone),
    party: String(i.partySize),
    link: i.link,
    replyKeys: REPLY_KEYS,
  });
}
