# Backlog — Countertop Reserve

One line per requirement, derived from `prd-countertop-reserve.md`'s Timeline
/ Phasing section. One item per session, in order, no skipping ahead. Mark
✅ when the gate passes and the PROGRESS/RELEASE_NOTES entries are written.

The gate, unchanged for every item:

```
npm run gate    # lint, typecheck, build, e2e, unit — in that order
```

## Phase 1 — pure logic, tested before any UI or database exists

- [x] **V-001** — Monorepo scaffold, Postgres wiring, Playwright + axe, CI (TZ×2, migrate-from-scratch, drift check), the four docs. Same shape as Countertop's C-001; port **3500**, add the row to the shared port table in `~/.claude/CLAUDE.md` in this commit.
- [x] **V-002** — Floor plan model + availability engine *(P0-1, P0-2)* — `packages/core`, pure, TDD from the hand-calculated fixture matrix: the last table, a combination-only fit, a pacing-blocked bucket with tables free, a blackout date, a party larger than the largest legal combination, a turn that overhangs closing. The engine returns *why* nothing is available, not just an empty list.

## Phase 2 — the reservation as a persisted object

- [x] **V-003** — Data model + hand-written migrations *(P0-3 allocation constraint, P0-11)* — exclusion constraint on `(table, [start, end))` overlap (decided at review over a literal unique, see PROGRESS), idempotency-key unique constraint, append-only event-log trigger. **Pause for schema review before writing it** — the PRD names this the decision the whole product builds against.
- [x] **V-004** — Reservation lifecycle state machine *(P0-4)* — one module in `packages/core`, full transition table (`booked/confirmed/seated/completed`, `cancelled`, `no_show`, `released`, `waitlisted`), every reader-facing status list exported from it, `now` as a parameter.
- [x] **V-005** — Booking placement, allocated under the constraint *(P0-3)* — server-side allocation inside the transaction, concurrent-booking test on the last table (exactly one reservation, N-1 clean refusals, zero orphan holds), idempotency key honoured, full snapshot captured.

## Phase 3 — the message channel

- [x] **V-006** — Confirmation text — outbound templates & delivery state *(P0-5)* — `MessageProvider` interface (mock in v1), named-slot templates, rendered body snapshotted onto the reservation, ≤320 chars / 2 segments asserted, `queued → sent → delivered|failed` tracked, idempotent per `(reservation, message kind)`. *Moved out: the T-24h/T-3h reminders → V-008 (same sweep); the failed-send badge on the host's row → V-010.*
- [x] **V-007** — Change and cancel by reply — the inbound webhook *(P0-6)* — signature validation, keyword allowlist (confirm/cancel/`CHANGE`→manage link/stop/help), idempotent on the provider's message id, disambiguation for a number with more than one upcoming reservation, a change is a re-allocation (original stands unchanged if the new time doesn't fit). *STOP's opt-out record and single acknowledgement landed here with the grammar; V-009 keeps the send-time check. The A5/A6 change-result texts → V-012, whose manage page is the only caller of `changeReservation`.*
- [x] **V-008** — Confirmation deadline & auto-release *(P0-7)* — sweep on a configurable deadline, table returns to inventory immediately, release notice deferred separately by quiet hours (inventory decision and notification on separate paths). Plus P0-5's reminder texts (default T-24h, T-3h for same-day bookings), carried from V-006 because they need the same scheduled sweep. *The sweep also dispatches every queued message (confirmations and inbound replies had no scheduled sender). Carried to V-012: a change is judged against the reservation's original `createdAt`, so a change made after the NEW time's deadline would be released on the next sweep — the change must count as the guest's confirmation.*
- [x] **V-009** — Consent, quiet hours, and STOP *(P0-8)* — consent text stored with the reservation, STOP honoured before any other keyword parsing and confirmed once *(parsed, recorded in `SmsOptOut` and acknowledged once by V-007; V-009 adds the send-time check in `dispatchQueued`, exempting the `opted_out` acknowledgement itself)*, quiet-hours deferral (with the "table's ready" exemption), per-number daily rate limit, opt-out checked at send time. *Quiet-hours scope decided at kickoff (PRD Open Questions). The "table's ready" exemption has no message kind yet — V-010 adds `table_ready` and must add it to `sendDecision`'s quiet-hours exemption.*

## Phase 4 — the two live surfaces, then the capstone

- [x] **V-010** — Host floor view *(P0-9)* — *From V-009: the `table_ready` kind (CHECK + MESSAGE_KINDS) is exempt from quiet hours in `sendDecision` (P0-8); a failed row's reason may be `opted_out` or `rate_limited`, not only a carrier refusal.* grouped by service period, seat/no-show/cancel one tap with 5s undo, ≥48px tap targets asserted by Playwright + axe, walk-in/waitlist from the same screen with quoted ranges, server-issued polling cursor, tags visually distinct by kind, and a failed confirmation text shown on its reservation (P0-5, carried from V-006) — a guest who never got the text must not look confirmed by silence. *Also: walk-ins skip pacing; a shared-passcode gate on /host (ported from Countertop C-037, decided at kickoff); `?day=` views another day's book.*
- [x] **V-011** — Service periods, blackouts and pacing *(P0-10)* — weekly periods + per-date overrides + blackouts in restaurant timezone, pacing cap per 15-minute bucket, explicit "last seating," hours-edit diff warning for reservations that would fall outside new hours. *Also: two exclusion constraints refuse overlapping periods; `/host/hours` edits them behind the existing passcode; an edit that would strand a booked party is shown, not saved, until forced.*
- [x] **V-012** — Guest-facing booking flow *(P0-12)* — *From V-011: `PlacementConfig.schedule` now comes from `loadSchedule(RESTAURANT.timezone)` (`@reserve/db/schedule`) — the booking route must read it per request, never cache a Schedule, or an hours edit stops reaching the guest flow.* — party size → date → time with unavailable times shown with their reason, E.164 phone validation, tokenized manage page sharing the same code path as the SMS keywords. *From V-008: a guest-driven change of a `booked` reservation must confirm it (or otherwise stop the sweep releasing it against the new time's deadline).* *Landed: `changeReservation` does it through the lifecycle module for any non-host source. Also here: `(reservationId, kind)` unique is now PARTIAL — `change_confirmed`/`change_failed` are per-change — and it is declared in the migration only, so `findUnique({ reservationId_kind })` no longer exists.*
- [x] **V-013** — No-show & cover report *(P1-1)*, plus the seeded service capstone demo — 60 covers / one dinner period including the ugly cases the PRD's Success Metrics names verbatim (a change into a table that no longer fits, a change to an unavailable time, two simultaneous bookings for the last table, a STOP mid-thread, a number with two upcoming reservations, a webhook redelivery, a walk-in into a released no-show's table). Zero double-seated tables, zero stranded parties. **Confirm the ugly-case list against the PRD verbatim before building**, same discipline as Countertop's C-017.

## Phase 5 — post-v1: the floor gets a table board

Added after v1 closed. Spec: `prd-countertop-reserve.md` → *Addendum v1.1*.
Two items, deliberately split so the read-only half can ship and be used
before any new write path exists.

- [x] **V-016** — Table board *(P0-13)* — a table-major view of the current
  service: `tableStates()` in `packages/core` alongside `availability()`,
  four states (`free` / `occupied` / `reserved_soon` / `blocked`) forced
  exhaustive by the compiler, combinations as their own inventory rows that
  block their members and are blocked by them, and **every `free` carrying
  its free-until** — a table free now but held in 40 minutes is not free for
  a 90-minute walk-in, and a bare green dot is the defect the spec exists to
  prevent. Reuses P0-9's 10s cursor rather than adding a second poll.
  Hand-calculated fixtures before implementation.
- [x] **V-017** — Manual assignment *(P0-14)* — the host names the unit, the
  same transaction still decides: identical advisory lock, schedule re-read
  under the lock, and constraint, with `firstUnit(units)` becoming "this
  unit, if it is in `units`". A unit outside the fitting set is refused with
  a named reason, never forced. Moves are one transaction (acquire new,
  then release old) and a failed move leaves the party where it was.
  *Resolved at spec time: a `seated` party may be moved, and the turn window
  carries from the original seat event rather than restarting — the new unit
  must be free for the remainder only.* Pacing applies to assigning a future
  reservation but not to seating someone already in the building; assert
  both ways. Concurrency test on one unit: exactly one assignment, one clean
  refusal. Snapshot regression: assign, move, re-assign, then assert stored
  messages are byte-identical.
- [x] **V-018** — The restyle — the approved design canvas applied to every
  screen: Archivo over Zilla Slab, the `#E9E5DF` ground and `#FFFDF9`
  surface, square corners, 3px ink card borders, and the five semantic
  colour roles (danger / attention / fresh / settled / hairline) carrying
  meaning that words already carry — never colour alone. One staff chrome
  shared by the four host screens. `/host/design` is new: the token and
  primitive sheet, rendered from the same classes the screens use, so a
  drifted token is visible rather than argued about. Every axe assertion
  stays green, the 18px staff floor and 48px target floor stay asserted,
  and no copy changes — this item may not touch behaviour.

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
