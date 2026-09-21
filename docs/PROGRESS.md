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

## V-005 — Booking placement, allocated under the constraint

**Built** (`packages/db/placement.ts`, `packages/core/booking.ts`):
- `placeReservation(req, config)`: guest-field validation, an idempotency
  replay, then one transaction. The transaction takes
  `pg_advisory_xact_lock(<start minute>)` (the pacing bucket), reads the
  floor plan and the `HOLDS_TABLES` reservations for the day *after* the
  lock, and runs `availability()`. It then tries each fitting unit in the
  engine's order under a `SAVEPOINT`. A `table_hold_no_overlap` violation
  rolls back to the savepoint and tries the next unit. When every unit is
  taken, it returns `no_longer_available`. The reservation, its holds and
  the `booked` event commit together or not at all.
- Refusals carry the engine's reasons (`past`, `closed`, `full`, `pacing`,
  `too_large`, `too_small`), plus `no_longer_available` and
  `invalid` + field. An off-grid time is `closed`.
- `booking.ts` (pure): `isE164`, `NOTE_MAX` (140, counted in code points to
  match Postgres `char_length`), `TAG_KINDS`, and `invalidGuestField`. The
  web form (V-012) will import the same functions.
- Migration `reservation_note_tags`: `note` and `tags` columns, plus CHECKs
  for the note cap and the tag allowlist.
- `placement.test.ts`, 16 tests: the full snapshot plus holds plus event, a
  combination holding both members, engine refusals that write nothing, five
  invalid fields, an emoji note at the cap, 8 concurrent bookings on the last
  table (1 reservation, 7 `full`, 1 hold, 1 event), 5 pairwise-overlapping bookings
  in *different* buckets (exactly one wins), a deterministic 23P01 path (both
  "refused, no orphan" and "fell through to the next unit"), pacing under
  concurrency (5 deuces, cap 4, 2 booked), and sequential and concurrent
  double-submits returning the same body.
- Mutation-checked: removing the advisory lock failed the pacing test in 3
  of 3 runs.

**Decided:**
- **The floor plan is read from the DB inside the transaction; the schedule,
  over-seat cap and turn bands stay config** (`PlacementConfig`) until V-011
  puts them in tables.
- **Tags are kinds only.** Details go in the note. See WRITEUP.
- **The lock key is the slot's start minute**, because slots sit on the
  15-minute grid, so a bucket is one start instant. The single-key form is
  used because nothing else here takes advisory locks. A change request
  (V-007) must take the same lock for its new bucket.
- **An idempotency replay returns the stored row without comparing the
  request** (`ponytail:` in placement.ts).

**Left behind:**
- No consent capture (V-009) and no confirmation message (V-006).
- No web route yet. V-012 wires the guest form to `placeReservation`, and
  V-010 wires host bookings (`source: 'host'`).


V-005 committed at 3d9fa06.
Fixture fix (CI-found, see WRITEUP) at 55ffba2.

## V-006 — Confirmation text: outbound templates & delivery state

**Built** (`packages/core/messages.ts`, `packages/db/messages.ts`, placement):
- `messages.ts` (pure): `MESSAGE_KINDS` (`confirmation`),
  `DELIVERY_STATUSES` with `canDeliver`, `REPLY_KEYS` (the text V-007 will
  parse), `DEFAULT_TEMPLATES`, `render` over six named slots (restaurant,
  date, time, party, link, replyKeys) that throws on an unknown slot,
  `segments` (GSM-7 basic + extension table, else UCS-2), and
  `confirmationBody`, which formats date and time in the restaurant timezone
  and throws above 2 segments or 320 chars.
- `placeReservation` mints a 128-bit base64url `manageToken`, renders the
  confirmation, and creates a `queued` `OutboundMessage` in the booking's
  own transaction. A replay returns before that point. A body too long to
  text throws, so the booking rolls back with it.
- `db/messages.ts`: the `MessageProvider` interface, `mockProvider`
  (records sends, refuses listed numbers), `dispatchQueued` (claims `queued`
  rows with `FOR UPDATE SKIP LOCKED`, moves each to `sent` + provider id or
  `failed` + reason) and `recordDelivery` (the carrier callback, a
  conditional update from `sent` only, so a redelivery is a no-op).
- Migration `outbound_message`: the table, UNIQUE `(reservationId, kind)`,
  UNIQUE `providerMessageId`, CHECKs for kind, status, body ≤ 320, "sent
  needs a provider id" and "failed needs a reason". `manageToken` is added
  nullable, backfilled, then made NOT NULL, so it applies over existing rows.
- Tests: 34 in `messages.test.ts` (segment boundaries at 160/161/306/307 and
  70/71/134/135, extension chars, a single U+202F forcing UCS-2, the body
  in LA time under any process TZ, over-length refusals, all 16 delivery
  transitions). 13 new in `placement.test.ts`: queued with the booking,
  unique tokens, replay and concurrent double-submit queue one each,
  refusals queue nothing, over-length rolls back, a second confirmation is
  refused by the DB, the snapshot regression (edit template, restaurant
  name, turn bands and floor plan, then dispatch: the old row sends its
  stored body byte-for-byte), and the delivery paths including concurrent
  dispatchers and a redelivered callback.
- Mutation-checked: removing `FOR UPDATE SKIP LOCKED` made 4 dispatchers
  send 12 texts for 3 messages. The first version of that test could not
  fail, because the mock answered too fast to open the race; it now uses a
  50 ms carrier.

**Decided:**
- **The rendered body lives on `OutboundMessage`, not on `Reservation`.**
  One row per (reservation, kind) is both the snapshot and the idempotency
  key. The PRD says "on the reservation"; the row belongs to it.
- **Templates are config (`PlacementConfig.templates`) until P1-7's editor.**
  Nothing reads a template after rendering, so moving them into a table
  later changes no history.
- **The manage link is `${manageBaseUrl}/${token}`** and the token is the
  only credential. V-012 builds the page.
- **Delivery is at-most-once per row.** The provider call runs inside the
  claiming transaction (`ponytail:` in `db/messages.ts`).

**Left behind:**
- Reminders (T-24h / T-3h same-day) moved to V-008, which owns the sweep.
- The failed-send badge on the host's row moved to V-010.
- STOP, quiet hours and the rate limit are V-009. Dispatch does not check
  opt-out yet.
- Nothing calls `dispatchQueued` on a schedule yet; V-008's sweep will.



V-006 committed at a29273d.

## V-007 — Change and cancel by reply: the inbound webhook

**Built:**
- `core/inbound.ts` (pure): `parseReply` implements Appendix B's allowlist
  in its precedence order (STOP words first). It applies NFKC, strips
  everything that is not a letter or a digit, and uppercases, so
  full-width "ＳＴＯＰ", "Yes!" and "stop all" all parse. Digits 1–9 parse as
  a choice, and anything else is `unknown`. `decideInbound(intent,
  upcoming, lastInbound, now)` returns the outcome: opt out/in, help,
  confirm/cancel (through `transition` with actor `guest`), change-link,
  choose (at most 9 choices), selected, no-reservation, unrecognised or
  handoff.
- `core/messages.ts`: eight reply kinds with Appendix A templates. `render`
  now throws on a slot that is unknown *or not supplied*. `whenSlots` and
  `renderMessage` (the ≤2-segment / ≤320-char check) are shared with the
  confirmation.
- `db/inbound.ts`: `verifySignature` (HMAC-SHA256 hex over the raw body,
  `timingSafeEqual`, length-checked first) and `parseInboundPayload`
  (E.164 `from`, `[\w.-]{1,128}` message id, string body). Then
  `handleInbound`, all in one transaction: a two-key advisory lock on the
  sender's number, the message-id check, the number's upcoming
  reservations locked `FOR UPDATE`, the decision, the append-only
  `InboundMessage` row, the transition with holds deleted on cancel and an
  `sms` event carrying `inboundMessageId`, and the queued reply.
- `db/placement.ts`: `changeReservation`. `allocate` was split into `fit`
  (bucket lock, reads, engine, with an optional reservation left out of
  the occupied set) and `firstUnit` (the per-unit savepoint loop), and
  booking and change share both.
- `app/api/sms/inbound/route.ts`: fails closed with 503 when
  `SMS_WEBHOOK_SECRET` is unset. Then a 413 over 16 KB, a 401 on a bad
  signature, a 400 on a bad payload, and otherwise the JSON result.
- Migration `inbound_message`: `InboundMessage` (BIGSERIAL id, UNIQUE
  provider id, CHECKs on outcome and body ≤ 1600, append-only trigger) and
  `SmsOptOut`. `OutboundMessage.reservationId` is now nullable and
  `inboundMessageId` is UNIQUE, with `outbound_one_owner` =
  `num_nonnulls(...) = 1`. `outbound_kind_known` was widened.
  `ReservationEvent.inboundMessageId` was added.
- Tests: `inbound.test.ts` in core has 63 cases (the grammar, the hostile
  bodies, the decision table, the 5-minute window at its boundary minute,
  and every template GSM-7 within 2 segments with nine choices). The DB
  `inbound.test.ts` has 31: the boundary, confirm/cancel, a sequential and
  an 8-way concurrent redelivery, a stale redelivery replaying rather than
  re-parsing, disambiguation, no reservation, CHANGE, unrecognised then
  handoff, STOP/START, the hostile body stored, append-only and one-owner,
  and the six change cases including a race and a refusal by the
  constraint. e2e `inbound-sms.spec.ts` covers 401 unsigned and
  mis-signed, 400 malformed, and 200 followed by a replay, all against the
  production build.
- Mutation-checked: deleting the old holds outside the savepoint, and
  dropping the self-exclusion in `fit`, are each killed by exactly one
  test.

**Decided:**
- **A reply belongs to the inbound message it answers, not to the
  reservation.** This follows NEXT.md's "revisit the `(reservationId,
  kind)` unique". A partial unique index would drift against Prisma, and a
  guest who texts C twice needs two replies. So each message has exactly
  one owner, and the unique constraint on `inboundMessageId` gives one
  reply per inbound.
- **The latest `InboundMessage` for a number is the conversation state.**
  That covers the pending choice, the selection and the first unrecognised
  body. No mutable thread table is needed, and the log itself is the
  evidence. Ordering uses the BIGSERIAL id, since the per-number lock
  makes insertion order the same as commit order.
- **A selection ("2") gets no reply.** The PRD shows "—" for it, and A9
  already told the guest "then C or X". A handoff also gets no bot reply.
  It shows up as an `InboundMessage` with outcome `handoff` for V-010's
  host view to surface.
- **"Unrecognised twice" means twice in a row**, and it stays handed off
  until something parses.
- **STOP is recorded here, not in V-009.** It is the first keyword in the
  grammar, so it is parsed and stored in `SmsOptOut` and acknowledged once
  (A14). A repeat STOP gets silence. After STOP, confirm and cancel still
  act, but their replies are not queued. The send-time check in dispatch
  is still V-009's job.
- **A14 is worded without {day} {time}**, because a STOP can come from a
  number with 0 or 2+ reservations: "Your booking is unchanged".
- **The templates use hyphens, not the PRD's em dashes.** A single "—"
  turns a text into UCS-2 (70 characters a segment).
- **A change keeps its status.** A confirmed guest who moves stays
  confirmed. The event is `from = to` with a `changed from …` note.
- **The webhook signature covers only the body.** A replayed signed
  request is harmless because handling is idempotent on the message id. The
  links in replies use the request's origin.

**Left behind:**
- The A5/A6 texts (change confirmed, change failed) go to V-012. Its manage
  page is the only caller of `changeReservation`, and it shows the result
  on screen.
- Nothing dispatches the queued replies on a schedule yet. That is V-008's
  sweep, as with V-006.
- The restaurant's name, timezone and phone are inline in the route
  (`ponytail:`) until V-011's config.
- **Deploy note:** the deployed environment needs `SMS_WEBHOOK_SECRET` set.
  Until it is, the webhook answers 503 (fail closed).



V-007 committed at a6593a5.

## V-008 — Confirmation deadline, auto-release, and reminders

**Built:**
- `core/sweep.ts` (pure): `releaseAt`/`shouldRelease` (P0-7) and
  `reminderAt`/`shouldRemind` (P0-5, A3), with `SweepPolicy` defaults
  T-3h / T-90m same-day for release and T-24h / T-3h for reminders.
  `releaseLead: 0` disables auto-release entirely. `core/time.ts` gained
  `dayOf(instant, tz)`, the instant → restaurant-calendar direction.
- `core/messages.ts`: `reminder` and `released` kinds with A3/A8 templates,
  GSM-7, covered by the existing every-template test.
- `db/sweep.ts`: `sweep(provider, config, now)` runs four passes, each
  committed on its own. (1) Release: `booked` rows past their deadline are
  claimed `FOR UPDATE SKIP LOCKED`, go through `transition(…, 'released',
  'system', now)`, and have their holds deleted plus a `system` event in the
  same transaction. (2) Release notices: released reservations with no
  notice yet. (3) Reminders. (4) `dispatchQueued`, so confirmations and
  inbound replies finally go out on a schedule.
- `app/api/cron/sweep/route.ts`: GET with `Authorization: Bearer
  $CRON_SECRET` (Vercel Cron's convention), fails closed with 503 when unset,
  401 on a wrong token, constant-time compare.
- Migration `sweep_message_kinds`: widens `outbound_kind_known`. Both new
  kinds are reservation-owned, so `(reservationId, kind)` unique gives one
  reminder and one notice per reservation.
- Tests: core `sweep.test.ts` (21 tests, hand-calculated deadlines, both
  boundary milliseconds, the 23:30-the-night-before case that a UTC "same
  day" gets wrong, the 6h confirm window at 5/6/7h). DB `sweep.test.ts` (9):
  no release at 15:59, release at 16:00 with holds gone and a walk-in into
  the freed table in the same session, confirmed untouched, 0 disables, two
  overlapping sweeps release once and notify once, notice sent once with the
  re-book link, STOP still releases but sends no notice, one reminder at
  T-24h exactly, the confirmation dispatched. e2e `sweep.spec.ts`: 401
  twice, then 200 twice against the production build.

**Decided:**
- **The notice is its own pass, not part of the release transaction.** A
  template that fails to render must not stop a table freeing, and a crash
  between the passes heals on the next sweep (it looks for released rows
  with no notice). Quiet hours (V-009) will defer the send in dispatch; the
  release is never deferred.
- **A booking made at or after its own deadline is never auto-released.**
  A guest booking at 6:30 for 7:00 was never given a window to confirm in;
  without this the next sweep would release them.
- **Once the start has passed, a `booked` row is the host's call** (seat or
  no-show), even if a stalled sweep never reached it.
- **"Same-day" is the restaurant calendar:** `dayOf(createdAt, tz) ===
  businessDay`.
- **The reminder uses the first lead the booking predates** — T-24h, else
  T-3h. The PRD says "T-3h for same-day"; this also covers a booking made
  the evening before, which would otherwise get no reminder at all. Field
  name `lateReminderLead` says what it is.
- **A3's "skipped if already confirmed and within 6h" = confirmed within
  6h before the reminder's due time.** Measured from the due time, not
  `now`, so a late sweep cannot turn a skipped reminder into a sent one.
- **A3 says "tonight"**, which is wrong for a T-24h reminder; the template
  uses `{date} at {time}`.
- **STOP is honoured at queue time** (SQL `NOT EXISTS SmsOptOut`); V-009's
  send-time check still has to land in `dispatchQueued`.
- **The route uses GET + `CRON_SECRET`**, matching Vercel Cron, though the
  project has no deploy target — any scheduler can call it.

**Left behind:**
- Quiet-hours deferral of the notice and reminders: V-009 (dispatch).
- A change is judged against the original `createdAt` — noted on V-012.
- The reminder pass reads then inserts unlocked (`ponytail:`): a cancel in
  the milliseconds between can still queue a reminder.
- **Deploy note:** the deployed environment needs `CRON_SECRET` and a
  scheduler hitting `/api/cron/sweep` every few minutes.

V-008 committed at 1153370.

## V-009 — Consent, quiet hours, and STOP at send time

**Built:** `packages/core/compliance.ts` — `quietUntil` and `sendDecision`,
pure, `now` and timezone as parameters. `dispatchQueued` asks it about
every queued row at the moment it would send: `send`, `defer` (row stays
`queued` for a later sweep), or a drop recorded as `failed` with reason
`opted_out` / `rate_limited` — that row is the drop's log.
`Reservation.smsConsent` (hand-written migration, blank refused by CHECK)
stores the consent wording verbatim; no consent means no confirmation,
reminder or release notice is ever queued.

**Decisions:**
- **Operator review (the PRD's one open question):** quiet hours stay
  21:00–09:00 restaurant time, but hold back only what can wait for
  morning. A reply to the guest's own text, and anything about a
  reservation starting before the window ends, still send. Recorded as
  resolved in the PRD.
- **STOP's acknowledgement is exempt from every rule** — opt-out, quiet
  hours, and the daily limit. Every other kind, owned or reply, is dropped
  once the number has opted out, including rows queued before the STOP.
- **The daily limit counts texts the provider accepted** (a provider id)
  since the start of the restaurant day, per number; a deferred row is not
  counted and not dropped, because tomorrow is a new day.
- **Dispatch claims every queued row** (no SQL `LIMIT`) so deferred rows
  cannot starve the rows behind them; `limit` counts rows moved
  (`ponytail:`, `notBefore` column if the queue grows).
- **Consent is checked at queue time only.** It cannot be withdrawn except
  by STOP, which is the send-time check.
- **Host-entered bookings carry no consent** and so get no texts: the
  `PlaceRequest.smsConsent` field is optional, absent = none.

**Tests:** quiet-window boundaries at 08:59/09:00/20:59/21:00 plus a DST
night; STOP against every message kind; the release-notice deferral at
20:59 vs 21:00 with the table free immediately; a reminder queued before a
STOP and dropped at send time; a 23:00 reply sent; the sixth text of the
day dropped and STOP still acknowledged; the limit resetting the next day.

**Left behind:**
- `table_ready` (the quiet-hours exemption P0-8 names) — V-010, noted on
  its backlog line.
- The daily count reads `statusChangedAt`, so a text sent at 23:59 and
  delivered at 00:01 counts toward the next day. Accepted; add `sentAt`
  if the limit ever has to be exact.

V-009 committed at 0e5723e.

## V-010 — Host floor view

**Built:**
- `core`: `table_ready` message kind (A12) and its quiet-hours exemption in
  `sendDecision`, by kind, not by start time. `walkIn` in `availability.ts`:
  the table half of the engine at an arbitrary instant (off-grid, no
  pacing), sharing `freeUnits` with `availability`, and a quoted range
  (first fitting end, rounded up to 5 min, +15) when nothing is free.
  `allows(from, to, actor)` exposes the edge table so screens draw buttons
  from it. `REVERTIBLE` gains `completed` (clear table) and `abandoned`
  (remove from waitlist). `minuteOfDay` moved to `time.ts`.
- Migration `host_floor`: `guestPhone` nullable (walk-ins), consent needs a
  phone (CHECK), `quotedWait` snapshot column, `reservation_has_tables`
  relaxed for `waitlisted`/`abandoned`, `table_ready` in the kind CHECK.
- `db/floor.ts`: `loadFloor`, `floorCursor`, `hostMove`, `undoLast`,
  `addWalkIn`, `tableReady`. Every tap runs `transition`/`revert` and
  applies the table effect in the same transaction as the event. Seating a
  waitlisted party allocates fresh at that instant; undoing a no-show,
  cancel or clear re-takes the snapshot tables under the constraint.
  `placement.ts` exports `loadPlan` and `firstUnit` for it.
- `apps/web`: `/host` (server component, grouped by service period,
  waitlist on top), server actions posting notice codes, `LiveUpdates`
  polling `/api/floor-updates` every 10s, paused in background tabs,
  `Expiring` for the undo button. `/host/login` + `middleware.ts` +
  `lib/staff-auth.ts`. `lib/restaurant.ts` holds the config the routes
  had inlined.
- Tests: core walk-in fixtures (hand-calculated: range, combination halves,
  a gap shorter than the turn, overstaying seated party, too large),
  revert/allows; DB `floor.test.ts` (13): undo inside/outside 5s, too-early
  no-show, a walk-in into a no-show's table then the no-show's undo refused
  `table_taken`, waitlist quote → seat → undo, "table ready" at 21:30 sent
  once, STOP shown on the row, five concurrent walk-ins for the last table,
  cursor moves on a tap and on a failed send. e2e `host.spec.ts`: passcode
  gate (GET redirect, POST 401), ≥48px targets, ≥18px rows, Seat largest,
  allergy vs occasion styling, failed text shown, axe clean, seat/undo and
  the undo vanishing, walk-in seated → waitlisted → table ready.

**Decided:**
- **Host auth now, not later** (kickoff question): Countertop's C-037
  passcode gate, ported. The floor shows names and can cancel tables.
- **Walk-ins skip pacing.** The party is at the stand; exceeding the cap is
  the host's call.
- **The cursor is the tip of what can change the screen**: event count,
  message count, non-queued count, failed count — all monotonic, so an
  out-of-order commit still moves it (Countertop's lesson).
- **"Table ready" does not hold a table**; seating allocates at the tap.
- **Refusals come back as codes mapped to fixed text**, so a crafted URL
  cannot write on the host's screen.
- **A seated party past its turn still occupies its table**; for quoting it
  is assumed to leave within one slot.

**Left behind:**
- The quote ignores parties already waitlisted ahead (`ponytail:` in core);
  P1-2.
- Walk-ins take no tags or note.
- Undoing a waitlisted party's seat keeps the seat time as `startAt`; the
  arrival time survives in the event log.

V-010 committed at de48ec8.
CI caught an order-sensitive assertion in `floor.test.ts` (a `groupBy` with no
`orderBy`); fixed in a follow-up commit, see WRITEUP Defects Found.

## V-011 — Service periods, blackouts and pacing

**Built:**
- `core/availability.ts`: two predicates pulled out of the slot loop —
  `periodAt` (which period contains a local minute) and `withinSeating`
  (does a turn fit, or does an explicit last seating allow it to overhang).
  The engine, the floor view's grouping and the new hours diff all call
  them; no second copy of "is this inside service hours" exists.
  `outsideHours(schedule, rows)` is the hours-edit diff warning (P0-10),
  pure: which upcoming reservations a schedule *would* strand, each labelled
  `closed` (no period contains it) or `overhang` (inside a period, but past
  its last seating or running past close).
- Migration `service_schedule`: `ServicePeriod` (weekly rows keyed by
  `weekday`, per-date overrides keyed by `day`, XOR'd by CHECK) and
  `Blackout`. Two EXCLUSION constraints — one per weekday, one per date —
  refuse overlapping periods. CHECKs cover the 15-minute grid, a positive
  window, a last seating inside its own period, and a positive pacing cap.
  The migration seeds Firebird's own hours.
- `db/schedule.ts`: `loadSchedule` builds the engine's `Schedule` from rows
  (a null `lastSeatingMinute` becomes *absent*, because that is what the
  engine branches on). `editSchedule(edit, tz, now, mode)` is the only
  writer: it applies the edit, reloads the schedule, runs `outsideHours`
  against the live upcoming rows, and rolls back unless the host forced it.
- `apps/web`: `/host/hours` — weekly periods, single-date overrides and
  closed dates, with add/remove forms and the diff warning; plain forms and
  server actions, behind the existing `/host` passcode gate. A pending edit
  round-trips through the URL and is re-parsed and re-checked on the way
  back. `lib/restaurant.ts` no longer holds a schedule.

**Tested:** `availability.test.ts` gains 6 `outsideHours` cases (covered,
`closed`, blackout, `overhang`, last-seating-decides, all rows not just the
first). `schedule.test.ts` (13): the round trip weekly/override/blackout,
null-vs-absent last seating, both exclusion constraints and their
non-collisions, four CHECK refusals, `not_found`, the diff warning writing
nothing, `force` landing it with the party still booked, a tightened last
seating stranding only the overhanging turn, `now`/status filtering, and
`check` never committing. e2e `hours.spec.ts` (5): periods rendered with cap
and last seating + axe, a clean blackout, a blackout over a booked date
(warning names the party, nothing written, Cancel, then Save anyway), an
overlapping period refused, and an override regrouping the floor view.

**Decided:**
- **A blackout is its own table, not a zero-period override.** An override
  with no rows is indistinguishable from no override, and "closed, and here
  is why" is worth storing.
- **Overlapping periods get an exclusion constraint, not a form check.**
  Two periods sharing slots would offer them twice, each with its own
  pacing cap — an allocation-shaped bug, so it gets the allocation-shaped
  mechanism.
- **The diff is computed against the applied edit inside the transaction,
  then rolled back.** Simulating it in memory would warn using different
  code than the one that writes.
- **The window/grid rules live only in the migration's CHECKs.** The form
  does not re-implement them; a second copy is the one that drifts.
- **The timezone stays app config.** It cannot be edited from a screen
  without rewriting every stored business day (P0-11).
- **The migration seeds the restaurant's hours.** Single-tenant
  configuration, not fixtures — without it a fresh database never opens.

**Left behind:**
- No edit-in-place for a period: change one by removing and re-adding. The
  diff warning fires on the removal, which is the honest half.
- The confirm step re-runs the check on a GET, so two hosts editing at once
  could both be shown a clean preview. One passcode, one stand.

V-011 committed at 3ffc19b.

## V-012 — Guest-facing booking flow

**Built:**
- `core/messages.ts`: two new kinds, `change_confirmed` and `change_failed`
  (Appendix A's A5 and A6), and the `{was}` slot they need — the booking as
  it stood.
- Migration `guest_change_messages`: the `outbound_kind_known` CHECK grows
  the two kinds, and `(reservationId, kind)` becomes a PARTIAL unique index
  that excludes them.
- `db/placement.ts`: `changeReservation` gains two things. A **no-op guard**
  — a request for the time and party it already has returns
  `changed: false`, writes nothing and logs nothing — and
  **confirmation-by-changing**: a guest-driven change moves `booked` to
  `confirmed` through the ONE lifecycle module, as its own event beside the
  change event.
- `db/guest.ts`: `dayAvailability` (a day's slots for a party size, every
  unavailable one carrying its reason), `loadManage` (the live reservation
  plus its newest message), `guestChange` and `guestCancel`. The token is
  validated against the shape `newManageToken` mints before it ever reaches
  the database.
- `apps/web`: `/book` (party → date → time → details, each step a query
  parameter), `/m/[token]` (the manage page), a shared `SlotGrid`, and
  `lib/guest.ts`, which reads the schedule per request.

**Tested:** `guest.test.ts` (20): the slot list keeps unavailable times with
their reasons, a too-large party gets a reason and no slots, a blackout
reaches the flow; a malformed token never reaches the database; the newest
message supersedes the old one; a change moves its holds and texts A5; a
change into a size that no longer fits leaves the original intact and texts
A6; a guest change confirms a `booked` party and a host change does not; the
`{was}` slot carries the date across a day change; a double submit writes
nothing; two changes queue two texts; a cancelled reservation refuses;
no consent means no text; cancel releases the table into inventory that
same instant and texts A7. e2e `book.spec.ts` (8): the whole journey, an
unavailable time shown with its reason + axe, a too-large party, E.164
refused by the browser *and* by the server with the attribute removed, the
change, a refused change, the cancel freeing the table, and a bad token as
a 404.

**Decided:**
- **`(reservationId, kind)` unique becomes partial.** It exists so a retry
  cannot text a guest twice about the same thing — one confirmation, one
  reminder, one release. A change result is not that: it is per change, and
  a guest may move twice. What stops a double-submit texting twice is the
  no-op guard, not the index.
- **The unique index is declared only in the migration.** Prisma has no
  syntax for a partial index, so `@@unique` in `schema.prisma` would make
  the drift check demand a full one forever. It lives beside the EXCLUDE
  constraints instead, and `findUnique({ reservationId_kind })` is gone.
- **A guest-driven change counts as that guest's confirmation.** The sweep
  judges a reservation against its original `createdAt`, so a `booked`
  party who reschedules past that deadline would be released out from under
  the change they just made. A host-driven change confirms nothing — the
  host moved it, not the guest.
- **The change text is queued after the change commits, not inside it.** A
  change that succeeded must not be undone by a message that would not
  render. This is the opposite of a booking, where the confirmation is
  queued in the booking's own transaction.
- **A slot picked in the URL is a day and a minute-of-day, never an
  instant.** The timezone turns them into the instant server-side, so a
  guest cannot hand us a time that means something other than what they saw.
- **The manage token is the whole of the authorisation.** No reservation id
  appears in any guest URL or form, and a bad token 404s exactly like one
  that never existed.
- **E.164 is validated twice, on purpose.** A `pattern` attribute so the
  browser refuses before submit (P0-12 asks for it), and
  `invalidGuestField` on the server, which is the one that decides.

**Left behind:**
- `{was}` carries the date only when the day changed. Same-day is the common
  move and the shorter text.
- The manage page has no edit for name, note or tags — only time, party and
  cancel, which are the two that touch inventory.
- `dayAvailability` reads outside a transaction, so a slot shown bookable
  can still be refused at submit. That is the design: the constraint decides.

V-012 committed at 5871161.

---

## V-013 — No-show & cover report, and the seeded service capstone

**Built:**
- `core/report.ts`: the P1-1 tallies as ONE pure function. Covers booked vs.
  seated per restaurant-day and 15-minute seating bucket; no-show rate split
  by confirmation state and by lead-time band; release rate; waitlist
  conversion. Takes rows and a timezone, reads no clock, derives every status
  list from `lifecycle.ts`.
- `db/report.ts`: the one read that feeds it. Each row carries `history` —
  every status the append-only event log says it reached — because the
  current status cannot answer the question the report exists for.
- `db/capstone.ts`: the seeded service. An 18-table floor plan with two legal
  combination sets, two service periods, one blackout date, and a scripted
  Friday dinner: 60 covers booked in advance, 88 on the book once walk-ins
  land, 76 seated. All seven of the PRD's ugly cases, each marked `UGLY n`.
- `db/capstone.test.ts`: 28 assertions over one run of it — each ugly case,
  the two service invariants, the message reconciliation, and the report
  hand-tallied against the script.
- `apps/web/app/host/report/page.tsx` + `e2e/report.spec.ts`: the report
  where the host already signs in. A plain GET form, so a range is a URL.
- `npm run db:seed:demo`: the same `runSeededService` against the dev
  database, so the demo and the fixture cannot drift apart.

**Decided:**
- **The report reads the event log, not the status.** `booked → confirmed →
  no_show` ends as plain `no_show`, so a report that split on `status` would
  answer "does confirming predict showing?" with a tautology. `history` comes
  from `ReservationEvent`, which is append-only and therefore the only honest
  source.
- **A cancelled or released party stays in `booked` covers.** The gap between
  the booked and seated lines IS the loss the report exists to show; netting
  it out of the denominator would hide exactly what a manager is looking for.
  Only `abandoned` is excluded — a waitlisted party who walked off was never
  on the book for a time.
- **…but `abandoned` still counts in waitlist conversion.** They are what
  conversion is measured against. Dropping them would report 100% for a night
  where half the waiting room gave up. The report's own test caught this.
- **A rate with an empty denominator is `null`, not zero.** The page prints
  "no data". A 0% no-show rate and no reservations at all are different
  facts, and a report that conflates them gets trusted.
- **The capstone drives the real entry points.** `placeReservation`,
  `handleInbound`, `guestChange`, `sweep`, `hostMove`, `addWalkIn` — nothing
  reaches past them into the tables. A demo that writes its own rows proves
  nothing about the code that ships.
- **The last-table race refuses with `full`, not `no_longer_available`.**
  Both parties of ten want the same 15-minute bucket, so they serialize on
  the pacing advisory lock and the loser's read — taken after the lock, on a
  fresh READ COMMITTED snapshot — already sees the winner. The exclusion
  constraint catches the cross-bucket case instead, which
  `placement.test.ts` and `constraints.test.ts` already hold. Both are a
  clean refusal with zero orphan holds, which is what the PRD asks for. The
  capstone asserts what actually happens rather than what reads better.
- **UGLY 7 is provable, not incidental.** The walk-in is a party of ten, and
  `C2` (T16+T17) is the only unit in the house that seats ten. T16 is the
  table the no-show just gave up — so that party is seatable *at all* only
  because the no-show released it five minutes earlier. A party of six would
  have landed on a free table anyway and proved nothing.
- **Two ways to be double-seated, two assertions.** A SQL self-join over live
  `TableHold` rows proves the end state; a replay over every party that held
  a table or sat down proves the whole night — bounded by the `completed`
  event, since a table cleared early is genuinely free before its turn is up.

**Left behind:**
- The fixture is hand-calculated and the table each party lands on is part of
  it. Re-ordering `ADVANCE` moves parties between tables and will fail the
  ugly cases that depend on a table being busy. The file says so at the top.
- Lead-time bands are fixed (`under 4h`, `4-24h`, `1-3 days`, `3+ days`) and
  measured in hours, not restaurant days — a duration needs no timezone.
- The report is one read of every reservation in the range, tallied in
  TypeScript. Right for one restaurant's night; a date-bucketed SQL rollup is
  the upgrade, and it would have to do its bucketing in the restaurant's
  timezone rather than the server's.
- No CSV export and no chart library — the covers table draws its two bars
  with a `div` each.
