# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Pulse" — a local, database-backed dashboard that scans Claude Code session
logs (`~/.claude/projects/*/*.jsonl`) and turns them into cost, time,
client-billing, and productivity insights. Single local Node/Express server,
single SQLite file, single vanilla-JS HTML frontend — no build step, no
frontend framework.

## Commands

```sh
npm install
node sync.js         # scan ~/.claude/projects, upsert into SQLite (manual, idempotent)
node server.js        # start the app at http://localhost:4173
npm test              # unit tests (lib/calc.js) -- no server/DB needed
npm run smoke-test     # hits every API endpoint on a running node server.js -- run after touching server.js, sync.js, or the schema
npm run init-db         # creates/verifies an empty DB explicitly
npm run backfill-recaps # retroactively generate recap files for pre-hook sessions (dry-run by default; --run to execute, --limit N to cap)
```

Run a single unit test file directly: `node --test test/calc.test.js`.

There is no lint/build step configured.

## Architecture

```
db.js                   — opens data/claude_usage_dashboard.sqlite (better-sqlite3), applies sql/schema.sqlite.sql on every startup (safe to re-run)
sync.js                 — scans ~/.claude/projects/*.jsonl, upserts into the DB (run manually, never automatic)
server.js               — Express app: serves the dashboard + a JSON API that reads/writes the DB live
lib/calc.js             — pure computation functions (anomaly z-score, MTD forecast, invoice rounding, streaks), unit-tested in isolation
public/dashboard.html   — the entire frontend: fetches from the API, persists every edit immediately, no build step
test/calc.test.js       — unit tests for lib/calc.js
scripts/smoke-test.js         — live-server endpoint checks
scripts/init-db.js            — creates/verifies an empty database
scripts/backfill-recaps.js    — retroactively generates recap files for sessions predating the recap hook
scripts/backup-db.js          — backs up the live SQLite file to backups/ (gitignored)
sql/schema.sqlite.sql   — live SQLite schema, applied automatically by db.js
```

### Data flow

`sync.js` is the only writer that ingests raw data. It reads every session's
`.jsonl` file under `~/.claude/projects`, computes cost (from its own
`PRICING` table, model ID → per-1M-token input/output/cache prices),
active-vs-span hours (20-minute gap cutoff, `GAP_THRESHOLD_MS`), and detected
commits, then upserts into `DailyUsage`, `ModelUsage`, `SessionFiles`,
`ToolUsage`, `FileTouches`, and `DaySummaries` — all upserts keyed on natural
keys (repo/day/session/model/file/tool), so re-running after more activity
just refreshes what changed. Cost is **recomputed and overwritten** on every
sync, not accumulated — updating `PRICING` and re-running `sync.js` rewrites
historical cost at the new rates.

`server.js` never touches the raw JSONL logs — it only reads/writes the
SQLite tables sync.js populated, plus a few tables edited directly by the UI
(`Clients`, `Repos.Client` assignment, `TimeEntries` adjustments/manual
hours, `DaySummaries` edits, `Expenses`). `lib/calc.js` holds the pure math
shared by multiple endpoints (anomaly detection, forecasting, rounding,
streaks) so it can be unit-tested without a live DB or server.

All day-bucketing uses Brisbane time (UTC+10, no DST) — see
`BRISBANE_OFFSET_MS`/`dayKeyBris` in `sync.js`. Don't use local-machine
timezone or UTC-midnight boundaries when adding day-level logic. Change this
if you're not in that timezone.

### API surface (server.js)

`GET /api/data`, `/api/insights`, `/api/invoice`, `/api/repo-commits`,
`/api/recap`, `/api/time-entries(-summary)`, `/api/expenses`; `POST`/`DELETE`
on `/api/clients`, `/api/repo-clients`, `/api/time-entries`,
`/api/day-summaries`, `/api/expenses`, `/api/sync`. All filter by
`client`/`repo`/`month` query params where applicable. See README.md's
Architecture section for the full per-endpoint description and the
`DailyUsage`/`ModelUsage`/`SessionFiles`/`ToolUsage`/`FileTouches`/`SyncRuns`
table shapes.

`/api/repo-commits` shells out to `git log` against each repo's recorded
`CwdPath` (most-frequent `cwd` seen in that repo's session logs) — it's a
verification layer on top of `sync.js`'s regex-detected commit counts, not a
replacement for them.

### Frontend

`public/dashboard.html` is the entire client: markup, styles, and JS in one
file (`<script>` block starting ~line 607), no bundler, no framework. Tabs:
Dashboard, Insights, Things to Try, Invoicing, Client Report, Clients, Assign
Repos, Time, Expenses (see README.md's Features section for what each does).
Every edit (client rates, repo assignment, time adjustments, day summaries,
expenses) saves to the DB immediately via the API — there's no separate
"save" step or client-side-only state to worry about losing.

## Working conventions specific to this repo

- **Never hand-edit `data/claude_usage_dashboard.sqlite`** — all writes go
  through `db.js`/`sync.js`/`server.js` so the schema-apply and upsert-key
  invariants hold. The file (and its `-shm`/`-wal` siblings) is gitignored.
- Estimates and proxies throughout this app (cost, "manual-equivalent
  hours", rework rate, detected-commit count, cycle-time split) are
  deliberately framed as assumptions, not measurements — see README.md's
  Caveats section and `RESEARCH.md` before changing how any of them are
  presented or before adding a new one. Don't upgrade a labeled estimate to
  look like a precise/verified number without the same rigor (or an explicit
  "verified" data source like `/api/repo-commits`'s `git log` cross-check).
- Sync is manual by design (no scheduled/automatic sync) — don't add one
  without discussing it first.
- After changing `server.js`, `sync.js`, or the schema, run
  `npm run smoke-test` against a running `node server.js` — a past SQL-driver
  type mismatch silently broke the client filter and shipped undetected
  without it.
