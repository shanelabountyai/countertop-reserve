# Project Write-Up: Countertop Reserve — Table Reservations with SMS Confirm & Change

> Portfolio write-up. Appended as the build happens, per CLAUDE.md — scaling
> caveats, deliberate simplifications, and defects found go in **as they
> happen**, not reconstructed at the end.

**Repo:** https://github.com/shanelabountyai/countertop-reserve (private)
**Live demo:** _(not yet — may not be needed; see Scaling Caveats)_
**Built with:** Claude Code + Next.js (App Router) · TypeScript · Postgres/Prisma · Tailwind · Vitest/Playwright + axe
**Status:** In progress — V-002 of 13 backlog items · 2026-09-18

---

## The Business Problem

*(filled in as the guest booking flow and the message channel land — see the PRD's Problem Statement for the working version.)*

## What I Built

*(filled in as phases land.)*

## The Screens

*(filled in as phases land.)*

## How It's Built

**The second project on this stack, and it shows.** This is Countertop's
sibling — same restaurant, same conventions, same Claude Code working
loop — and the scaffold session (V-001) was written by reading Countertop's
own `WRITEUP.md` Defects Found section first. Two defects that cost
Countertop real time (a bundled Prisma client that broke only on deploy; a
missing `migration_lock.toml` that broke CI on its first run) simply don't
exist here — not fixed, avoided, because the cause was legible from the
first project's own record of it.

## Scaling Caveats and Deliberate Simplifications

- **The report tallies in TypeScript, not SQL** (V-013): one read of every
  reservation in the range, then a pass over it in memory. Right for one
  restaurant's night and it keeps the restaurant's timezone out of Postgres.
  A date-bucketed SQL rollup is the upgrade, and it would have to do its
  bucketing in the restaurant's calendar rather than the server's — which is
  precisely why it was not the starting point.
- **The capstone fixture is hand-calculated, including table assignments**
  (V-013). Which table each party lands on follows from the booking order in
  `ADVANCE`, and several of the ugly cases depend on a particular table being
  busy at a particular minute. Re-ordering that list fails the suite loudly
  rather than silently, but it does fail it. The file says so at the top.
- **No deploy target yet, possibly never.** Countertop went to Vercel + Neon
  because the PRD named that as the target. This PRD doesn't have an
  equivalent line — the seeded 60-cover demo (V-013) may be the whole
  deliverable. Revisit once the message channel (V-006/V-007) exists, since
  a live SMS integration is the one thing genuinely hard to demo without
  something running somewhere.
- **Floor view poll interval is fixed at 10s** (P0-9), not a backoff — the
  PRD calls this out explicitly ("a floor moves slower than a kitchen
  queue"). Noted here rather than only in the PRD so it isn't rediscovered
  as a question later.
- **Availability scans every held reservation for every slot** (V-002):
  O(slots × reservations), about 16 × 60 for a dinner service. Fine at one
  restaurant. Index by table if the engine ever serves a multi-day search.
- **No DST-transition-date fixture** (V-002). A slot inside the one skipped
  or doubled local hour a year resolves to a real instant near that minute.
  Dinner service never spans 1–3am, so this is untested rather than wrong.
- **Pacing is serialized by an advisory lock per 15-minute bucket** (decided
  V-003, built V-005). This is the one deliberate check-then-write: a cap on
  a sum across rows cannot be a constraint. Same-bucket bookings queue
  behind each other, which is fine at one restaurant and a hot spot only at
  a scale this product will never reach.

- **`released` only from `booked`, and it is terminal** (V-004). The PRD
  contradicts itself here: P0-4's state line allows `confirmed → released`,
  and P0-7 releases only unconfirmed reservations. P0-7 wins, because
  releasing a guest who replied C is the defect. A released guest who shows
  up anyway is seated as a walk-in with a new allocation.
- **Undoing a no-show or cancel can fail** (V-004). Those transitions delete
  the table holds, so the undo has to re-acquire them under the exclusion
  constraint, and a walk-in seated in the 5-second window wins. That is
  correct, and V-010 has to show it as a refusal, not an error.

- **Tags are kinds, not labels** (V-005). A tag is `allergy`, `occasion`
  or `accessibility`, enforced by a CHECK. The detail ("shellfish") goes in
  the 140-character note. The host view styles by kind (P0-9), so that is
  the only part it needs to be structured.
- **An idempotency replay does not compare the request** (V-005). A second
  submit with the same key gets the stored reservation back, even if the
  body differs. That is right for a double-click. Compare fields if a
  client ever reuses keys across different bookings.
- **Placement reads the occupied set by business day** (V-005). A service
  that runs past midnight would not see the previous day's late tables in
  the availability read. The exclusion constraint still refuses the
  overlap, so the guest gets "no longer available" and nothing is
  double-seated.

- **A confirmation is sent inside the transaction that claims it**
  (V-006). The carrier call holds a row lock for one network round trip.
  That is fine with a mock and one restaurant. With a slow real carrier,
  claim first, then send, with a `sending` state.
- **Date and time formatting strips U+202F** (V-006). Newer ICU puts a
  narrow no-break space before "PM". That character is not in the GSM-7
  alphabet, so one of it turns the whole text into UCS-2, where a segment
  holds 70 characters instead of 160. The confirmation would go from two
  segments to three with nothing visibly different.

- **The inbound conversation has no thread table** (V-007). The latest
  inbound row for a number *is* the state: a pending choice, a selection,
  or an unrecognised first message. Correct because a per-number advisory
  lock serializes a number's messages. A host↔guest thread (P1-5) would
  want a real conversation model.
- **The webhook signature covers the body, not the URL** (V-007). Twilio
  signs the full URL plus the parameters. The mock provider signs the raw
  body. Replaying a captured request is harmless, because handling is
  idempotent on the provider's message id. The real adapter (P2) brings
  the provider's own scheme.
- **The deadline sweep is a polled cron route** (V-008). Release accuracy
  is the sweep interval: at every 5 minutes, a table frees up to 5 minutes
  after its deadline. Overlapping sweeps are safe (`SKIP LOCKED`, one
  message per reservation and kind by constraint), so a tight interval
  costs load, not correctness. A job queue with per-reservation timers
  would be the upgrade at scale.
- **Reminders read then insert without a lock** (V-008). A guest who
  cancels in the same milliseconds can still be queued a reminder. An
  `INSERT … SELECT` with the status check is the fix if it ever happens.

- **Quiet hours hold back only what can wait (V-009, operator decision).**
  21:00–09:00, but messages about tonight's table and replies to the
  guest's own text still send. A restaurant with a later last seating or a
  stricter state rule changes `SendPolicy`; the exemption logic stays.
- **Dispatch locks every queued row each sweep (V-009).** Deferred rows
  sit in the queue overnight; claiming them all keeps them from starving
  the rows behind a `LIMIT`. Fine for one restaurant's queue; a
  `notBefore` column is the upgrade.
- **The daily text limit counts by status-change time (V-009)**, so a text
  sent at 23:59 and delivered after midnight counts toward the next day.
- **The host floor is behind one shared passcode (V-010).** Ported from
  Countertop's C-037: a cookie that is a digest of `STAFF_PASSCODE`, no
  accounts, rotate the passcode to sign everyone out. Not in the PRD; added
  because the floor shows guest names and can cancel tables.
- **Walk-ins skip pacing (V-010).** The party is already at the stand;
  seating them past the kitchen's per-bucket cap is the host's call, so the
  walk-in path asks the table half of the engine only.
- **Waitlist quotes come from booked turns and ignore the queue (V-010).**
  The first time a fitting unit is free for a full turn, rounded up to 5
  minutes, plus 15 — a range, never a point. A second waiting two-top is
  quoted the same table as the first. P1-2 (measured turns) is the fix.
- **An overstaying seated party is assumed gone within 15 minutes (V-010)**
  when quoting, and is never offered as free while seated. "Clear table" is
  what frees it.
- **"Table ready" does not hold the table (V-010).** The host texts, then
  seats; seating allocates under the constraint at that moment, and a table
  taken in between is a clean "no table fits" refusal. One text per party
  by constraint.

## Defects Found

- **V-013: the report would have claimed 100% waitlist conversion on a night
  half the waiting room walked out.** Covers deliberately exclude
  `abandoned` — a waitlisted party who left was never on the book for a
  time — and the first cut applied that same exclusion to every tally. But a
  party who gave up waiting is exactly what waitlist conversion is *measured
  against*, so removing them left only the parties who got tables: one of
  one, every time. Caught by the pure report test before any of it reached a
  screen. Covers exclude them; conversion counts them.

- **V-003: the spec's own constraint would have double-seated tables.** A
  "unique constraint on (table, turn window)" only rejects *identical*
  windows. With 75/90/120-minute turns, a 7:00 and a 7:30 booking on one
  table both pass. Caught at the schema review, before any migration was
  written. The mechanism is an exclusion constraint on overlapping ranges.

- **V-002: a fixture that could not fail.** The "last table" test proved a
  combination is blocked when one member table is taken, but it booked the
  *first* member. Mutating the engine to check only `tableIds[0]` left all
  26 tests green. It was caught by a deliberate mutation pass before commit,
  never in the product. The fixture now books the second member, and that
  mutation fails. Lesson: a test for "every member" needs its example to be
  a member other than the first.

- **V-005: a concurrency fixture that was wrong about overlap.** The
  "different buckets, exactly one wins" test raced six starts from 18:30 to
  19:45 on one table with a 75-minute turn. 18:30 ends at 19:45, so that
  pair is back-to-back and both may rightly book. It passed locally and
  failed on CI's second unit run, depending on which request committed
  first. The code was right and the fixture was not. Its starts now span 60
  minutes, so every pair overlaps. Lesson: before asserting "exactly one
  wins", check that every pair of contenders actually conflicts.

- **V-006: a concurrency test that could not fail.** "Four dispatchers send
  each message once" passed with the row lock deleted. The mock carrier
  answered instantly, so each dispatcher finished before the next one read
  the queue. Found by mutating the lock before commit. The test's carrier
  now waits 50 ms, and without the lock it sends 12 texts for 3 messages.
  Lesson: a race test needs the race window held open on purpose.

- **V-007: a rollback path no test reached.** A change deletes the old
  holds and inserts the new ones under one savepoint, so a refusal by the
  constraint brings the old holds back. Every change test that refused
  did so in the *engine*, before any delete ran. Moving the delete outside
  the savepoint left all 29 of them green. That would have been a guest
  holding nothing after a refused change, which is exactly what P0-6
  forbids. Caught by a mutation pass before commit. The new test puts a
  hold the engine cannot see onto the target table, so only the constraint
  can refuse. Lesson: a refusal test proves only the refusal path it
  actually reaches. Check whether it is the engine or the constraint
  saying no.

- **V-009: a test that STOPped too early.** The rate-limit test queued six
  HELP replies, then a STOP, then dispatched once, and expected five sends.
  It got one: the send-time check correctly dropped every HELP, because the
  number had opted out before any of them went. The code was right and the
  test was describing the old, queue-time world. Lesson: once a check moves
  to send time, a test's order of *events* matters, not just its inputs.

- **V-010: a test that leaned on unspecified row order.** The five-walk-ins
  test compared a `groupBy` over TableHold to `[T1, T2]` with no `orderBy`.
  Green locally three times, red in CI, where Postgres returned T2 first.
  The allocation was right; the assertion was order-sensitive. Fixed with
  an explicit `orderBy`.

- **V-011: a DB default that reads as drift.** The new `ServicePeriod` table
  was written with `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, which is
  perfectly good SQL and exactly wrong here: Prisma's `@default(uuid())`
  mints the id client-side, so `migrate diff` saw a default in the database
  that the schema does not declare and failed. Caught by running the CI drift
  check locally before committing, not by CI. Every other uuid id in this
  schema is minted client-side; the migration's own seed rows now pass
  `gen_random_uuid()` explicitly instead.

- **V-012: a partial unique index is invisible to Prisma, and the drift
  check says so.** The change-result texts (A5/A6) needed
  `(reservationId, kind)` to stop being unique for two of the fourteen
  kinds, so the migration replaced the index with a partial one. Leaving
  `@@unique([reservationId, kind])` in `schema.prisma` made
  `prisma migrate diff` report "Added unique index on columns
  (reservationId, kind)" forever — it cannot represent a `WHERE` clause, so
  it sees the partial index as no index at all. The fix is to declare it
  only in the migration, beside the EXCLUDE constraints, and accept losing
  `findUnique({ reservationId_kind })`. Caught by running CI's drift check
  locally before committing, the same way V-011's was.

- **V-012: `tsc -p .` at the repo root does not typecheck `apps/web`.** Six
  real errors — `Date | null` reaching a `Date` field among them — passed a
  root typecheck and failed the gate's second step. The web workspace has
  its own tsconfig with its own `strict` settings and its own include paths.
  `npm run typecheck` is the only check that means anything; the root
  invocation is a false green. The errors themselves were one cause: a
  `never`-returning `back()` helper only narrows control flow when its call
  is `return`ed, not when it stands alone as a statement.

- **V-012: a `'use server'` file may export nothing but async functions.**
  The consent sentence was put beside the write it is stored by, which is
  where it belongs and is not where Next.js allows it. Turbopack refused
  the build with "Only async functions are allowed to be exported" — and
  then, confusingly, with "Export book doesn't exist in target module" for
  the function that plainly does, because the whole module had been
  rejected. Lint and typecheck are both clean on this; only `build` catches
  it, which is exactly why the gate runs the build as its own step.

- **V-012: `Number('')` is 0, so "no time picked yet" became a booking for
  midnight.** `parseSlot` validated the minute-of-day with
  `Number.isInteger(Number(minute))`, and an absent `at` parameter sailed
  through as minute 0. `/book?party=2&day=…` with no time chosen rendered a
  full details form headed "Party of 2 on 2026-10-14 at 12:00 AM". Submitting
  it would have been refused by the engine, so nothing could have been
  double-booked — but the guest would have been asked for their phone number
  to book a table that does not exist. Found in a Playwright failure snapshot
  taken for an unrelated assertion, which is an argument for reading the whole
  snapshot rather than the one line the error points at. The fix is to test
  the string for digits before converting it.

- **V-012: a fixed future date in an e2e spec outlived the page's own
  horizon.** The spec used `2027-03-05`, copied from `hours.spec.ts`, where it
  is fine because that spec writes rows straight to the database. The booking
  page has a 60-day horizon expressed as `max` on the date input, so Chromium
  refused to submit the day form and every spec that went through the UI timed
  out waiting for a time that had never been asked for. The failure looked like
  a missing link, three steps downstream of the cause. The spec now reads
  `today + 30 days` from Postgres in the restaurant's timezone.

## Skills Learned / Functions Unlocked

*(filled in as phases land.)*

## The Hardest Bug

*(reserved for the end.)*

## What I'd Do Differently

*(reserved for the end.)*

## By the Numbers

*(reserved for the end.)*
