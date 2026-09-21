# Project Write-Up: Countertop Reserve — Table Reservations with SMS Confirm & Change

> Portfolio write-up. Appended as the build happens, per CLAUDE.md — scaling
> caveats, deliberate simplifications, and defects found go in **as they
> happen**, not reconstructed at the end.

**Repo:** https://github.com/shanelabountyai/countertop-reserve (private)
**Live demo:** <https://reserve.labintelligence.co> — the seeded 60-cover service, behind one shared password (V-014). The carrier is still stubbed; a demo deployment is not production.
**Built with:** Claude Code + Next.js (App Router) · TypeScript · Postgres/Prisma · Tailwind · Vitest/Playwright + axe
**Status:** Complete — 13 of 13 backlog items

---

## The Business Problem

A reservation nobody confirms is a table nobody sits at. The standard fix —
call every guest the afternoon of service — costs a host an hour a day and
reaches about half of them. The phone is also where changes go to die: a
guest who wants 7:30 instead of 7:00 calls during service, nobody picks up,
and they either arrive at the wrong time or not at all.

Text is where the guest already is. A booking that confirms itself by reply,
and a time or party size a guest can change *by texting back*, turns the two
most expensive host interactions into a channel that costs nothing and works
at 3am. Cancelling has to be the path of least resistance — that is the whole
no-show strategy.

The builder-side problem is two things the previous five projects never
made me face. **Allocation under contention:** a table holds one party per
turn, tables combine into larger ones, and two people book the last 7:00
four-top in the same second. **An inbound channel that mutates state:** every
prior project's writes came from a browser session the app controlled. Here a
stranger with a phone can move a reservation.

## What I Built

Thirteen items, one per session, in the PRD's phase order.

**The engine** (`packages/core`, pure, no clock, no database). One
availability function answering through two constraints — does a table or a
legal combination *fit*, and is the 15-minute pacing bucket under its cap —
called by the guest flow, the host's floor and every change request. One
lifecycle module owning `booked → confirmed → seated → completed` plus
`cancelled`, `no_show`, `released` and `waitlisted`, exporting every
status list its readers filter by, so adding a state makes the compiler
find the readers. Message templates with named slots, and the send policy
that decides consent, quiet hours, STOP and the daily cap.

**The allocation** (`packages/db`, ten hand-written migrations). A Postgres
`EXCLUDE` constraint on `(table, [start, end))` overlap is what actually
stops a double-seat; the greyed-out slot in the UI is only UX. Bookings
race into the constraint and lose cleanly. Pacing — a cap on a *sum* across
rows, which no constraint can express — is serialized by an advisory lock
per bucket, the one deliberate check-then-write in the product and labelled
as such. An append-only trigger on the event log, including for transitions
a text message caused.

**The channel.** Outbound messages are queued with delivery state
(`queued → sent → delivered|failed`) and idempotent per reservation and
kind. Inbound is treated as a trust boundary: the provider's signature is
validated, the body is parsed against a five-keyword allowlist
(confirm/cancel/change/stop/help — `CHANGE` always bounces to the tokenized
manage link rather than parsing free-text times), and every handler is
idempotent on the provider's message id, so a redelivered webhook causes
exactly one transition. A cron sweep releases unconfirmed reservations on a
deadline and dispatches the queue; quiet hours defer the *message* and never
the inventory decision.

**The surfaces.** A guest booking flow, a tokenized manage page sharing the
same code path as the SMS keywords, a host floor view worked at arm's length
during service, an hours/pacing editor, and a no-show and cover report in the
restaurant's timezone.

**The capstone.** A seeded 60-cover dinner service carrying all seven of the
PRD's ugly cases verbatim — a change into a table that no longer fits, a
change to an unavailable time, two simultaneous bookings for the last table,
a STOP mid-thread, a number with two upcoming reservations, a webhook
redelivery, a walk-in into a released no-show's table. It is both the demo
and a test: 28 assertions, zero double-seated tables, zero stranded parties.

## The Screens

Shot against the seeded 60-cover service in `docs/screenshots/`:
[the booking grid](screenshots/2-book-times.png) (a party of 10 on a full
night — every dinner slot refused with its reason, because the floor's two
combinations are both taken, and the closing overhang reads *not serving*
rather than vanishing), [the floor](screenshots/4-host-floor.png)
(combinations as `T16+T17`, a released table, a no-show, and a failed
reminder on its own row), [the manage page](screenshots/3-manage.png) (the
snapshot rule visible — it shows the text as *sent and stored*, not
re-rendered), [hours](screenshots/5-host-hours.png), and
[the report](screenshots/6-host-report.png).

Regenerate after a UI change: `npm run db:seed:demo`, start the server on
the dev database (`npm run dev:demo` — plain `npm run dev` is `dev:test` and
serves the *test* database, which the seed never wrote to), then
`MANAGE_TOKEN=<any booked reservation's token> STAFF_PASSCODE=$(grep
STAFF_PASSCODE .env.local | cut -d= -f2) node docs/screenshots/capture.mjs
docs/screenshots`.

| Route | Who | What it does |
|---|---|---|
| `/book` | Guest | Party size → date → time → details. Unavailable times stay on the grid **with their reason**; the phone number is validated by the browser and again by the server. |
| `/m/[token]` | Guest | The manage page the `CHANGE` keyword links to. Change the time or party size, or cancel. The token is the entire authorisation — no reservation id appears in any guest URL. |
| `/host` | Host | Tonight's book, grouped by service period. Seat / no-show / cancel in one tap with a 5-second undo, walk-ins and a waitlist with quoted ranges, tags styled by kind, a failed confirmation text shown on its row. ≥48px targets, axe-clean, 10s poll. |
| `/host/hours` | Manager | Weekly service periods, per-date overrides, blackouts, pacing caps and last seating. An edit that would strand a booked party is *shown*, not saved, until forced. |
| `/host/report` | Manager | Covers, no-shows, releases and waitlist conversion for a date range, in the restaurant's timezone. |
| `/host/login` | Host | One shared passcode behind a digest cookie. Not in the PRD — added because the floor shows guest names and can cancel tables. |
| `/api/sms/inbound` | Carrier | The webhook. Signature, allowlist, idempotency key. |
| `/api/cron/sweep` | Scheduler | Deadline releases, reminders, and queue dispatch. |

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

- **Sending is not crash-safe exactly-once, and cannot be made so from
  here.** `dispatchQueued` calls the carrier INSIDE its database transaction.
  If the process dies after the provider accepts a message but before the
  transaction commits, the row stays `queued` and the next sweep sends it
  again — the guest gets the text twice. The stored provider id makes a
  duplicate *detectable afterwards*; it is not what prevents one. Real
  exactly-once needs an idempotency key the carrier itself honours, and the
  mock provider (P0-5 is explicit that v1 mocks the carrier) has no
  equivalent. It also holds a transaction open across network I/O, which is
  the part that will bite first at volume. Documented rather than fixed,
  because every honest fix is a real carrier integration.
- **The e2e specs share state in one chain, and CI retries them.**
  `book.spec.ts` books, changes, then cancels one reservation across separate
  `test()` blocks — deliberate, because that is the journey, and Playwright
  runs the file serially. The cost is that a CI retry (`retries: 1`) re-runs a
  single failed test against a database the earlier tests already moved, so a
  retry can pass or fail for reasons unrelated to the original failure.
  Reviewed and kept: the chain is what makes the specs readable, and the
  alternative is re-seeding per test, which loses the "immediately real
  inventory" assertions that depend on what the previous step did. Worth
  knowing when a CI-only flake appears. `hours.spec.ts` also pins a fixed
  future date (2027-03-05) so `startAt >= now` holds; it will need moving
  before then, and will fail loudly rather than silently when it does.
- **Staff auth is one shared passcode, with no throttling and no
  server-enforced expiry.** Reviewed and deliberately left as is for this
  scope, but naming what that means: the cookie is a salted digest of
  `STAFF_PASSCODE`, compared in constant time, so it carries no authority of
  its own and rotating the passcode revokes every session at once. What is
  missing is a rate limit on the login form — nothing slows an online guess
  against a six-character passcode — and any expiry the server enforces,
  since the 30-day `Max-Age` is a cookie attribute the client could simply
  keep. Authorization is also route-local: the middleware gates `/host/*`,
  and the server actions behind it re-check nothing, so they rely entirely on
  that one check. That is sound as long as every host action stays under
  `/host` and the middleware matcher keeps covering it — a coupling worth
  knowing about rather than a defect today. Per-host accounts, a login
  throttle and server-side sessions are the upgrade, and they are a project,
  not a patch.

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
- **Deployed after all, and the first answer was wrong (V-014).** This PRD
  never named a deploy target, so the question stayed open through the whole
  build and got answered at close as *no, deliberately* — the argument being
  that the only thing a hosted instance adds is a live carrier, which is an
  explicit Non-Goal. That argument is sound about SMS and wrong about the
  demo, because it assumes the carrier is the only thing a deployment buys.
  What it actually buys is a link you can send. Every sibling project is
  already a `labintelligence.co` subdomain; this was the only one that needed
  its owner present at a laptop to be seen at all, and the exec brief said
  "walkthrough on request" where the others say "click here." Now at
  `reserve.labintelligence.co`, Vercel + Neon, behind a shared password.
  **The carrier is still stubbed** — nothing about deploying changed that,
  and the outbox is still the real part. **The honest caveat is that a demo
  deployment is not production:** no backups, no monitoring, no on-call, and
  every row in it is a fixture. The lesson is the one already in *What I'd Do
  Differently* — decide the deploy question at kickoff, because a question
  left open until close gets answered by whoever is most tired.
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

### From an external code review (2026-09-21)

A read-only review of the whole repository, after the deploy. Nine findings
held up under independent verification; each is written here as the defect it
was, not as the patch.

- **A booking nobody asked was released anyway.** Consent to texts is a
  checkbox (P0-8), not a requirement — so a guest could book without it, never
  be sent a confirmation request, never be sent a reminder, and be
  auto-released at T-3h for failing to answer a question that was never put to
  them. The release notice could not reach them either. The manage page had no
  confirm button and neither did the floor view, so *no* path to `confirmed`
  existed for that guest: the only one was the `C` reply to a text they had
  declined. Two fixes, and the second is the interesting one. `shouldRelease`
  now requires the confirmation request to have actually been **sent** — keyed
  on the send, not on current consent, so a guest who was texted and then sent
  STOP still has a deadline. And both confirm paths exist now: a token-
  authorised button on the manage page, and a staff button on the floor that
  needed no new action at all, because `move` already drives every host
  transition and the `booked → confirmed` edge already listed `host`.

- **A date-shaped string that names no date reached the database.**
  `Date.UTC(2026, 8, 31)` is October 1st, silently — so `2026-09-31` parsed to
  a real instant while `businessDay` kept the impossible original. The row
  then answered to one date on the floor query (which keys off `businessDay`)
  and another by its own clock. Every entry point validated with the same
  shape-only regex, five copies of it. The fix is one predicate
  (`isCalendarDay`, a round-trip through `Date.UTC` demanding the same three
  numbers back) that every edge now shares, plus the invariant the schema
  never stated: `fit` refuses unless the day a reservation NAMES is the day
  its instant FALLS on.

- **The 60-day booking horizon was an `<input max>` and nothing else.** A
  client editing the form could book 2027. Now enforced in `fit`, which is the
  one path a new booking and a guest change both take, and compared as *days*
  so a 22:00 slot on the last day is not "too far" because the clock says
  09:00.

- **An expired SMS selection retargeted the wrong reservation.** Offered A and
  B, the guest picks A; A is then cancelled or starts; the guest texts `X`.
  The handler fell back to "the only one left" and cancelled **B** — the one
  booking they had explicitly not chosen. Having chosen once is exactly what
  makes the guess unacceptable. A stale selection now asks again.

- **A booking and an hours edit could pass through each other.**
  `guestConfig` loaded the schedule before placement's transaction opened, so
  a booking could be decided against hours a blackout had already removed:
  committed, outside service, and invisible to the edit's own stranding check
  because the row did not exist when that check ran. Neither side was wrong
  alone; they had no boundary in common. They share one advisory lock now —
  bookings take it shared and reload the schedule under it, edits take it
  exclusive — with a fixed lock order (schedule, then pacing bucket) so there
  is no cycle to deadlock on.

- **The change picker counted the booking it was replacing.** `changeReservation`
  had always excluded the reservation being replaced from the occupied set;
  the picker that fed it had not. So a guest moving 19:00 → 19:15 on the only
  table that fits them was shown `full` by the page and would have been
  granted by the engine. The exclusion is derived from the manage token, never
  from a parameter — a guest cannot ask to have someone else's reservation
  ignored.

- **A retry of a successful booking was told the table was gone.** Two
  requests with one idempotency key both find nothing on the first replay
  check. The bucket lock serialises them; the winner takes the last table; the
  loser's `fit` reads the winner's committed row, reports `full`, and returns
  **without ever touching the unique index** — so the P2002 catch that exists
  for exactly this never fires. A refusal is no longer final until the key has
  been checked again. `addWalkIn` had neither half of the protection: no catch
  at all, so under a double-tapped form the loser's P2002 escaped as an
  unhandled rejection rather than a result.

- **A committed cancel could lose the text that said so.** `guestChange`,
  `guestCancel` and `guestConfirm` committed state and *then* queued their
  notification. A crash in between left the guest cancelled and the message
  gone, with nothing recording that one had been owed. `placeReservation` had
  always queued the confirmation inside its transaction — this is the same
  rule applied to the three writes that were missing it. The queued row is the
  durable intent; `dispatchQueued` is the retryable path.

- **The webhook's size cap protected nothing.** `req.text()` buffers the whole
  body and only then lets you measure it, and the pre-check read
  `Content-Length` — absent on a chunked request, so `Number(null ?? 0)` is 0
  and the check passed. It also counted UTF-16 code units against a *byte*
  cap. Replaced with a bounded read that counts as it goes and cancels the
  stream at the limit.

Three smaller ones from the same review: `docker-compose.yml` published
Postgres on every interface with a password committed to the repo (now
loopback-only, password from the environment with no default); the screenshot
script printed manage URLs to stdout, and a manage token *is* the credential
(now redacted); and the hours editor could not express a midnight close even
though the schema has always allowed minute 1440 and the table renders it —
a native `<input type="time">` caps at 23:59, so the Closes control is a list.

Two test defects the review surfaced, which matter more than they look:

- **`vitest.config.ts` included `packages/**` only.** `apps/web/lib/demo-gate.test.ts`
  had existed since the deploy item and had never once run. Fifteen assertions
  about the password gate that guards the public demo, green by never
  executing. The gate now includes `apps/web/**`.

- **The capstone's occupancy assertion could not catch the thing it was for.**
  It ended every party at `min(scheduled turn end, cleared)`, so a party that
  sat down and was never cleared counted as having left when their turn was
  up. A table physically occupied past its turn is what an over-running party
  *is*, and seating someone else into it is the double-seating the test
  exists to catch. Rewritten against actual seat/clear events, and it then
  failed — correctly. The seeded service was giving three tables to new
  parties before the host had cleared them: T1 at 19:45 while Alvarez Pena
  sat there until 20:50, T14 at 20:45 under Quinn Alaba, and the C2
  combination at 21:00 under a walk-in of ten. The fixture now busses a table
  before it reuses it. A fixture that cannot fail is the same defect class as
  V-002, two items apart.

### Found while building


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

- **Post-close: the demo script's own environment was the one thing never
  under the gate.** `npm run db:seed:demo` writes the *dev* database, but
  `npm run dev` is an alias for `dev:test`, which loads `.env.test` first and
  first-wins — so the documented way to start the app served a database the
  seed had never touched, and the demo opened on an empty restaurant. The
  same gap had a second half: `.env.local` carried no `SMS_WEBHOOK_SECRET` and
  no `CRON_SECRET`, so the live-SMS section returned `503 webhook not
  configured`. Both routes fail closed by design, which is correct and is
  exactly why the omission was invisible. Neither defect could ever be caught
  by the gate, because the gate runs on `.env.test`, where both values are
  set and the database is the one the tests seed themselves — the failing
  configuration is the one no automated step ever exercises. Fixed with a
  `dev:demo` script that loads `.env.local` alone and by setting both secrets
  there; the write-ups and `.env.example` now say both env files need them.
  The lesson is narrower than "test your docs": an env file that only a human
  ever loads has no coverage by construction, so the commands that use it have
  to be run by hand before they ship. `docs/DEMO.md` already carried that rule
  — every command run once before shipping — and these two were the ones the
  rule was written about.

- **V-014: the build typechecked files that a production install cannot
  resolve — invisible until the first deploy.** `next build` runs TypeScript
  over everything `apps/web/tsconfig.json` includes, which was `**/*.ts`:
  the Playwright specs and the unit tests too. Those import `pg` and
  `vitest`, both root devDependencies, and Vercel's production install omits
  devDependencies — so the first deploy failed with nine `TS2307 Cannot find
  module` errors in files that have no business being in a production build.
  Every one of them predated this item; the project had simply never
  deployed, so nothing had ever run `tsc` without devDependencies present.
  The fix is two configs rather than one: `tsconfig.json` excludes `e2e` and
  `**/*.test.ts` so the build does not see them, and `tsconfig.test.json`
  includes exactly those so the gate still does. Verified the second config
  is not a no-op by planting a deliberate type error in a test file and
  confirming `npm run typecheck` failed on it — a config that silently
  matches nothing looks identical to a config that passes.

- **The password-rotation recipe wrote an empty password, and nothing said
  so.** `read -rs NEWPW` creates a *shell* variable; perl's `$ENV{NEWPW}`
  reads the *environment*. Without an `export` between them perl sees undef,
  and `perl -pe` does not warn on undef by default — so the substitution ran,
  succeeded, printed nothing, and left `neondb_owner:@host` in
  `.env.production.local`. That is a syntactically valid Postgres URL, so
  every later step co-operated: the file looked edited, `vercel env add`
  accepted it, the build succeeded, and the failure surfaced only as a `500`
  on the deployed site, three steps and one irreversible Neon reset after the
  actual mistake. The distance between cause and symptom is the whole defect.

  Worse, the recipe had been written *and documented as verified* the session
  before, against a fixture — but the fixture exercised the perl substitution
  with the variable already exported in that shell, which is precisely the
  condition the real run would not have. A check that cannot reproduce the
  caller's environment is not a check.

  Three fixes, and only the first is the bug: `export NEWPW`; a repair pattern
  (`[A-Za-z0-9]*@` rather than `npg_[A-Za-z0-9]+`) so a file already wrecked
  by the broken run is recoverable by re-running the same line; and a guard
  that refuses to touch Vercel until the file holds two identical non-trivial
  passwords **and** one real `psql` connection has been made with them.
  Verified the guard by feeding it both broken states it exists to catch — an
  empty password and two mismatched ones — and confirming a non-zero exit on
  each, because a guard that has only ever seen a good file is indistinguish-
  able from `true`.

- **The fix for that defect shipped with a second defect inside it, and the
  fixture proved the wrong thing.** The repair pattern written above —
  `s{(neondb_owner:)[A-Za-z0-9]*@}{...}` — cannot match a Neon password.
  Neon passwords are `npg_…`, and `_` is not in `[A-Za-z0-9]`, so the class
  stops at `npg` and never reaches the `@`. Zero matches, every time, on every
  real password. It appeared to work when first written because the file it
  was tested against had the *empty* password left behind by the first bug,
  and `[A-Za-z0-9]*` happily matches zero characters. A fixture built from the
  broken state proved only that the tool handled the broken state.

  What made it expensive is that `perl -pi` rewrites the file whether or not
  it substitutes anything, so a zero-match run updates the modification time
  and is indistinguishable from a success by every cheap check: the file looks
  edited, both strings are present, they are identical to each other, and the
  password is a plausible 16 characters. It ran twice against Countertop, was
  diagnosed both times as a mis-paste, and cost a second irreversible Neon
  reset before the pattern itself came under suspicion.

  Three lessons, and the middle one is the general case. The character class
  was wrong: `[^@]*` describes the *delimiter*, not what a password may
  contain, and a pattern that enumerates permitted characters in a secret is
  a bug waiting for the first secret that adds one. **Length is not identity**
  — every Neon password is 16 characters, so the length check could never
  distinguish rotated from unrotated, and shape checks that all pass on an
  unchanged file are theatre. The decisive check was the one that talks to the
  live system: after a reset the old password is *rejected*, so `psql` is the
  only step that can tell "wrote the new value" from "wrote nothing." Compare
  secrets by fingerprint (`shasum | cut -c1-12`) when you need to know whether
  two values differ without putting either on screen.

## Skills Learned / Functions Unlocked

- **An exclusion constraint, and knowing when a unique constraint is a
  lie.** The PRD asked for "a unique constraint on (table, turn window)."
  That phrase is wrong, and it is wrong in a way that reads as correct: with
  75/90/120-minute turns, a 7:00 and a 7:30 booking on one table are two
  different windows and both pass. `EXCLUDE USING gist (tableId WITH =,
  during WITH &&)` over a `tstzrange` is the real mechanism, and it is the
  single most valuable thing this project taught me.
- **Which invariants a database *can* hold, and which it can't.** Overlap is
  a constraint. A cap on a sum across rows is not — no amount of wanting
  makes it one. That is why pacing is an advisory lock and says so in the
  code, instead of pretending to be enforced.
- **Treating an inbound webhook as a trust boundary.** Signature first, then
  an allowlist rather than a parser, then an idempotency key checked *before
  any state transition* rather than before any send. Free-text time parsing
  was declared out of scope on purpose: `CHANGE` bounces to a tokenized link,
  which is both safer and less code.
- **Separating an inventory decision from its notification.** Quiet hours
  defer the text; the table frees at the deadline regardless. Tangling those
  two is the kind of thing that only bites the first time someone books at
  2am, which is to say in production.
- **GSM-7 versus UCS-2, the hard way.** Newer ICU emits U+202F before "PM".
  One character outside GSM-7 turns a whole message into UCS-2, where a
  segment holds 70 characters instead of 160 — a confirmation silently
  becoming three segments instead of two, with nothing visibly different.
- **Mutation testing as a habit, not a tool.** Three of this project's
  defects were found by deliberately breaking the code before commit and
  watching the suite stay green. Two of them (V-002, V-006) were fixtures
  that could not fail; one (V-007) was a rollback path that 29 refusal tests
  all managed to miss.
- **Running CI's drift check locally before committing.** Both V-011 and
  V-012's migration defects were caught this way. `prisma migrate diff`
  cannot represent a partial index or a database-side default that the
  schema mints client-side — so the schema and the migration have to agree
  about *who* generates a value, and a partial index can only be declared in
  the migration.
- **A production-build e2e sweep as a real check, not ceremony.** The
  `'use server'` export rule (V-012) is clean under both lint and typecheck
  and fails only at build. That is the argument for the build being its own
  gate step.

## The Hardest Bug

**V-012: a fixed future date in an e2e spec outlived the page's own
horizon.** Every spec that went through the booking UI timed out, and each
one reported the same thing — it could not find the link to the next step.
The link was the symptom. The cause was three steps upstream: the spec used
`2027-03-05`, copied from `hours.spec.ts`, where it is perfectly fine
because that spec writes rows straight to the database and never touches the
form. The booking page expresses its 60-day horizon as a `max` attribute on
the date input, so Chromium silently refused to submit the day form. No time
was ever requested, so no time grid rendered, so the link the assertion
waited on never existed.

What made it hard is that nothing in the failure pointed at the date. The
browser's refusal to submit an out-of-range input produces no error, no
console message and no network request — it produces *nothing*, which is
indistinguishable from a page that rendered and lacked a link. The error
named the last thing that was missing rather than the first thing that went
wrong, and I spent the first pass looking at the time grid, which was
innocent.

Two things settled it. Reading the whole Playwright failure snapshot rather
than the line the error pointed at — the snapshot showed the page still
sitting on the day step, which the error message never said. And noticing the
date was a *literal*, copied from a spec with a different relationship to the
UI. The fix is that the spec now reads `today + 30 days` from Postgres in the
restaurant's timezone, which is the only way for a test's date to stay inside
a horizon that moves.

The lesson generalises past this bug: **a copied fixture carries the
assumptions of the spec it came from**, and those assumptions are invisible
at the copy site. `2027-03-05` is correct in `hours.spec.ts` and wrong in
`book.spec.ts` for a reason that appears in neither file.

*(Runner-up, and arguably the more valuable find: V-007's rollback path,
where all 29 change-refusal tests refused in the engine and none of them
ever reached the constraint. Deleting the savepoint left every one of them
green. It was caught by mutation rather than by debugging, which is why it
is not the hardest — the method found it, not me.)*

## What I'd Do Differently

- **Send the confirmation outside the transaction that claims it.** V-006
  queues and sends inside the booking's transaction, so the carrier call
  holds a row lock for a network round trip. With a mock that is invisible;
  with a real carrier it is the first thing that would hurt. The shape I'd
  start from now is the one V-012 arrived at for change texts — claim,
  commit, then send from a `sending` state.
- **Give the capstone fixture explicit table assignments.** The hand-
  calculated service derives which table each party lands on from the order
  of the `ADVANCE` list, and several ugly cases need a specific table busy at
  a specific minute. It fails loudly when reordered, which is the right
  failure — but it should not be possible to reorder a list and break an
  unrelated assertion. Naming the expected table per booking would cost
  twenty lines and remove a whole class of confusing red.
- **Model the inbound conversation, even at v1.** "The latest inbound row
  for a number *is* the state" is correct today because a per-number advisory
  lock serializes it, and it will be wrong the moment a host can text a
  guest back (P1-5). The thread table is cheap now and a migration later.
- **Stop trusting a root `tsc --noEmit`.** V-012 lost a gate step to six real
  errors that passed the repo-root typecheck because `apps/web` has its own
  tsconfig with its own `strict` settings. A root invocation that checks less
  than the gate is a false green, and I would wire the workspace typecheck
  into the root script on day one rather than discovering it at item twelve.
- **Decide the deploy question at kickoff, not at the end.** The PRD never
  named a target, so the project ran thirteen items with "deploy?" quietly
  unanswered. The answer it eventually got — no, because the seeded service
  shows everything and a live carrier is a Non-Goal — is the same answer it
  would have got in V-001, and having it early would have settled a caveat
  that instead sat marked "revisit" for a month. A PRD that doesn't name a
  target should be made to name one, including when the target is *none*.
- **Write the PRD's contradictions down as they're found.** P0-4's state
  line allows `confirmed → released` and P0-7 releases only unconfirmed
  reservations. Those cannot both be true. It was resolved correctly at V-004
  (P0-7 wins; releasing a guest who replied C is the defect) but only because
  someone happened to read both in the same session.

## By the Numbers

| | |
|---|---|
| **Backlog items shipped** | 13 of 13 (V-001 → V-013) |
| **Commits** | 49 (one per item, plus its SHA-recording follow-up) |
| **Application code** | 6,505 lines of TypeScript/TSX |
| **Test code** | 4,598 lines — 0.71 lines of test per line of source |
| **Unit tests** | **768 passing**, across 19 files |
| **End-to-end tests** | **32 passing**, against a production build, axe included |
| **Hand-written migrations** | 10 (+ `migration_lock.toml`), none by `db push` |
| **Database-enforced invariants** | 3 `EXCLUDE` constraints, 1 partial unique index, 1 append-only trigger, plus CHECKs on every enumerated column |
| **Documentation** | 2,612 lines across the PRD, backlog, PROGRESS, release notes, the demo script and this file |
| **Defects recorded** | 30 — 16 found while building, of which **3 by mutating the code before commit**, 2 by running CI's drift check locally, and 1 at a schema review before any migration existed; plus **14 from the external code review** (V-015), which read finished, deployed code |
| **Defects that survived a commit** | 16. Two from the build itself, neither in shipped code — the demo script's own environment setup, and a build-only typecheck failure that could not appear until the project first deployed; both are cases where the gate runs a *different* configuration than the one that broke. The other 14 are the review's, and all of them **had shipped** — the honest number on this row, and the argument for the review being a step rather than a favour. The remaining 14 of the 30 never survived a commit |
| **Capstone service** | 18 tables · 2 combination sets · 2 service periods · 1 blackout · 60 covers booked in advance, 88 on the book, 76 seated · all 7 PRD ugly cases · 28 assertions |
| **Double-seated tables** | 0 |
| **Stranded parties** | 0 |

Gate at close: `npm run gate` green on all five steps — lint, typecheck,
768 unit tests (7.4s), production build, 32 e2e.

**These figures are as of V-015 (2026-09-21), re-measured by running the suite
rather than by editing the previous row.** Every one of them had drifted
stale-low since the close of V-013 — the unit count by 145 — which is the
ordinary fate of a number a human types into a table. Re-run before quoting.
