# Deployment — Countertop Reserve

Target: **`reserve.labintelligence.co`**, Vercel + Neon, matching the sibling
projects (`eventoolkit`, `storage`, `talk4me`).

This reverses the PRD's original "nowhere, deliberately." The reasoning is in
the PRD's Open Questions and in `WRITEUP.md`; the short version is that the
original answer was right about SMS and wrong about the demo. A hosted copy
does not add a carrier — the carrier is still a stub, still a Non-Goal — it
adds a link you can send.

> [!IMPORTANT]
> **This is a demo deployment, not production.** No backups, no monitoring,
> no on-call. Every row in it is a fixture. Say so before anyone assumes
> otherwise — the same rule as the brief's "what this is not."

---

## What is already in the repo

| Piece | Where | What it does |
|---|---|---|
| Build config | `vercel.json` | Monorepo build (`apps/web/.next`), the `ignoreCommand`, and the sweep cron every 15 minutes. |
| Demo password gate | `apps/web/lib/demo-gate.ts` | One shared HTTP Basic password over the whole site when `DEMO_ACCESS_PASSWORD` is set. Unset = no gate, which is how local and CI run. |
| Seed opt-in | `packages/db/testing/index.ts` | `resetDatabase()` still refuses any non-local host unless `SEED_ALLOW_HOST` names it **exactly**. |

Both guards have their own unit tests (`reset-guard.test.ts`,
`demo-gate.test.ts`) — 13 assertions between them, most of them about the ways
each gate could open by accident.

## The `ignoreCommand`, and why it reads backwards

```
exit 0  → SKIP the build
exit 1  → BUILD
```

That is inverted from every other exit code, and nothing warns you. It diffs
from `$VERCEL_GIT_PREVIOUS_SHA` (the last **successful** deployment), never
`HEAD^` — Vercel's own doc example uses `HEAD^` and it is wrong for any repo
that pushes twice quickly, because job cancellation means the surviving
deployment is often the later, docs-only commit. The `git cat-file -e` guard
plus the trailing `|| exit 1` make every failure mode fall to *build*, because
skipping on error is a deployment that silently never happens.

## Order to do it in

1. **A separate Neon database.** Not `reserve_dev`, not `reserve_test` — the
   test suite truncates freely. Set `DATABASE_URL` (pooled) and `DIRECT_URL`
   (direct); migrations need the direct one because Neon's pooler rejects some
   startup parameters.
2. **`vercel link`** from the repo root, or Add New → Import Git Repository.
   Link to git rather than pushing files: a project created by a file push is
   not connected to the repo, and every later deploy is another manual push.
3. **Environment variables** (below) — including `DEMO_ACCESS_PASSWORD`
   **before** the first deploy, not after.
4. **Preview deploy first.** Confirm it builds and that `/book` challenges for
   the password.
5. **Migrations against the new database**, deliberately outside the build:
   ```bash
   DIRECT_URL="<neon direct>" npm run db:migrate:deploy -w packages/db
   ```
   A build that migrates is a build that can half-migrate.
6. **Seed it** — the one command that needs the opt-in, and the only time you
   will ever type it:
   ```bash
   SEED_ALLOW_HOST="<the neon hostname, exactly>" \
     DATABASE_URL="<neon pooled>" DIRECT_URL="<neon direct>" \
     npx tsx packages/db/seed-demo.ts
   ```
   The hostname must match character for character. A prefix, a suffix, a
   wildcard, or a trailing space is refused — that is what the tests pin.
7. **The DNS record** for `reserve.labintelligence.co`, then verify:
   ```bash
   curl -sI https://reserve.labintelligence.co/book      # 401, WWW-Authenticate: Basic
   curl -sI -u "demo:$PASS" https://reserve.labintelligence.co/book   # 200
   ```

## Environment variables

| Variable | Without it |
| --- | --- |
| `DATABASE_URL` | Neon **pooled** string. Nothing runs. |
| `DIRECT_URL` | Neon **direct** string. Migrations fail. |
| `STAFF_PASSCODE` | The `/host` screens stay locked and say so. |
| `SMS_WEBHOOK_SECRET` | `/api/sms/inbound` returns `503`, fails closed. |
| `CRON_SECRET` | `/api/cron/sweep` refuses every request, so nothing is ever released. |
| `DEMO_ACCESS_PASSWORD` | **The site is fully public.** Strangers can book tables into the seeded service. |

Generate the secrets with `openssl rand -hex 32`. None of them may be the
values in `.env.local` — those are local demo values and are documented as
such.

## The two routes the password gate does not cover

`/api/sms/inbound` and `/api/cron/sweep` are exempt, deliberately. Each already
authenticates: the webhook validates an HMAC-SHA256 signature over the raw
body, the sweep requires `Authorization: Bearer $CRON_SECRET`. Putting Basic in
front of them would break Vercel Cron and the live-SMS demo, and would add
nothing — a stranger without the signature is already refused with `401`.

This does mean **the webhook is genuinely on the public internet**. That is the
project's whole thesis rather than a regret: inbound is a trust boundary, the
signature is the boundary, and it is now being tested by the internet instead
of by a test suite.

## Demo data drift

The password gate is what keeps the seeded service clean — without it, anyone
who finds the URL can book a table and the report numbers you read aloud stop
matching `DEMO.md`.

If the numbers ever drift, reseed with step 6. There is no automatic reseed,
deliberately: a nightly job that truncates a database is a worse thing to own
than a command you run before a demo.

> **ponytail:** one shared password, manual reseed. Upgrade is a scheduled
> reseed only if the drift actually becomes annoying, and per-viewer accounts
> only if this ever holds data that matters. Neither is worth building now.
