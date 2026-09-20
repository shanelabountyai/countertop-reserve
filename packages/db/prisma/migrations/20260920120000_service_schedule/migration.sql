-- V-011 (P0-10): service periods, per-date overrides, blackouts and pacing.
-- Hand-written: every statement below is a constraint, or the seed of the one
-- restaurant's opening hours.

CREATE TABLE "ServicePeriod" (
  -- No DB default: Prisma's @default(uuid()) mints it client-side, same as
  -- every other uuid id here. A DB default would read as drift.
  "id"                UUID PRIMARY KEY,
  "weekday"           INTEGER,
  "day"               TEXT,
  "name"              TEXT    NOT NULL,
  "openMinute"        INTEGER NOT NULL,
  "closeMinute"       INTEGER NOT NULL,
  "lastSeatingMinute" INTEGER,
  "pacingCap"         INTEGER NOT NULL
);

CREATE INDEX "ServicePeriod_weekday_idx" ON "ServicePeriod" ("weekday");
CREATE INDEX "ServicePeriod_day_idx" ON "ServicePeriod" ("day");

-- A row is EITHER a weekly period or a single-date override. Both set, or
-- neither, is a row the loader cannot place.
ALTER TABLE "ServicePeriod"
  ADD CONSTRAINT service_period_weekly_xor_override CHECK (("weekday" IS NULL) <> ("day" IS NULL)),
  ADD CONSTRAINT service_period_weekday_range CHECK ("weekday" IS NULL OR "weekday" BETWEEN 0 AND 6),
  -- A restaurant-calendar day, never a Postgres `date` (CLAUDE.md).
  ADD CONSTRAINT service_period_day_format CHECK ("day" IS NULL OR "day" ~ '^\d{4}-\d{2}-\d{2}$'),
  ADD CONSTRAINT service_period_name_present CHECK (length(btrim("name")) > 0),
  -- The engine walks 15-minute slots FROM openMinute, so an 11:35 open would
  -- put every slot of that period off the grid a booking link can name.
  ADD CONSTRAINT service_period_on_grid CHECK (
    "openMinute" % 15 = 0 AND "closeMinute" % 15 = 0 AND COALESCE("lastSeatingMinute", 0) % 15 = 0),
  ADD CONSTRAINT service_period_window CHECK (
    "openMinute" >= 0 AND "closeMinute" > "openMinute" AND "closeMinute" <= 1440),
  -- Last seating is a START time: at close it could never be offered.
  ADD CONSTRAINT service_period_last_seating_inside CHECK (
    "lastSeatingMinute" IS NULL OR ("lastSeatingMinute" >= "openMinute" AND "lastSeatingMinute" < "closeMinute")),
  ADD CONSTRAINT service_period_pacing_positive CHECK ("pacingCap" > 0);

-- Overlapping periods would offer the shared slots twice, each carrying its
-- own pacing cap — so the same mechanism as the allocation constraint, not an
-- application check. btree_gist (V-003) is what lets an int and a text sit in
-- a gist index beside the range.
ALTER TABLE "ServicePeriod"
  ADD CONSTRAINT service_period_weekly_no_overlap
    EXCLUDE USING gist ("weekday" WITH =, int4range("openMinute", "closeMinute") WITH &&)
    WHERE ("weekday" IS NOT NULL),
  ADD CONSTRAINT service_period_override_no_overlap
    EXCLUDE USING gist ("day" WITH =, int4range("openMinute", "closeMinute") WITH &&)
    WHERE ("day" IS NOT NULL);

CREATE TABLE "Blackout" (
  "day"    TEXT PRIMARY KEY,
  "reason" TEXT
);

ALTER TABLE "Blackout"
  ADD CONSTRAINT blackout_day_format CHECK ("day" ~ '^\d{4}-\d{2}-\d{2}$');

-- Firebird Kitchen's opening hours. Single-tenant configuration, not test
-- data: without it a fresh database is a restaurant that never opens, and the
-- host screen is where it is edited from here on. Noted in WRITEUP.md.
INSERT INTO "ServicePeriod" ("id", "weekday", "name", "openMinute", "closeMinute", "lastSeatingMinute", "pacingCap")
SELECT gen_random_uuid(), d, 'Lunch', 690, 870, NULL, 12 FROM generate_series(0, 6) AS d;
INSERT INTO "ServicePeriod" ("id", "weekday", "name", "openMinute", "closeMinute", "lastSeatingMinute", "pacingCap")
SELECT gen_random_uuid(), d, 'Dinner', 1020, 1320, 1245, 20 FROM generate_series(0, 6) AS d;
