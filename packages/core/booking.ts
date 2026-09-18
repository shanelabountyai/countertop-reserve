// Guest-supplied booking fields (P0-3). Placement is a trust boundary for
// these — the web form validates with the same functions, but the server
// never relies on it. The database repeats the note cap and the tag allowlist
// as CHECKs.

export const NOTE_MAX = 140;
export const TAG_KINDS = ['allergy', 'occasion', 'accessibility'] as const;
export type TagKind = (typeof TAG_KINDS)[number];

/** E.164: "+", a non-zero country digit, 15 digits max in total. */
export const isE164 = (phone: string) => /^\+[1-9]\d{1,14}$/.test(phone);

export type GuestFields = { guestName: string; guestPhone: string; note?: string; tags?: readonly string[] };
export type InvalidField = 'guestName' | 'guestPhone' | 'note' | 'tags';

/** The first field that fails, or null. */
export function invalidGuestField(g: GuestFields): InvalidField | null {
  if (g.guestName.trim() === '') return 'guestName';
  if (!isE164(g.guestPhone)) return 'guestPhone';
  // Code points, not UTF-16 units — the same count as Postgres char_length.
  if (g.note !== undefined && [...g.note].length > NOTE_MAX) return 'note';
  if (g.tags?.some((t) => !(TAG_KINDS as readonly string[]).includes(t))) return 'tags';
  return null;
}
