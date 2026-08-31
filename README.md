# Countertop Reserve

Table reservations with SMS confirm/change for a full-service restaurant
(sample business: "Firebird Kitchen"). Learning build #6, adjacent to
Countertop. Start with `START-HERE.md`; the product source of truth is
`prd-countertop-reserve.md`, and the working conventions are in `CLAUDE.md`.

## Setup

```bash
npm install
createdb reserve_dev && createdb reserve_test   # or: docker compose up -d
cp .env.example .env.local                      # then fill in DATABASE_URL/DIRECT_URL
npm run db:migrate:all
```

`.env.test` overrides only the database and inherits the rest from `.env.local`
(`dotenv -e .env.test -e .env.local`, first file wins).

## Running

```bash
npm run dev          # http://localhost:3500
```

**This repo owns port 3500** (storage 3000, rental 3100, event toolkit 3200,
bookable 3300, Countertop 3400). It is the default in `apps/web/package.json`
and `playwright.config.ts`, not an environment variable — a forgotten `PORT=`
must not be able to hijack a neighbouring project's server.

## The gate

Nothing is done until all five pass:

```bash
npm run gate    # lint, typecheck, unit, build, e2e
```

e2e runs against a production build; `E2E_DEV=1 npm run test:e2e` restores the
dev server for stack traces when debugging a single spec.

## Layout

| Path | What lives there |
|---|---|
| `apps/web` | Next.js App Router — guest booking, the manage page, the host floor view |
| `packages/core` | The domain engine: pure functions, no database, no clock — the availability engine, allocation rules, reservation lifecycle |
| `packages/db` | Prisma schema and hand-written migrations |
| `docs/` | `backlog.md`, `PROGRESS.md`, `RELEASE_NOTES.md`, `WRITEUP.md` |
