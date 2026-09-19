-- V-010 (P0-9): the host floor view — walk-ins, the waitlist, "table ready".
-- Hand-written: every change here is a constraint or loosens one.

-- A walk-in need not give a number; a waitlisted party gives one only if they
-- want the "table ready" text. No number, no consent: nothing can be queued
-- to a guest we cannot reach.
ALTER TABLE "Reservation" ALTER COLUMN "guestPhone" DROP NOT NULL;
ALTER TABLE "Reservation"
  ADD CONSTRAINT reservation_consent_needs_phone CHECK ("smsConsent" IS NULL OR "guestPhone" IS NOT NULL);

-- The wait the host quoted a waitlisted party, as said ("20-35 min") — a
-- snapshot, never recomputed from tonight's floor.
ALTER TABLE "Reservation" ADD COLUMN "quotedWait" TEXT;

-- A waitlisted party has no table yet, and one who left never got one. The
-- statuses mirror lifecycle.ts: the two that sit outside table inventory
-- without ever having held any.
ALTER TABLE "Reservation"
  DROP CONSTRAINT reservation_has_tables,
  ADD CONSTRAINT reservation_has_tables CHECK (cardinality("tableIds") > 0 OR "status" IN ('waitlisted', 'abandoned'));

-- The list mirrors MESSAGE_KINDS in packages/core. `table_ready` is owned by
-- the reservation, so (reservationId, kind) unique gives one per party.
ALTER TABLE "OutboundMessage"
  DROP CONSTRAINT outbound_kind_known,
  ADD CONSTRAINT outbound_kind_known CHECK ("kind" IN (
    'confirmation', 'reminder', 'released', 'confirmed', 'cancelled',
    'change_link', 'choose', 'no_reservation', 'unrecognised', 'help',
    'opted_out', 'table_ready'));
