# Demo Script — Countertop Reserve

How to show this project to someone in 15 minutes, screen by screen, with the
exact commands, the accounts, and what to say at each stop.

**There are two ways to demo this.**

**Hosted** — <https://reserve.labintelligence.co>, behind one shared password
(`grep DEMO_ACCESS_PASSWORD .env.production.local` — that file, not
`.env.local`). The browser prompt is HTTP Basic and **the username is
ignored**; type anything. The `/host` screens then want their own passcode
(`grep STAFF_PASSCODE .env.production.local` — the hosted one, which is not
the local one). Send the link and both; no laptop, no setup. Same seeded
service as below. Use this for anyone remote, and for "can you show me
something you built?"

**Local** — everything below. Still the better demo when you are *present*,
because you can run the live webhook from a terminal and show state move. It
is also the fallback if the hosted copy is mid-reseed.

The seeded 60-cover service is the deliverable either way. Everything below
assumes you are in the repo root.

**Contents**

- [The 60-second version](#the-60-second-version) — if you only get one minute
- [Before you start](#before-you-start) — 5 minutes, do it the day before
- [Credentials](#credentials) — where each one lives
- [What's on the book](#whats-on-the-book) — the sample data
- [The demo, screen by screen](#the-demo-screen-by-screen) — the main event
- [The seven hard cases](#the-seven-hard-cases) — the "prove it" section
- [Live SMS](#live-sms-the-webhook-without-a-carrier) — driving a text from the terminal
- [If something goes wrong](#if-something-goes-wrong)
- [No-laptop version](#no-laptop-version)

---

## The 60-second version

> Firebird Kitchen takes table reservations. Guests confirm, change, or cancel
> by replying to a text — no phone call, no host spending an hour a day chasing
> people. What makes it interesting isn't the booking form. It's that two people
> racing for the last table is settled by the **database**, not by application
> code checking-then-writing. And that a stranger with a phone can move real
> inventory, which makes the inbound message a trust boundary the app has to
> treat as hostile.
>
> It's a seeded 60-cover Friday service — 18 tables, one dinner period, and
> seven deliberately nasty cases that all have to come out right. Zero
> double-seated tables, zero stranded parties.

Then open `/host?day=2026-10-02` and let them look at the floor.

---

## Before you start

Do this the day before, not five minutes ahead. The build is the slow part.

**Prerequisites:** Node, a local Postgres running, and `.env.local` present
with real values (see [Credentials](#credentials)).

```bash
# 1. Migrations on the dev database (the one the demo uses).
npm run db:migrate:dev

# 2. Seed the capstone service. ~20 seconds. Safe to re-run: it resets first.
npm run db:seed:demo

# 3. Start the app ON THE DEV DATABASE (see the trap below).
npm run dev:demo
```

> [!IMPORTANT]
> **`npm run dev` serves the *test* database, not the dev one.** The root `dev`
> script is `dev:test`, which loads `.env.test` first and first-wins — so it
> reads a different database than `db:seed:demo` just wrote. `dev:demo` loads
> `.env.local` only, which is the one the seed used. Use `dev:demo` for every
> demo, or you will show an empty restaurant and spend the first three minutes
> of your meeting debugging it.

The seed prints its own ledger. It should end like this — if the numbers differ,
the fixture has drifted and you should stop and read `docs/WRITEUP.md` rather
than demo it:

```
Seeded 2026-10-02: 88 covers booked, 76 seated.
  no-show  confirmed 10% (1 of 10) · never confirmed 25% (1 of 4)
  released 6% (1 of 16) · waitlist converted 50% (1 of 2)
  texts    50 queued = 48 sent + 1 deferred + 1 dropped (reminder: opted_out)
  provider accepted 48

Open http://localhost:3500/host?day=2026-10-02 and http://localhost:3500/host/report?from=2026-10-02
```

Those numbers are worth reading aloud, because three of them *are* the demo:

- **`no-show confirmed 10% · never confirmed 25%`** — guests who replied to a
  text no-show at less than half the rate of guests who never did. That single
  comparison is the entire business case for the product.
- **`1 deferred`** — tomorrow's reminder, queued at 21:30 and held for 09:00.
  Quiet hours deferred the *message*; no table moved.
- **`1 dropped (reminder: opted_out)`** — Novak's reminder, killed at the send
  attempt because he texted STOP after it was queued. Dropped **with a reason**,
  and his reservation untouched.

**Verify before you present** — all three, takes 30 seconds:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3500/book     # 200
psql reserve_dev -tAc 'SELECT count(*) FROM "Reservation"'              # 20
psql reserve_dev -tAc "SELECT count(*) FROM \"DiningTable\""            # 18
```

**Open these tabs in this order** before anyone is watching, so you are never
typing a URL on a shared screen:

1. `http://localhost:3500/book`
2. `http://localhost:3500/book?party=10&day=2026-10-02`
3. `http://localhost:3500/m/<token>` — see [Credentials](#credentials)
4. `http://localhost:3500/host?day=2026-10-02`
5. `http://localhost:3500/host/board`
6. `http://localhost:3500/host/hours`
7. `http://localhost:3500/host/report?from=2026-10-02`
8. `http://localhost:3500/host/design` — only if they ask about the design

Tab 4 needs you to be signed in. Do that first (`/host/login`), once — the
cookie carries across 4 through 8. Once you are signed in the black bar at
the top of every staff screen has all five as tabs, so you can also just
click rather than switch tabs.

---

## Credentials

Nothing real is committed. The values live in `.env.local`, which is gitignored
— read them from there, never from this file.

| What | Where | Note |
|---|---|---|
| Staff passcode | `grep STAFF_PASSCODE .env.local` | One shared passcode for `/host`, `/host/hours`, `/host/report`. There are no user accounts — a deliberate simplification, and worth naming out loud as one. |
| Manage-page token | query below | The guest's entire authorisation. No reservation id appears in any guest URL. |
| Webhook secret | `grep SMS_WEBHOOK_SECRET .env.local` | The webhook fails closed without it — `503 webhook not configured`. |
| Cron secret | `grep CRON_SECRET .env.local` | Bearer token for the deadline sweep route. Same fail-closed behaviour. |

> [!NOTE]
> `.env.local` carries all six variables, including both secrets, so the
> [live SMS](#live-sms-the-webhook-without-a-carrier) section works with no
> extra setup. The values there are local demo values, not real credentials;
> a deployed environment would set its own.

**Tokens change on every reseed — look one up, never hardcode it:**

```bash
psql reserve_dev -tA -F' | ' -c \
  "SELECT \"guestName\", \"partySize\", to_char(\"startAt\" AT TIME ZONE 'America/Los_Angeles','MM-DD HH24:MI'), status, \"manageToken\"
   FROM \"Reservation\" WHERE status = 'booked' ORDER BY \"startAt\""
```

After a fresh seed this returns exactly one row — **Yardley Cole**, a party of 4
at 19:00 on 2026-10-03. That is the one to demo the manage page with, because
it is the only reservation still in `booked`: tomorrow's booking, not yet
confirmed, so the page still offers every action. Everything on the 10-02
service has already been seated, completed, cancelled, released or no-showed.

---

## What's on the book

**Firebird Kitchen**, timezone `America/Los_Angeles`. The service is
**Friday 2026-10-02**.

**The floor — 18 tables:**

| Tables | Seats | Section |
|---|---|---|
| T1–T4 | 2 | window |
| T5–T8 | 2 | bar |
| T9–T13 | 4 | main |
| T14–T17 | 6 | main |
| T18 | 8 | private |

**Two legal combinations**, and they are inventory, not a display detail — a
combination occupies *both* underlying tables:

- **C1** = T1 + T2 → seats 4, minimum party 3
- **C2** = T16 + T17 → seats 12, minimum party 10 — **the only unit in the house
  that seats ten.** Three of the seven hard cases turn on that fact.

**Service periods** (every weekday): Lunch 11:30–14:00, pacing cap 20 covers per
15 minutes. Dinner 17:00–22:00, **last seating 21:00**, pacing cap 24.
One blackout: **2026-10-05, "Annual deep clean."**

**The cast** — 15 booked in advance, plus a same-day booking, two parties of ten
racing for C2, and three walk-ins. Final tally: 20 reservations — 11 seated,
3 completed, 2 no-shows, 1 cancelled, 1 released, 1 abandoned, 1 still booked
(tomorrow's).

The ones worth knowing by name:

| Guest | Party | Time | What they're for |
|---|---|---|---|
| Iqbal Nasser | 6 | 17:45 | Never arrives. No-showed at 18:05, frees T16 |
| Osei Mensah | 10 | walk-in 18:10 | Seated into C2 **because** Iqbal just freed T16 |
| Greaves Mutombo | 8 | 18:15 | Holds T18, the only eight-top, until 20:16 |
| Vance Iyer | 8 | walk-in 18:30 | Waitlisted — T18 is taken. Seated 20:20 when it clears |
| Wren Adeyemi | 10 | walk-in 19:30 | Waitlisted, gives up at 20:25. **Counts against waitlist conversion, not covers** |
| Novak Petrov | 4 | 19:30 | Confirms, then texts STOP |
| Okafor Diallo | 2 + 4 | 19:45, 20:30 | **Same phone number, two reservations** |
| Pryce Hammond | 2 | 20:00 | Tries to grow to a party of 8. Refused |
| Reyes Molina | 2 | 20:15 | The webhook redelivery |
| Quinn Alaba | 6 | 17:00 | Tries to move to the blackout date. Refused |
| Chen Wu | 2 | 17:30 | Never replies → released at the 16:00 deadline sweep |
| Maren Holt | 2 | 19:30 | Books same-day at 15:00, never confirms, no-shows |
| Yardley Cole | 4 | **10-03** 19:00 | Tomorrow. The one still-live reservation |

---

## The demo, screen by screen

Fifteen minutes at a normal pace, or twelve if you skip stop 8. Each stop has
**what's on screen**, **what to say**, and **the point** — if you're short on
time, the point is the part to keep.

### 1 · The booking grid, and a refusal that explains itself
`/book?party=10&day=2026-10-02` · screenshot `2-book-times.png`

**On screen:** a party of ten on a Friday that fills as the night goes on. The
early sittings are open; **from 19:15 every slot is refused** — and each refused
one still shows, with its reason, rather than vanishing.

**Say:** "Ten people. C2 — two six-tops pushed together — is the only unit in
the house that seats them, so the whole evening turns on one piece of
inventory. It's free early and gone from quarter past seven. Notice what the
grid does with the gone ones: it doesn't hide the times, it tells you *why*.
And read the two reasons — *fully booked* and *not serving* are different
answers. One means try another night, the other means we're closed. The 21:15
slot says *not serving* because last seating is 21:00."

**The point:** a greyed-out slot is UX, not the safety mechanism. The next two
screens are where the actual guarantee lives.

> [!NOTE]
> **Don't say "every slot is refused."** It was true of an earlier seed and is
> not true of this one — the early sittings free up because those parties are
> `completed` on the seeded night. Look at the screen before you narrate it.

### 2 · The manage page, and the snapshot rule
`/m/<Yardley Cole's token>` · screenshot `3-manage.png`

**On screen:** tomorrow's party of four. Change time, change party size, cancel.
And the text the restaurant sent, as stored.

**Say:** "The token in that URL is the whole authorisation — no reservation id
appears in any guest URL, so there's nothing to enumerate. And this message
isn't re-rendered from a template. It's the text as it was actually sent and
stored at booking time."

**The point:** *"Edit a message template now and this reservation's history does
not change."* If someone doubts it, that's a test —
`snapshot regression` in the suite mutates the floor plan, the turn times and
every template, then asserts the stored data is byte-identical.

### 3 · The floor — where a service actually gets run
`/host?day=2026-10-02` · screenshot `4-host-floor.png` · **spend the most time here**

**On screen:** the finished Friday, grouped by service period.

Point at four specific rows:

- **`T16+T17`** — a combination shown as what it is. Both tables are held.
- **The released table** — Chen Wu, who never replied. The deadline sweep took
  the table back at 16:00 and it became real inventory that instant.
- **The no-show** — Iqbal Nasser.
- **A failed text, on its own row** — Novak Petrov's reminder, dropped because
  he'd opted out. The floor shows the failure rather than swallowing it.

**Say:** "This is worked at arm's length during service, so every target is at
least 48 pixels, seat/no-show/cancel is one tap with a five-second undo, and it
polls every ten seconds. It's also axe-clean."

**The point:** a released table is inventory immediately, not a flag someone
sweeps up later. Which leads straight into the best story —

### 4 · The walk-in that could only happen because of the no-show
still on `/host`

**Say:** "Iqbal's party of six no-shows at 18:05. That frees T16. Five minutes
later a party of ten walks in — and C2 is T16 plus T17, so they're seatable
*only because* that no-show just released half of it. If a released table were a
flag waiting for a nightly job, that party walks out."

**The point:** this is the one case that proves the inventory model end to end.
It's scripted in the seed as `UGLY 7` and asserted in the capstone test.

### 5 · The table board — the invariant you can point at
`/host/board` · screenshot `5-host-board.png`

**On screen:** every unit in the house, by section, with its state in a word,
and a free count in the black bar. Twenty units, not eighteen — the two legal
combinations are units too, which is the whole point of the screen. The count
itself moves with the clock, so don't quote a number you rehearsed.

**Point at T16, T17 and C2.** T16 and T17 read **Blocked — taken by C2**, and
C2 itself reads **Occupied — Table Ten A, party of 10**. Then point at C1,
blocked the other way round: **taken by T1, T2**.

**Say:** "A combination isn't a label on a screen, it's inventory. C2 *is*
T16 plus T17 — so seating C2 takes both of those tables out of the house, and
seating T1 and T2 separately takes C2 out. This board is read-only; it's
showing you what the availability engine and the database constraint already
agree on."

**The point:** this is the one screen where a whole class of double-booking
bug is visible as an absence. If combinations were a display detail, one of
these rows would be free and a walk-in would get seated on top of a party of
ten.

Note the state words: **Free**, **Occupied**, **Reserved**, **Blocked** — all
four legible with the colour taken away, which is the accessibility rule the
whole UI is built on, not a retrofit.

### 6 · Hours, pacing, and a guard rail
`/host/hours` · screenshot `6-host-hours.png`

**On screen:** weekly periods, per-date overrides, blackouts, pacing caps, last
seating.

**Say:** "Two constraints decide availability: does a table or a legal
combination *fit*, and is the fifteen-minute pacing bucket under its cap.
One function answers both, and the guest flow, this floor view and every change
request all call it — there's no second implementation to drift."

**Then the guard rail:** "If you make an edit here that would strand a party
that's already booked, it doesn't save. It shows you who you'd strand first, and
makes you force it."

### 7 · The report, and the bug worth admitting
`/host/report?from=2026-10-02` · screenshot `7-host-report.png`

**On screen:** covers, no-shows, releases, waitlist conversion, in the
restaurant's timezone.

**Say:** "No-show rate is split by whether the guest ever confirmed — that's the
number that tells you whether the texting is doing anything."

**Then tell on yourself, because it lands better than any feature:**

> "This report had a bug that never reached a screen. Covers deliberately exclude
> parties who gave up waiting — they were never on the book for a time. The first
> version applied that same exclusion everywhere, including waitlist conversion.
> But a party who left is exactly what conversion is measured *against*. So it
> reported one-of-one, 100%, on a night half the waiting room walked out. Caught
> by a pure unit test before any of it rendered."

**The point:** the same number can be right in one column and catastrophic in
another. That's a domain judgement, not a coding one.

### 8 · The design sheet — only if they ask about the look
`/host/design` · screenshot `8-host-design.png`

Skip this unless someone asks how the UI was built, or you are talking to a
designer. It is a one-page token sheet: colour, type ramp, buttons, badges,
callouts.

**The part worth showing even in thirty seconds** is the status row —
**all nine reservation statuses, rendered from the lifecycle module itself**,
and the line under it: *a tenth fails to compile until it is classified and
given its edges.*

**Say:** "The lifecycle lives in one module, and this page reads it rather
than listing it again. So this can't drift — adding a status makes the
compiler find every reader, including this sheet."

**The point:** a design system that is generated from the domain can't go
stale. It's the same discipline as the rest of the project pointed at the UI.

---

## The seven hard cases

These are quoted verbatim from the PRD's Success Metrics and scripted into the
seed, each marked `UGLY n` in `packages/db/capstone.ts`. The capstone test
asserts all of them — 28 assertions.

Use this section when someone asks "but does it actually handle…". You don't
have to demo them live; the honest and faster answer is to show the code and
run the test.

| # | Case | What has to come out right |
|---|---|---|
| 1 | Party size grows into a size no table fits | Pryce Hammond, 2 → 8 at 20:00. T18 is the only eight-top and Greaves has it. **Refused, original booking intact** — not half-applied |
| 2 | Change to an unavailable time | Quinn Alaba → the 10-05 blackout. Refused, original intact |
| 3 | Two simultaneous bookings for the last table | Two parties of ten, same instant, for C2. **Exactly one booked, one clean refusal, zero orphan holds** |
| 4 | STOP mid-thread | Novak confirms at 22:00, opts out at 22:05. The already-queued reminder is dropped **at send time, with a reason** — and his reservation is untouched. Opting out of texts and cancelling a table are different intents |
| 5 | One number, two upcoming reservations | Okafor Diallo. A bare "C" is ambiguous, so the guest is asked which; the answer acts on exactly one and leaves the other alone |
| 6 | Webhook redelivery | The same provider message id, delivered twice. **One transition, one reply** — idempotency checked before any state change, not just before any send |
| 7 | Walk-in into a released no-show's table | Osei Mensah into T16+T17, ninety seconds after Iqbal's no-show |

To run them in front of someone:

```bash
npm test -- capstone        # the 28 assertions, under a second
```

If they want the whole gate (~1 minute, and it builds):

```bash
npm run gate                # lint, typecheck, 821 unit, production build, 41 e2e
```

---

## Live SMS, the webhook without a carrier

> [!NOTE]
> **No text message has ever left this system.** The carrier is a stub; the
> outbox and its delivery states are real. Say this out loud rather than letting
> someone assume otherwise — a live carrier is an explicit non-goal in the PRD.

You can still drive a real state change through the real webhook, signature and
all. No extra setup: `npm run dev:demo` already loads `SMS_WEBHOOK_SECRET` from
`.env.local`.

In another terminal — this confirms tomorrow's reservation exactly the way a
guest's reply would. The secret has to match what the server loaded, so read it
rather than retyping it:

```bash
SECRET=$(grep '^SMS_WEBHOOK_SECRET=' .env.local | cut -d= -f2-)
BODY='{"providerMessageId":"demo-1","from":"+15035550114","body":"C"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')
curl -s -X POST http://localhost:3500/api/sms/inbound \
  -H 'content-type: application/json' -H "x-signature: $SIG" -d "$BODY"
```

Verified output:

```json
{"replayed":false,"outcome":"confirmed","reply":"Confirmed - 4 on Sat, Oct 3 at 7:00 PM. See you then. Reply X to cancel or CHANGE to reschedule."}
```

Yardley Cole flips to `confirmed` on the floor.

**Two follow-ups that make the point better than the happy path.** Re-run the
identical command — same `providerMessageId`:

```json
{"replayed":true,"outcome":"confirmed","reply":"Confirmed - 4 on Sat, Oct 3 at 7:00 PM. ..."}
```

`replayed: true`, and **nothing changes** — one transition, not two, one reply,
not two. That is a redelivered webhook being recognised before any state moved.

Now change one character of the signature:

```
bad signature   [401]
```

Rejected before the body is parsed at all. That one is the demo. Anyone can POST
to a public webhook URL; the signature is the only thing separating the carrier
from a stranger with `curl`.

> [!NOTE]
> This mutates the seed — Yardley Cole is `confirmed` afterwards, and
> `demo-1` is now a spent message id. **Re-run `npm run db:seed:demo` after
> rehearsing**, or the live section won't work twice.

---

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| Empty restaurant, no reservations | The server is on the **test** database | You ran `npm run dev`. Restart with `npm run dev:demo` |
| `/m/<token>` 404s | Token is from a previous seed | Re-run the token query — they're regenerated every seed |
| `/host` bounces to login | No cookie yet | Sign in at `/host/login` once; it carries to hours and report |
| Webhook returns 503 | `SMS_WEBHOOK_SECRET` unset | It fails closed on purpose. `.env.local` carries one — check you started with `dev:demo` |
| Webhook returns 401 | Signature mismatch | The HMAC is over the **raw body** — don't reformat the JSON between signing and sending |
| Port 3500 busy | Another project, or a stale server | `lsof -ti :3500 \| xargs kill -9`. This repo owns 3500 |
| Seed numbers don't match | The fixture has drifted | Stop. `npm test -- capstone` will say which case broke |
| Everything is slow / tests die | Too many dev servers | `devservers`; stop the ones you aren't demoing |

---

## No-laptop version

Eight screenshots in `docs/screenshots/`, shot against this same seeded service.
They carry the demo on their own if you're screen-sharing a deck or sending a
link:

| File | Screen | The one thing it shows |
|---|---|---|
| `1-book-party.png` | `/book` | The entry point |
| `2-book-times.png` | `/book?party=10&day=2026-10-02` | Refusals that **say why** — *fully booked* and *not serving* are different answers |
| `3-manage.png` | `/m/<token>` | The snapshot rule — text as sent and stored |
| `4-host-floor.png` | `/host` | `T16+T17`, a release, a no-show, a failed text |
| `5-host-board.png` | `/host/board` | T16 and T17 **blocked, taken by C2** — a combination as inventory |
| `6-host-hours.png` | `/host/hours` | Pacing caps and last seating |
| `7-host-report.png` | `/host/report` | No-shows split by confirmation |
| `8-host-design.png` | `/host/design` | All nine statuses, generated from the lifecycle module |

**To reshoot after a UI change:**

```bash
npm run db:seed:demo
npm run dev:demo                                      # separate terminal

MANAGE_TOKEN=<a booked reservation's token> \
STAFF_PASSCODE=$(grep '^STAFF_PASSCODE=' .env.local | cut -d= -f2-) \
node docs/screenshots/capture.mjs docs/screenshots
```

---

## What to concede before you're asked

Volunteering these reads as confidence. Having them pulled out of you doesn't.

- **The restaurant and every guest are invented.** Synthetic on purpose.
- **No text has ever been sent.** Carrier stubbed, outbox real, live SMS deferred
  and a stated non-goal.
- **The hosted copy is a demo deployment, not production.** One shared
  password in front of the whole site, one shared staff passcode behind it, a
  seeded database that gets reset, and the same stubbed carrier. It proves the
  thing runs on real infrastructure; it does not claim to be a live service.
- **One shared staff passcode, no user accounts.** Fine for a single floor,
  wrong for a group.
- **The report tallies in TypeScript, not SQL** — one read of a night's
  reservations. Fine at 88 covers; wrong at a year of them.
- **Pacing is the one check-then-write in the product.** A cap on a sum across
  rows is not something a constraint can express, so it's an advisory lock —
  and the code says so, right next to it. Table overlap *is* a constraint, and
  that distinction is the most interesting thing in the codebase.
