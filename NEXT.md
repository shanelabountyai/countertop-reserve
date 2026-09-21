# Next: nothing. The project is closed and the optional list is empty too.

`docs/backlog.md` has zero unchecked boxes. `docs/WRITEUP.md` is complete
(13 of 13). Every Open Question in the PRD is now marked *resolved* — the
last two closed 2026-09-21 by recording where each V1 answer already lives
in the code, not by building anything.

`docs/screenshots/` has the six-shot portfolio pass, indexed in the
WRITEUP under *The Screens*, with the reshoot recipe beside it.

Gate green at close: 623 unit across 15 files, 29 e2e, all five steps.

CI does not run on docs-only pushes (`paths-ignore: '**/*.md'` and
`docs/**`), so the last four commits have no CI run and should not be
waited for.

## Closure deliverables (per `~/.claude/CLAUDE.md` → *Definition of done*)

All three exist as of 2026-09-21:

| Deliverable | Where |
|---|---|
| Demo script | [`docs/DEMO.md`](docs/DEMO.md) — screen by screen, every command run once before shipping |
| Exec brief | https://claude.ai/artifact/78aJhCD9HZePoiXjun93f6 — *Countertop Reserve in Brief* (private) |
| LinkedIn drafts | https://claude.ai/artifact/Ai5xKScgT2sWtqXRQ1ZA8i — *Lab Intelligence Ledger*, 8 drafts tagged `countertop-reserve` (posts 12–19) |

**Do not start a session here expecting work.** P1-2…P1-8 and all of P2 are
deferred by decision, not pending. If you want to reopen this project, the
only thing that genuinely changes it is P2's real SMS integration — that
needs a public webhook URL, which reopens the deploy decision (currently
"nowhere, deliberately").

## Two wrinkles a future session will hit

**`db:seed:demo` writes the *dev* database, but plain `npm run dev` serves
the *test* one.** Start the server with
`npx dotenv -e .env.local -- npm run dev -w apps/web` to see the demo data.
`docs/DEMO.md` leads with this because it is the most likely thing to go
wrong in front of an audience.

**`.env.local` has no `SMS_WEBHOOK_SECRET` and no `CRON_SECRET`** — only
`.env.test` does. The webhook fails closed (`503`) without one, so the live
SMS section of the demo needs the server started with a secret inline. Also
in `docs/DEMO.md`.
