# Release Notes — Countertop Reserve

The portfolio-facing history: one entry per backlog item, written for "walk
me through something you built." `docs/PROGRESS.md` is the mechanical
version of the same history.

---

## V-001 — Project scaffold, built on top of a finished sibling project's scars

This is the second restaurant project built on this stack — Countertop
(online ordering) shipped first, and its `WRITEUP.md` has a defects section
naming exactly what went wrong along the way. The interesting question for a
scaffold session isn't "does this work," it's "which of those defects can
this project simply not have."

**A bundled Prisma client cost Countertop three failed deploys.** Its
schema generated the client into a custom path beside the schema file
(`packages/db/generated/client`), which reads nicely — until you notice a
custom path is imported by relative path, and a relative import has no
package name to hand to Next's `serverExternalPackages`. Turbopack bundled
it, and a bundled Prisma client can't find its own query engine binary at
runtime — a failure that is invisible locally (dev server doesn't bundle;
the e2e build runs on the same machine that generated the engine) and only
shows up as a 500 on a deployed page. This project's schema has no custom
output path. Not a fix — there was never a bug to fix, because the mistake
never got made.

**A missing lock file would have broken CI on the first run.** Countertop's
drift-check step failed on its very first CI execution: with zero
migrations written, Prisma had no `migration_lock.toml` to determine a
connector from, and the "no difference" check isn't a no-op on an empty
directory, it's an error. The fix there was a follow-up commit. Here, the
file exists from the first commit.

**The rest of the scaffold is a known-good template, not a rediscovery.**
Next.js App Router + TypeScript + Tailwind, the same restaurant-timezone
ESLint bans (`new Date(string)`, `Date.parse`, the `get/set*` accessors,
`getTimezoneOffset`, UTC-day slicing — carried forward through two projects
now), Playwright + axe from commit one, and a CI workflow that builds a
throwaway Postgres from nothing and demands the unit suite pass identically
under `TZ=UTC` and `TZ=Pacific/Kiritimati`. The production-build gate step
Countertop only added after two separate bundler-only failures (C-024) is
here from the start, because there was no reason to wait for the same
lesson twice.

**What's actually new:** a floor plan and an availability engine that has to
answer "why not," not just "not now" — the next session's work, not this
one's.

---

## V-002 — An availability engine that says *why not*

Most booking widgets answer "is 7:00 open?" with a greyed-out button. This
engine answers with a reason for every time it won't offer: already past,
outside service hours, every fitting table taken, or the kitchen's pacing
cap for that 15 minutes is spent. When the whole night is unavailable it
still names the reason: closed, fully booked, or a party too large (or too
small) for any table.

**Tables combine, and a combination is real inventory.** Two two-tops pushed
together make a four-top, but only while both halves are free. The
fixture that proves it had a flaw the first time round. It booked the
combination's *first* table, so an engine that only checked the first table
of a combination passed too. A deliberate mutation of the engine caught the
gap before commit, and the fixture now books the second table.

**Pacing blocks a time even when tables are free.** Eight covers per 15
minutes means a 6:00 bucket holding seven guests refuses a party of two,
while the four-top across the room sits empty. That's the point: the
kitchen is the constraint, not the floor.

Pure TypeScript, no database, no clock. `now` is a parameter, and the whole
suite passes identically in UTC and in Kiritimati (UTC+14).

## V-003 — The database, not the app, decides who gets the last table

The spec said "a unique constraint on (table, turn window)." Taken
literally, that constraint lets two parties share a table. A four-top
booked 7:00–8:30 and another booked 7:30–9:00 have *different* windows, so
a uniqueness check sees nothing wrong. Turn lengths depend on party size,
so windows almost never line up exactly.

The fix is a Postgres **exclusion constraint**: a rule that no two holds on
the same table may *overlap* in time. Combined tables are handled the same
way, because booking two joined tables writes a hold on each. A test fires
eight simultaneous bookings at the last open table: one wins, seven are
refused, and nothing is left half-booked. Back-to-back seatings (one ends
at 8:30, the next starts at 8:30) still fit, because a window includes its
start and excludes its end.

The other rule the database now enforces: the reservation history can only
be added to, never edited or deleted. Undoing a change writes a new "undo"
entry, so the record of what happened is always complete.


## V-004 — One rulebook for what can happen to a reservation

A reservation moves through a fixed set of stages: booked, confirmed,
seated, completed. It can also end as cancelled, no-show or released (never
confirmed in time), and a walk-in can sit on the waitlist. All of these
rules now live in one place. The host screen, the text-message replies,
the availability search and the reports all read their lists from it, so
they cannot drift apart.

The rules also say *who* may do what. A guest texting in can confirm or
cancel their own booking, but cannot mark themselves seated. Only the
automatic sweep can release an unconfirmed table, and it can never release
a guest who has confirmed. Every refusal comes back with a specific reason,
such as "too early to call a no-show" or "that reservation is already
finished," so the screen can say something true.

The host's 5-second undo for seat, no-show and cancel is a new entry in the
history, never an erasure. The tests check every combination of starting
stage, target stage and actor (243 of them) against a list written straight
from the spec.


## V-005 — Booking a table, safely, when everyone wants the same one

A booking now picks its table on the server at the moment it is saved.
The guest never chooses from a list that might already be stale. It tries
the best-fitting table first, then the next best, and the database has the
final say on each one. If eight people press "book" for the last 7:00 table
at the same instant, one gets it and seven are told it is no longer
available. Nothing is left half-booked.

The kitchen's per-15-minute cover limit holds under the same pressure.
Five simultaneous bookings for a slot with room for four covers get exactly
two tables, even with five tables free.

Pressing "book" twice, or a phone retrying on a bad connection, returns the
same reservation rather than creating a second one. Each booking stores its
own copy of what was agreed: name, phone number, party size, time, table,
how long the table is held, a short note (140 characters at most), and
flags for allergies, occasions and accessibility needs.

## V-006 — The confirmation text

Every booking now comes with a text message, written at the moment the
table is booked: "Firebird Kitchen: table for 4 on Fri, Oct 2 at 7:00 PM.
Reply C to confirm, X to cancel, CHANGE to change. Manage: <link>". The
booking and its text are saved together. There is never a booking without
its confirmation, or a confirmation for a booking that did not happen.

The text is kept exactly as sent. If the restaurant later rewords its
messages, changes its tables or changes how long a table is held, the
guest's record still shows what they were actually told. Each message is
checked to fit in two text-message segments, since a third costs money
and can arrive out of order. The link carries a private code that cannot
be guessed.

The system also tracks what happened to each text: waiting, sent,
delivered or failed, with the carrier's reason when it fails. A guest is
never texted the same confirmation twice, even if the send is retried or
two senders run at once.

## V-007 — Replying to the text

Guests can now answer the confirmation text. "C" (or "yes") confirms the
booking, "X" (or "cancel") cancels it, and "CHANGE" sends back the link to
pick a new time. "HELP" gives the restaurant's number, and "STOP" turns the
texts off without touching the booking. Each reply gets a short, clear
answer. A cancelled table is free for someone else the moment the guest's
text arrives.

A guest with two bookings is never guessed at. They get "You have 2
upcoming: 1) Fri 7:00 PM, 2) Sat 8:30 PM. Reply with the number, then C or
X." A number with no booking gets a friendly link to book. A message the
system does not understand gets one clarifying reply. A second one goes to
the host instead of looping a bot at a person.

Text messages come from the outside world, so this is where the system
defends itself. Every incoming message must carry the text provider's
signature, or it is refused before anything is read. Carriers sometimes
deliver the same message twice. A repeated delivery gets the same answer
and never cancels or confirms twice, even when eight copies arrive at
once. Every incoming text is kept exactly as received, together with what
it caused, so "the guest says they cancelled" can be settled from the
record.

Moving a booking to a new time or party size now books the new table
before letting go of the old one. If the new time is not available, the
original booking stays exactly as it was.

