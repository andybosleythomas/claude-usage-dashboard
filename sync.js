#!/usr/bin/env node
// Manual sync: scans ~/.claude/projects/*.jsonl and upserts everything into
// the claude_usage_dashboard SQLite database (data/claude_usage_dashboard.sqlite).
// Run with:
//   node sync.js
// Safe to re-run any time — every write is an upsert keyed on natural keys,
// so re-syncing after more chatting just refreshes changed days/sessions.

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { getDb } = require('./db');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const BRISBANE_OFFSET_MS = 10 * 60 * 60 * 1000; // UTC+10, no DST
const GAP_THRESHOLD_MS = 20 * 60 * 1000;

// Per-1M-token pricing: [input, output, cacheWrite5m, cacheWrite1h, cacheRead]
const PRICING = {
  'claude-opus-5': [5, 25, 6.25, 10, 0.5],
  'claude-sonnet-5': [3, 15, 3.75, 6, 0.3],
  'claude-fable-5': [10, 50, 12.5, 20, 1.0],
  'claude-haiku-4-5': [1, 5, 1.25, 2, 0.1],
  'claude-haiku-4-5-20251001': [1, 5, 1.25, 2, 0.1],
  'claude-opus-4-8': [5, 25, 6.25, 10, 0.5],
  'claude-opus-4-7': [5, 25, 6.25, 10, 0.5],
  'claude-opus-4-6': [5, 25, 6.25, 10, 0.5],
  'claude-sonnet-4-6': [3, 15, 3.75, 6, 0.3],
  'claude-sonnet-4-5': [3, 15, 3.75, 6, 0.3],
};

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit']);
const GIT_COMMIT_RE = /\bgit\s+commit\b/i;

function priceFor(model) { return PRICING[model] || null; }
function toBrisbane(ms) { return new Date(ms + BRISBANE_OFFSET_MS); }
function dayKeyBris(ms) { return toBrisbane(ms).toISOString().slice(0, 10); }
function hhmmBris(ms) { return toBrisbane(ms).toISOString().slice(11, 16); }

async function processFile(filePath, repo) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  const sessionId = path.basename(filePath, '.jsonl');
  let session = repo.sessions.get(sessionId);
  if (!session) {
    session = { firstSeen: null, lastSeen: null, messageCount: 0, gitBranch: null, tools: {}, skills: {} };
    repo.sessions.set(sessionId, session);
  }

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj.timestamp) continue;
    const ms = Date.parse(obj.timestamp);
    if (isNaN(ms)) continue;
    const day = dayKeyBris(ms);

    if (session.firstSeen === null || ms < session.firstSeen) session.firstSeen = ms;
    if (session.lastSeen === null || ms > session.lastSeen) session.lastSeen = ms;
    if (obj.gitBranch) session.gitBranch = obj.gitBranch;
    if (obj.cwd) repo.cwdCounts.set(obj.cwd, (repo.cwdCounts.get(obj.cwd) || 0) + 1);
    session.messageCount += 1;

    if (!repo.days.has(day)) {
      repo.days.set(day, {
        input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, commits: 0,
        messages: 0, models: {}, sessionIds: new Set(), timestamps: [], files: new Map(),
      });
    }
    const d = repo.days.get(day);
    d.sessionIds.add(sessionId);

    let hadToolUse = false;
    if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
      for (const block of obj.message.content) {
        if (block.type !== 'tool_use' || !block.name) continue;
        hadToolUse = true;
        session.tools[block.name] = (session.tools[block.name] || 0) + 1;
        if (FILE_TOOLS.has(block.name) && block.input && block.input.file_path) {
          const fp = String(block.input.file_path).slice(0, 400);
          d.files.set(fp, (d.files.get(fp) || 0) + 1);
        }
        if (block.name === 'Bash' && block.input && typeof block.input.command === 'string' && GIT_COMMIT_RE.test(block.input.command)) {
          d.commits += 1;
        }
        if (block.name === 'Skill' && block.input && typeof block.input.skill === 'string') {
          const skillName = block.input.skill.slice(0, 100);
          session.skills[skillName] = (session.skills[skillName] || 0) + 1;
        }
      }
    }
    d.timestamps.push({ ms, hadToolUse });

    if (obj.type === 'assistant' && obj.message && obj.message.usage) {
      const usage = obj.message.usage;
      const model = obj.message.model || 'unknown';
      const input = usage.input_tokens || 0;
      const output = usage.output_tokens || 0;
      const cacheWrite = usage.cache_creation_input_tokens || 0;
      const cacheRead = usage.cache_read_input_tokens || 0;
      let cw5m = cacheWrite, cw1h = 0;
      if (usage.cache_creation) {
        cw5m = usage.cache_creation.ephemeral_5m_input_tokens || 0;
        cw1h = usage.cache_creation.ephemeral_1h_input_tokens || 0;
      }
      d.input += input;
      d.output += output;
      d.cacheWrite += cacheWrite;
      d.cacheRead += cacheRead;
      d.messages += 1;
      d.models[model] = (d.models[model] || 0) + 1;
      const price = priceFor(model);
      if (price) {
        const [pIn, pOut, pCw5, pCw1, pCr] = price;
        d.cost += (input * pIn + output * pOut + cw5m * pCw5 + cw1h * pCw1 + cacheRead * pCr) / 1e6;
      }
    }
  }
}

async function scan() {
  const dirs = fs.readdirSync(PROJECTS_DIR).filter(d =>
    fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory()
  );
  const perRepo = {};
  for (const dir of dirs) {
    const full = path.join(PROJECTS_DIR, dir);
    const files = fs.readdirSync(full).filter(f => f.endsWith('.jsonl'));
    if (files.length === 0) continue;
    const repo = { days: new Map(), sessions: new Map(), cwdCounts: new Map() };
    for (const f of files) {
      await processFile(path.join(full, f), repo);
    }
    perRepo[dir] = repo;
  }
  return perRepo;
}

function getOrCreateRepoId(db, repoKey, cwdPath) {
  const existing = db.prepare('SELECT RepoId FROM Repos WHERE RepoKey = @key').get({ key: repoKey });
  const cwd = cwdPath ? cwdPath.slice(0, 500) : null;
  if (existing) {
    const repoId = existing.RepoId;
    if (cwd) {
      db.prepare('UPDATE Repos SET CwdPath = @cwd WHERE RepoId = @id').run({ id: repoId, cwd });
    }
    return repoId;
  }
  const inserted = db.prepare('INSERT INTO Repos (RepoKey, CwdPath) VALUES (@key, @cwd)')
    .run({ key: repoKey, cwd });
  return inserted.lastInsertRowid;
}

function upsertDailyUsage(db, repoId, day, d) {
  d.timestamps.sort((a, b) => a.ms - b.ms);
  const first = d.timestamps[0].ms, last = d.timestamps[d.timestamps.length - 1].ms;
  let activeMs = 0, toolExecMs = 0, modelLatencyMs = 0;
  for (let i = 1; i < d.timestamps.length; i++) {
    const gap = d.timestamps[i].ms - d.timestamps[i - 1].ms;
    if (gap <= GAP_THRESHOLD_MS) {
      activeMs += gap;
      // Gap right after a tool_use message = waiting on the tool result;
      // otherwise it's model/API latency between turns. A rough two-way
      // split of "active" time, not a precise trace -- see RESEARCH.md.
      if (d.timestamps[i - 1].hadToolUse) toolExecMs += gap;
      else modelLatencyMs += gap;
    }
  }
  const spanHours = Math.round(((last - first) / 3600000) * 100) / 100;
  const activeHours = Math.round((activeMs / 3600000) * 100) / 100;
  const toolExecHours = Math.round((toolExecMs / 3600000) * 100) / 100;
  const modelLatencyHours = Math.round((modelLatencyMs / 3600000) * 100) / 100;

  db.prepare(`
    INSERT INTO DailyUsage
      (RepoId, UsageDate, Cost, Messages, SessionCount, StartTime, EndTime, SpanHours, ActiveHours,
       ToolExecHours, ModelLatencyHours,
       InputTokens, OutputTokens, CacheWriteTokens, CacheReadTokens, CommitCount, UpdatedAt)
    VALUES (@repoId, @day, @cost, @messages, @sessionCount, @start, @end, @spanHours, @activeHours,
            @toolExecHours, @modelLatencyHours,
            @inputTokens, @outputTokens, @cacheWriteTokens, @cacheReadTokens, @commitCount, CURRENT_TIMESTAMP)
    ON CONFLICT(RepoId, UsageDate) DO UPDATE SET
      Cost = @cost, Messages = @messages, SessionCount = @sessionCount,
      StartTime = @start, EndTime = @end, SpanHours = @spanHours, ActiveHours = @activeHours,
      ToolExecHours = @toolExecHours, ModelLatencyHours = @modelLatencyHours,
      InputTokens = @inputTokens, OutputTokens = @outputTokens,
      CacheWriteTokens = @cacheWriteTokens, CacheReadTokens = @cacheReadTokens,
      CommitCount = @commitCount,
      UpdatedAt = CURRENT_TIMESTAMP;
  `).run({
    repoId,
    day,
    cost: Math.round(d.cost * 10000) / 10000,
    messages: d.messages,
    sessionCount: d.sessionIds.size,
    start: hhmmBris(first),
    end: hhmmBris(last),
    spanHours,
    activeHours,
    toolExecHours,
    modelLatencyHours,
    inputTokens: d.input,
    outputTokens: d.output,
    cacheWriteTokens: d.cacheWrite,
    cacheReadTokens: d.cacheRead,
    commitCount: d.commits,
  });

  for (const [model, count] of Object.entries(d.models)) {
    db.prepare(`
      INSERT INTO ModelUsage (RepoId, UsageDate, Model, MessageCount) VALUES (@repoId, @day, @model, @count)
      ON CONFLICT(RepoId, UsageDate, Model) DO UPDATE SET MessageCount = @count;
    `).run({ repoId, day, model, count });
  }

  for (const [fp, count] of d.files) {
    db.prepare(`
      INSERT INTO FileTouches (RepoId, FilePath, UsageDate, TouchCount) VALUES (@repoId, @fp, @day, @count)
      ON CONFLICT(RepoId, FilePath, UsageDate) DO UPDATE SET TouchCount = @count;
    `).run({ repoId, fp, day, count });
  }

  return d.sessionIds.size;
}

// Strips the light markdown the recap hook's LLM writes (**bold**, `code`,
// backtick spans) so the result reads as plain text on a client invoice.
function stripMarkdown(s) {
  return s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/[*_]/g, '');
}

// Condenses that day's session-recap files (~/.claude/tools/hooks/session-recap.sh,
// SessionEnd hook) into a one-line "what was the key deliverable" summary --
// no LLM call needed here, since the recap hook already ran one per session.
// Returns null if no recap file covers this day (predates the hook, or the
// session never triggered SessionEnd), leaving DaySummaries untouched for
// that day rather than writing an empty/wrong row.
function condenseRecapForDay(repoKey, day) {
  const recapDir = path.join(PROJECTS_DIR, repoKey, 'recap');
  let files;
  try { files = fs.readdirSync(recapDir); } catch { return null; }
  const matches = files.filter(f => f.startsWith(day) && f.endsWith('.md')).sort();
  if (matches.length === 0) return null;

  // One line, not a paragraph -- take the headline ("What happened" bullet
  // #1) from the day's LAST session, since that's most likely to reflect
  // the culminating/most-complete state of the day's work.
  for (let i = matches.length - 1; i >= 0; i--) {
    let content;
    try { content = fs.readFileSync(path.join(recapDir, matches[i]), 'utf8'); } catch { continue; }
    const section = content.match(/### What happened\r?\n([\s\S]*?)(\r?\n###|\r?\n---|$)/);
    if (!section) continue;
    for (const line of section[1].split('\n')) {
      const m = line.match(/^-\s*(.+)/);
      if (m) {
        let summary = stripMarkdown(m[1].trim());
        if (summary.length > 400) summary = summary.slice(0, 397) + '...';
        return summary;
      }
    }
  }
  return null;
}

// Only fills DaySummaries when no row exists yet -- never overwrites a
// 'manual' correction, and never re-generates over an already-generated
// 'ai' row just because a later session added a second recap that day.
function fillDaySummaryIfMissing(db, repoId, repoKey, day) {
  const existing = db.prepare('SELECT 1 FROM DaySummaries WHERE RepoId = @repoId AND UsageDate = @day')
    .get({ repoId, day });
  if (existing) return;
  const summary = condenseRecapForDay(repoKey, day);
  if (!summary) return;
  db.prepare(`
    INSERT INTO DaySummaries (RepoId, UsageDate, Summary, Source) VALUES (@repoId, @day, @summary, 'ai')
    ON CONFLICT(RepoId, UsageDate) DO NOTHING;
  `).run({ repoId, day, summary });
}

function upsertSession(db, repoId, sessionId, session) {
  db.prepare(`
    INSERT INTO SessionFiles (RepoId, SessionId, FirstSeen, LastSeen, MessageCount, GitBranch)
    VALUES (@repoId, @sessionId, @firstSeen, @lastSeen, @messageCount, @gitBranch)
    ON CONFLICT(RepoId, SessionId) DO UPDATE SET
      FirstSeen = @firstSeen, LastSeen = @lastSeen, MessageCount = @messageCount, GitBranch = @gitBranch;
  `).run({
    repoId,
    sessionId,
    firstSeen: new Date(session.firstSeen).toISOString(),
    lastSeen: new Date(session.lastSeen).toISOString(),
    messageCount: session.messageCount,
    gitBranch: session.gitBranch,
  });

  for (const [tool, count] of Object.entries(session.tools)) {
    db.prepare(`
      INSERT INTO ToolUsage (RepoId, SessionId, ToolName, CallCount) VALUES (@repoId, @sessionId, @tool, @count)
      ON CONFLICT(RepoId, SessionId, ToolName) DO UPDATE SET CallCount = @count;
    `).run({ repoId, sessionId, tool, count });
  }

  for (const [skill, count] of Object.entries(session.skills)) {
    db.prepare(`
      INSERT INTO SkillUsage (RepoId, SessionId, SkillName, CallCount) VALUES (@repoId, @sessionId, @skill, @count)
      ON CONFLICT(RepoId, SessionId, SkillName) DO UPDATE SET CallCount = @count;
    `).run({ repoId, sessionId, skill, count });
  }
}

async function main() {
  const startedAt = new Date();
  console.log('Scanning', PROJECTS_DIR, '...');
  const perRepo = await scan();
  const repoCount = Object.keys(perRepo).length;
  console.log(`Found ${repoCount} project directories. Connecting to database...`);

  const db = getDb();

  let daysUpserted = 0;
  for (const [repoKey, repo] of Object.entries(perRepo)) {
    // Most-frequent cwd wins, not "last seen" -- a session can briefly touch
    // a scratchpad/temp directory and we don't want that to override the
    // project's real path.
    let modeCwd = null, modeCount = 0;
    for (const [cwd, count] of repo.cwdCounts) {
      if (count > modeCount) { modeCwd = cwd; modeCount = count; }
    }
    const repoId = getOrCreateRepoId(db, repoKey, modeCwd);
    for (const [day, d] of repo.days) {
      if (d.messages === 0) continue;
      upsertDailyUsage(db, repoId, day, d);
      fillDaySummaryIfMissing(db, repoId, repoKey, day);
      daysUpserted++;
    }
    for (const [sessionId, session] of repo.sessions) {
      if (session.firstSeen === null) continue;
      upsertSession(db, repoId, sessionId, session);
    }
    console.log(`  synced ${repoKey}: ${repo.days.size} day(s), ${repo.sessions.size} session(s)`);
  }

  db.prepare(`
    INSERT INTO SyncRuns (StartedAt, FinishedAt, ReposScanned, DaysUpserted)
    VALUES (@startedAt, @finishedAt, @reposScanned, @daysUpserted)
  `).run({
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    reposScanned: repoCount,
    daysUpserted,
  });

  console.log(`Done. ${repoCount} repos, ${daysUpserted} repo-days upserted.`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
