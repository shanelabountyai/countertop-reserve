# Next: the deploy is live. Docs are current. Two credentials want rotating.

**<https://reserve.labintelligence.co>** — Vercel + Neon, behind one shared
password (`grep DEMO_ACCESS_PASSWORD .env.production.local`). Added at V-014,
which reversed the PRD's "nowhere, deliberately."

`docs/DEPLOYMENT.md` is the full recipe. `docs/backlog.md` has zero unchecked
boxes. Gate green: 636 unit across 16 files, 29 e2e, all five steps.

## What V-014 changed

- **`vercel.json`** — the repo never had one. Root Directory must stay `.` on
  Vercel or the file is never read, and you silently lose the `ignoreCommand`
  (build minutes) and the sweep `crons`.
- **The demo password gate** (`apps/web/lib/demo-gate.ts`). Unset locally and
  in CI, so the suite never sees it. `/api/sms/inbound` and `/api/cron/sweep`
  are exempt — each authenticates itself.
- **The seed opt-in.** `resetDatabase()` still refuses a remote host unless
  `SEED_ALLOW_HOST` names it exactly. Reseeding the hosted demo is the only
  time you will type it; `docs/DEPLOYMENT.md` step 6 has the command.
- **Two tsconfigs.** `next build` was typechecking the e2e specs and unit
  tests, which import devDependencies a production install omits. Defect 16.

## Outstanding

1. **Rotate `npg_HqiYs7SGU8wT`** — Countertop's Neon password, exposed in a
   session transcript. Update Countertop's Vercel env after.
2. **Rotate this project's Neon password** (`npg_01EMsexvmbAV`) at some point;
   it is in `.env.production.local` and in Vercel, both easy to update.
3. **Reseed if the demo data drifts.** The password gate is what keeps
   strangers out of it, but a reseed is one command.

## Wrinkle a future session will hit

`db:seed:demo` writes the *dev* database and `npm run dev` is `dev:test`.
Use `npm run dev:demo` for the local demo — it loads `.env.local` alone.
