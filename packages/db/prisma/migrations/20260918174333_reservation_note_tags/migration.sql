-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN     "note" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- ═══ HAND-WRITTEN ═══════════════════════════════════════════════════════════

-- V-005 snapshot fields (P0-3). The cap and the tag allowlist are the
-- database's, so a caller that skips placement's validation still cannot
-- store a 141-char note or an unknown tag kind.
ALTER TABLE "Reservation"
  ADD CONSTRAINT reservation_note_max_140 CHECK (char_length("note") <= 140),
  ADD CONSTRAINT reservation_tags_known CHECK ("tags" <@ ARRAY['allergy', 'occasion', 'accessibility']::text[]);
