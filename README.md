# Countertop Reserve

Table reservations with SMS confirm/change for a full-service restaurant
(sample business: "Firebird Kitchen"). Learning build #6, adjacent to
Countertop. Start with `START-HERE.md`; the product source of truth is
`prd-countertop-reserve.md`, and the working conventions are in `CLAUDE.md`.

## Setup

```bash
npm install
createdb reserve_dev && createdb reserve_test   # or: see "Postgres in Docker" below
cp .env.example .env.local                      # then fill in every name it lists
npm run db:migrate:all
```

`.env.test` overrides only the database and inherits the rest from `.env.local`
(`dotenv -e .env.test -e .env.local`, first file wins). Both files need
`SMS_WEBHOOK_SECRET`, `CRON_SECRET` and `STAFF_PASSCODE` — the webhook, the
sweep route and the host screens all fail closed when theirs is unset.

Give both local `DATABASE_URL`s `?connection_limit=10&pool_timeout=20`:
Postgres's `max_connections` is shared across every project on the machine.

### Which database the tests may wipe

The destructive fixtures TRUNCATE every table, so they refuse to run unless
the environment NAMES the database they are allowed to destroy:

```
TEST_DATABASE_NAME=reserve_test    # set by `npm test` / `npm run test:e2e`
```

`DATABASE_URL` must resolve to exactly that database, on a local host. A
local hostname alone is not enough — `reserve_dev`, the demo database the
floor view reads, is also on localhost, and the test scripts fall back to
`.env.local` when `.env.test` does not load. Unset means refuse, so running
`vitest` directly wipes nothing. **Give the test database its own Postgres
role** if you are sharing the machine; the guard is about identity, a
dedicated role is about privilege, and they are worth having both.

`npm run db:seed:demo` is the deliberate exception and has its own door: it
may wipe a local database of any name, and a remote one only when
`SEED_ALLOW_HOST` names the host exactly.

### Postgres in Docker

Optional, for a machine without a local Postgres. The container listens on
127.0.0.1 only and takes its password from the environment — there is no
default, so it refuses to start rather than come up with a password that
lives in git:

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -base64 24)" >> .env   # gitignored
docker compose up -d
```

Then point `DATABASE_URL`/`DIRECT_URL` at `localhost:5436` with that
password.

## Running

```bash
npm run dev          # http://localhost:3500, on the TEST database
npm run dev:demo     # same port, on the DEV database — what `db:seed:demo` wrote
```

`npm run dev` is an alias for `dev:test`, so it serves the test database. Use
`dev:demo` whenever you want to see seeded demo data (`docs/DEMO.md`).

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
