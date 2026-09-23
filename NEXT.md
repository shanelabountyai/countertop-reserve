# Next: project closure. V-018 is shipped and green; the backlog is empty.

**<https://reserve.labintelligence.co>** — Vercel + Neon, behind one shared
password (`grep DEMO_ACCESS_PASSWORD .env.production.local` — that file, not
`.env.local`, which does not have it). The browser prompt is HTTP Basic and
**the username is ignored**; type anything. `/host` wants a separate
`STAFF_PASSCODE`. `docs/DEPLOYMENT.md` is the full recipe.

Gate green at V-018: lint, typecheck, **821 unit across 22 files**, build,
**41 e2e**. Watch CI green before calling V-018 closed.

## Closed on 2026-09-23

- **V-018 — the restyle.** The approved canvas across all six screens. The
  palette was already Tailwind's (`stone` / `red-700` / `amber-500` /
  `sky-700` / `green-800`), so most of it was the cool `neutral-*` ramp
  swapped for the warm `stone-*` one plus four theme tokens
  (`--color-ground`, `--color-surface`, `--color-ink`, `--font-display`).
  New: `app/notice.tsx`, `app/host/chrome.tsx`, `app/host/table-state.ts`,
  and `/host/design` — a token sheet generated from the lifecycle module and
  the board's own state map, so it cannot drift silently. One new e2e.
  **No migration.** Screenshots regenerated.

## Pick up here

**Project closure.** The backlog is empty. Per the global CLAUDE.md
"Definition of done", closure needs all three, and none is optional:

1. **`docs/DEMO.md` refreshed**, and *every command in it run once* before it
   ships. The screens it walks through all changed look in V-018; check the
   copy it quotes still matches, and that the env vars it tells you to grep
   exist in the file it names.
2. **The exec-brief artifact** — `Countertop Reserve in Brief` already
   exists at <https://claude.ai/artifact/78aJhCD9HZePoiXjun93f6>. Update it
   rather than publishing a second one (read it first, then republish to that
   URL). Its figures must match `WRITEUP.md` → *By the Numbers*.
3. **The LinkedIn drafts** in the Lab Intelligence Ledger
   (<https://claude.ai/artifact/Ai5xKScgT2sWtqXRQ1ZA8i>), tagged to this
   project and slotted so no two adjacent drafts share a pillar. Mine
   `WRITEUP.md` → *Defects Found* and *The Hardest Bug* first.

**Before the brief: re-measure `WRITEUP.md` → *By the Numbers*.** That table
is explicitly as of **V-015** and says so — it is stale by V-016, V-017 and
V-018 (unit tests are 821, not 768; e2e 41, not 32; items 16 of 16, not 13
of 13). Re-run the suite and count the lines; do not edit the previous row.

Recommend **Opus** for the brief and the ledger drafts — they are judgement
and audience work, not mechanical.

## Things a future session still trips on

- **Never write a password into this file.** Both Neon passwords were named
  literally here until 2026-09-21, which put them in the repo and its
  history. Identify a database by its **endpoint** instead — this project is
  `ep-dawn-snow-b4dkr9e2` (`c-6.us-east-2`), Countertop is
  `ep-empty-dream-a5px6wnr` (`us-east-2`).
- **V-018 added no migration.** The last one is V-017's
  `ReservationEvent.fromTableIds`, applied on all three databases. **The
  build does not migrate** (`docs/DEPLOYMENT.md`: "a build that migrates is a
  build that can half-migrate"), so any future schema change must be applied
  by hand or the deployed `/host` 500s on the missing column.
- **Renaming a heading is not a restyle.** V-018 lost a sweep to changing
  `/host`'s h1 from `Floor` to the canvas's `Tonight`; `host.spec` and
  `assign.spec` both name that heading in their sign-in helper, so the
  failure looked like a login failure four tests deep.
- **The e2e chrome is the page's one `<header>`.** `board.spec` asserts the
  banner states how many tables are free. A page that adds a second
  `<header>` gives `getByRole('banner')` two matches and fails strict mode.
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
  `dev:test`.** Use `npm run dev:demo` for the local demo. Regenerating the
  screenshots needs that server plus a `MANAGE_TOKEN` from a `booked` row —
  the recipe is in `WRITEUP.md` → *The Screens*.
