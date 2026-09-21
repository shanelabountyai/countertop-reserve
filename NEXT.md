# Next: the review is remediated. Two credentials still want rotating.

**<https://reserve.labintelligence.co>** — Vercel + Neon, behind one shared
password (`grep DEMO_ACCESS_PASSWORD .env.production.local`).
`docs/DEPLOYMENT.md` is the full recipe.

Gate green at V-015: lint, typecheck, **768 unit across 19 files**, build,
**32 e2e** — and 768 again under `TZ=Pacific/Kiritimati`.

## What V-015 changed that will surprise you

- **Tests refuse to run unless the environment NAMES the database they may
  wipe.** `TEST_DATABASE_NAME=reserve_test` is set by `npm test` and
  `npm run test:e2e`; CI sets `reserve_ci`. Running bare `vitest` now wipes
  nothing and says why. A local hostname is no longer sufficient, because
  `reserve_dev` is local too.
- **Playwright no longer reuses a running server.** If 3500 is held it
  refuses to start rather than adopting whatever is there. Stop your
  `npm run dev:demo` before a sweep, or set `E2E_REUSE_SERVER=1` knowing you
  are vouching for that server.
- **`fit` re-reads the schedule from the database**, under a shared advisory
  lock. `config.schedule` now supplies only the timezone. A DB test that
  passes an in-memory `Schedule` must also call `seedSchedule(...)` from
  `packages/db/testing` or every slot comes back `closed`.
- **`vitest.config.ts` now includes `apps/web/**`.** A test you add under
  `apps/web` will actually run — which was not true before.
- **A booking with no SMS consent is never auto-released.** Deliberate, and
  the PRD's one unanswered case. See `docs/PROGRESS.md` → V-015 → Decided.

## Outstanding

1. **Rotate `npg_HqiYs7SGU8wT`** — Countertop's Neon password, exposed in a
   session transcript. Update Countertop's Vercel env after.
2. **Rotate this project's Neon password** (`npg_01EMsexvmbAV`); it is in
   `.env.production.local` and in Vercel, both easy to update.
3. **Closure deliverables, still missing.** `docs/DEMO.md` exists; the
   exec-brief artifact and the LinkedIn drafts do not. The project is not
   `good to clear` at the project level until both exist, and the write-up's
   new *From an external code review* section is the best raw material the
   posts have had.

## Wrinkle a future session will hit

`db:seed:demo` writes the *dev* database and `npm run dev` is `dev:test`.
Use `npm run dev:demo` for the local demo — it loads `.env.local` alone.
