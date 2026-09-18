-- V-008: the deadline sweep's two reservation-owned kinds. Hand-written — no
-- schema change, only the CHECK. `reminder` and `released` are owned by the
-- reservation, so the existing (reservationId, kind) unique gives one each.

-- The list mirrors MESSAGE_KINDS in packages/core.
ALTER TABLE "OutboundMessage"
  DROP CONSTRAINT outbound_kind_known,
  ADD CONSTRAINT outbound_kind_known CHECK ("kind" IN (
    'confirmation', 'reminder', 'released', 'confirmed', 'cancelled',
    'change_link', 'choose', 'no_reservation', 'unrecognised', 'help',
    'opted_out'));
