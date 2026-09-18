# Progress Log — Countertop Reserve

Mechanical build log, one entry per backlog item: what it built, what it
decided, what it left behind. Pair with `docs/RELEASE_NOTES.md` for the
portfolio-facing version of the same history.

---

## V-001 — Monorepo scaffold, CI, and the four docs

**Built:**
- `apps/web`: Next.js 16.3.3 (App Router) + TypeScript + Tailwind v4, same
  versions as Countertop's own scaffold (known to work together). **Port
  3500 is baked into the `dev`/`start` scripts and into
  `playwright.config.ts`'s default** — never passed as `PORT=` on the command
  line.
- `packages/core`: `package.json` + an empty `index.ts` naming which session
  fills each export, and one scaffold test so the two CI timezone passes run
  a real suite rather than reporting green on zero tests.
- `packages/db`: Prisma client singleton, `schema.prisma` with datasource +
  generator only — no models yet. **Default Prisma client output from day
  one** (no custom `output` path) — Countertop generated its client into
  `packages/db/generated/client`, which made the client unexcludable from
  Turbopack's bundle and cost three failed deploys before C-045 reverted it
  to the default. That fix is inherited here as the starting point, not
  rediscovered.
- `packages/db/prisma/migrations/migration_lock.toml` committed with zero
  migrations present. Also inherited rather than rediscovered: Countertop's
  own C-001 shipped without this file, and its drift-check CI step failed on
  the very first run because Prisma has no connector to diff against an
  empty migrations directory.
- ESLint: `eslint-rules/no-time-axis.mjs`, copied from Countertop's
  *current* (C-003-refined) version rather than its original C-001
  version — the refined one exempts `new Date(Date.UTC(...))`, the one
  argument form every frozen-`now` test needs, so no test file here will
  ever need an `eslint-disable` for it.
- Playwright + `@axe-core/playwright`, `workers: 1`, production build by
  default (`e2e:server` = build + start), `E2E_DEV=1` as the escape hatch.
  Two smoke specs: the app serves on 3500, and the landing page has zero axe
  violations at WCAG 2.1 AA.
- `.github/workflows/ci.yml`: throwaway Postgres, `prisma migrate deploy`
  from scratch, `prisma migrate diff --exit-code` drift check, an assertion
  that the (default-location) Prisma client actually got generated, the unit
  suite twice (`TZ=UTC` and `TZ=Pacific/Kiritimati`), a production build step
  of its own (Countertop only added this at C-024, after two build-only
  failures slipped past a green `tsc`/ESLint/unit gate — built in from the
  start here), then the e2e leg on 3500.
- Local databases `reserve_dev` / `reserve_test` on the brew-managed
  Postgres cluster, with `.env.local` / `.env.test` (both gitignored) wired
  through the `dotenv -e .env.test -e .env.local` first-file-wins pattern,
  and `?connection_limit=10&pool_timeout=20` on both from the start
  (`~/.claude/CLAUDE.md` "Cap the connection pool per project").
- `docs/`: this file, `RELEASE_NOTES.md`, `WRITEUP.md`. `backlog.md` already
  existed from the V-000 kickoff commit (V-001 → V-013, derived from the
  PRD's Timeline / Phasing section).

**Verified locally:** `npm run gate` — lint clean, typecheck clean, unit
1/1 passed, production build clean, e2e 2/2 passed. Full output not
reproduced here; the reconciled counts are the record.

**Decided:**
- **Reused Countertop's proven C-001 file shapes rather than running
  `create-next-app` fresh.** Every config file here (next.config.ts,
  playwright.config.ts, the ESLint wiring, the workspace package.jsons) is a
  known-working template adapted for this project's names and port, not a
  fresh scaffold re-litigating decisions Countertop already made and tested.
- **Skipped the pre-push hook and `ci-local.sh`.** Countertop added those at
  C-033/C-035 to work around a GitHub Actions billing block on private
  repos. This repo hit an *account-level* billing failure on its first push
  (see below) and went public instead, which is the cheaper fix while there
  is no self-hosted runner's exposure to weigh against it — CLAUDE.md's gate
  command covers the same ground locally in the meantime.
- **No `STAFF_PASSCODE` / staff-auth scaffolding.** Countertop's C-037 added
  that once a `/kitchen` route existed to protect. This project's equivalent
  (the host floor view) doesn't exist until V-010 — nothing to gate yet.
- **Repo made public, same day as creation.** The first CI push (private)
  failed with a GitHub billing annotation — "recent account payments have
  failed or your spending limit needs to be increased" — an account-level
  payment problem, not a code or config defect (local `npm run gate` had
  already passed clean before this push). Made public rather than waiting on
  a billing fix, same lever Countertop used at C-044: public repos get free
  GitHub-hosted Actions minutes regardless of the payment method's state.
  Unlike Countertop, there is no self-hosted runner in this repo to worry
  about deregistering — V-001 never built one, so there was nothing for
  going public to make unsafe. Re-run via `workflow_dispatch` after the
  flip: green — lint, typecheck, unit ×2 timezones, drift check, build,
  e2e 2/2.

**Left behind:**
- **No `.env.production.local` / deploy story.** Deployment is out of scope
  until the PRD's own backlog reaches it (there is no V-item for it yet,
  unlike Countertop's C-045) — this project may not need a deploy target at
  all if it never leaves demo/portfolio use.

V-001 committed at acd82b4.

---

## V-002 — Floor plan model + availability engine

**Built** (`packages/core`, pure, no database, no clock):
- `floor-plan.ts` — `Table` (seats, min party, section), declared
  `Combination` (member table ids + seats + min party), `FloorPlan` with an
  over-seat cap (default 2). `fittingUnits(plan, party)` returns every legal
  unit best-first: least waste, single table before combination, then id.
  `turnMinutes(party, bands)` is the one turn-time function (PRD default
  75/90/120).
- `availability.ts` — `availability({ day, partySize, plan, schedule,
  reservations, now })`. Slots every 15 minutes across the day's service
  periods; each slot is either bookable with its free units in preference
  order, or not bookable with a reason (`past`, `closed`, `full`,
  `pacing`). The day gets a reason too when nothing is bookable
  (`too_large`, `too_small`, `closed`, or the most useful slot reason).
  `periodsFor` resolves blackout → per-date override → weekly.
- `time.ts` — `zonedTimeToInstant` and `weekdayOf`, carried from
  Countertop's `business-day.ts`.
- 26 unit tests, the fixture matrix hand-calculated in the test file: the
  last table, a combination-only fit, a pacing-blocked bucket with tables
  free, a blackout date, a party larger than the largest unit, a turn that
  overhangs close (and the explicit last-seating override), half-open turn
  boundaries, the snapshotted-turn rule, past slots. Passes identically
  under `TZ=UTC` and `TZ=Pacific/Kiritimati`.

**Decided:**
- **Occupancy is checked per table, never per unit.** A combination's
  "busy" test is that *every* member table is free, so a deuce booked on T2
  blocks the T1+T2 four-top, and a booked combination blocks each of its
  halves.
- **Held reservations use their own snapshotted `turnMinutes` and
  `tableIds`**, never recomputed from today's bands or floor plan.
- **Last seating:** when a period sets `lastSeatingMinute`, starts up to it
  are offered even if the turn overhangs close; otherwise the turn must end
  by close. Satisfies both PRD lines (P0-2 overhang, P0-10 "explicit
  config").
- **Two reasons beyond the PRD's four:** `past` (a slot at or before `now`)
  and `too_small` (no unit's min party admits the party). Saying `too_large`
  to a party of one would be untrue, and the PRD's rule is that the reason
  has to be true.
- **Pacing counts covers whose start falls in the slot's own
  `[start, start+15m)` window**, and the cap is inclusive (6 + 2 = 8 fits a
  cap of 8).

**Left behind:**
- The caller decides which reservations hold tables. V-004's status module
  becomes the single source of that list.
- No floor-plan validation (for example, a combination naming an unknown
  table). V-003's foreign keys enforce it at the data layer.
- No DST-transition-date fixture (`ponytail:` note in `time.ts`).

V-002 committed at 448f0a0.

## V-003 — Data model + hand-written migrations

**Built** (`packages/db`, migration `20260918173221_reservation_model`):
- Floor plan: `DiningTable`, `Combination`, `CombinationMember` (FK to the
  table is `Restrict`, so a table a combination names cannot vanish).
- `Reservation` — every display column is a copy taken at booking:
  `startAt`, `partySize`, `turnMinutes`, `tableIds[]`, guest name and phone,
  `businessDay` as a restaurant-timezone string. It produces V-002's
  `HeldReservation` directly. `idempotencyKey` is unique.
- `TableHold` — live inventory, one row per (reservation, table), carrying
  `[startAt, endAt)`. A combination writes one row per member table.
- `ReservationEvent` — append-only (trigger refuses UPDATE and DELETE;
  TRUNCATE is left open for test reset, same as Countertop).
- Hand-written: `btree_gist`, the exclusion constraint, CHECKs (positive
  party and turn, `endAt > startAt`, at least one table), the trigger.
  The drift check is clean: Prisma ignores the exclusion constraint and the
  extension, so the schema and the migration history still agree.
- `packages/db/constraints.test.ts`, 9 tests against local Postgres:
  overlap refused, an overlap that starts *earlier* refused, back-to-back
  turns allowed (half-open), a combination whose half is held refused with
  no partial hold left behind, 8 concurrent bookings on the last table give
  exactly 1 win, deleting holds frees the table immediately, a zero-length
  hold refused, a duplicate idempotency key refused, and the event log
  refuses UPDATE and DELETE.

**Decided (schema review, 2026-09-18):**
- **An exclusion constraint, not a literal `UNIQUE(table, turn window)`.**
  `EXCLUDE USING gist ("tableId" WITH =, tstzrange("startAt","endAt",'[)')
  WITH &&)`. Turns vary by party size (75/90/120, operator-configurable), so
  overlapping windows are not *equal* windows and a unique index cannot see
  the collision. Rejected: one row per (table, 15-minute bucket) under a
  UNIQUE. It is literal, but it writes 6+ rows per table per turn, rounds
  turns to the grid, and forces walk-ins onto the grid. The violation is
  SQLSTATE 23P01, which V-005 maps to a clean refusal.
- **Pacing cap: an advisory lock per (day, bucket)** inside the booking
  transaction (to be implemented in V-005). A sum across rows cannot be a
  constraint, so two bookings on different tables could both pass the check
  and overshoot. The lock serializes only same-bucket bookings. This is the
  one deliberate check-then-write, and it guards pacing, not table
  inventory. Rejected: a soft cap with a documented overshoot.
- **Release deletes the hold rows** in the same transaction as the status
  event, so no partial-index predicate on a status column is needed, and a
  released table is inventory the instant that commits. The reservation
  keeps its `tableIds` snapshot for history.
- **`status` is plain text for now.** V-004's lifecycle module is the one
  list, and a DB enum would be a second one.

**Left behind:**
- No settings or schedule tables. Service periods, turn bands and the
  timezone stay config until P0-10's hours editor needs them in the DB.
- No inbound/outbound message tables. V-006 and V-007 add them with the
  provider-message-id unique constraint.


V-003 committed at 2d136c8.

## V-004 — Reservation lifecycle state machine

**Built** (`packages/core/lifecycle.ts`, pure, `now` is a parameter):
- `STATUSES` plus a `TRAITS` record (`holdsTables`, `upcoming`, `showed`,
  `terminal`) and an `EDGES` record (from → to → which actors may drive it).
  Both are `Record<Status, …>`, so a new status does not compile until it is
  classified and given its edges. The reader lists (`HOLDS_TABLES`,
  `UPCOMING`, `SHOWED`, `TERMINAL`) are derived from `TRAITS`, never written
  out by hand. The availability engine's `HeldReservation` doc now points at
  `HOLDS_TABLES`.
- `transition(r, to, actor, now, policy)` returns `{ok, from, to, tables}`
  or `{ok:false, reason}`. The reasons are `no_change`, `terminal`,
  `no_edge`, `actor`, `too_early` (no-show inside the grace period),
  `too_late` (a guest confirm or cancel at or after the start). `tables` is
  `keep | release | acquire | none`, derived from `holdsTables` on either
  side, so V-005/V-008/V-010 know whether to delete or allocate `TableHold`
  rows in the same transaction.
- `revert(r, lastEvent, now, policy)` is the logged undo for the host's
  seat, no-show and cancel inside `undoSeconds` (5). It goes back to the
  event's `fromStatus`. It refuses guest and system events, and refuses a
  stale event whose status has moved on.
- `parseStatus` is the only way in from the plain-text DB column.
- `plusMs` was added to `time.ts`, so the `new Date(<ms>)` lint exception
  stays in one file.
- Tests: all 9×9×3 `(from, to, actor)` triples are checked against a
  hand-written VALID list taken from the PRD, not derived from the module.
  15 invalid transitions are asserted by reason, plus both boundary minutes,
  the table effects, the derived lists, and revert. Mutation-checked: adding
  `confirmed → released` fails two tests.

**Decided:**
- **`released` only from `booked`.** The PRD's P0-4 state line says
  `booked|confirmed → released`, but P0-7 releases *unconfirmed*
  reservations. Auto-releasing a guest who replied C would be the defect.
  P0-7 wins.
- **`released` is terminal.** Rebooking is a new booking with a new
  allocation (PRD Open Question, resolved: V1 yes via the re-book link).
- **The actor is part of the edge.** The inbound SMS is a trust boundary, so
  the lifecycle itself refuses a guest seating or no-showing themselves. It
  does not rely on the webhook handler to remember.
- **Guests cannot confirm or cancel at or after the start time.** Past that
  point it is the host's call: seat, or no-show after the grace period.
- `noShowGraceMinutes` defaults to 15, and is a policy value, not a constant.

**Left behind:**
- The confirmation-deadline check for `released` belongs to V-008. The
  lifecycle only restricts that edge to `system`.
- Seating a released guest who shows up anyway is a walk-in (new
  allocation), not an edge out of `released`. V-010 builds that.

V-004 committed at 4a38ff5.
