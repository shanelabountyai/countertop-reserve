# Countertop Reserve — Table Reservations with SMS Confirm & Change

Table reservations for a full-service restaurant (sample: "Firebird Kitchen,"
same restaurant as Countertop, grown a dining room). Learning project #6,
adjacent to but separate from Countertop — Countertop's Non-Goals name table
reservations explicitly. Same idiom as storage (`B-`), rental (`R-`),
Bookable (`A-`), BoxLoop (`S-`), Countertop (`C-`); this project's items are
`V-`.

## How to work in this repo

- Product source of truth: `prd-countertop-reserve.md` (Draft v1). Its Open
  Questions marked *resolved* are settled — never re-open them; the one
  marked *open* (quiet-hours start time) wants an operator review before
  Phase 3, not before.
- Stack: Next.js (App Router) + TypeScript, Postgres + Prisma, Tailwind +
  shadcn, Vitest/Playwright + axe, Vercel target — same as Countertop.
  Monorepo: `apps/web`, `packages/core` (domain logic — the availability
  engine, allocation rules, message-state and reservation-lifecycle
  machines live here as pure functions), `packages/db` (Prisma schema +
  hand-written migrations where constraints are involved).
- **This repo owns port 3500** (storage 3000, rental 3100, event toolkit
  3200, bookable 3300, Countertop 3400) — config default, never a
  command-line override. Update the shared port table in `~/.claude/CLAUDE.md`
  if this ever changes.
- Money is **integer cents**, always, same rounding function as Countertop —
  reservations carry no priced items, but deposits/no-show fees are P1-3 and
  will need it.
- Build order: the PRD's Timeline / Phasing section, one requirement per
  session. After completing an item: run the gate → mark it in
  `docs/backlog.md` → add its entry to `docs/PROGRESS.md` → add its entry to
  `docs/RELEASE_NOTES.md` (portfolio-facing) → commit (`V-001: ...`) → record
  the SHA in a follow-up commit, never by amending → one push for both
  commits → watch CI green before saying "done."
- `docs/WRITEUP.md` exists from commit one, same rules as Countertop's:
  scaling caveats, deliberate simplifications, and defects found go in as
  they happen, not at the end.

## The invariants this project exists to practice

**Allocation is a database constraint, not application logic.** A unique
constraint on `(table, turn window)` is the mechanism; a greyed-out time slot
in the UI is just UX. Concurrent bookings for the last table contend on the
constraint, not on a check-then-write — map the violation to a clean refusal
and test it under the seeded service, same discipline as Countertop's
`(businessDay, seq)`.

**The snapshot rule extends to messages.** A reservation stores the
*rendered* text it sent, not a template FK. Chasing a template's live
content to render history is the same defect class Countertop's snapshot
rule exists to prevent for orders — floor-plan edits, turn-time changes, and
message-template edits after a reservation is booked must be provably
invisible to what was already sent and stored.

**One status module.** The reservation lifecycle (`booked → confirmed →
seated → completed`, plus `cancelled`, `no_show`, `released`, and logged
reverts) lives in ONE module in `packages/core`. Host filters, the
availability engine's occupied-table set, message triggers, and reports all
derive their status lists from it. Adding `released` must make the compiler
find every reader, not grep.

**Inbound is a trust boundary — the first project here where a stranger can
move state.** Every prior project's writes came from a browser session the
app controlled. Validate the provider's signature, treat the message body as
hostile, parse keywords with an allowlist (confirm/cancel/change/stop/help
only — free-text time parsing is out of scope, `CHANGE` always bounces to the
tokenized manage link), and make every handler idempotent on the provider's
message id so a redelivered webhook causes exactly one transition.

**A change is a re-allocation, not free-then-book.** Freeing the old table
before booking the new one leaves a window where the guest owns nothing.
Allocate the new one first, or do both inside one transaction.

**Quiet hours defer the message, never the state change.** Keep the
inventory decision and the notification on separate paths, or a 2am booking
tangles the two the first time it happens.

**One availability function, two constraints.** "Is this table/time
combination bookable right now?" answers through table capacity/combination
fit AND the pacing cap (max covers per 15-minute bucket) — one function in
`packages/core` that the guest booking flow, the host's floor view, and
change requests all call.

## Time rules

- The restaurant's timezone is a config value, shared with Countertop's
  approach — never UTC, never the server's process timezone. Reports and
  service-period bucketing use it.
- Reservation timestamps are instants (`timestamptz`); every engine function
  takes `now` as a parameter. Nothing in `packages/core` reads the system
  clock.
- The floor view's poll interval is fixed at 10s (a floor moves slower than
  a kitchen queue) — noted in `docs/WRITEUP.md` as a scaling caveat, not
  built as a backoff.
- Same lint bans as Countertop: `new Date(string)`, `Date.parse`,
  `get/setHours`, `toISOString().slice(0,10)`, `getTimezoneOffset`.

## Database rules

- The `(table, turn window)` allocation constraint is a hand-written
  migration, never `db push`. **Pause for schema review before writing
  it** — the PRD calls this out as the decision the whole product builds
  against.
- Reservation snapshot tables carry copied guest/message data as columns. FKs
  back to floor-plan or template tables, if kept for analytics, are
  `onDelete: Restrict` and never read for display.
- The reservation event log is append-only (trigger, same pattern as
  Countertop), including transitions driven by an inbound SMS reply.
- Migrations with constraints/triggers are hand-written
  (`prisma migrate dev --create-only`, then edit). Never edit an applied
  migration.

## Traps that only fail at runtime

- **A table combination is inventory, not a display detail.** Two two-tops
  combined into a four-top occupy both underlying tables — the availability
  engine and the allocation constraint both need to know that, or a
  combination booking can double-seat one of its own halves.
- **A change into a size that no longer fits must leave the original
  intact.** Reject the change, don't half-apply it.
- **A webhook redelivery is not a new message.** Idempotency keys on the
  provider's message id, checked before any state transition, not just
  before any message send.
- **STOP must survive everything.** Honoured on the next send attempt of
  every message kind, and it does not cancel the reservation — opting out of
  texts and cancelling a table are different guest intents.
- **A released table is immediately real inventory**, not a flag someone
  sweeps later — a walk-in must be seatable into a table a deadline just
  freed, same session.

## The gate

Nothing is done until all five pass:

```
npm run gate    # = lint && typecheck && test && build:test && test:e2e
```

Same shape as Countertop's: the build is its own step, e2e runs against a
production build (`E2E_DEV=1` for dev-server debugging), CI applies all
migrations to a throwaway Postgres from scratch with a drift check, and runs
the unit suite under two hostile timezones expecting identical results.

The seeded service (60 covers, one dinner period, the ugly cases from the
PRD's Success Metrics) is both the capstone demo and a test. Zero
double-seated tables, zero stranded parties.

## Test suite rules

- Every engine test supplies a frozen `now`.
- Availability fixtures are hand-calculated: table-only fits,
  combination-only fits, pacing-blocked buckets, closing overhang.
- Allocation: a concurrent-booking test on the last available table produces
  exactly one reservation, N-1 clean refusals, zero orphan holds.
- State-machine tests enumerate the full transition table — valid AND ≥8
  invalid transitions asserted by reason.
- Snapshot regression: book a reservation, then mutate the floor plan, turn
  times, and every message template, then assert the reservation's stored
  data and rendered messages are byte-identical.
- Compliance: STOP honoured on the next send attempt of every message kind;
  quiet-hours deferral asserted at a boundary minute.
