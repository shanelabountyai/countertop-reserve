# Project Write-Up: Countertop Reserve — Table Reservations with SMS Confirm & Change

> Portfolio write-up. Appended as the build happens, per CLAUDE.md — scaling
> caveats, deliberate simplifications, and defects found go in **as they
> happen**, not reconstructed at the end.

**Repo:** https://github.com/shanelabountyai/countertop-reserve (private)
**Live demo:** _(not yet — may not be needed; see Scaling Caveats)_
**Built with:** Claude Code + Next.js (App Router) · TypeScript · Postgres/Prisma · Tailwind · Vitest/Playwright + axe
**Status:** In progress — V-001 of 13 backlog items · 2026-08-31

---

## The Business Problem

*(filled in as the guest booking flow and the message channel land — see the PRD's Problem Statement for the working version.)*

## What I Built

*(filled in as phases land.)*

## The Screens

*(filled in as phases land.)*

## How It's Built

**The second project on this stack, and it shows.** This is Countertop's
sibling — same restaurant, same conventions, same Claude Code working
loop — and the scaffold session (V-001) was written by reading Countertop's
own `WRITEUP.md` Defects Found section first. Two defects that cost
Countertop real time (a bundled Prisma client that broke only on deploy; a
missing `migration_lock.toml` that broke CI on its first run) simply don't
exist here — not fixed, avoided, because the cause was legible from the
first project's own record of it.

## Scaling Caveats and Deliberate Simplifications

- **No deploy target yet, possibly never.** Countertop went to Vercel + Neon
  because the PRD named that as the target. This PRD doesn't have an
  equivalent line — the seeded 60-cover demo (V-013) may be the whole
  deliverable. Revisit once the message channel (V-006/V-007) exists, since
  a live SMS integration is the one thing genuinely hard to demo without
  something running somewhere.
- **Floor view poll interval is fixed at 10s** (P0-9), not a backoff — the
  PRD calls this out explicitly ("a floor moves slower than a kitchen
  queue"). Noted here rather than only in the PRD so it isn't rediscovered
  as a question later.

## Defects Found

*(none yet — V-001 is a scaffold with nothing to have a defect in beyond
config, and the two defects a scaffold session could have repeated are
covered under How It's Built above.)*

## Skills Learned / Functions Unlocked

*(filled in as phases land.)*

## The Hardest Bug

*(reserved for the end.)*

## What I'd Do Differently

*(reserved for the end.)*

## By the Numbers

*(reserved for the end.)*
