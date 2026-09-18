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

---

## V-002 — An availability engine that says *why not*

Most booking widgets answer "is 7:00 open?" with a greyed-out button. This
engine answers with a reason for every time it won't offer: already past,
outside service hours, every fitting table taken, or the kitchen's pacing
cap for that 15 minutes is spent. When the whole night is unavailable it
still names the reason: closed, fully booked, or a party too large (or too
small) for any table.

**Tables combine, and a combination is real inventory.** Two two-tops pushed
together make a four-top, but only while both halves are free. The
fixture that proves it had a flaw the first time round. It booked the
combination's *first* table, so an engine that only checked the first table
of a combination passed too. A deliberate mutation of the engine caught the
gap before commit, and the fixture now books the second table.

**Pacing blocks a time even when tables are free.** Eight covers per 15
minutes means a 6:00 bucket holding seven guests refuses a party of two,
while the four-top across the room sits empty. That's the point: the
kitchen is the constraint, not the floor.

Pure TypeScript, no database, no clock. `now` is a parameter, and the whole
suite passes identically in UTC and in Kiritimati (UTC+14).
