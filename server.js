#!/usr/bin/env node
// Live local web app for the claude-usage-dashboard. Reads/writes the local
// SQLite database directly -- no download/replace/regenerate step.
// Run with: node server.js
// Data itself is refreshed separately via: node sync.js

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { execFile } = require('child_process');
const util = require('util');
const express = require('express');
const { getDb } = require('./db');
const {
  computeCostAnomaly, computeForecast, computeRoundedHours, computeStreaks,
  materializeOccurrenceDates, computeEffectiveHours,
} = require('./lib/calc');

const execFileAsync = util.promisify(execFile);

const PORT = process.env.PORT || 4173;
const UNASSIGNED = 'Unassigned';
const BRISBANE_OFFSET_MS = 10 * 60 * 60 * 1000; // UTC+10, no DST

function matchesRepoClient(r, { repo, client, wantedClientId }) {
  return (repo === 'all' || r.repo === repo) &&
    (client === 'all' || (client === UNASSIGNED ? r.clientId == null : r.clientId === wantedClientId));
}

// Per-1M-token pricing (input, output, cacheWrite5m, cacheWrite1h, cacheRead),
// used only for blended-average insight estimates -- sync.js's copy is the
// source of truth for stored cost.
const PRICING = {
  'claude-opus-5': [5, 25, 6.25, 10, 0.5], 'claude-sonnet-5': [3, 15, 3.75, 6, 0.3], 'claude-fable-5': [10, 50, 12.5, 20, 1.0],
  'claude-haiku-4-5': [1, 5, 1.25, 2, 0.1], 'claude-haiku-4-5-20251001': [1, 5, 1.25, 2, 0.1],
  'claude-opus-4-8': [5, 25, 6.25, 10, 0.5], 'claude-opus-4-7': [5, 25, 6.25, 10, 0.5], 'claude-opus-4-6': [5, 25, 6.25, 10, 0.5],
  'claude-sonnet-4-6': [3, 15, 3.75, 6, 0.3], 'claude-sonnet-4-5': [3, 15, 3.75, 6, 0.3],
};

const TOOL_CATEGORY = {
  Edit: 'Code-changing', Write: 'Code-changing', NotebookEdit: 'Code-changing',
  Read: 'Investigative', Grep: 'Investigative', Glob: 'Investigative',
  Bash: 'Execution', PowerShell: 'Execution',
  Agent: 'Orchestration', TaskCreate: 'Orchestration', TaskUpdate: 'Orchestration',
  TaskList: 'Orchestration', TaskGet: 'Orchestration', ToolSearch: 'Orchestration',
  WebFetch: 'External', WebSearch: 'External', SendUserFile: 'External', AskUserQuestion: 'External',
};
function toolCategory(tool) {
  if (TOOL_CATEGORY[tool]) return TOOL_CATEGORY[tool];
  if (tool.startsWith('mcp__')) return 'External';
  return 'Other';
}

const app = express();

// Optional HTTP Basic Auth -- off by default (matches prior behavior for
// localhost-only use). Set DASHBOARD_PASSWORD before starting the server to
// require it; any username is accepted, only the password is checked. This
// exists because opening the LAN firewall port for phone access means
// anyone on the local network can otherwise view/edit client billing data.
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || null;
if (DASHBOARD_PASSWORD) {
  const crypto = require('crypto');
  const expected = Buffer.from(DASHBOARD_PASSWORD);
  app.use((req, res, next) => {
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const sepIdx = decoded.indexOf(':');
      const pass = sepIdx >= 0 ? decoded.slice(sepIdx + 1) : '';
      const given = Buffer.from(pass);
      if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="claude-usage-dashboard"');
    res.status(401).send('Authentication required.');
  });
  console.log('DASHBOARD_PASSWORD is set -- HTTP Basic Auth is enabled.');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function loadClientsConfig(db) {
  const clientsResult = db.prepare('SELECT ClientId, Name, ActiveRate, IdleRate, ManualMultiplier, RoundingIncrementMinutes FROM Clients ORDER BY Name').all();
  const repoResult = db.prepare('SELECT RepoKey, ClientId FROM Repos WHERE ClientId IS NOT NULL').all();
  const clients = {};
  const idToName = {};
  for (const c of clientsResult) {
    clients[c.Name] = {
      activeRate: c.ActiveRate, idleRate: c.IdleRate,
      manualMultiplier: c.ManualMultiplier, roundingIncrementMinutes: c.RoundingIncrementMinutes,
    };
    idToName[c.ClientId] = c.Name;
  }
  const repoClients = {};
  for (const r of repoResult) {
    if (idToName[r.ClientId]) repoClients[r.RepoKey] = idToName[r.ClientId];
  }
  return { clients, repoClients };
}

// Time-tab overrides, keyed by 'repoKey|day' so the Dashboard/Insights
// records and the Invoicing line items can fold them in with the same
// computeEffectiveHours formula the Time tab itself is built on.
function loadRepoTimeEntryMaps(db) {
  const rows = db.prepare(`
    SELECT r.RepoKey AS repo, te.EntryDate AS day, te.EntryType AS type, te.Hours AS hours
    FROM TimeEntries te
    JOIN Repos r ON r.RepoId = te.RepoId
  `).all();
  const adjByKey = {}, manByKey = {};
  for (const row of rows) {
    const key = row.repo + '|' + row.day;
    if (row.type === 'adjustment') adjByKey[key] = Number(row.hours);
    else manByKey[key] = Number(row.hours);
  }
  return { adjByKey, manByKey };
}

// Manual time logged against a client with no repo at all (a client
// meeting, offline planning) -- has no DailyUsage row to attach to, so it's
// surfaced separately rather than as a synthetic repo. Pass clientId to
// scope to one client (Invoicing); omit for every client (Dashboard).
function loadClientLevelTimeEntries(db, clientId) {
  let where = "te.RepoId IS NULL AND te.EntryType = 'manual'";
  const params = {};
  if (clientId != null) {
    params.clientId = clientId;
    where += ' AND te.ClientId = @clientId';
  }
  const rows = db.prepare(`
    SELECT c.Name AS clientName, te.EntryDate AS day, te.Hours AS hours, te.Note AS note
    FROM TimeEntries te JOIN Clients c ON c.ClientId = te.ClientId
    WHERE ${where}
    ORDER BY te.EntryDate
  `).all(params);
  return rows.map(r => ({
    clientName: r.clientName, day: r.day, month: r.day.slice(0, 7), hours: Number(r.hours), note: r.note || '',
  }));
}

// One-line "what was the key deliverable" per repo/day, keyed the same way
// as loadRepoTimeEntryMaps so callers can look both up with the same key.
function loadDaySummaryMap(db) {
  const rows = db.prepare(`
    SELECT r.RepoKey AS repo, ds.UsageDate AS day, ds.Summary AS summary, ds.Source AS source
    FROM DaySummaries ds
    JOIN Repos r ON r.RepoId = ds.RepoId
  `).all();
  const byKey = {};
  for (const row of rows) {
    byKey[row.repo + '|' + row.day] = { summary: row.summary, source: row.source };
  }
  return byKey;
}

app.get('/api/data', async (req, res) => {
  try {
    const db = getDb();
    const daily = db.prepare(`
      SELECT r.RepoKey AS repo, d.UsageDate AS day,
             d.Cost AS cost, d.Messages AS messages, d.SessionCount AS sessions,
             d.StartTime AS start, d.EndTime AS [end], d.SpanHours AS spanHours, d.ActiveHours AS activeHours,
             d.CommitCount AS commits
      FROM DailyUsage d JOIN Repos r ON r.RepoId = d.RepoId
    `).all();
    const modelRows = db.prepare(`
      SELECT r.RepoKey AS repo, m.UsageDate AS day, m.Model AS model, m.MessageCount AS cnt
      FROM ModelUsage m JOIN Repos r ON r.RepoId = m.RepoId
    `).all();
    const modelsByKey = {};
    for (const m of modelRows) {
      const key = m.repo + '|' + m.day;
      if (!modelsByKey[key]) modelsByKey[key] = {};
      modelsByKey[key][m.model] = m.cnt;
    }

    const { adjByKey, manByKey } = loadRepoTimeEntryMaps(db);

    const records = daily.map(r => {
      const key = r.repo + '|' + r.day;
      const eff = computeEffectiveHours(r.activeHours, r.spanHours, adjByKey[key], manByKey[key]);
      return {
        repo: r.repo, day: r.day, month: r.day.slice(0, 7),
        cost: Math.round(r.cost * 100) / 100,
        messages: r.messages, sessions: r.sessions,
        models: modelsByKey[key] || {},
        start: r.start, end: r.end,
        spanHours: eff.spanHours, activeHours: eff.activeHours, adjusted: eff.adjusted,
        commits: r.commits,
      };
    }).sort((a, b) => a.day.localeCompare(b.day) || a.repo.localeCompare(b.repo));

    const sessionRows = db.prepare(`
      SELECT r.RepoKey AS repo, s.FirstSeen AS firstSeen
      FROM SessionFiles s JOIN Repos r ON r.RepoId = s.RepoId
    `).all();
    const repoMonthSessions = {};
    const repoAllTimeSessions = {};
    for (const s of sessionRows) {
      repoAllTimeSessions[s.repo] = (repoAllTimeSessions[s.repo] || 0) + 1;
      const month = new Date(new Date(s.firstSeen).getTime() + BRISBANE_OFFSET_MS).toISOString().slice(0, 7);
      if (!repoMonthSessions[s.repo]) repoMonthSessions[s.repo] = {};
      repoMonthSessions[s.repo][month] = (repoMonthSessions[s.repo][month] || 0) + 1;
    }

    const clientsConfig = loadClientsConfig(db);
    const clientLevelTime = loadClientLevelTimeEntries(db);
    res.json({ records, repoMonthSessions, repoAllTimeSessions, clientsConfig, clientLevelTime });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/clients', async (req, res) => {
  try {
    const { name, activeRate, idleRate, manualMultiplier, roundingIncrementMinutes } = req.body;
    if (!name || typeof name !== 'string' || !name.trim() || name === UNASSIGNED) {
      return res.status(400).json({ error: 'Invalid client name' });
    }
    const db = getDb();
    db.prepare(`
      INSERT INTO Clients (Name, ActiveRate, IdleRate, ManualMultiplier, RoundingIncrementMinutes, UpdatedAt)
      VALUES (@name, @active, @idle, @multiplier, @rounding, CURRENT_TIMESTAMP)
      ON CONFLICT(Name) DO UPDATE SET ActiveRate = @active, IdleRate = @idle,
        ManualMultiplier = @multiplier, RoundingIncrementMinutes = @rounding, UpdatedAt = CURRENT_TIMESTAMP
    `).run({
      name: name.trim(),
      active: Number(activeRate) || 0,
      idle: Number(idleRate) || 0,
      multiplier: manualMultiplier != null ? Number(manualMultiplier) || 1.5 : 1.5,
      rounding: roundingIncrementMinutes != null ? Number(roundingIncrementMinutes) || 0 : 15,
    });
    res.json(loadClientsConfig(db));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/clients/:name', async (req, res) => {
  try {
    const db = getDb();
    const name = req.params.name;
    const existing = db.prepare('SELECT ClientId FROM Clients WHERE Name = @name').get({ name });
    if (existing) {
      const clientId = existing.ClientId;
      db.prepare('UPDATE Repos SET ClientId = NULL WHERE ClientId = @id').run({ id: clientId });
      db.prepare('DELETE FROM Clients WHERE ClientId = @id').run({ id: clientId });
    }
    res.json(loadClientsConfig(db));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/repo-clients', async (req, res) => {
  try {
    const { repo, client } = req.body;
    if (!repo) return res.status(400).json({ error: 'Missing repo' });
    const db = getDb();
    let clientId = null;
    if (client && client !== UNASSIGNED) {
      const found = db.prepare('SELECT ClientId FROM Clients WHERE Name = @name').get({ name: client });
      if (!found) return res.status(400).json({ error: `Unknown client "${client}"` });
      clientId = found.ClientId;
    }
    db.prepare(`
      INSERT INTO Repos (RepoKey, ClientId, UpdatedAt) VALUES (@key, @clientId, CURRENT_TIMESTAMP)
      ON CONFLICT(RepoKey) DO UPDATE SET ClientId = @clientId, UpdatedAt = CURRENT_TIMESTAMP
    `).run({ key: repo, clientId });
    res.json(loadClientsConfig(db));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/insights', async (req, res) => {
  try {
    const month = req.query.month || 'all';
    const repo = req.query.repo || 'all';
    const client = req.query.client || 'all';
    const db = getDb();

    const dailyAll = db.prepare(`
      SELECT r.RepoKey AS repo, r.ClientId AS clientId, d.UsageDate AS day,
             d.SpanHours AS spanHours, d.ActiveHours AS activeHours,
             d.ToolExecHours AS toolExecHours, d.ModelLatencyHours AS modelLatencyHours,
             d.InputTokens AS inputTokens, d.OutputTokens AS outputTokens,
             d.CacheWriteTokens AS cacheWriteTokens, d.CacheReadTokens AS cacheReadTokens,
             d.Cost AS cost, d.CommitCount AS commits
      FROM DailyUsage d JOIN Repos r ON r.RepoId = d.RepoId
    `).all();
    const clientRows = db.prepare('SELECT ClientId, Name, ActiveRate, ManualMultiplier FROM Clients').all();
    const clientIdByName = {};
    const activeRateByClientId = {};
    const manualMultiplierByClientId = {};
    for (const c of clientRows) {
      clientIdByName[c.Name] = c.ClientId;
      activeRateByClientId[Number(c.ClientId)] = Number(c.ActiveRate);
      manualMultiplierByClientId[Number(c.ClientId)] = Number(c.ManualMultiplier);
    }
    const wantedClientId = client !== 'all' && clientIdByName[client] != null ? Number(clientIdByName[client]) : undefined;

    const daily = dailyAll.filter(r =>
      (month === 'all' || r.day.slice(0, 7) === month) && matchesRepoClient(r, { repo, client, wantedClientId })
    );
    const keptRepos = new Set(daily.map(r => r.repo));

    const modelRows = db.prepare(`
      SELECT DISTINCT Model FROM ModelUsage WHERE Model IN (${Object.keys(PRICING).map(m => `'${m}'`).join(',')})
    `).all();
    const avgInputPrice = modelRows.length
      ? modelRows.reduce((a, m) => a + PRICING[m.Model][0], 0) / modelRows.length
      : 4;

    const fileTouchesAll = db.prepare(`
      SELECT r.RepoKey AS repo, f.UsageDate AS day, f.FilePath AS filePath, f.TouchCount AS touches
      FROM FileTouches f JOIN Repos r ON r.RepoId = f.RepoId
    `).all();
    const fileTouches = fileTouchesAll.filter(r =>
      keptRepos.has(r.repo) && (month === 'all' || r.day.slice(0, 7) === month)
    );

    const toolUsageAll = db.prepare(`
      SELECT r.RepoKey AS repo, s.FirstSeen AS firstSeen, t.ToolName AS tool, t.CallCount AS cnt
      FROM ToolUsage t
      JOIN SessionFiles s ON s.RepoId = t.RepoId AND s.SessionId = t.SessionId
      JOIN Repos r ON r.RepoId = t.RepoId
    `).all();
    const toolUsage = toolUsageAll.filter(r => {
      if (!keptRepos.has(r.repo)) return false;
      if (month === 'all') return true;
      const m = new Date(new Date(r.firstSeen).getTime() + BRISBANE_OFFSET_MS).toISOString().slice(0, 7);
      return m === month;
    });

    // Which specific skills (not just the generic "Skill" tool count) have
    // run against each repo -- lets "Things to try" flag e.g. a repo with
    // real code-changing activity that's never had code-review or
    // security-review run against it.
    const skillUsageAll = db.prepare(`
      SELECT r.RepoKey AS repo, s.FirstSeen AS firstSeen, sk.SkillName AS skill, sk.CallCount AS cnt
      FROM SkillUsage sk
      JOIN SessionFiles s ON s.RepoId = sk.RepoId AND s.SessionId = sk.SessionId
      JOIN Repos r ON r.RepoId = sk.RepoId
    `).all();
    const skillUsage = skillUsageAll.filter(r => {
      if (!keptRepos.has(r.repo)) return false;
      if (month === 'all') return true;
      const m = new Date(new Date(r.firstSeen).getTime() + BRISBANE_OFFSET_MS).toISOString().slice(0, 7);
      return m === month;
    });

    const totalInput = daily.reduce((a, r) => a + Number(r.inputTokens), 0);
    const totalOutput = daily.reduce((a, r) => a + Number(r.outputTokens), 0);
    const totalCacheRead = daily.reduce((a, r) => a + Number(r.cacheReadTokens), 0);
    const totalCacheWrite = daily.reduce((a, r) => a + Number(r.cacheWriteTokens), 0);
    const totalCostFiltered = daily.reduce((a, r) => a + Number(r.cost), 0);
    const totalCommits = daily.reduce((a, r) => a + Number(r.commits), 0);
    const cacheDenominator = totalInput + totalCacheRead + totalCacheWrite;
    const cacheHitRate = cacheDenominator > 0 ? totalCacheRead / cacheDenominator : 0;
    const estSavings = totalCacheRead * avgInputPrice * 0.9 / 1e6;

    const avgOutputPrice = modelRows.length
      ? modelRows.reduce((a, m) => a + PRICING[m.Model][1], 0) / modelRows.length : 20;
    const avgCacheWritePrice = modelRows.length
      ? modelRows.reduce((a, m) => a + PRICING[m.Model][2], 0) / modelRows.length : 5;
    const avgCacheReadPrice = modelRows.length
      ? modelRows.reduce((a, m) => a + PRICING[m.Model][4], 0) / modelRows.length : 0.4;
    const cacheCostBreakdown = {
      input: Math.round(totalInput * avgInputPrice / 1e4) / 100,
      output: Math.round(totalOutput * avgOutputPrice / 1e4) / 100,
      cacheWrite: Math.round(totalCacheWrite * avgCacheWritePrice / 1e4) / 100,
      cacheRead: Math.round(totalCacheRead * avgCacheReadPrice / 1e4) / 100,
    };

    const costPerCommit = totalCommits > 0 ? Math.round((totalCostFiltered / totalCommits) * 100) / 100 : null;

    // Rework signal: files revisited across 3+ distinct days -- a proxy for
    // DORA's "rework rate" derivable from FileTouches without git history.
    const fileDayMap = {};
    for (const r of fileTouches) {
      const key = r.repo + '::' + r.filePath;
      if (!fileDayMap[key]) fileDayMap[key] = new Set();
      fileDayMap[key].add(r.day);
    }
    const totalFilesTouched = Object.keys(fileDayMap).length;
    const reworkFiles = Object.entries(fileDayMap)
      .filter(([, days]) => days.size >= 3)
      .map(([key, days]) => {
        const sepIdx = key.indexOf('::');
        return { repo: key.slice(0, sepIdx), filePath: key.slice(sepIdx + 2), distinctDays: days.size };
      })
      .sort((a, b) => b.distinctDays - a.distinctDays)
      .slice(0, 15);
    const reworkRate = totalFilesTouched > 0 ? reworkFiles.length / totalFilesTouched : 0;

    // Tool-use taxonomy: code-changing vs. investigative vs. execution vs.
    // orchestration vs. external, instead of raw per-tool counts alone.
    const taxonomyTotals = {};
    for (const r of toolUsage) {
      const cat = toolCategory(r.tool);
      taxonomyTotals[cat] = (taxonomyTotals[cat] || 0) + r.cnt;
    }
    const toolTaxonomy = Object.entries(taxonomyTotals).sort((a, b) => b[1] - a[1]).map(([category, count]) => ({ category, count }));

    // Same taxonomy, broken out per repo -- powers the "Things to try" tab's
    // per-repo candidate flagging (heavy investigative/execution use with
    // near-zero orchestration or research tool calls).
    const perRepoToolsMap = {};
    function repoToolsEntry(repo) {
      if (!perRepoToolsMap[repo]) {
        perRepoToolsMap[repo] = { repo, total: 0, byCategory: {}, agentCalls: 0, skillCalls: 0, researchCalls: 0, mcpCalls: 0, skillNames: {} };
      }
      return perRepoToolsMap[repo];
    }
    for (const r of toolUsage) {
      const p = repoToolsEntry(r.repo);
      p.total += r.cnt;
      const cat = toolCategory(r.tool);
      p.byCategory[cat] = (p.byCategory[cat] || 0) + r.cnt;
      if (r.tool === 'Agent') p.agentCalls += r.cnt;
      if (r.tool === 'Skill') p.skillCalls += r.cnt;
      if (r.tool === 'WebFetch' || r.tool === 'WebSearch') p.researchCalls += r.cnt;
      if (r.tool.startsWith('mcp__')) p.mcpCalls += r.cnt;
    }
    // Skill-name detail (code-review, security-review, ...) per repo, kept
    // separate from the generic Skill-tool count above.
    for (const r of skillUsage) {
      const p = repoToolsEntry(r.repo);
      p.skillNames[r.skill] = (p.skillNames[r.skill] || 0) + r.cnt;
    }
    const perRepoTools = Object.values(perRepoToolsMap).sort((a, b) => b.total - a.total);

    const skillMix = Object.entries(
      skillUsage.reduce((acc, r) => { acc[r.skill] = (acc[r.skill] || 0) + r.cnt; return acc; }, {})
    ).sort((a, b) => b[1] - a[1]).map(([skill, count]) => ({ skill, count }));

    // Cost anomaly: day-of-week z-score baseline (AWS/Datadog-style), computed
    // over ALL history for the repo/client filter, independent of the month
    // filter, since a baseline needs trailing weeks of data to mean anything.
    const dailyForBaseline = dailyAll.filter(r => matchesRepoClient(r, { repo, client, wantedClientId }));
    const costByDay = {};
    for (const r of dailyForBaseline) costByDay[r.day] = (costByDay[r.day] || 0) + Number(r.cost);
    const allDaysSorted = Object.keys(costByDay).sort();
    const costAnomaly = computeCostAnomaly(costByDay);

    // Month-to-date forecast: straight run-rate extrapolation (Azure/AWS
    // pattern) for whichever calendar month "today" falls in.
    const nowBris = new Date(Date.now() + BRISBANE_OFFSET_MS);
    const forecast = computeForecast(costByDay, nowBris);

    // Adjustable "manual-equivalent" estimate (Sourcegraph Cody pattern):
    // only shown for a single selected client, and always labeled as an
    // assumption -- see RESEARCH.md re: METR's finding that self-perceived
    // speedup is unreliable, so we never present this as a measurement.
    let manualEquivalent = null;
    if (client !== 'all' && client !== UNASSIGNED && wantedClientId) {
      const mult = manualMultiplierByClientId[wantedClientId] ?? 1.5;
      const totalActiveForClient = daily.reduce((a, r) => a + Number(r.activeHours), 0);
      const manualHours = totalActiveForClient * mult;
      manualEquivalent = {
        multiplier: mult, activeHours: Math.round(totalActiveForClient * 10) / 10,
        manualEquivalentHours: Math.round(manualHours * 10) / 10,
        extraHours: Math.round((manualHours - totalActiveForClient) * 10) / 10,
      };
    }

    const hotFiles = Object.entries(
      fileTouches.reduce((acc, r) => {
        acc[r.filePath] = (acc[r.filePath] || 0) + r.touches;
        return acc;
      }, {})
    ).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([filePath, touches]) => ({ filePath, touches }));

    const toolMix = Object.entries(
      toolUsage.reduce((acc, r) => {
        acc[r.tool] = (acc[r.tool] || 0) + r.cnt;
        return acc;
      }, {})
    ).sort((a, b) => b[1] - a[1]).map(([tool, count]) => ({ tool, count }));

    const totalActive = daily.reduce((a, r) => a + Number(r.activeHours), 0);
    const totalSpan = daily.reduce((a, r) => a + Number(r.spanHours), 0);

    // Utilization: billable (assigned to a client with a nonzero active rate)
    // vs. non-billable (Unassigned, or assigned to a $0-rate client) active
    // hours -- Harvest's billable/total-tracked-hours pattern, 65-80% is the
    // typical professional-services target per RESEARCH.md.
    let billableHours = 0, nonBillableHours = 0;
    for (const r of daily) {
      const rate = r.clientId != null ? (activeRateByClientId[Number(r.clientId)] || 0) : 0;
      if (rate > 0) billableHours += Number(r.activeHours);
      else nonBillableHours += Number(r.activeHours);
    }
    const utilizationTotal = billableHours + nonBillableHours;
    const utilization = {
      billableHours: Math.round(billableHours * 10) / 10,
      nonBillableHours: Math.round(nonBillableHours * 10) / 10,
      pct: utilizationTotal > 0 ? billableHours / utilizationTotal : 0,
    };

    // Session cycle-time: within "active" gaps, how much was spent waiting on
    // a tool result vs. waiting on the model -- a rough two-way split (see
    // sync.js), not a precise trace.
    const totalToolExec = daily.reduce((a, r) => a + Number(r.toolExecHours), 0);
    const totalModelLatency = daily.reduce((a, r) => a + Number(r.modelLatencyHours), 0);
    const cycleTime = {
      toolExecHours: Math.round(totalToolExec * 10) / 10,
      modelLatencyHours: Math.round(totalModelLatency * 10) / 10,
    };

    const distinctDays = [...new Set(daily.map(r => r.day))].sort();
    const { currentStreak, longestStreak } = computeStreaks(distinctDays, nowBris.toISOString().slice(0, 10));

    res.json({
      cacheEfficiency: {
        totalInputTokens: totalInput, cacheReadTokens: totalCacheRead, cacheWriteTokens: totalCacheWrite,
        cacheHitRate, estSavings,
      },
      cacheCostBreakdown,
      hotFiles,
      toolMix,
      toolTaxonomy,
      perRepoTools,
      skillMix,
      focusRatio: { activeHours: totalActive, spanHours: totalSpan, pct: totalSpan > 0 ? totalActive / totalSpan : 0 },
      utilization,
      cycleTime,
      streaks: { currentStreak, longestStreak, activeDayCount: distinctDays.length },
      rework: { files: reworkFiles, rate: reworkRate, totalFilesTouched },
      costPerCommit: { value: costPerCommit, totalCommits, totalCost: Math.round(totalCostFiltered * 100) / 100 },
      costAnomaly,
      forecast,
      manualEquivalent,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

function nextDayStr(dayStr) {
  const d = new Date(dayStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Verified commits for one repo on one calendar day, for the Recap tab.
// Same approach as /api/repo-commits below, just scoped to a single day.
async function gitLogForDay(cwdPath, dayStr) {
  if (!cwdPath) return { available: false, reason: 'No working directory recorded for this repo yet.' };
  const args = ['-C', cwdPath, 'log', '--format=%H%x1f%aI%x1f%s', `--since=${dayStr}`, `--until=${nextDayStr(dayStr)}`, '-n', '30'];
  try {
    const { stdout } = await execFileAsync('git', args, { timeout: 5000, windowsHide: true });
    const commits = stdout.split('\n').filter(Boolean).map(line => {
      const [hash, date, ...rest] = line.split('\x1f');
      return { hash: hash.slice(0, 10), date, message: rest.join('\x1f') };
    });
    return { available: true, commits };
  } catch (e) {
    const text = (e.stderr || e.message || '').toString();
    const reason = /not a git repository/i.test(text) ? 'Not a git repository.'
      : /no such file or directory|cannot find the path|does not exist/i.test(text) ? 'This path no longer exists on disk.'
      : /ENOENT/i.test(text) ? 'git is not available on PATH.'
      : `git log failed: ${text.slice(0, 200)}`;
    return { available: false, reason };
  }
}

function memoDir(repoKey) {
  return path.join(os.homedir(), '.claude', 'projects', repoKey, 'memory');
}

function parseMemoFrontmatter(content, fallbackName) {
  const stripQuotes = s => s.trim().replace(/^["']|["']$/g, '');
  const nameMatch = content.match(/^name:\s*(.+)$/m);
  const descMatch = content.match(/^description:\s*(.+)$/m);
  const typeMatch = content.match(/^\s*type:\s*(.+)$/m);
  return {
    name: nameMatch ? stripQuotes(nameMatch[1]) : fallbackName,
    description: descMatch ? stripQuotes(descMatch[1]) : '',
    type: typeMatch ? stripQuotes(typeMatch[1]) : '',
  };
}

// Memory files (the auto-memory system's per-project notes under
// ~/.claude/projects/<repo>/memory/*.md) whose mtime falls on the given
// Brisbane calendar day -- surfaces "what did I ask to be remembered" on
// the Recap tab alongside cost/commits. MEMORY.md itself is the index, not
// a memory, so it's excluded.
async function memoriesForDay(repoKey, dayStr) {
  const dir = memoDir(repoKey);
  let files;
  try {
    files = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const results = [];
  for (const f of files) {
    if (!f.endsWith('.md') || f.toLowerCase() === 'memory.md') continue;
    const full = path.join(dir, f);
    let stat;
    try { stat = await fsp.stat(full); } catch { continue; }
    const mtimeDay = new Date(stat.mtimeMs + BRISBANE_OFFSET_MS).toISOString().slice(0, 10);
    if (mtimeDay !== dayStr) continue;
    let content = '';
    try { content = await fsp.readFile(full, 'utf8'); } catch { /* skip content, keep filename */ }
    results.push({ file: f, ...parseMemoFrontmatter(content, f.replace(/\.md$/, '')) });
  }
  return results;
}

// The single most-recently-modified memory file for a project, regardless
// of when it was written -- used for the Recap tab's "latest note per
// project" list, which covers every C:\code project (not just ones with
// DailyUsage activity yesterday), so a project you haven't touched in a
// while still shows what you last recorded about it.
async function latestMemoryFor(repoKey) {
  const dir = memoDir(repoKey);
  let files;
  try {
    files = await fsp.readdir(dir);
  } catch {
    return null;
  }
  let best = null;
  for (const f of files) {
    if (!f.endsWith('.md') || f.toLowerCase() === 'memory.md') continue;
    const full = path.join(dir, f);
    let stat;
    try { stat = await fsp.stat(full); } catch { continue; }
    if (!best || stat.mtimeMs > best.mtimeMs) best = { file: f, full, mtimeMs: stat.mtimeMs };
  }
  if (!best) return null;
  let content = '';
  try { content = await fsp.readFile(best.full, 'utf8'); } catch { /* skip content, keep filename */ }
  return {
    file: best.file,
    mtime: new Date(best.mtimeMs).toISOString(),
    ...parseMemoFrontmatter(content, best.file.replace(/\.md$/, '')),
  };
}

// The single most-recently-written auto-recap for a project (see the
// SessionEnd hook in ~/.claude/tools/hooks/session-recap.sh), a sibling of
// memory/ under ~/.claude/projects/<repo>/recap/. One file per session, so
// "newest by mtime" is also "most recent session for this project."
async function latestRecapFor(repoKey) {
  const dir = path.join(os.homedir(), '.claude', 'projects', repoKey, 'recap');
  let files;
  try {
    files = await fsp.readdir(dir);
  } catch {
    return null;
  }
  let best = null;
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const full = path.join(dir, f);
    let stat;
    try { stat = await fsp.stat(full); } catch { continue; }
    if (!best || stat.mtimeMs > best.mtimeMs) best = { file: f, full, mtimeMs: stat.mtimeMs };
  }
  if (!best) return null;
  let content = '';
  try { content = await fsp.readFile(best.full, 'utf8'); } catch { return null; }
  const body = content.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  if (!body) return null;
  const { happened, next } = parseRecapSections(body);
  if (!happened.length && !next.length) return null;
  return { file: best.file, mtime: new Date(best.mtimeMs).toISOString(), happened, next };
}

// Pulls the "### What happened" / "### What's next" bullet lists out of one
// recap file's markdown body. Shared by recapsForDay (below) and
// latestRecapFor, so a recap renders identically -- clean bullets, not raw
// markdown -- whether it's shown as yesterday's activity or as a project's
// last-known note.
function parseRecapSections(content) {
  const extract = (heading) => {
    const section = content.match(new RegExp(`### ${heading}\\r?\\n([\\s\\S]*?)(\\r?\\n###|\\r?\\n---|$)`));
    if (!section) return [];
    const items = [];
    for (const line of section[1].split('\n')) {
      const m = line.match(/^-\s*(.+)/);
      if (m) items.push(m[1].trim());
    }
    return items;
  };
  return { happened: extract('What happened'), next: extract("What's next") };
}

// Same day-matching convention as sync.js's condenseRecapForDay (recap
// filenames start with the day they cover), but returns everything for
// that day's Recap-tab card rather than the single condensed one-liner
// DaySummaries needs -- this is what fills in a project's story when it
// had real activity but no commits or saved memories yet (a discussion/
// investigation day still has a "what happened", it just isn't in git).
// Aggregates "What happened" bullets across every session that day
// (chronological), and "What's next" from the last session only, since
// earlier pending items are usually superseded by a later session.
async function recapsForDay(repoKey, dayStr) {
  const dir = path.join(os.homedir(), '.claude', 'projects', repoKey, 'recap');
  let files;
  try { files = await fsp.readdir(dir); } catch { return null; }
  const matches = files.filter(f => f.startsWith(dayStr) && f.endsWith('.md')).sort();
  if (!matches.length) return null;

  const happened = [];
  let next = [];
  for (const f of matches) {
    let content;
    try { content = await fsp.readFile(path.join(dir, f), 'utf8'); } catch { continue; }
    const parsed = parseRecapSections(content);
    happened.push(...parsed.happened);
    if (parsed.next.length) next = parsed.next; // last session's list wins, not appended
  }
  if (!happened.length && !next.length) return null;
  return { happened, next, sessionCount: matches.length };
}

// Prefers the auto-generated recap (richer, written every session close)
// and falls back to the curated memory system for projects with no recap
// yet -- this feature is going-forward only, so most projects will still
// fall back to memory/ until they've had a session close since the hook
// went live.
async function latestNoteFor(repoKey) {
  const recap = await latestRecapFor(repoKey);
  if (recap) return { source: 'recap', ...recap };
  const memo = await latestMemoryFor(repoKey);
  if (memo) return { source: 'memory', ...memo };
  return null;
}

// Yesterday's per-project recap: cost/messages/hours from the DB, plus
// verified git commits and saved memories read live from disk -- the
// morning "what did I do, what's next" landing view.
app.get('/api/recap', async (req, res) => {
  try {
    const db = getDb();
    const { repoClients } = loadClientsConfig(db);
    const nowBris = new Date(Date.now() + BRISBANE_OFFSET_MS);
    const yesterday = new Date(nowBris.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const rows = db.prepare(`
      SELECT r.RepoKey AS repo, r.CwdPath AS cwdPath,
             d.Cost AS cost, d.Messages AS messages, d.SessionCount AS sessions,
             d.ActiveHours AS activeHours, d.SpanHours AS spanHours, d.CommitCount AS detectedCommits,
             d.StartTime AS startTime, d.EndTime AS endTime
      FROM DailyUsage d JOIN Repos r ON r.RepoId = d.RepoId
      WHERE d.UsageDate = @day
      ORDER BY d.ActiveHours DESC, d.Cost DESC
    `).all({ day: yesterday });

    const projects = await Promise.all(rows.map(async row => {
      const [commits, memories, recap] = await Promise.all([
        gitLogForDay(row.cwdPath, yesterday),
        memoriesForDay(row.repo, yesterday),
        recapsForDay(row.repo, yesterday),
      ]);
      return {
        repo: row.repo,
        client: repoClients[row.repo] || UNASSIGNED,
        cost: row.cost, messages: row.messages, sessions: row.sessions,
        activeHours: row.activeHours, spanHours: row.spanHours,
        detectedCommits: row.detectedCommits, startTime: row.startTime, endTime: row.endTime,
        commits, memories, recap,
      };
    }));

    // Latest note per project, for every repo actually living under
    // C:\code (not the ~/.claude/projects root session itself, and not
    // repos elsewhere like the AD Reporting or E:\scripts trees) -- this
    // covers projects with no DailyUsage activity yesterday too, so a
    // project you haven't touched in a while still shows its last note.
    // Excludes anything already in `projects` above -- that list already
    // carries richer same-day detail, so repeating it here would just be
    // the same project shown twice on one page.
    const yesterdayRepoKeys = new Set(rows.map(r => r.repo));
    const allRepos = db.prepare('SELECT RepoKey AS repo, CwdPath AS cwdPath FROM Repos').all();
    const codeRepos = allRepos.filter(r =>
      r.cwdPath && /^[A-Za-z]:\\code\\/.test(r.cwdPath) && r.repo.toUpperCase() !== 'C--CODE'
      && !yesterdayRepoKeys.has(r.repo));
    const latestNotes = (await Promise.all(codeRepos.map(async r => {
      const note = await latestNoteFor(r.repo);
      if (!note) return null;
      return { repo: r.repo, client: repoClients[r.repo] || UNASSIGNED, ...note };
    }))).filter(Boolean).sort((a, b) => new Date(b.mtime) - new Date(a.mtime));

    res.json({ day: yesterday, projects, latestNotes });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Runs `node sync.js` as a child process (the same one-time-manual command
// the README documents) so the "end of day" button on the Recap tab can
// pull the day's chatting into the DB without leaving the browser.
app.post('/api/sync', async (req, res) => {
  try {
    const { stdout } = await execFileAsync('node', ['sync.js'], { cwd: __dirname, timeout: 120000, windowsHide: true });
    res.json({ success: true, output: stdout });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, output: (e.stdout || '') + (e.stderr || '') });
  }
});

// Verified commit history for a single repo, straight from `git log` on its
// recorded working directory -- an upgrade over the Bash-text-pattern
// commit heuristic used for the cross-repo CommitCount/cost-per-commit
// stats. Only meaningful for one repo at a time (there's no single cwd for
// "all repos"), and only if that path still exists as a git repo on disk.
app.get('/api/repo-commits', async (req, res) => {
  try {
    const repo = req.query.repo;
    const month = req.query.month || 'all';
    if (!repo) return res.status(400).json({ error: 'Missing ?repo=' });
    const db = getDb();
    const row = db.prepare('SELECT CwdPath FROM Repos WHERE RepoKey = @key').get({ key: repo });
    const cwdPath = row ? row.CwdPath : null;
    if (!cwdPath) {
      return res.json({ available: false, reason: 'No working directory recorded for this repo yet -- run node sync.js after chatting in it.' });
    }

    const args = ['-C', cwdPath, 'log', '--format=%H%x1f%aI%x1f%an%x1f%s', '-n', '50'];
    if (month !== 'all') {
      const [y, m] = month.split('-').map(Number);
      const since = `${y}-${String(m).padStart(2, '0')}-01`;
      const until = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10); // m is already 1-indexed -> next month's 1st
      args.push(`--since=${since}`, `--until=${until}`);
    }

    let stdout;
    try {
      ({ stdout } = await execFileAsync('git', args, { timeout: 5000, windowsHide: true }));
    } catch (e) {
      const text = (e.stderr || e.message || '').toString();
      const reason = /not a git repository/i.test(text) ? 'This directory is not a git repository.'
        : /no such file or directory|cannot find the path|does not exist/i.test(text) ? 'This path no longer exists on disk.'
        : /ENOENT/i.test(text) ? 'git is not available on PATH.'
        : `git log failed: ${text.slice(0, 200)}`;
      return res.json({ available: false, reason, cwdPath });
    }

    const commits = stdout.split('\n').filter(Boolean).map(line => {
      const [hash, date, author, ...rest] = line.split('\x1f');
      return { hash: hash.slice(0, 10), date, author, message: rest.join('\x1f') };
    });
    res.json({ available: true, cwdPath, commits });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/invoice', async (req, res) => {
  try {
    const client = req.query.client;
    const month = req.query.month || 'all';
    if (!client) return res.status(400).json({ error: 'Missing ?client=' });
    const db = getDb();

    const clientRow = db.prepare('SELECT ClientId, ActiveRate, IdleRate, RoundingIncrementMinutes FROM Clients WHERE Name = @name').get({ name: client });
    if (!clientRow) return res.status(404).json({ error: `Unknown client "${client}"` });
    const { ClientId, ActiveRate, IdleRate, RoundingIncrementMinutes } = clientRow;

    const rows = db.prepare(`
      SELECT r.RepoKey AS repo, d.UsageDate AS day,
             d.ActiveHours AS activeHours, d.SpanHours AS spanHours
      FROM DailyUsage d JOIN Repos r ON r.RepoId = d.RepoId
      WHERE r.ClientId = @clientId
      ORDER BY d.UsageDate, r.RepoKey
    `).all({ clientId: ClientId });
    const { adjByKey, manByKey } = loadRepoTimeEntryMaps(db);
    const summaryByKey = loadDaySummaryMap(db);

    // Idle hours are billed at IdleRate but shown to the client as an
    // active-hour equivalent so the invoice has one "Hours" figure per line
    // instead of an active/idle split -- e.g. at $100 active / $5 idle,
    // 20 idle hours reads as 1h added to the active total. The amount is
    // unchanged (idleHours * IdleRate == idleHours * idleToActiveFactor *
    // ActiveRate), only the displayed hours are collapsed into one number.
    const idleToActiveFactor = ActiveRate > 0 ? IdleRate / ActiveRate : 0;

    const lineItems = rows
      .filter(r => month === 'all' || r.day.slice(0, 7) === month)
      .map(r => {
        const key = r.repo + '|' + r.day;
        const eff = computeEffectiveHours(r.activeHours, r.spanHours, adjByKey[key], manByKey[key]);
        const rawIdleHours = Math.max(eff.spanHours - eff.activeHours, 0);
        const { activeHours, idleHours } = computeRoundedHours(eff.activeHours, rawIdleHours, RoundingIncrementMinutes);
        const amount = activeHours * ActiveRate + idleHours * IdleRate;
        const hours = activeHours + idleHours * idleToActiveFactor;
        return {
          repo: r.repo, day: r.day, hours, amount: Math.round(amount * 100) / 100, adjusted: eff.adjusted,
          summary: summaryByKey[key]?.summary || null,
        };
      });

    // Client-level manual time (a meeting, offline planning -- no repo at
    // all) bills at the active rate with no idle component, same as any
    // other active hour, and appears as its own pseudo-repo so it's visible
    // as a separate line rather than silently folded into a real repo.
    const clientLevelEntries = loadClientLevelTimeEntries(db, ClientId);
    for (const entry of clientLevelEntries) {
      if (month !== 'all' && entry.month !== month) continue;
      const { activeHours: hours } = computeRoundedHours(entry.hours, 0, RoundingIncrementMinutes);
      const amount = hours * ActiveRate;
      lineItems.push({
        repo: '(General — no repo)', day: entry.day, hours,
        amount: Math.round(amount * 100) / 100, adjusted: true, note: entry.note,
      });
    }
    lineItems.sort((a, b) => a.day.localeCompare(b.day) || a.repo.localeCompare(b.repo));

    const totals = lineItems.reduce((a, li) => ({
      hours: a.hours + li.hours,
      amount: a.amount + li.amount,
    }), { hours: 0, amount: 0 });

    // Expenses (travel, subscriptions, ...) bill alongside time -- a
    // separate category on the same invoice, not folded into the hours
    // total. Materialize recurring occurrences first (same as GET
    // /api/expenses) so a subscription due this month shows up even if the
    // Expenses tab was never opened.
    materializeRecurringExpenses(db);
    const expenseItems = loadExpenses(db)
      .filter(e => e.clientName === client && (month === 'all' || e.date.slice(0, 7) === month))
      .map(e => ({
        date: e.date, category: e.category, description: e.description,
        repoKey: e.repoKey, amount: e.amount, isRecurring: e.isRecurring,
      }));
    const expensesTotal = Math.round(expenseItems.reduce((a, e) => a + e.amount, 0) * 100) / 100;

    res.json({
      client, month, rates: { activeRate: ActiveRate, idleRate: IdleRate },
      roundingIncrementMinutes: RoundingIncrementMinutes, lineItems, totals,
      expenseItems, expensesTotal,
      grandTotal: Math.round((totals.amount + expensesTotal) * 100) / 100,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---- Time entries ----
// 'adjustment' overrides the auto-computed ActiveHours for a repo/day (kept
// out of DailyUsage because sync.js MERGEs that table wholesale per repo,
// which would silently wipe a manual override on the next sync).  'manual'
// is additive non-Claude time, either against a repo or -- when there's no
// Claude session history at all for that work (a client meeting, offline
// planning) -- directly against a client with RepoId left NULL.

function loadTimeEntriesForDate(db, dateStr) {
  const repoRows = db.prepare(`
    SELECT r.RepoKey AS repo, c.Name AS clientName,
           d.ActiveHours AS auto,
           adj.Hours AS adjustment, adj.Note AS adjustmentNote,
           man.Hours AS manual, man.Note AS manualNote,
           ds.Summary AS summary, ds.Source AS summarySource
    FROM Repos r
    LEFT JOIN Clients c ON c.ClientId = r.ClientId
    LEFT JOIN DailyUsage d ON d.RepoId = r.RepoId AND d.UsageDate = @date
    LEFT JOIN TimeEntries adj ON adj.RepoId = r.RepoId AND adj.EntryDate = @date AND adj.EntryType = 'adjustment'
    LEFT JOIN TimeEntries man ON man.RepoId = r.RepoId AND man.EntryDate = @date AND man.EntryType = 'manual'
    LEFT JOIN DaySummaries ds ON ds.RepoId = r.RepoId AND ds.UsageDate = @date
    ORDER BY c.Name, r.RepoKey
  `).all({ date: dateStr });
  const clientRows = db.prepare(`
    SELECT te.TimeEntryId AS id, c.Name AS clientName, te.Hours AS hours, te.Note AS note
    FROM TimeEntries te
    JOIN Clients c ON c.ClientId = te.ClientId
    WHERE te.RepoId IS NULL AND te.EntryDate = @date
    ORDER BY c.Name
  `).all({ date: dateStr });
  return {
    date: dateStr,
    repoRows: repoRows.map(r => ({
      repo: r.repo, clientName: r.clientName || UNASSIGNED,
      auto: r.auto != null ? Number(r.auto) : 0,
      adjustment: r.adjustment != null ? Number(r.adjustment) : null, adjustmentNote: r.adjustmentNote || '',
      manual: r.manual != null ? Number(r.manual) : null, manualNote: r.manualNote || '',
      summary: r.summary || '', summarySource: r.summarySource || null,
    })),
    clientRows: clientRows.map(r => ({
      id: r.id, clientName: r.clientName, hours: Number(r.hours), note: r.note || '',
    })),
  };
}

app.get('/api/time-entries', async (req, res) => {
  try {
    const date = req.query.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Missing or invalid ?date= (expected YYYY-MM-DD)' });
    const db = getDb();
    res.json(loadTimeEntriesForDate(db, date));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/time-entries-summary', async (req, res) => {
  try {
    const month = req.query.month;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Missing or invalid ?month= (expected YYYY-MM)' });
    const db = getDb();
    const rows = db.prepare(`
      SELECT EntryType, SUM(Hours) AS totalHours, COUNT(*) AS cnt
      FROM TimeEntries
      WHERE substr(EntryDate, 1, 7) = @month
      GROUP BY EntryType
    `).all({ month });
    const byType = {};
    for (const r of rows) byType[r.EntryType] = { totalHours: Number(r.totalHours) || 0, count: r.cnt };
    res.json({
      month,
      manualHours: byType.manual?.totalHours || 0,
      adjustedDays: byType.adjustment?.count || 0,
      adjustedHoursTotal: byType.adjustment?.totalHours || 0,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/time-entries', async (req, res) => {
  try {
    const { repo, client, date, type, hours, note } = req.body;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Missing or invalid date' });
    if (type !== 'adjustment' && type !== 'manual') return res.status(400).json({ error: 'type must be "adjustment" or "manual"' });
    if (type === 'adjustment' && !repo) return res.status(400).json({ error: 'An adjustment must be tied to a repo' });
    if (!repo && !client) return res.status(400).json({ error: 'Provide either a repo or a client' });

    const db = getDb();
    let repoId = null, clientId = null;
    if (repo) {
      const found = db.prepare('SELECT RepoId FROM Repos WHERE RepoKey = @key').get({ key: repo });
      if (!found) return res.status(400).json({ error: `Unknown repo "${repo}"` });
      repoId = found.RepoId;
    } else {
      const found = db.prepare('SELECT ClientId FROM Clients WHERE Name = @name').get({ name: client });
      if (!found) return res.status(400).json({ error: `Unknown client "${client}"` });
      clientId = found.ClientId;
    }

    const hoursNum = Number(hours) || 0;
    const noteStr = (note || '').toString().trim().slice(0, 500);
    const clearing = hoursNum <= 0 && !noteStr;

    if (repoId != null) {
      if (clearing) {
        db.prepare('DELETE FROM TimeEntries WHERE RepoId = @repoId AND EntryDate = @date AND EntryType = @type')
          .run({ repoId, date, type });
      } else if (type === 'adjustment') {
        // Partial unique index UX_TimeEntries_Adjustment covers (RepoId,
        // EntryDate) WHERE EntryType = 'adjustment' -- SQLite requires the
        // ON CONFLICT target's WHERE clause to textually match a partial
        // index's WHERE clause, which rules out parametrizing @type here,
        // so the two EntryType branches use separate literal predicates.
        db.prepare(`
          INSERT INTO TimeEntries (RepoId, EntryDate, EntryType, Hours, Note) VALUES (@repoId, @date, @type, @hours, @note)
          ON CONFLICT(RepoId, EntryDate) WHERE EntryType = 'adjustment'
            DO UPDATE SET Hours = @hours, Note = @note, UpdatedAt = CURRENT_TIMESTAMP
        `).run({ repoId, date, type, hours: hoursNum, note: noteStr || null });
      } else {
        // Matches partial unique index UX_TimeEntries_ManualRepo (RepoId,
        // EntryDate) WHERE EntryType = 'manual' AND RepoId IS NOT NULL.
        db.prepare(`
          INSERT INTO TimeEntries (RepoId, EntryDate, EntryType, Hours, Note) VALUES (@repoId, @date, @type, @hours, @note)
          ON CONFLICT(RepoId, EntryDate) WHERE EntryType = 'manual' AND RepoId IS NOT NULL
            DO UPDATE SET Hours = @hours, Note = @note, UpdatedAt = CURRENT_TIMESTAMP
        `).run({ repoId, date, type, hours: hoursNum, note: noteStr || null });
      }
    } else {
      if (clearing) {
        db.prepare("DELETE FROM TimeEntries WHERE ClientId = @clientId AND EntryDate = @date AND EntryType = 'manual' AND RepoId IS NULL")
          .run({ clientId, date });
      } else {
        // Matches partial unique index UX_TimeEntries_ManualClient
        // (ClientId, EntryDate) WHERE EntryType = 'manual' AND RepoId IS NULL.
        db.prepare(`
          INSERT INTO TimeEntries (ClientId, EntryDate, EntryType, Hours, Note) VALUES (@clientId, @date, 'manual', @hours, @note)
          ON CONFLICT(ClientId, EntryDate) WHERE EntryType = 'manual' AND RepoId IS NULL
            DO UPDATE SET Hours = @hours, Note = @note, UpdatedAt = CURRENT_TIMESTAMP
        `).run({ clientId, date, hours: hoursNum, note: noteStr || null });
      }
    }

    res.json(loadTimeEntriesForDate(db, date));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/time-entries/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const db = getDb();
    db.prepare('DELETE FROM TimeEntries WHERE TimeEntryId = @id').run({ id });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// One-line "what was the key deliverable" per repo/day -- shown on
// Invoicing next to the date, editable here on the Time tab. Source='ai'
// rows come from the backfill / sync.js's recap-condensing step; saving
// here always marks the row 'manual' so future auto-generation never
// silently overwrites a human correction. An empty summary deletes the
// row, reopening it to auto-generation.
app.post('/api/day-summaries', async (req, res) => {
  try {
    const { repo, date, summary } = req.body;
    if (!repo) return res.status(400).json({ error: 'Missing repo' });
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Missing or invalid date' });
    const db = getDb();
    const repoRow = db.prepare('SELECT RepoId FROM Repos WHERE RepoKey = @key').get({ key: repo });
    if (!repoRow) return res.status(400).json({ error: `Unknown repo "${repo}"` });
    const repoId = repoRow.RepoId;

    const summaryStr = (summary || '').toString().trim().slice(0, 400);
    if (!summaryStr) {
      db.prepare('DELETE FROM DaySummaries WHERE RepoId = @repoId AND UsageDate = @date').run({ repoId, date });
    } else {
      db.prepare(`
        INSERT INTO DaySummaries (RepoId, UsageDate, Summary, Source) VALUES (@repoId, @date, @summary, 'manual')
        ON CONFLICT(RepoId, UsageDate) DO UPDATE SET Summary = @summary, Source = 'manual', UpdatedAt = CURRENT_TIMESTAMP
      `).run({ repoId, date, summary: summaryStr });
    }
    res.json(loadTimeEntriesForDate(db, date));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---- Expenses ----
// Client-incurred costs (travel, subscriptions, software, ...). Recurring
// rows are templates (IsRecurring=1); materializeRecurringExpenses turns
// them into concrete dated occurrences (ParentExpenseId -> template) up
// through today on every read, so there's no cron dependency. The
// UX_Expenses_ParentOccurrence filtered unique index makes a duplicate
// insert (two tabs materializing at once) a no-op we can safely ignore.

function materializeRecurringExpenses(db) {
  const nowBris = new Date(Date.now() + BRISBANE_OFFSET_MS);
  const today = nowBris.toISOString().slice(0, 10);

  const templates = db.prepare(`
    SELECT ExpenseId, ExpenseDate AS expenseDate, RecurrenceInterval,
           RecurrenceEndDate AS recurrenceEndDate,
           ClientId, RepoId, Category, Description, Amount
    FROM Expenses
    WHERE IsRecurring = 1 AND (RecurrenceEndDate IS NULL OR RecurrenceEndDate >= @today)
  `).all({ today });

  for (const t of templates) {
    const existingRows = db.prepare(`
      SELECT ExpenseDate AS d FROM Expenses WHERE ParentExpenseId = @parentId
    `).all({ parentId: t.ExpenseId });
    const existingDates = existingRows.map(r => r.d);
    const throughDate = t.recurrenceEndDate && t.recurrenceEndDate < today ? t.recurrenceEndDate : today;
    const missing = materializeOccurrenceDates(t.expenseDate, t.RecurrenceInterval, throughDate, existingDates);

    for (const dateStr of missing) {
      try {
        db.prepare(`
          INSERT INTO Expenses (ClientId, RepoId, ExpenseDate, Category, Description, Amount, IsRecurring, ParentExpenseId)
          VALUES (@clientId, @repoId, @date, @category, @description, @amount, 0, @parentId)
        `).run({
          clientId: t.ClientId, repoId: t.RepoId, date: dateStr,
          category: t.Category, description: t.Description, amount: t.Amount, parentId: t.ExpenseId,
        });
      } catch (e) {
        if (!/unique|duplicate/i.test(e.message || '')) throw e; // lost a materialize race to another tab -- fine
      }
    }
  }
}

function loadExpenses(db) {
  const rows = db.prepare(`
    SELECT e.ExpenseId AS id, c.Name AS clientName, r.RepoKey AS repoKey,
           e.ExpenseDate AS date, e.Category AS category,
           e.Description AS description, e.Amount AS amount,
           e.IsRecurring AS isRecurring, e.RecurrenceInterval AS recurrenceInterval,
           e.RecurrenceEndDate AS recurrenceEndDate,
           e.ParentExpenseId AS parentExpenseId
    FROM Expenses e
    JOIN Clients c ON c.ClientId = e.ClientId
    LEFT JOIN Repos r ON r.RepoId = e.RepoId
    ORDER BY e.ExpenseDate DESC, c.Name
  `).all();
  return rows.map(r => ({
    id: r.id, clientName: r.clientName, repoKey: r.repoKey || null,
    date: r.date, category: r.category, description: r.description, amount: Number(r.amount),
    isRecurring: !!r.isRecurring, recurrenceInterval: r.recurrenceInterval || null,
    recurrenceEndDate: r.recurrenceEndDate || null,
    isGeneratedOccurrence: r.parentExpenseId != null,
  }));
}

const RECURRENCE_INTERVALS = ['weekly', 'monthly', 'yearly'];

app.get('/api/expenses', async (req, res) => {
  try {
    const db = getDb();
    materializeRecurringExpenses(db);
    res.json({ expenses: loadExpenses(db) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/expenses', async (req, res) => {
  try {
    const { id, clientName, repoKey, date, category, description, amount, isRecurring, recurrenceInterval, recurrenceEndDate } = req.body;
    if (!clientName) return res.status(400).json({ error: 'Missing client' });
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Missing or invalid date' });
    if (!description || !description.trim()) return res.status(400).json({ error: 'Missing description' });
    const amountNum = Number(amount);
    if (!Number.isFinite(amountNum)) return res.status(400).json({ error: 'Invalid amount' });
    const recurring = !!isRecurring;
    if (recurring && !RECURRENCE_INTERVALS.includes(recurrenceInterval)) {
      return res.status(400).json({ error: `recurrenceInterval must be one of ${RECURRENCE_INTERVALS.join(', ')}` });
    }

    const db = getDb();
    const clientRow = db.prepare('SELECT ClientId FROM Clients WHERE Name = @name').get({ name: clientName });
    if (!clientRow) return res.status(400).json({ error: `Unknown client "${clientName}"` });
    const clientId = clientRow.ClientId;

    let repoId = null;
    if (repoKey) {
      const repoRow = db.prepare('SELECT RepoId, ClientId FROM Repos WHERE RepoKey = @key').get({ key: repoKey });
      if (!repoRow) return res.status(400).json({ error: `Unknown repo "${repoKey}"` });
      if (repoRow.ClientId !== clientId) return res.status(400).json({ error: `Repo "${repoKey}" is not assigned to client "${clientName}"` });
      repoId = repoRow.RepoId;
    }

    const categoryStr = (category || 'Other').toString().trim().slice(0, 50) || 'Other';
    const descriptionStr = description.trim().slice(0, 300);
    const endDate = recurring && recurrenceEndDate ? recurrenceEndDate : null;

    if (id) {
      db.prepare(`
        UPDATE Expenses SET
          ClientId = @clientId, RepoId = @repoId, ExpenseDate = @date, Category = @category,
          Description = @description, Amount = @amount, IsRecurring = @isRecurring,
          RecurrenceInterval = @interval, RecurrenceEndDate = @endDate, UpdatedAt = CURRENT_TIMESTAMP
        WHERE ExpenseId = @id
      `).run({
        id: Number(id), clientId, repoId, date, category: categoryStr,
        description: descriptionStr, amount: amountNum,
        isRecurring: recurring ? 1 : 0, interval: recurring ? recurrenceInterval : null, endDate,
      });
    } else {
      db.prepare(`
        INSERT INTO Expenses (ClientId, RepoId, ExpenseDate, Category, Description, Amount, IsRecurring, RecurrenceInterval, RecurrenceEndDate)
        VALUES (@clientId, @repoId, @date, @category, @description, @amount, @isRecurring, @interval, @endDate)
      `).run({
        clientId, repoId, date, category: categoryStr,
        description: descriptionStr, amount: amountNum,
        isRecurring: recurring ? 1 : 0, interval: recurring ? recurrenceInterval : null, endDate,
      });
    }

    materializeRecurringExpenses(db);
    res.json({ expenses: loadExpenses(db) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/expenses/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const db = getDb();
    // Detach any generated occurrences first -- deleting a recurring
    // template must not take its already-materialized history with it.
    db.prepare('UPDATE Expenses SET ParentExpenseId = NULL WHERE ParentExpenseId = @id').run({ id });
    db.prepare('DELETE FROM Expenses WHERE ExpenseId = @id').run({ id });
    res.json({ expenses: loadExpenses(db) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.listen(PORT, () => {
  console.log(`claude-usage-dashboard running at http://localhost:${PORT}`);
});
