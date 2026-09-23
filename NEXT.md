# Next: nothing. Countertop Reserve is closed.

Backlog empty at V-018, and all three closure deliverables exist. There is no
V-019. If you opened this session expecting work, the work is on another
project.

**<https://reserve.labintelligence.co>** — Vercel + Neon, behind one shared
password (`grep DEMO_ACCESS_PASSWORD .env.production.local` — that file, not
`.env.local`, which does not have it). The browser prompt is HTTP Basic and
**the username is ignored**; type anything. `/host` wants a separate
`STAFF_PASSCODE`, and the hosted one is **not** the local one — read it from
`.env.production.local` too. `docs/DEPLOYMENT.md` is the full recipe.

Gate green at closure: lint, typecheck, **821 unit across 22 files**, build,
**41 e2e**.

## Closed on 2026-09-23

- **V-018 — the restyle.** The approved canvas across all six screens.
- **Closure.** The three deliverables the global "definition of done"
  requires, plus a re-measure of `WRITEUP.md` → *By the Numbers*.

### What closure actually turned up

Running the demo script end to end is not a formality — it found four wrong
claims, and two of them were product-shaped rather than numeric:

- `docs/DEMO.md` still told the reader **"Not deployed anywhere, and that
  was a decision"**, four items after V-014 deployed it, while its own
  opening paragraph linked the hosted copy.
- It claimed **"every dinner slot is refused"** for a party of ten. False
  against this seed: 17:00–19:00 are offered, because those parties are
  `completed` and have released their tables. It is a fixture fact written
  as a product fact.
- The **exec brief's two embedded screenshots were the pre-V-018 look** —
  rounded corners, cool grey, no staff chrome. A brief showing one product
  and linking to a different-looking one. Both figures are re-shot.
- The V-015 line counts **could not be reproduced under any rule** — 6,459,
  not the 6,505 recorded. The rows name their method now.

## Artifacts (also in `docs/RELEASE_NOTES.md`)

| What | URL |
|---|---|
| **Countertop Reserve in Brief** (private) | <https://claude.ai/artifact/78aJhCD9HZePoiXjun93f6> |
| **Lab Intelligence Ledger** (anyone with the link) | <https://claude.ai/artifact/Ai5xKScgT2sWtqXRQ1ZA8i> |
| **Build Log** (private) | <https://claude.ai/artifact/28KeGV3xfBwcBuoMEQjFMj> |

Ledger posts **38, 39, 40** are this project's newest drafts — V-016's
39-versus-40-minute floor, V-018's heading rename, V-017's silent fixture.
The whole 40-post queue has zero adjacent same-pillar pairs; keep it that way
if you reorder.

## If you come back to this repo

The only open question in the PRD is quiet-hours start time, and it wants an
operator, not a session. Real SMS integration is the one thing that would
reopen the build, and it needs a carrier account, not a decision.

## Things a future session still trips on

- **Never write a password into this file.** Both Neon passwords were named
  literally here until 2026-09-21, which put them in the repo and its
  history. Identify a database by its **endpoint** instead — this project is
  `ep-dawn-snow-b4dkr9e2` (`c-6.us-east-2`), Countertop is
  `ep-empty-dream-a5px6wnr` (`us-east-2`).
- **The last migration is V-017's** `ReservationEvent.fromTableIds`, applied
  on all three databases. **The build does not migrate**
  (`docs/DEPLOYMENT.md`: "a build that migrates is a build that can
  half-migrate"), so any future schema change must be applied by hand or the
  deployed `/host` 500s on the missing column.
- **Renaming a heading is not a restyle.** V-018 lost a sweep to changing
  `/host`'s h1 from `Floor` to the canvas's `Tonight`; `host.spec` and
  `assign.spec` both name that heading in their sign-in helper, so the
  failure looked like a login failure four tests deep. The h1 is `Floor`.
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
  never make the product round to suit the assertion. The board floors on
  purpose; rounding up tells a host a turn fits when it does not.
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
  the recipe is in `docs/DEMO.md` → *No-laptop version*, and there are eight
  screenshots now, not six.
- **The seeded service is a *finished* Friday on a *future* date.** Most
  parties are `completed`, so their tables are free for new bookings. That
  is why the booking grid offers the early sittings. Do not write docs that
  describe the night as full.
