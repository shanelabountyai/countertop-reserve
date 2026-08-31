# Backlog — Countertop Reserve

One line per requirement, derived from `prd-countertop-reserve.md`'s Timeline
/ Phasing section. One item per session, in order, no skipping ahead. Mark
✅ when the gate passes and the PROGRESS/RELEASE_NOTES entries are written.

The gate, unchanged for every item:

```
npm run gate    # lint, typecheck, build, e2e, unit — in that order
```

## Phase 1 — pure logic, tested before any UI or database exists

- [ ] **V-001** — Monorepo scaffold, Postgres wiring, Playwright + axe, CI (TZ×2, migrate-from-scratch, drift check), the four docs. Same shape as Countertop's C-001; port **3500**, add the row to the shared port table in `~/.claude/CLAUDE.md` in this commit.
- [ ] **V-002** — Floor plan model + availability engine *(P0-1, P0-2)* — `packages/core`, pure, TDD from the hand-calculated fixture matrix: the last table, a combination-only fit, a pacing-blocked bucket with tables free, a blackout date, a party larger than the largest legal combination, a turn that overhangs closing. The engine returns *why* nothing is available, not just an empty list.

## Phase 2 — the reservation as a persisted object

- [ ] **V-003** — Data model + hand-written migrations *(P0-3 allocation constraint, P0-11)* — unique constraint on `(table, turn window)`, idempotency-key unique constraint, append-only event-log trigger. **Pause for schema review before writing it** — the PRD names this the decision the whole product builds against.
- [ ] **V-004** — Reservation lifecycle state machine *(P0-4)* — one module in `packages/core`, full transition table (`booked/confirmed/seated/completed`, `cancelled`, `no_show`, `released`, `waitlisted`), every reader-facing status list exported from it, `now` as a parameter.
- [ ] **V-005** — Booking placement, allocated under the constraint *(P0-3)* — server-side allocation inside the transaction, concurrent-booking test on the last table (exactly one reservation, N-1 clean refusals, zero orphan holds), idempotency key honoured, full snapshot captured.

## Phase 3 — the message channel

- [ ] **V-006** — Confirmation text — outbound templates & delivery state *(P0-5)* — `MessageProvider` interface (mock in v1), named-slot templates, rendered body snapshotted onto the reservation, ≤320 chars / 2 segments asserted, `queued → sent → delivered|failed` tracked, idempotent per `(reservation, message kind)`.
- [ ] **V-007** — Change and cancel by reply — the inbound webhook *(P0-6)* — signature validation, keyword allowlist (confirm/cancel/`CHANGE`→manage link/stop/help), idempotent on the provider's message id, disambiguation for a number with more than one upcoming reservation, a change is a re-allocation (original stands unchanged if the new time doesn't fit).
- [ ] **V-008** — Confirmation deadline & auto-release *(P0-7)* — sweep on a configurable deadline, table returns to inventory immediately, release notice deferred separately by quiet hours (inventory decision and notification on separate paths).
- [ ] **V-009** — Consent, quiet hours, and STOP *(P0-8)* — consent text stored with the reservation, STOP honoured before any other keyword parsing and confirmed once, quiet-hours deferral (with the "table's ready" exemption), per-number daily rate limit, opt-out checked at send time.

## Phase 4 — the two live surfaces, then the capstone

- [ ] **V-010** — Host floor view *(P0-9)* — grouped by service period, seat/no-show/cancel one tap with 5s undo, ≥48px tap targets asserted by Playwright + axe, walk-in/waitlist from the same screen with quoted ranges, server-issued polling cursor, tags visually distinct by kind.
- [ ] **V-011** — Service periods, blackouts and pacing *(P0-10)* — weekly periods + per-date overrides + blackouts in restaurant timezone, pacing cap per 15-minute bucket, explicit "last seating," hours-edit diff warning for reservations that would fall outside new hours.
- [ ] **V-012** — Guest-facing booking flow *(P0-12)* — party size → date → time with unavailable times shown with their reason, E.164 phone validation, tokenized manage page sharing the same code path as the SMS keywords.
- [ ] **V-013** — No-show & cover report *(P1-1)*, plus the seeded service capstone demo — 60 covers / one dinner period including the ugly cases the PRD's Success Metrics names verbatim (a change into a table that no longer fits, a change to an unavailable time, two simultaneous bookings for the last table, a STOP mid-thread, a number with two upcoming reservations, a webhook redelivery, a walk-in into a released no-show's table). Zero double-seated tables, zero stranded parties. **Confirm the ugly-case list against the PRD verbatim before building**, same discipline as Countertop's C-017.

## Deferred by decision (not backlog)

P1-2 through P1-8 (waitlist quoting from real data, deposits/card holds,
large-party rules, two-way host↔guest thread, repeat-guest recognition,
template editor, standby list), and everything in the PRD's P2 list (real
carrier adapter, marketplace sync, POS integration, multi-location, ticketed
seatings, voice/IVR). Revisit only if a specific learning objective needs one
of them — none is required for the capstone demo.

**The one Open Question left genuinely open** (not resolved, unlike the
others): is 21:00 too early a quiet-hours start for a restaurant seating
until 22:00? Wants an operator review before Phase 3 (V-009), not before.
