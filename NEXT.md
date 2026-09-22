# Next: V-018, the restyle. V-017 is shipped and green.

**<https://reserve.labintelligence.co>** — Vercel + Neon, behind one shared
password (`grep DEMO_ACCESS_PASSWORD .env.production.local` — that file, not
`.env.local`, which does not have it). The browser prompt is HTTP Basic and
**the username is ignored**; type anything. `/host` wants a separate
`STAFF_PASSCODE`. `docs/DEPLOYMENT.md` is the full recipe.

Gate green at V-017: lint, typecheck, **821 unit across 22 files**, build,
**40 e2e**. Watch CI before calling V-017 closed — it is the run that applies
the new migration from scratch and runs the unit suite under two hostile
timezones.

## Closed on 2026-09-22

- **V-016 — the table board.** Confirmed green in CI (run 35743892471).
- **V-017 — manual assignment.** `unitMisfit()` in `packages/core` beside
  `fittingUnits()`, `assignUnit()` in `packages/db/floor.ts` routed through
  the exported `fit()`, the picker on each `/host` row. One migration:
  `ReservationEvent.fromTableIds`, which is how the undo of a move knows
  where to put the party back. 36 new unit tests, 4 new e2e.

## Pick up here

**V-018 — the restyle.** The approved design canvas is
<https://claude.ai/artifact/B8MVj7sZQV3XxTCNGMqLNC> ("Countertop Reserve UI",
six artboards; source mock in the "Fire kitchen" design project). **Nothing
in the repo is styled from it yet.** It touches all six screens — `/host`,
`/host/board`, `/host/design`, `/book`, `/m/[token]`, the message thread —
and every axe assertion has to stay green, including the new picker on the
host row (`aria-label="Table for <name>"`).

It is not yet a backlog item: add the `V-018` row to `docs/backlog.md` in the
same commit that starts it.

Recommend **Sonnet** — it is presentation work against an approved design,
not a correctness problem.

**Then: project closure.** The backlog is empty after V-018. Closure needs
all three of `docs/DEMO.md` refreshed (every command run once), the
exec-brief artifact, and the LinkedIn drafts in the Ledger — see the global
CLAUDE.md "Definition of done".

## Things a future session still trips on

- **Never write a password into this file.** Both Neon passwords were named
  literally here until 2026-09-21, which put them in the repo and its
  history. Identify a database by its **endpoint** instead — this project is
  `ep-dawn-snow-b4dkr9e2` (`c-6.us-east-2`), Countertop is
  `ep-empty-dream-a5px6wnr` (`us-east-2`).
- **V-017's migration is applied everywhere** — local test, local
  `reserve_dev`, and production Neon (`ep-dawn-snow-b4dkr9e2`), verified with
  `migrate:status`. **The build does not migrate** (`docs/DEPLOYMENT.md`: "a
  build that migrates is a build that can half-migrate"), so any future
  schema change must be applied by hand or the deployed `/host` 500s on the
  missing column. `.env.local` is a LOCAL `reserve_dev`, not a Neon branch;
  production creds live in `.env.production.local`.
- **A fixture's own state changes get asserted, not assumed.** V-017 lost a
  pass to `hostMove(..., 'completed')` on a `booked` party — not an edge, so
  the setup silently no-opped and the test asserted the opposite of its name.
- **`booked → completed` is not an edge.** A party must be `seated` before
  they can be cleared. `cancelled` is the way to free a booked party's table.
- **`perl -pi` rewrites a file whether or not it substitutes anything.** A
  zero-match run updates the mtime and looks exactly like success. This cost
  two irreversible Neon resets. Match `[^@]*`, never a class enumerating what
  a secret may contain — Neon passwords hold an underscore.
- **Length is not identity.** Every Neon password is 16 characters, so a
  length check cannot tell rotated from unrotated. The `psql` connection is
  the only decisive check, which is why it runs *before* Vercel.
- **The `new Date(string)` lint ban also matches `new Date(<number>)`.** The
  selector sees the call, not the argument's type. Reach for `plusMs`, or
  keep the `Date` you already have.
- **A fixture seeded from the database's clock cannot assert an exact
  elapsed minute.** Assert the band (`/(39|40) min/`) or freeze the clock —
  never make the product round to suit the assertion.
- **Tests refuse to run unless the environment NAMES the database they may
  wipe.** `TEST_DATABASE_NAME=reserve_test` is set by `npm test` and
  `npm run test:e2e`; CI sets `reserve_ci`.
- **Playwright no longer reuses a running server.** Stop `npm run dev:demo`
  before a sweep, or set `E2E_REUSE_SERVER=1` and own that choice.
- **Each e2e spec seeds its own `ServicePeriod` rows** and truncates them
  first. `assign.spec.ts` sorts before `board.spec.ts`, so it cannot inherit
  another spec's hours.
- **`fit` re-reads the schedule from the database** under a shared advisory
  lock. A DB test passing an in-memory `Schedule` must also call
  `seedSchedule(...)` from `packages/db/testing`, or every slot is `closed`.
- **`db:seed:demo` writes the *dev* database and `npm run dev` is
  `dev:test`.** Use `npm run dev:demo` for the local demo.
