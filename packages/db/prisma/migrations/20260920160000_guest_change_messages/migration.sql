-- V-012 (P0-12): the guest booking flow's change-result texts.
-- Hand-written: both statements are constraints.

-- The list mirrors MESSAGE_KINDS in packages/core.
ALTER TABLE "OutboundMessage"
  DROP CONSTRAINT outbound_kind_known,
  ADD CONSTRAINT outbound_kind_known CHECK ("kind" IN (
    'confirmation', 'reminder', 'released', 'confirmed', 'cancelled',
    'change_link', 'change_confirmed', 'change_failed', 'choose',
    'no_reservation', 'unrecognised', 'help', 'opted_out', 'table_ready'));

-- (reservationId, kind) unique exists so a retry cannot text a guest twice
-- about the SAME thing: there is one confirmation, one reminder, one release,
-- one "table ready" per party. A change result is not that — it is per
-- change, and a guest may move twice. The index keeps its job for every
-- other kind and steps aside for these two. What stops a double-submit
-- texting twice is changeReservation's no-op guard, not this index.
DROP INDEX "OutboundMessage_reservationId_kind_key";
CREATE UNIQUE INDEX "OutboundMessage_reservationId_kind_key"
  ON "OutboundMessage" ("reservationId", "kind")
  WHERE "kind" NOT IN ('change_confirmed', 'change_failed');
