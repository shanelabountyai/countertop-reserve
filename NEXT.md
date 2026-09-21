# Next: V-016, the table board. Both credential rotations are done.

**<https://reserve.labintelligence.co>** — Vercel + Neon, behind one shared
password (`grep DEMO_ACCESS_PASSWORD .env.production.local` — that file, not
`.env.local`, which does not have it). The browser prompt is HTTP Basic and
**the username is ignored**; type anything. `/host` wants a separate
`STAFF_PASSCODE`. `docs/DEPLOYMENT.md` is the full recipe.

Gate green at V-015: lint, typecheck, **768 unit across 19 files**, build,
**32 e2e** — and 768 again under `TZ=Pacific/Kiritimati`. Every commit since
is docs-only, so that still holds without a re-run.

## Closed on 2026-09-21

- **Both Neon passwords rotated.** This project's and Countertop's. The
  leaked values are rejected by Neon; both sites verified serving real data.
  No password literal remains in any tracked file.
- **Countertop moved to `ordering.labintelligence.co`** (Cloudflare CNAME →
  `cname.vercel-dns.com`, unproxied). `countertop-mu.vercel.app` still works
  as a Vercel alias. Its `DEMO.md`, portfolio body, smoke-test default and
  the build-log row all name the new URL; the dated history entries were
  deliberately left alone.
- **PRD addendum v1.1 written** — `prd-countertop-reserve.md`, spec for the
  two items below.

## Pick up here

**V-016 — the table board** (`docs/backlog.md` → Phase 5, spec in the PRD
addendum). Read-only, ships alone, no new write path. A new `tableStates()`
in `packages/core` beside `availability()`: table-major where that one is
slot-major. The requirement that carries the item is **every `free` carries
its free-until** — a table free now but held in 40 minutes is not free for a
90-minute walk-in, and a bare green dot is the defect the spec exists to
prevent.

**V-017 — manual assignment** comes after, and is the correctness-critical
one. A host-named unit is an *input* to the same allocation transaction,
never a bypass of it. Already resolved at spec time, do not re-open: a
`seated` party may be moved, and the turn window **carries** from the
original seat event rather than restarting.

Recommend **Opus** for both — V-017 especially.

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
