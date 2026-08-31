# Progress Log — Countertop Reserve

Mechanical build log, one entry per backlog item: what it built, what it
decided, what it left behind. Pair with `docs/RELEASE_NOTES.md` for the
portfolio-facing version of the same history.

---

## V-001 — Monorepo scaffold, CI, and the four docs

**Built:**
- `apps/web`: Next.js 16.3.3 (App Router) + TypeScript + Tailwind v4, same
  versions as Countertop's own scaffold (known to work together). **Port
  3500 is baked into the `dev`/`start` scripts and into
  `playwright.config.ts`'s default** — never passed as `PORT=` on the command
  line.
- `packages/core`: `package.json` + an empty `index.ts` naming which session
  fills each export, and one scaffold test so the two CI timezone passes run
  a real suite rather than reporting green on zero tests.
- `packages/db`: Prisma client singleton, `schema.prisma` with datasource +
  generator only — no models yet. **Default Prisma client output from day
  one** (no custom `output` path) — Countertop generated its client into
  `packages/db/generated/client`, which made the client unexcludable from
  Turbopack's bundle and cost three failed deploys before C-045 reverted it
  to the default. That fix is inherited here as the starting point, not
  rediscovered.
- `packages/db/prisma/migrations/migration_lock.toml` committed with zero
  migrations present. Also inherited rather than rediscovered: Countertop's
  own C-001 shipped without this file, and its drift-check CI step failed on
  the very first run because Prisma has no connector to diff against an
  empty migrations directory.
- ESLint: `eslint-rules/no-time-axis.mjs`, copied from Countertop's
  *current* (C-003-refined) version rather than its original C-001
  version — the refined one exempts `new Date(Date.UTC(...))`, the one
  argument form every frozen-`now` test needs, so no test file here will
  ever need an `eslint-disable` for it.
- Playwright + `@axe-core/playwright`, `workers: 1`, production build by
  default (`e2e:server` = build + start), `E2E_DEV=1` as the escape hatch.
  Two smoke specs: the app serves on 3500, and the landing page has zero axe
  violations at WCAG 2.1 AA.
- `.github/workflows/ci.yml`: throwaway Postgres, `prisma migrate deploy`
  from scratch, `prisma migrate diff --exit-code` drift check, an assertion
  that the (default-location) Prisma client actually got generated, the unit
  suite twice (`TZ=UTC` and `TZ=Pacific/Kiritimati`), a production build step
  of its own (Countertop only added this at C-024, after two build-only
  failures slipped past a green `tsc`/ESLint/unit gate — built in from the
  start here), then the e2e leg on 3500.
- Local databases `reserve_dev` / `reserve_test` on the brew-managed
  Postgres cluster, with `.env.local` / `.env.test` (both gitignored) wired
  through the `dotenv -e .env.test -e .env.local` first-file-wins pattern,
  and `?connection_limit=10&pool_timeout=20` on both from the start
  (`~/.claude/CLAUDE.md` "Cap the connection pool per project").
- `docs/`: this file, `RELEASE_NOTES.md`, `WRITEUP.md`. `backlog.md` already
  existed from the V-000 kickoff commit (V-001 → V-013, derived from the
  PRD's Timeline / Phasing section).

**Verified locally:** `npm run gate` — lint clean, typecheck clean, unit
1/1 passed, production build clean, e2e 2/2 passed. Full output not
reproduced here; the reconciled counts are the record.

**Decided:**
- **Reused Countertop's proven C-001 file shapes rather than running
  `create-next-app` fresh.** Every config file here (next.config.ts,
  playwright.config.ts, the ESLint wiring, the workspace package.jsons) is a
  known-working template adapted for this project's names and port, not a
  fresh scaffold re-litigating decisions Countertop already made and tested.
- **Skipped the pre-push hook and `ci-local.sh`.** Countertop added those at
  C-033/C-035 to work around a GitHub Actions billing block on private
  repos. This repo hit an *account-level* billing failure on its first push
  (see below) and went public instead, which is the cheaper fix while there
  is no self-hosted runner's exposure to weigh against it — CLAUDE.md's gate
  command covers the same ground locally in the meantime.
- **No `STAFF_PASSCODE` / staff-auth scaffolding.** Countertop's C-037 added
  that once a `/kitchen` route existed to protect. This project's equivalent
  (the host floor view) doesn't exist until V-010 — nothing to gate yet.
- **Repo made public, same day as creation.** The first CI push (private)
  failed with a GitHub billing annotation — "recent account payments have
  failed or your spending limit needs to be increased" — an account-level
  payment problem, not a code or config defect (local `npm run gate` had
  already passed clean before this push). Made public rather than waiting on
  a billing fix, same lever Countertop used at C-044: public repos get free
  GitHub-hosted Actions minutes regardless of the payment method's state.
  Unlike Countertop, there is no self-hosted runner in this repo to worry
  about deregistering — V-001 never built one, so there was nothing for
  going public to make unsafe. Re-run via `workflow_dispatch` after the
  flip: green — lint, typecheck, unit ×2 timezones, drift check, build,
  e2e 2/2.

**Left behind:**
- **No `.env.production.local` / deploy story.** Deployment is out of scope
  until the PRD's own backlog reaches it (there is no V-item for it yet,
  unlike Countertop's C-045) — this project may not need a deploy target at
  all if it never leaves demo/portfolio use.

V-001 committed at acd82b4.
