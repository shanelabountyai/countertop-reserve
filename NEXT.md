# Next: closure deliverables are done. Two credentials still want rotating.

**<https://reserve.labintelligence.co>** — Vercel + Neon, behind one shared
password (`grep DEMO_ACCESS_PASSWORD .env.production.local`).
`docs/DEPLOYMENT.md` is the full recipe.

Gate green at V-015: lint, typecheck, **768 unit across 19 files**, build,
**32 e2e** — and 768 again under `TZ=Pacific/Kiritimati`.

## The previous handoff was wrong about what was missing

It said the exec brief and the LinkedIn drafts did not exist. **Both already
did.** Check before rebuilding — a duplicate brief is exactly how Clearpath
ended up with two in the gallery. Both URLs are now recorded in
`docs/RELEASE_NOTES.md` → *Where the portfolio artifacts live*, which is the
place to look first from now on.

What this session actually did: updated both with the V-015 review material,
and corrected the numbers.

- **Every figure in `WRITEUP.md` → *By the Numbers* had drifted stale-low**,
  the unit count by 145 (623 → **768**, 15 → **19** files, 29 → **32** e2e,
  9 → **10** migrations, 31 → **49** commits, 5,042 → **6,505** lines of
  source). Re-measured by running the suite, not by editing the old row. The
  table now says so, and says to re-run before quoting.
- **Defects recorded is 30, not 16** — 16 found while building, plus the
  review's 14. The honest row is *Defects that survived a commit: 16*,
  because all fourteen of the review's had already shipped.
- The brief now carries the review as its second of five calls, and the
  ledger has three new drafts (30, 31, 32) mined from it: the impossible
  date `2026-09-31`, the booking released for not answering a question never
  asked, and the fifteen tests that had never executed.

## Outstanding

Both rotations need the Neon console, so neither can be done from a session.
**The commands for the half that can be are now in `docs/DEPLOYMENT.md` →
*Rotating the Neon password*** — verified against a fixture, and written to
keep the new value out of the transcript, the shell history and `ps`. Do not
re-derive them; do not paste a password into a session to get help.

Identify each Neon project by its **endpoint**, not by its password — the
endpoint is in the connection string's host, is not a secret, and is what the
console lists. <https://console.neon.tech/app/projects> → Branch → Roles →
`neondb_owner` → Reset password.

1. **Countertop's Neon password** — endpoint `ep-empty-dream-a5px6wnr`
   (`us-east-2`). Exposed in a session transcript. Lives in
   `~/Projects/Restaurant ordering/.env.production.local` and that project's
   Vercel env; its local dev is on `localhost`, so nothing local breaks. Same
   recipe, different repo.
2. **This project's Neon password** — endpoint `ep-dawn-snow-b4dkr9e2`
   (`c-6.us-east-2`). In `.env.production.local` and in Vercel, both easy to
   update.

**Never write a password into this file.** Both of these were named literally
here until 2026-09-21, which put them in the repo and in its history on top of
the transcript that leaked one of them. Once rotated, those committed strings
are dead text and need no history rewrite — but do not re-create the problem.

Rotating breaks the deployed site until Vercel has the new value, and a
`vercel --prod` redeploy is required — an env change alone does not reach a
running deployment.

Nothing else is open. With the rotations done, this project is closed at the
project level: shipped code, `docs/DEMO.md`, the exec brief, the LinkedIn
drafts.

## Things a future session still trips on

- **Tests refuse to run unless the environment NAMES the database they may
  wipe.** `TEST_DATABASE_NAME=reserve_test` is set by `npm test` and
  `npm run test:e2e`; CI sets `reserve_ci`. Bare `vitest` wipes nothing and
  says why.
- **Playwright no longer reuses a running server.** Stop `npm run dev:demo`
  before a sweep, or set `E2E_REUSE_SERVER=1` and own that choice.
- **`fit` re-reads the schedule from the database** under a shared advisory
  lock. A DB test passing an in-memory `Schedule` must also call
  `seedSchedule(...)` from `packages/db/testing`, or every slot is `closed`.
- **`db:seed:demo` writes the *dev* database and `npm run dev` is
  `dev:test`.** Use `npm run dev:demo` for the local demo.
