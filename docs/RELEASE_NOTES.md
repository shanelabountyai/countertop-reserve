# Release Notes — Countertop Reserve

The portfolio-facing history: one entry per backlog item, written for "walk
me through something you built." `docs/PROGRESS.md` is the mechanical
version of the same history.

---

## V-001 — Project scaffold, built on top of a finished sibling project's scars

This is the second restaurant project built on this stack — Countertop
(online ordering) shipped first, and its `WRITEUP.md` has a defects section
naming exactly what went wrong along the way. The interesting question for a
scaffold session isn't "does this work," it's "which of those defects can
this project simply not have."

**A bundled Prisma client cost Countertop three failed deploys.** Its
schema generated the client into a custom path beside the schema file
(`packages/db/generated/client`), which reads nicely — until you notice a
custom path is imported by relative path, and a relative import has no
package name to hand to Next's `serverExternalPackages`. Turbopack bundled
it, and a bundled Prisma client can't find its own query engine binary at
runtime — a failure that is invisible locally (dev server doesn't bundle;
the e2e build runs on the same machine that generated the engine) and only
shows up as a 500 on a deployed page. This project's schema has no custom
output path. Not a fix — there was never a bug to fix, because the mistake
never got made.

**A missing lock file would have broken CI on the first run.** Countertop's
drift-check step failed on its very first CI execution: with zero
migrations written, Prisma had no `migration_lock.toml` to determine a
connector from, and the "no difference" check isn't a no-op on an empty
directory, it's an error. The fix there was a follow-up commit. Here, the
file exists from the first commit.

**The rest of the scaffold is a known-good template, not a rediscovery.**
Next.js App Router + TypeScript + Tailwind, the same restaurant-timezone
ESLint bans (`new Date(string)`, `Date.parse`, the `get/set*` accessors,
`getTimezoneOffset`, UTC-day slicing — carried forward through two projects
now), Playwright + axe from commit one, and a CI workflow that builds a
throwaway Postgres from nothing and demands the unit suite pass identically
under `TZ=UTC` and `TZ=Pacific/Kiritimati`. The production-build gate step
Countertop only added after two separate bundler-only failures (C-024) is
here from the start, because there was no reason to wait for the same
lesson twice.

**What's actually new:** a floor plan and an availability engine that has to
answer "why not," not just "not now" — the next session's work, not this
one's.
