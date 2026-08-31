# PRD: Countertop Reserve — Table Reservations with SMS Confirm & Change

**Sample business:** "Firebird Kitchen" grown a dining room — 18 tables, two seatings a night (works for any full-service restaurant)
**Builder:** Solo, in Claude Code
**Status:** Draft v1 — written against the conventions Countertop already runs on (integer cents, one status module, snapshot rule, `now` as a parameter, restaurant timezone as config)
**Relationship to Countertop:** a **separate product**, not a Countertop feature. Countertop's Non-Goals name "table reservations / dine-in service" explicitly. This PRD is what that adjacent product would be. Shared: money rules, time rules, the gate, the port table. Not shared: the menu model, the cart, the kitchen queue.
**Learning objectives:** capacity/inventory allocation under contention (tables ≠ slots), a two-way messaging channel as a first-class interface, consent and quiet-hours compliance as product requirements, state that changes because a *guest replied to a text*

---

## Problem Statement

A reservation that nobody confirms is a table nobody sits at. Full-service restaurants lose 10–20% of booked covers to no-shows (industry-reported range; treat as context, not a claim to verify in-app), and the standard fix — call every guest the afternoon of — costs a host an hour a day and reaches half of them. The phone is also where changes go to die: a guest who wants 7:30 instead of 7:00 calls during service, nobody picks up, and they either show up at the wrong time or don't show up at all.

Text is where the guest already is. A booking that confirms itself by reply, and a party size or time that a guest can change *by texting back*, converts the two most expensive host interactions into a channel that costs nothing and runs at 3am.

The builder-side problem: **allocation under contention** (a table can hold one party per turn, tables combine, and two people book the last 7:00 four-top simultaneously) and **an inbound channel that mutates state** — every prior project's writes came from a browser session the app controlled.

## Goals

1. A guest can book a table for a party size and time, and gets a text confirming it within seconds.
2. A guest can **confirm, change, or cancel by replying to that text** — no app, no login, no phone call.
3. The book never double-seats a table: capacity is allocated by the server, under a constraint, not by a check-then-write.
4. The host sees tonight's book on one screen and works it — seat, comp, waitlist, walk-in — at arm's length during service.
5. Unconfirmed reservations release themselves on a deadline, so the 7:00 four-top a guest forgot about becomes bookable again.
6. Every message the system sends is consented, quiet-hours-respecting, and honours STOP on the first attempt.
7. **(Builder goal)** Exercise contention-safe allocation, an inbound webhook that drives a state machine, and message templating with delivery state.

## Non-Goals

- **Online ordering / menus / pricing** — that is Countertop. A reservation carries no menu data.
- **Real SMS carrier integration** — a mock provider behind an interface, same convention as Countertop's payments. The outbox is real, the wire is stubbed.
- **Marketplace distribution** (Resy/OpenTable/Google inventory sync) — that is a two-way sync product, P2.
- **Deposits and card-hold no-show fees** — needs real payments; the hooks are P1-3.
- **Table-management-as-POS** (check firing, server sections, coursing) — adjacent, hardware-shaped.
- **Multi-location** — one restaurant, one floor plan.
- **Guest accounts / login** — the phone number is the identity; the manage link is tokenized, same pattern as Countertop's status page.

## Personas

- **Guest** — books from the website, then lives entirely inside a text thread.
- **Host** — owns the book and the door; works a tablet standing up, during service, with a line of people in front of them.
- **Manager/Owner** — sets the floor plan, service periods, pacing caps, blackouts, and message templates; reads no-show and cover reports.

## User Stories (priority order)

1. As a guest, I want to book a table for a party size, date and time in a few taps so that I stop calling during service.
2. As a guest, I want a **text confirming the booking immediately**, with the restaurant name, date, time, party size and what to do if plans change, so that I have a record I can find in my thread.
3. As a guest, I want to **reply to that text to confirm** so that I never have to answer a call to keep my table.
4. As a guest, I want to **change my time or party size by texting back** so that a plan change takes twenty seconds instead of a phone call nobody answers.
5. As a guest, I want to cancel by replying so that cancelling is easier than no-showing. *(cancelling must always be the path of least resistance — that is the whole no-show strategy)*
6. As a host, I want tonight's book on one screen, sorted by time, showing party size, table, tags and confirmation state, so that I can work the door without reading a spreadsheet.
7. As a host, I want to seat a party in one tap and see the floor's real state so that I know what is actually open when a walk-in asks.
8. As a host, I want to add a walk-in to a waitlist with a quoted range and **text them when the table is ready** so that people stop hovering at the podium.
9. As a manager, I want unconfirmed reservations to release automatically at a deadline I set so that forgotten bookings do not hold inventory.
10. As a manager, I want pacing limits (max covers seated per 15 minutes) so that the kitchen does not get 60 covers at 7:00.
11. As a manager, I want to edit the floor plan, turn times and service periods so that the availability engine reflects the real room.
12. As a manager, I want a no-show and cover report in my restaurant's timezone so that I can see whether the texts are working.
13. As a guest who texted STOP, I want to never hear from the system again, and still keep my reservation.

## Requirements

### Must-Have (P0)

**P0-1: Floor plan & capacity model** *(core learning artifact #1)*
Tables have a seat count, a min party size, a section, and an optional set of **combinable partners** (two 2-tops make a 4-top). Turn time is a function of party size, configurable (default: 1–2 guests 75 min, 3–4 guests 90 min, 5+ 120 min).
- [ ] A party of 4 can be seated on a 4-top, a 6-top (over-seating allowed with a configurable waste cap), or a legal combination of two 2-tops — never on a 2-top
- [ ] A table's min party size blocks seating a deuce at a 8-top when smaller tables exist
- [ ] Combinable sets are declared data, not inferred: `[T4, T5] → 4 seats`, and a combination consumes *every* member table for the turn
- [ ] Turn time comes from one function of party size; no caller computes its own
- [ ] Floor plan edits never mutate a booked reservation (snapshot rule — see P0-4)

**P0-2: Availability engine** *(core learning artifact #2 — pure, no database)*
Given a date, party size, a floor plan, service periods, existing reservations and pacing caps, return the bookable times.
- [ ] Pure function in `packages/core`, `now` supplied as a parameter, hand-calculated fixture matrix written before the implementation
- [ ] A time is bookable only if some table (or legal combination) is free for the full turn **and** the pacing cap for its 15-minute bucket is not exhausted
- [ ] Times outside a service period are not offered; a service period ending at 21:00 with a 90-minute turn stops offering 20:00 unless "last seating" is configured to allow overhang
- [ ] The engine returns *why* nothing is available (`full`, `pacing`, `closed`, `too_large`) — an empty list with no reason is a bug, because the UI has to say something true
- [ ] Fixtures include: the last table, a combination-only fit, a pacing-blocked bucket with tables free, a blackout date, a party larger than the largest legal combination, and a turn that overhangs closing

**P0-3: Booking placement, allocated under a constraint**
- [ ] Table assignment happens **server-side at placement**, inside the transaction, against a unique constraint on `(table, turn window)` — never a read-then-write
- [ ] Two simultaneous bookings for the last 7:00 four-top produce exactly one reservation and one clean "no longer available" — proven by a concurrent test, not by a disabled button
- [ ] Every booking carries a client-generated idempotency key with a unique constraint behind it; a double-submit returns the *same* reservation body, not just no duplicate
- [ ] Placement captures: guest name, phone (E.164), party size, requested time, allocated table(s), quoted turn, guest note (140 char cap), and tags (allergy / occasion / accessibility)
- [ ] A held table is released if placement fails at any later step — no orphan holds

**P0-4: Reservation lifecycle** *(one status module, same rule as Countertop)*
States: `booked → confirmed → seated → completed`; `booked|confirmed → cancelled` (guest or host); `booked|confirmed → no_show` (host, after a grace period); `booked|confirmed → released` (auto, on the confirmation deadline); `waitlisted → seated|abandoned`.
- [ ] The transition table lives in ONE module; every reader — the host list filters, the availability engine's "occupied" set, the reports, the messaging triggers — derives its status lists from it
- [ ] Invalid transitions rejected by reason; ≥8 invalid transitions asserted by reason in tests
- [ ] Every transition is timestamped and appended to an append-only event log (trigger-enforced); undo is a logged revert, never a delete
- [ ] `no_show`, `cancelled` and `released` are three different facts and never collapsed — "cancelled at 4pm" and "never showed" are opposite business signals
- [ ] The reservation is a **snapshot**: quoted time, party size, table, turn length and the text of every message sent are copied onto it. A floor-plan or template edit is provably invisible to a booked reservation (regression test)

**P0-5: Confirmation text — the message that goes out** *(the "txt for confirm")*
On placement, a confirmation message is queued through a `MessageProvider` interface (mock in v1, real carrier is a swap).
- [ ] The message renders from a **template with named slots** (restaurant, date, time, party size, manage link, reply keys) and the rendered body is snapshotted onto the reservation — a later template edit never rewrites history
- [ ] Rendered body is ≤ 320 characters (2 SMS segments) and the segment count is asserted in tests; the manage link is a tokenized ≥128-bit URL
- [ ] Delivery state is tracked: `queued → sent → delivered | failed`, with the provider's id and failure reason stored
- [ ] A failed send surfaces on the host's screen for that reservation — a guest who never got the text must not look "confirmed by silence"
- [ ] Messages are **idempotent per (reservation, message kind)**: a retry of the confirmation send never texts a guest twice
- [ ] Timeline: confirmation on booking; a reminder at a configurable lead (default T-24h, and T-3h for same-day bookings); nothing else unsolicited

**P0-6: Change and cancel by reply — the inbound channel** *(the "txt for change")*
An inbound webhook receives `(from_number, body, provider_message_id)` and drives P0-4 transitions.
- [ ] Keyword grammar, case- and whitespace-insensitive, documented in the outgoing text itself: `C` / `YES` → confirm; `X` / `CANCEL` → cancel; `CHANGE` → replies with the manage link; `STOP` / `UNSUB` → opt out; `HELP` → the restaurant's phone number
- [ ] A number with **more than one** upcoming reservation gets a disambiguating reply ("Reply 1 for Fri 7:00, 2 for Sat 8:30") — never a silent guess at which one they meant
- [ ] A number with **no** upcoming reservation gets a polite fallback with the booking link, not silence and not an error
- [ ] An unrecognised body gets one clarifying reply, and a second unrecognised body **hands off to the host** rather than looping a bot at a human
- [ ] Inbound is idempotent on the provider's message id — a webhook redelivery must not cancel a reservation twice or double-confirm
- [ ] A **party-size or time change is a re-allocation**, not an edit: it re-runs P0-2 and P0-3's constraint. If the new time is unavailable, the original reservation stands unchanged and the reply says so. There is no state where a guest has been released from their table and given nothing.
- [ ] Every inbound message and every action it caused is written to the event log — "the guest says they cancelled" is settled by data

**P0-7: Confirmation deadline & auto-release**
- [ ] A reservation unconfirmed by a configurable deadline (default: T-3h, and T-90m for same-day) transitions `booked → released` and its table returns to inventory
- [ ] The guest gets one release notice with a re-book link; the host list shows released rows for the rest of service (a guest who shows up anyway is a real event)
- [ ] Auto-release respects quiet hours (P0-8): it releases the table on time, and defers the *notice* — the inventory decision and the message are separate concerns
- [ ] The deadline is per-restaurant config, and 0 disables auto-release entirely

**P0-8: Consent, quiet hours, and STOP** *(not simplifiable — this one has a regulator)*
- [ ] Booking captures explicit consent to transactional texts; the checkbox text is stored with the reservation, not just the boolean
- [ ] `STOP` opts the number out **immediately and permanently** across all message kinds, is honoured before any other keyword parsing, and is confirmed once; the reservation itself is unaffected
- [ ] Quiet hours (default 21:00–09:00 restaurant time) defer non-urgent messages to the window's edge; "your table is ready" (P0-9) is exempt because the guest is standing outside
- [ ] Outbound rate limit per number per day (default 5), with the drop logged
- [ ] Every send checks opt-out state at send time, not at queue time

**P0-9: Host floor view** *(the arm's-length screen)*
- [ ] Tonight's book on one screen, grouped by service period, sorted by time; each row shows time, name, party size, table, confirmation state, tags, and elapsed-since-seated
- [ ] Seat / no-show / cancel are one tap each, with a 5-second undo; the seat control is the largest thing on the row
- [ ] Tap targets ≥48px, row text ≥18px equivalent, asserted by Playwright + axe (same discipline as Countertop's kitchen queue)
- [ ] Walk-in and waitlist entry from the same screen, with a quoted **range** never a point; "table ready" texts the waitlisted guest
- [ ] Live updates by polling a changes-since endpoint with a **server-issued cursor** (never the client's clock); background tabs pause
- [ ] Guest-facing tags are visually distinct by kind — an allergy is not styled like a birthday. *(Countertop's negation lesson: a warning rendered like decoration recreates the failure it exists to prevent.)*

**P0-10: Service periods, blackouts and pacing**
- [ ] Weekly service periods per day (lunch/dinner), a per-date override, and full-day blackouts; all in the restaurant's configured timezone
- [ ] Pacing cap = max covers seated per 15-minute bucket, configurable per service period
- [ ] "Last seating" is explicit config, not derived from closing time minus turn
- [ ] Editing hours shows a diff of only the days that move and warns about **already-booked reservations that would fall outside** the new hours — it never silently strands them *(the C-029 lesson)*

**P0-11: Time discipline** *(carried from Countertop's CLAUDE.md, unchanged)*
- [ ] Restaurant timezone is config; all bucketing, deadlines and day boundaries use it — never UTC, never the process timezone
- [ ] All instants are `timestamptz`; nothing in `packages/core` reads the system clock; `now` is a parameter
- [ ] The lint bans stay on: `new Date(string)`, `Date.parse`, `get/setHours`, `toISOString().slice(0,10)`, `getTimezoneOffset`
- [ ] Unit suite runs under `TZ=Pacific/Kiritimati` and `TZ=UTC` in CI with identical results

**P0-12: Guest-facing booking flow**
- [ ] Party size → date → time, with unavailable times shown as unavailable **with the reason**, not hidden
- [ ] Name, phone, consent, note (140 cap), tags; phone validated to E.164 before submit
- [ ] The tokenized manage page shows the live reservation and offers change/cancel — the same code path the SMS keywords call, not a parallel one
- [ ] A confirmed change re-texts the new details and supersedes the previous message on the manage page

### Nice-to-Have (P1)

- **P1-1: No-show & cover report** — covers booked vs. seated by day and 15-minute bucket, no-show rate by lead time and by confirmation state (does confirming actually predict showing?), release rate, waitlist conversion. Restaurant timezone; the seeded service is the regression fixture.
- **P1-2: Waitlist quoting from real data** — quote ranges from measured turn times instead of the configured default.
- **P1-3: Deposits / card hold for large parties** — mock payment provider, forfeit on `no_show`; the honest no-show fix once texts have taken the easy half.
- **P1-4: Large-party rules** — parties over N require approval, a longer lead time, or a different set of legal table combinations.
- **P1-5: Two-way host↔guest thread** — the host replies to a guest text from the floor view; the handoff in P0-6 currently ends in a to-do, not a conversation.
- **P1-6: Repeat-guest recognition** — "4th visit, allergic to shellfish, likes booth 12" on the row; phone number is already the identity.
- **P1-7: Template editor** — managers edit message copy with slot validation and a live segment count; P0-5 snapshots protect history.
- **P1-8: Standby list** — a guest who wanted a full 7:00 gets texted first when it opens, with a claim window.

### Future Considerations (P2)

- Real carrier adapter (Twilio/Sinch) behind the P0-5 interface — a swap, plus a 10DLC registration chore that is paperwork, not code
- Marketplace two-way sync (Resy/OpenTable/Google) — inventory in two places is a distributed-systems product, not a feature
- Server sections and coursing; POS table-state integration (the floor view stops guessing when the check is dropped)
- Multi-location with per-floor-plan availability
- Prepaid ticketed seatings for tasting menus (a different allocation model — inventory becomes a ticket, not a table)
- Voice/IVR fallback for guests who will never text back

## Success Metrics (evaluated against seeded demo data)

**Leading**
- Availability engine: 100% pass on the hand-calculated fixture matrix, including combination-only fits, pacing-blocked buckets and closing overhang
- Allocation: a concurrent-booking test on the last available table produces exactly one reservation, N-1 clean refusals, and zero orphan holds
- State machine: 100% of valid transitions plus ≥8 invalid transitions asserted **by reason**; `no_show`, `cancelled`, `released` never conflated
- Idempotency: the double-submit fixture produces one reservation and identical response bodies; a redelivered inbound webhook causes exactly one transition
- Snapshot integrity: editing the floor plan, turn times and every message template after booking produces zero changes to the reservation's stored data or rendered messages
- Compliance: a `STOP` is honoured on the next send attempt of every message kind, and quiet-hours deferral is asserted at a boundary minute

**Lagging (simulated)**
- A seeded service (60 covers across a dinner period) runs with zero double-seated tables and zero stranded parties — **and includes the ugly cases**: a guest changing party size by text into a table that no longer fits, a change request for an unavailable time (original must survive intact), two simultaneous bookings for the last table, a `STOP` mid-thread, an inbound from a number with two upcoming reservations, a webhook redelivery, and a walk-in seated into a released no-show's table
- No-show rate for confirmed vs. unconfirmed reservations is reportable and hand-tallies against the seed
- Every message the seed sends reconciles: queued = sent + deferred + dropped, with a reason on each drop

Measurement method: seed builds an 18-table floor plan with two legal combination sets, two service periods, one blackout date, and a scripted dinner service with the ugly cases above.

## Open Questions

- **(Product)** Does the guest pick a table, or only a time? V1: **time only**; table assignment is the house's job and exposing it invites gaming. *(resolved)*
- **(Product)** Auto-confirm on booking (skip `booked`), or require a reply? V1: **require a reply** — the confirmation step is the entire point of the SMS channel, and P0-7's release depends on it. A restaurant that hates it sets the deadline to 0. *(resolved)*
- **(Builder)** Where does a change land: SMS keyword parsing, or always bounce to the manage link? V1: **`CHANGE` sends the link**; only confirm/cancel/stop/help are parsed. Free-text time parsing ("can we do 8ish sat?") is an NLP project wearing a reservation costume. *(resolved)*
- **(Builder)** Poll interval for the floor view — fixed or backoff? V1: **fixed 10s** (a floor moves slower than a kitchen), noted in WRITEUP as a scaling caveat. *(resolved)*
- **(Product)** Over-seating waste cap — how far over is acceptable? V1: configurable, default 2 seats; it is the difference between a full room and a wasted six-top. *(non-blocking)*
- **(Product)** Should a released reservation be silently re-bookable by the same guest? V1: yes, via the re-book link; treat it as a new booking with a new allocation. *(non-blocking)*
- **(Ops)** Is a 21:00 quiet-hours start too early for a restaurant that seats until 22:00? Likely — the reminder cadence and quiet hours want operator input before Phase 3. *(open — worth an operator review, same as Countertop's v2 addendum)*

## Timeline / Phasing

- **Phase 1:** P0-1, P0-2 (floor model + availability engine) — pure logic in `packages/core`, TDD from the fixture matrix, no database, no UI. This is this project's slot engine.
- **Phase 2:** P0-3, P0-4, P0-11 (schema, hand-written migrations, allocation constraint, lifecycle module, event-log trigger). **Pause for schema review before writing it** — the `(table, turn window)` constraint is the decision the whole product builds against.
- **Phase 3:** P0-5, P0-6, P0-7, P0-8 (the message channel: outbound templates and delivery state, the inbound webhook and its grammar, the deadline sweep, consent and quiet hours). The mock provider is a queue table and a fake webhook poster — the tests drive it end to end.
- **Phase 4:** P0-9, P0-10, P0-12 (host floor view, service periods and pacing, guest booking flow), then P1-1 and the seeded service as the capstone demo.

## Build Notes for Claude Code

- **TDD the availability engine before anything else.** Table combinations and pacing caps are where the hand-calculated fixtures earn their keep, exactly as the price engine did in Countertop.
- **Allocation is a database constraint, not application logic.** The unique constraint on `(table, turn window)` is the mechanism; the greyed-out time is UX. Map the violation to a clean refusal and test it under the seeded service, same discipline as Countertop's `(businessDay, seq)`.
- **The snapshot rule extends to messages.** A reservation stores the *rendered* text it sent. Chasing a template FK to render history is the same defect class as joining an order to a live menu row.
- **One status module.** Host filters, the availability engine's occupied set, the message triggers and the reports all derive their status lists from it. Adding `released` must make the compiler find every reader.
- **Inbound is a trust boundary.** Validate the provider signature, treat the body as hostile, parse keywords with an allowlist, and make every handler idempotent on the provider's message id. This is the first project here where a stranger can move state.
- **A change is a re-allocation.** The tempting shortcut — free the old table, then book the new one — has a window where the guest owns nothing. Allocate the new one first, or do both inside one transaction.
- **Quiet hours defer the message, never the state change.** Keep the inventory decision and the notification on separate paths or the two will get tangled the first time someone books at 2am.
- Countertop owns port 3400; this project takes **3500** and adds its row to the port table in the same commit that creates its config.

---

## Appendix A — Message templates (the texts, verbatim)

Slots in `{braces}`. Segment counts assume GSM-7 (160 chars per segment, 153 when concatenated); every template is asserted ≤2 segments in tests.

**A1 — Confirmation (sent on booking)**
```
{restaurant}: table for {party} on {day} {time}. Reply C to confirm,
X to cancel, CHANGE to reschedule. {manage_link}
```
*Example:* `Firebird Kitchen: table for 4 on Fri Sep 12, 7:00 PM. Reply C to confirm, X to cancel, CHANGE to reschedule. https://…/r/8fK2…` — 148 chars, 1 segment.

**A2 — Confirmed (reply to `C`)**
```
Confirmed — {party} on {day} {time}. See you then. Reply X to cancel
or CHANGE to reschedule.
```

**A3 — Reminder (T-24h, or T-3h same-day; skipped if already confirmed and within 6h)**
```
{restaurant}: reminder, {party} tonight at {time}. Reply C to confirm,
X if plans changed. {manage_link}
```

**A4 — Change requested (reply to `CHANGE`)**
```
Change your {day} {time} booking here: {manage_link} — the link holds
your current table until you submit.
```

**A5 — Change confirmed (after re-allocation succeeds)**
```
Updated — {party} on {new_day} {new_time}. Your previous {old_time}
booking is released.
```

**A6 — Change failed (re-allocation refused; the original stands)**
```
{new_time} isn't available for {party}. Your {old_time} booking is
unchanged. Other times: {manage_link}
```

**A7 — Cancelled (reply to `X`, or from the manage page)**
```
Cancelled — {day} {time}. Thanks for letting us know. Book again
anytime: {book_link}
```

**A8 — Auto-release (deadline passed, deferred out of quiet hours)**
```
{restaurant}: we released your {day} {time} table since we didn't hear
back. Still want it? {book_link}
```

**A9 — Disambiguation (inbound from a number with 2+ upcoming reservations)**
```
You have 2 upcoming: 1) {day_a} {time_a}, 2) {day_b} {time_b}.
Reply with the number, then C or X.
```

**A10 — No matching reservation**
```
We don't see an upcoming reservation for this number. Book here:
{book_link}
```

**A11 — Unrecognised (first time only; a second unrecognised body hands off to the host)**
```
Sorry — I only understand C (confirm), X (cancel), CHANGE, or HELP.
```

**A12 — Waitlist ready (quiet-hours exempt)**
```
{restaurant}: your table is ready. Please come to the host stand in
the next 10 minutes.
```

**A13 — HELP (required)**
```
{restaurant} reservations. Reply C to confirm, X to cancel, CHANGE to
reschedule, STOP to opt out. Call {phone}.
```

**A14 — STOP acknowledgement (required, sent once, then silence)**
```
You're opted out and won't get more texts. Your {day} {time} booking
is unchanged — call {phone} to change it.
```

## Appendix B — Inbound keyword grammar

Parsed in this order; the first match wins. Comparison is case-insensitive on the trimmed body with punctuation stripped.

| Input | Action | Reply |
|---|---|---|
| `STOP`, `STOPALL`, `UNSUBSCRIBE`, `UNSUB`, `CANCELALL`, `QUIT`, `END` | opt out permanently; reservation untouched | A14, then silence |
| `START`, `UNSTOP` | opt back in | A13 |
| `HELP`, `INFO` | none | A13 |
| `C`, `Y`, `YES`, `CONFIRM`, `OK` | `booked → confirmed` | A2 |
| `X`, `N`, `NO`, `CANCEL` | `booked\|confirmed → cancelled` | A7 |
| `CHANGE`, `RESCHEDULE`, `MOVE` | none (link only) | A4 |
| `1`–`9` while a disambiguation is pending (5-minute window) | selects that reservation, then re-parses the next message | — |
| anything else | none | A11 once, then host handoff |

`STOP` is evaluated **before** reservation lookup, so an opt-out from a number with no reservation still works.
