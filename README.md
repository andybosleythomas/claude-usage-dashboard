# Pulse

*(repo: claude-usage-dashboard)*

A local, database-backed dashboard that scans your Claude Code session logs
(`~/.claude/projects/*/*.jsonl`) and turns them into cost, time, client-billing,
and productivity insights.

Everything lives in a local SQLite database (`data/claude_usage_dashboard.sqlite`
— a single file, no server to install) so history persists even if Claude Code
ever rotates or deletes old session log files. A small local Express server
reads and writes that database live — no download/replace/regenerate
workflow, no static files to keep in sync.

## Features

- **Dashboard** — token cost, "my time" cost (valued at each client's hourly
  rate), sessions/messages/active days, daily spend timeline, daily working
  hours (first-to-last span vs. actual active-chatting time), model mix, and a
  full per-repo breakdown table. Filterable by client, repo, and month. Hours
  and cost figures fold in any Time-tab Adjustment/Manual overrides (marked
  with a `•`), plus a separate table for client-level time with no repo.
- **Insights** — cache hit rate + estimated $ saved by prompt caching (and an
  approximate cost breakdown by input/output/cache-write/cache-read), a
  day-of-week cost-anomaly flag and month-to-date spend forecast, cost per
  detected git commit (plus verified `git log` commit history when a single
  repo is selected), focus ratio (active time / session span) with a rough
  cycle-time split (waiting on tool result vs. waiting on model) and an
  adjustable "manual-equivalent hours" estimate per client (explicitly an
  assumption, not a measurement — see `RESEARCH.md`), a utilization metric
  (billable vs. non-billable active hours), current & longest activity
  streaks, an "investment by client over time" stacked chart, tool usage mix
  (by individual tool and by taxonomy: code-changing / investigative /
  execution / orchestration / external), a rework-rate signal (files
  revisited across 3+ distinct days), and "hot files" (most Read/Write/Edit'd
  files) — all filterable the same way as the dashboard.
- **Things to Try** — a set of nudges toward underused Claude Code
  capabilities (subagents, web research, MCP integrations, Skills, scripted
  multi-agent workflows, escalating to a stronger model, code review, and
  security/cyber assessment), each one triggered off an actual pattern in the
  current period's tool-call mix rather than generic advice — including
  which named Skills (e.g. `code-review`, `security-review`) have actually
  been invoked, from a `SkillUsage` table synced from each Skill tool call's
  own input — plus a per-repo table flagging candidates (e.g. heavy
  investigative tool use with zero subagent fan-out, or real code-changing
  activity with no review/security pass run against it).
- **Invoicing** — itemized per-client, per-month invoice (day-by-day active +
  idle hours × that client's rates, subtotaled per repo, with configurable
  per-line rounding), with print/PDF and CSV export buttons. The Dashboard's
  full-breakdown table also has a CSV export button. Line items fold in
  Time-tab Adjustment/Manual overrides, and client-level (no-repo) time
  appears as its own "(General — no repo)" line. Expenses for the same
  client/month appear as a separate category (recurring ones materialized
  first), with a time subtotal, expenses subtotal, and grand total. Each
  day also carries a one-line "what was the deliverable" summary (`dbo.DaySummaries`)
  next to the date — auto-condensed from that day's session-recap file by
  `sync.js` (falls back to nothing if no recap exists yet), editable per
  repo/day on the Time tab, same spirit as the manual time-entry notes.
- **Client Report** — a clean, printable "value delivered" summary per
  client/month: active hours, sessions, active days, projects touched, a
  few plain-language highlights, and a per-project breakdown table. No
  dollar figures by default (there's an "include cost figures" checkbox) —
  this is for sending to the client to show the work, not for billing math
  (that's what Invoicing is for).
- **Clients** — create clients and set active/idle hourly rates, a manual-work
  multiplier (feeds the Insights "manual-equivalent" estimate), and an invoice
  rounding increment. Edits save to the database immediately.
- **Assign Repos** — map every project directory under `~/.claude/projects` to
  a client. Unassigned repos cost $0 until assigned. Edits save immediately.
- **Time** — a day-first grid for manual time keeping. Pick a date and, per
  repo, enter an **Adjustment** (replaces that day's auto-computed hours when
  it's wrong) and/or **Manual** (separate non-Claude time — meetings,
  planning — added on top), plus an editable **Summary** — the one-line
  "what was the deliverable" text shown on Invoicing. A "client-level time"
  section below covers work with no Claude Code session at all. Just a
  number of hours, no start/finish times. Everything entered here feeds into
  Dashboard and Invoicing.
- **Expenses** — client-incurred costs (travel, subscriptions, software),
  scoped to a client and optionally a repo. One-off or recurring; recurring
  expenses auto-generate their next occurrence (up to today) every time the
  tab loads, so there's nothing to run manually. CSV export, per-client-per-
  month total.

## Setup

No database server to install — everything lives in a single local SQLite
file (`data/claude_usage_dashboard.sqlite`, created automatically, never
committed to git).

```sh
npm install
node sync.js       # scans ~/.claude/projects, upserts into a local SQLite file (created on first run)
node server.js     # starts the live app at http://localhost:4173
```

Open `http://localhost:4173` in a browser. `node scripts/init-db.js` creates
(or verifies) the empty database explicitly, if you want to see that step in
isolation before running a real sync — useful mainly for a fresh install.

### Bringing in history from before this app existed

Claude Code's own SessionEnd hook auto-writes a short recap file at the end
of every session (see `~/.claude/tools/hooks/session-recap.sh`), and this
app condenses that into the one-line "what got delivered" text shown
throughout the app. Sessions from before that hook was installed have no
recap, so they show up in cost/hours numbers (`node sync.js` picks up all
history, not just new activity) but with no deliverable summary.

```sh
node scripts/backfill-recaps.js               # dry run: counts sessions with no recap yet
node scripts/backfill-recaps.js --run          # generate one retroactively for each (one `claude -p --model haiku` call per session -- try --limit N first on a big history)
node sync.js                                    # pull the new recaps into DaySummaries
```

Two layers of tests:

```sh
npm test          # unit tests (lib/calc.js) -- no server or DB needed
npm run smoke-test # hits every API endpoint on a running node server.js
```

`npm test` covers the trickiest pure math (anomaly z-score, MTD forecast,
invoice rounding, streak calculation) in isolation. `smoke-test` is cheap
insurance against the kind of silent regression (a SQL-driver type mismatch
that made the client filter quietly return nothing) that shipped once
already during development — run it after any change to `server.js`,
`sync.js`, or the schema.

### LAN access

`server.js` binds to all interfaces, so it's reachable from other devices on
your local network at `http://<this-PC's-LAN-IP>:4173` (find the IP with
`ipconfig`). Windows Firewall blocks this by default on a "Public" network
profile; an inbound rule scoped to your subnet is required — see the repo's
git history / chat log for the exact `New-NetFirewallRule` command used.
**There's no authentication by default** — anyone who can reach that port on
your LAN can view and edit client billing data. Fine for a home network you
trust; don't expose this port beyond that. If you want a password gate
(e.g. phone access over a less-trusted network), set `DASHBOARD_PASSWORD`
before starting the server:

```sh
# PowerShell
$env:DASHBOARD_PASSWORD = "your-password-here"; node server.js
```

This enables HTTP Basic Auth (any username, that password) for every route.
Browsers will prompt for credentials once and remember them for the session.
Leave the variable unset to keep the previous no-auth behavior.

### Keeping data fresh

Sync is **manual by design** — run it whenever you want the dashboard to pick
up recent chatting:

```sh
node sync.js
```

It's idempotent: every write is an upsert keyed on natural keys (repo, day,
session, model, file, tool), so re-running after more activity just refreshes
what changed. No automatic/scheduled sync — that was a deliberate choice, not
an oversight.

### Database backups

```sh
node scripts/backup-db.js
```

Uses `better-sqlite3`'s native online-backup API to write a timestamped
snapshot of `data/claude_usage_dashboard.sqlite` to `backups/` (a plain file
copy can miss pages still sitting in the WAL, so this is safe to run while
the server is up). `backups/` is gitignored — nothing here is ever committed.
`scripts/backup-db.ps1` is a thin wrapper for Windows Task Scheduler; the
repo runs it weekly via a scheduled task named "claude-usage-dashboard weekly
DB backup".

## Architecture

```
sql/schema.sqlite.sql — SQLite schema, applied automatically by db.js on every startup (safe to re-run)
db.js                   — opens data/claude_usage_dashboard.sqlite (better-sqlite3), applies the schema
sync.js                 — scans ~/.claude/projects/*.jsonl, upserts everything into the DB (run manually)
server.js               — Express app: serves the dashboard + a small JSON API that reads/writes the DB live
lib/calc.js             — pure computation functions (anomaly z-score, forecast, invoice rounding, streaks) used by server.js, unit-tested in isolation
public/dashboard.html   — the frontend: fetches data from the API, persists every edit immediately
test/calc.test.js       — unit tests for lib/calc.js (npm test)
scripts/smoke-test.js         — live-server endpoint checks (npm run smoke-test)
scripts/init-db.js            — creates/verifies an empty database (npm run init-db)
scripts/backfill-recaps.js    — retroactively generates recap files for sessions predating the recap hook (npm run backfill-recaps)
package.json
```

### Database schema (`data/claude_usage_dashboard.sqlite`)

- **Clients** — name, active/idle hourly rates, manual-work multiplier, invoice rounding increment
- **Repos** — every `~/.claude/projects` directory seen, optionally linked to a Client, plus its most-frequently-seen working directory (`CwdPath`, from the JSONL `cwd` field) for git-log correlation
- **DailyUsage** — one row per (repo, Brisbane calendar day): cost, messages, sessions, token counts, active/span hours (split into tool-exec/model-latency sub-components), detected commit count
- **ModelUsage** — per (repo, day, model) message counts, for the model-mix chart
- **SessionFiles** — one row per `.jsonl` session file: first/last seen, message count, git branch
- **ToolUsage** — per (repo, session, tool) call counts, for the tool-mix insight
- **FileTouches** — per (repo, file, day) touch counts (Read/Write/Edit/NotebookEdit), for the hot-files and rework-rate insights
- **SyncRuns** — a log row per `node sync.js` run

### API (served by `server.js`)

- `GET /api/data` — records (incl. detected commits) + session counts + client config, for the Dashboard tab
- `GET /api/insights?month=&repo=&client=` — cache efficiency + cost breakdown, cost anomaly, MTD forecast, cost-per-commit, focus ratio + manual-equivalent + cycle time, utilization, streaks, tool mix + taxonomy, rework signal, hot files
- `GET /api/invoice?client=&month=` — itemized line items (rounded per the client's increment) + totals
- `GET /api/repo-commits?repo=&month=` — verified commit history (hash/date/author/message) via `git log` on the repo's recorded working directory; only meaningful for one repo at a time. Returns `{available: false, reason}` if the directory isn't a git repo, no longer exists, or `git` isn't on PATH.
- `POST /api/clients` `{name, activeRate, idleRate, manualMultiplier, roundingIncrementMinutes}` — upsert a client
- `DELETE /api/clients/:name` — remove a client (repos assigned to it become Unassigned)
- `POST /api/repo-clients` `{repo, client}` — assign (or unassign, `client: null`) a repo

## Updating pricing

`sync.js` has a `PRICING` table mapping model ID → `[input, output, cacheWrite5m, cacheWrite1h, cacheRead]`
price per 1M tokens. Update it when Anthropic ships new models/prices, then
re-run `node sync.js` to recompute historical cost with the new rates (cost is
recomputed and overwritten on every sync, not accumulated).

## Caveats

- **Cost is estimated**, not billed — first-party API list pricing, doesn't
  account for subscription-plan billing, promotional pricing, or the exact
  cache-write TTL actually used per request.
- **"Active hours"** uses a 20-minute gap cutoff (`GAP_THRESHOLD_MS` in
  `sync.js`) as a heuristic for "still actively working" vs. "walked away".
- **"My time" cost** is `activeHours × client.activeRate + (spanHours − activeHours) × client.idleRate`.
  A day spent running parallel sessions across multiple repos over-counts
  relative to actual wall-clock hours, since each repo's hours are summed
  independently.
- **Cache-savings estimate** (Insights tab) uses a blended average input-token
  price across whichever models appear in the selected period — a rough
  figure, not an exact bill.
- **Session counts** are per-`.jsonl`-file. A session spanning multiple days
  counts once per calendar day it touched in the Dashboard's per-day session
  count, but once per month (bucketed by its first message) in the "Sessions"
  tile and Full Breakdown table.
- Repos whose Claude Code sessions were launched from the wrong working
  directory (e.g. `C:\Windows\System32`) show up as their own "repo" — a
  Claude Code quirk, not a bug in this tool.
- **Detected commits** (`git commit` pattern-matched inside logged Bash
  commands) are a rough proxy, not a verified git-log count — a commit run
  from outside Claude Code, or a command that doesn't literally contain
  "git commit" (e.g. a GUI client), won't be counted.
- **Cycle-time split** (waiting on tool result vs. waiting on model) is a
  rough two-way classification of already-"active" gaps based on whether the
  preceding message contained a tool call — not a precise trace of what
  actually happened during each gap.
- **Recorded working directory** (`Repos.CwdPath`, used for the verified
  git-log commits view) is whichever `cwd` value appears most often across a
  repo's session logs — a repo whose sessions spent more time in a scratchpad
  or subagent working directory than the actual project root will show that
  path instead, and `git log` will correctly report it's not a git repository
  rather than showing wrong commits.
- **"Manual-equivalent hours"** and the "rework rate" file-churn signal are
  both deliberately framed as assumptions/proxies, not measurements — see
  `RESEARCH.md` for why (the METR RCT finding that developers' *self-reported*
  AI speedup was ~40 points off from measured reality is the reason we never
  present a hard "time saved" number).

## Further reading

`RESEARCH.md` documents the overnight research pass (competitor AI-coding
dashboards, engineering-intelligence platforms, consulting billing norms, AI
productivity-measurement pitfalls, and simple anomaly/forecast formulas) that
the Insights-tab features above were built from.
