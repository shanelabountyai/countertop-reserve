# Start here — running Countertop Reserve with Claude Code

This starter is V-000: the reviewed PRD (Draft v1, authored as Countertop's
C-034) and the working conventions in `CLAUDE.md`. Everything below is how to
drive the rest.

## The loop

One requirement per session, in phase order, no skipping ahead:

1. Read the requirement in `prd-countertop-reserve.md`, its user stories, and
   any *resolved* Open Question it touches.
2. Build it. Tests are part of the item, not a follow-up.
3. Run the gate: `npm run gate`
4. Mark the item ✅ in `docs/backlog.md`.
5. Add the entry to `docs/PROGRESS.md` — what it built, what it decided, what
   it left behind.
6. Add the entry to `docs/RELEASE_NOTES.md` — the portfolio-facing version,
   written for "walk me through something you built."
7. Commit (`V-00N: <thing>`). Record the SHA in a small follow-up commit,
   never by amending. One push for both. Watch CI green before saying done.

## Session 1 — V-001, the scaffold

> Read CLAUDE.md and prd-countertop-reserve.md fully. Then build V-001: the
> monorepo scaffold — Next.js App Router + TypeScript in apps/web, Prisma +
> Postgres in packages/db (default Prisma client output, never a custom
> path — see CLAUDE.md and the Countertop write-up's Prisma-bundling defect),
> an empty packages/core with the vitest wiring, Playwright + axe, and CI
> that (a) applies all migrations to a throwaway Postgres from scratch with a
> drift check and (b) runs the unit suite under TZ=Pacific/Kiritimati and
> TZ=UTC, asserting identical results. Create docs/PROGRESS.md,
> docs/RELEASE_NOTES.md, docs/WRITEUP.md (docs/backlog.md already exists,
> derived from the PRD's Timeline section — V-002 through V-013). Preserve
> CLAUDE.md's gate command exactly. Do not implement any domain logic yet.

## Session 2 — V-002, the floor model & availability engine (this project's slot engine)

The highest-defect-risk pure logic, same role C-002 played for Countertop.
TDD it before any schema or UI exists.

> Build V-002: packages/core's floor plan model and availability engine per
> P0-1 and P0-2. Tables with seat count, min party size, section, and
> declared (not inferred) combinable partner sets; turn time as one function
> of party size. The availability engine is pure, takes `now` as a parameter,
> and returns bookable times WITH A REASON when none are offered (`full`,
> `pacing`, `closed`, `too_large` — never a bare empty list). TDD: write the
> hand-calculated fixture matrix FIRST — the last table, a combination-only
> fit, a pacing-blocked bucket with tables free, a blackout date, a party
> larger than the largest legal combination, a turn that overhangs closing —
> and confirm every fixture fails before implementing.

## Session 3 — V-003, the data model

The highest-leverage session. Do not let it get rushed.

> Build V-003 from docs/backlog.md. Read the PRD's P0-3, P0-4, P0-11 and
> CLAUDE.md's Database rules first. Before writing the schema, show me: (1)
> the full entity list, (2) the exact unique constraint shape for
> `(table, turn window)` and the idempotency key, (3) how the snapshot
> columns on the reservation prove it renders with zero joins to the floor
> plan or message-template tables — and wait for my confirmation. Then write
> the schema, hand-write the migrations (append-only event log trigger
> included), and add tests that (a) book a reservation, mutate every
> referenced floor-plan row and template, and assert the reservation's stored
> data is byte-identical, and (b) attempt colliding table/turn-window and
> idempotency keys directly against the database and assert refusal.

The pause before the schema is the point: the allocation constraint is the
decision the whole product builds against.

## Sessions 4+ — follow the backlog

`docs/backlog.md` carries V-004 through V-013 in phase order: the lifecycle
state machine and booking placement (Phase 2), the message channel — outbound
templates, the inbound webhook, the deadline sweep, consent/quiet-hours
(Phase 3) — then the host floor view, service periods/pacing, the guest
booking flow, and the no-show report plus the seeded-service capstone
(Phase 4).

Session-3-style pauses to repeat: before V-007 (the inbound webhook),
confirm the keyword grammar and idempotency approach against the PRD's
Appendix B verbatim; before V-013's seeded service, confirm its ugly-case
list matches the PRD's Success Metrics verbatim, same discipline as
Countertop's C-017.

## The capstone

One command seeds an 18-table floor plan and runs a scripted dinner service:
60 covers across one period, including a change into a table that no longer
fits, a change to an unavailable time, two simultaneous bookings for the last
table, a STOP mid-thread, a number with two upcoming reservations, a webhook
redelivery, and a walk-in seated into a released no-show's table. Zero
double-seated tables, zero stranded parties. That recording is the portfolio
demo.
