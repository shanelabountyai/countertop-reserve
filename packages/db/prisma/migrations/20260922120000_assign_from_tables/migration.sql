-- V-017 (P0-14): manual assignment.
--
-- A host moving a party between tables changes no STATUS — a `seated` party
-- stays seated, a `booked` one stays booked — so the existing undo, which
-- reverts a status edge, has nothing to grip. The undo of a move has to put
-- the tables back, and the append-only event log is the only place that
-- records where they were.
--
-- Empty on every other event. Non-empty is what marks a move: every status a
-- party can be moved out of holds tables, so a move always has a previous
-- unit to name.
ALTER TABLE "ReservationEvent"
  ADD COLUMN "fromTableIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
