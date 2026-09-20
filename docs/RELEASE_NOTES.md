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

## V-008 — The table a guest forgot about comes back on its own

A booking nobody confirms now lets go of its table at a deadline the
restaurant sets: three hours before for bookings made in advance, ninety
minutes for same-day ones, or never, if the restaurant turns it off. The
moment it is released, the table is bookable again — the test books a
walk-in into it in the same breath. The guest gets one text saying so, with
a link to book again.

Guests also get one reminder the day before (or three hours before, if
they booked late), unless they confirmed recently enough that a reminder
would be noise. And every text the system queues — confirmations, replies,
reminders — now actually goes out on a schedule.

The interesting part is what is kept apart. Freeing the table and telling
the guest are two separate steps, so a message that can't be sent (or,
next item, shouldn't be sent at 2am) never holds a table hostage. Two
sweeps running at once release a table once and text once. A guest who
booked at 6:30 for 7:00 is never released for "failing to confirm" in a
window they never had, and a guest who texted STOP still loses an
unconfirmed table on time — they just aren't texted about it.

## V-009 — Texts that know when to stay quiet

Every text now passes three checks at the moment it would go out, not the
moment it was written: has this number said STOP, is it the middle of the
night, and has this number already had five texts today. A reminder queued
yesterday for a guest who opted out this morning is stopped at the door,
and the record says why.

The interesting call was quiet hours. The draft spec said 21:00–09:00,
which sounds right until you remember the restaurant seats until 22:00: a
guest booking at 21:30 for 21:45 would get their confirmation the next
morning. Asked as an operator question before building, the answer was to
keep the window but let through what can't wait — anything about tonight's
table, and any reply to a text the guest just sent us. Reminders and
"we released your table" notices for later days wait until 9am. The table
itself is released on time regardless: the message waits, the inventory
never does.

Booking now records the exact consent wording the guest agreed to, not
just a checkbox, and a booking made without consent (a phone booking the
host enters) is never texted. STOP is always acknowledged, even at 2am and
even over the daily limit, because it is the one message a guest must get.

## V-010 — The host stand

The host now has a screen: tonight's book on one page, lunch and dinner in
their own groups, each party showing its time, table, whether they
confirmed, and how long they have been sitting. Seat, no-show and cancel
are one tap each, with five seconds to undo — and the Seat button is the
biggest thing on the row, because it is the one tapped all night.

Walk-ins go in from the same screen. If a table is free for their whole
meal they are seated on the spot; if not, they go on the waitlist with a
quoted range ("20-35 min"), never a single number nobody can keep. When a
table clears, one tap texts them that it is ready — even at 9:30pm, since
they are standing outside.

Two things were built to be hard to miss. An allergy tag is solid red and
shouted; a birthday is a quiet outline — a warning styled like decoration
is how a warning gets ignored. And a guest whose confirmation text never
arrived says so on their row, with the reason (opted out, daily limit, or
not delivered), so silence is never mistaken for "confirmed."

Under the hood, undo is honest: undoing a no-show gives back the table
only if nobody has been seated there since, and says so if they have. The
screen refreshes itself every ten seconds from a server-issued marker, not
the tablet's clock, and stops polling when the tab is hidden. The whole
screen sits behind a passcode.

## V-011 — When the restaurant is open

Opening hours were, until now, a line in the code. They are now something
the host edits from the same tablet they seat people on: a page listing
what the restaurant serves every week, the dates that run differently, and
the dates it is closed altogether.

Three things a schedule has to say, and now can. **Last seating**, said out
loud instead of inferred — a dinner service that closes at 22:00 can still
take a 20:45 five-top and let them finish, because the restaurant decided
that, not the arithmetic. **Pacing**, as covers per fifteen minutes, so a
kitchen never gets forty people at 19:00 because forty tables happened to
be free. And **one date at a time**: a wine dinner on the 12th replaces
that Thursday's normal service, and only the 12th.

The part that matters most is what happens when hours change *after*
people have booked. Shortening dinner, blacking out a date, tightening a
last seating — each of those can leave a party holding a reservation for a
time the restaurant will not be serving. So an edit that would do that is
not saved. The screen stops and names them: who, what time, how many, and
whether the restaurant would simply be closed or their table would run
past the end of service. Nothing has been written at that point. The host
can back out, or say save anyway — and if they do, the hours change and
those guests stay booked, visible, and someone's to phone.

Two periods that overlap are refused outright. Hours that share slots would
quietly offer the same table twice under two different pacing caps, which
is exactly the kind of double-booking this system is built not to do.

## Booking a table, and changing your mind

The guest side is open. Pick how many people, pick a night, pick a time,
leave a name and a mobile number — that is the whole of it, and it works
without JavaScript, because a reservation form that needs a modern browser
is a reservation someone made by phone instead.

The part worth pointing at is what the time picker does with the times you
*cannot* have. It shows them. A seven o'clock that is fully booked is on
screen, crossed out, with "fully booked" beside it. A nine o'clock past the
last seating says "not serving." A guest who is simply shown an empty
evening learns nothing and calls; a guest who can see that the restaurant is
busy at seven and free at eight forty-five books eight forty-five. Nothing
is hidden to make the page look tidier.

Every confirmation text carries a link, and that link is the reservation.
Open it and you see the booking as it stands right now — the time, the
party, whether we have your confirmation yet, and the last text we sent you,
word for word as it was sent. From there you can move it or cancel it.

Moving a booking is the case that had to be built carefully. It is not
"release the table, then take a new one" — that leaves a gap where the guest
owns nothing and someone else can walk into it. The new table is taken and
the old one given up in a single step, so either you have moved or you have
not. If the time you picked went while you were deciding, or your bigger
party no longer fits anywhere, the answer is no and your original booking is
exactly where you left it. You get a text saying so, with a link back.

Two quieter things. Rescheduling counts as confirming — someone who takes
the trouble to move a booking has plainly told us they are coming, and they
should not then be released for never replying to a text. And cancelling
hands the table back that second: the host can seat a walk-in into it
immediately, not after some overnight tidy-up.
