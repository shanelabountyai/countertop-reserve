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

## Defects Found

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

## Skills Learned / Functions Unlocked

*(filled in as phases land.)*

## The Hardest Bug

*(reserved for the end.)*

## What I'd Do Differently

*(reserved for the end.)*

## By the Numbers

*(reserved for the end.)*

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

