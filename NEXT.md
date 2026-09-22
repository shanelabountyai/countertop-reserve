# Next: V-017, manual assignment. V-016 is shipped and green.

**<https://reserve.labintelligence.co>** — Vercel + Neon, behind one shared
password (`grep DEMO_ACCESS_PASSWORD .env.production.local` — that file, not
`.env.local`, which does not have it). The browser prompt is HTTP Basic and
**the username is ignored**; type anything. `/host` wants a separate
`STAFF_PASSCODE`. `docs/DEPLOYMENT.md` is the full recipe.

Gate green at V-016: lint, typecheck, **785 unit across 20 files**, build,
**36 e2e**. Not yet re-run under `TZ=Pacific/Kiritimati` — CI does that on
push; watch it before calling V-016 closed.

## Closed on 2026-09-22

- **V-016 — the table board.** `tableStates()` in `packages/core` beside
  `availability()`, `loadBoard()` in `packages/db/floor.ts`, the page at
  `/host/board`, linked from `/host`. Four states; every `free` carries its
  free-until and the window in minutes; combinations are their own inventory
  rows that block their members and are blocked by them. 17 hand-calculated
  fixtures, 4 e2e specs.
- **Design canvas: <https://claude.ai/artifact/B8MVj7sZQV3XxTCNGMqLNC>** —
  "Countertop Reserve UI". Six artboards taking Countertop's UI mock as the
  brand basis (Archivo + Zilla Slab, `#E9E5DF` ground, 3px `#0a0a0a` staff
  borders, the five semantic colour roles, the 18px staff floor) and drawing
  Reserve's own screens in it: `/host`, `/host/board`, `/host/design`,
  `/book`, `/m/[token]`, and the message thread. **Nothing in the repo is
  styled from it yet** — see the open item below. Source mock lives in the
  "Fire kitchen" design project.

## Pick up here

**V-017 — manual assignment** (`docs/backlog.md` → Phase 5, spec in the PRD
addendum). The correctness-critical half, and the most dangerous feature in
the product: a host naming a table is an **input** to the same allocation
transaction — the same advisory lock, the same schedule re-read under the
lock, the same constraint — never a bypass of it. `firstUnit(units)` becomes
"this unit, if it is in `units`"; a unit outside the fitting set is refused
with a named reason (`too_large`, `too_small`, `unit_held`, `outside_hours`,
`over_seat_cap`), never forced.

Already resolved at spec time, do not re-open: a `seated` party **may** be
moved, and the turn window **carries** from the original seat event rather
than restarting — so the new unit must be free for the remainder only, and a
move at 19:20 off a 19:00/90-minute seat needs 19:20–20:30.

Recommend **Opus**.

**Open, needs your call: the restyle.** The design canvas above is approved
as a design but not implemented. It is its own item (V-018) — it touches all
six screens and has to keep every axe assertion green. Do V-017 first.

## Things a future session still trips on

- **Never write a password into this file.** Both Neon passwords were named
  literally here until 2026-09-21, which put them in the repo and its
  history. Identify a database by its **endpoint** instead — this project is
  `ep-dawn-snow-b4dkr9e2` (`c-6.us-east-2`), Countertop is
  `ep-empty-dream-a5px6wnr` (`us-east-2`).
- **`perl -pi` rewrites a file whether or not it substitutes anything.** A
  zero-match run updates the mtime and looks exactly like success. This cost
  two irreversible Neon resets. Match `[^@]*`, never a class enumerating what
  a secret may contain — Neon passwords hold an underscore.
- **Length is not identity.** Every Neon password is 16 characters, so a
  length check cannot tell rotated from unrotated. The `psql` connection is
  the only decisive check, which is why it runs *before* Vercel.
- **The `new Date(string)` lint ban also matches `new Date(<number>)`.** The
  selector sees the call, not the argument's type. This is a feature: both
  times it fired in V-016 the code was rebuilding an instant it already held.
  Reach for `plusMs`, or keep the `Date` you already have.
- **A fixture seeded from the database's clock cannot assert an exact
  elapsed minute.** The render happens an unknown number of seconds after the
  insert, and `freeMinutes` floors. Assert the band (`/(39|40) min/`) or
  freeze the clock — never make the product round to suit the assertion.
- **Tests refuse to run unless the environment NAMES the database they may
  wipe.** `TEST_DATABASE_NAME=reserve_test` is set by `npm test` and
  `npm run test:e2e`; CI sets `reserve_ci`.
- **Playwright no longer reuses a running server.** Stop `npm run dev:demo`
  before a sweep, or set `E2E_REUSE_SERVER=1` and own that choice.
- **`fit` re-reads the schedule from the database** under a shared advisory
  lock. A DB test passing an in-memory `Schedule` must also call
  `seedSchedule(...)` from `packages/db/testing`, or every slot is `closed`.
- **`db:seed:demo` writes the *dev* database and `npm run dev` is
  `dev:test`.** Use `npm run dev:demo` for the local demo.
