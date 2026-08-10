#!/usr/bin/env node
// One-off (re-runnable) backfill: generates the same auto-recap markdown
// files the SessionEnd hook (~/.claude/tools/hooks/session-recap.sh)
// writes for live sessions, but retroactively for old sessions that
// predate the hook (or that never triggered SessionEnd) -- most relevantly
// for a new install pointed at a machine with years of pre-existing
// ~/.claude/projects history and no recap coverage yet.
//
// No new DB code needed: this only writes recap/*.md files in the exact
// place and naming convention (`${day}-${sessionIdShort8}.md`) sync.js's
// existing condenseRecapForDay() already reads from -- run `node sync.js`
// afterward and DaySummaries fills in the same way it does for live
// sessions.
//
// Usage:
//   node scripts/backfill-recaps.js                    -- dry run: count only
//   node scripts/backfill-recaps.js --run               -- generate recaps for every session missing one
//   node scripts/backfill-recaps.js --run --limit 10     -- cap how many this run (try a small batch first)
//
// Each session costs one `claude -p --model haiku` call (a few cents at
// most, haiku pricing) and takes several seconds -- for a large history,
// run with --limit first to see the pace before committing to the rest.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const BRISBANE_OFFSET_MS = 10 * 60 * 60 * 1000; // matches sync.js -- keep day-bucketing identical

const args = process.argv.slice(2);
const DO_RUN = args.includes('--run');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx !== -1 ? Number(args[limitIdx + 1]) : Infinity;

function dayKeyBris(ms) { return new Date(ms + BRISBANE_OFFSET_MS).toISOString().slice(0, 10); }

// The recap's filename date has to match the day sync.js's
// condenseRecapForDay(repoKey, day) will look for -- that function filters
// recap files by `startsWith(day)`, so this has to be the session's actual
// day, not the day the backfill happens to run on. Mirrors the live hook's
// own choice (date at session-end) by using the transcript's last message.
function lastMessageMs(jsonlPath) {
  const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n');
  let lastMs = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.timestamp) {
        const ms = new Date(obj.timestamp).getTime();
        if (!Number.isNaN(ms)) lastMs = ms;
      }
    } catch { /* tolerate malformed lines, same as sync.js's own scan */ }
  }
  return lastMs;
}

function findCandidates() {
  const dirs = fs.readdirSync(PROJECTS_DIR).filter(d => fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory());
  const candidates = [];
  for (const repoKey of dirs) {
    const repoDir = path.join(PROJECTS_DIR, repoKey);
    const jsonlFiles = fs.readdirSync(repoDir).filter(f => f.endsWith('.jsonl'));
    if (jsonlFiles.length === 0) continue;
    const recapDir = path.join(repoDir, 'recap');
    let existingRecaps = [];
    try { existingRecaps = fs.readdirSync(recapDir); } catch { /* no recap dir yet -- everything here is a candidate */ }
    for (const f of jsonlFiles) {
      const sessionId = path.basename(f, '.jsonl');
      const short = sessionId.slice(0, 8);
      if (existingRecaps.some(r => r.endsWith(`-${short}.md`))) continue; // already has a recap, live or backfilled
      const fullPath = path.join(repoDir, f);
      const lastMs = lastMessageMs(fullPath);
      if (lastMs == null) continue; // empty/unparseable transcript -- nothing to summarize
      candidates.push({ repoKey, sessionId, short, transcriptPath: fullPath, day: dayKeyBris(lastMs), recapDir });
    }
  }
  return candidates;
}

const PROMPT = (transcriptPath) => `Read the transcript at ${transcriptPath} (JSONL, one JSON object per line). Then respond with ONLY the recap itself, nothing else -- no preamble, no tool calls beyond reading. Format:
### What happened
- 3 to 6 bullets on what was worked on and key decisions/outcomes
### What's next
- 1 to 3 bullets on anything left unfinished, or the single line 'Nothing pending'
Under 200 words. If the session was trivial (a handful of messages, no real work), say so briefly rather than padding it out.`;

async function generateRecap(c) {
  // CLAUDE_RECAP_HOOK_RUNNING mirrors the live hook's own recursion guard:
  // this call is itself a fresh Claude Code session, so its own SessionEnd
  // would otherwise re-trigger session-recap.sh for a session that's just
  // generating a recap, not doing real work.
  const { stdout } = await execFileAsync(
    'claude',
    ['-p', PROMPT(c.transcriptPath), '--allowedTools', 'Read', '--model', 'haiku'],
    { maxBuffer: 10 * 1024 * 1024, timeout: 120000, windowsHide: true, env: { ...process.env, CLAUDE_RECAP_HOOK_RUNNING: '1' } }
  );
  const body = stdout.trim();
  if (!body) return false;
  fs.mkdirSync(c.recapDir, { recursive: true });
  const outfile = path.join(c.recapDir, `${c.day}-${c.short}.md`);
  fs.writeFileSync(outfile, `---\ndate: ${c.day}\nsession_id: ${c.sessionId}\ncwd: (backfilled)\n---\n\n${body}\n`);
  return true;
}

async function main() {
  console.log(`Scanning ${PROJECTS_DIR} for sessions with no recap yet...`);
  const candidates = findCandidates();
  console.log(`${candidates.length} session(s) have no recap file.`);

  if (!DO_RUN) {
    console.log('\nDry run only -- nothing written. Re-run with --run to actually generate them');
    console.log('(add --limit N to try a small batch first, e.g. --run --limit 10).');
    return;
  }

  const toProcess = candidates.slice(0, LIMIT);
  console.log(`\nGenerating recaps for ${toProcess.length} session(s) -- one \`claude -p --model haiku\` call each, so this takes a while...`);
  let done = 0, failed = 0;
  for (const c of toProcess) {
    try {
      const wrote = await generateRecap(c);
      if (wrote) { done++; console.log(`  ok    ${c.repoKey}/${c.short} (${c.day})  [${done + failed}/${toProcess.length}]`); }
      else console.log(`  skip  ${c.repoKey}/${c.short} -- empty response  [${done + failed + 1}/${toProcess.length}]`);
    } catch (e) {
      failed++;
      console.error(`  FAIL  ${c.repoKey}/${c.short}: ${e.message}  [${done + failed}/${toProcess.length}]`);
    }
  }
  console.log(`\nDone. ${done} recap(s) written, ${failed} failed, ${candidates.length - toProcess.length} left for a future run.`);
  console.log('Run `node sync.js` next to pull these into DaySummaries.');
}

main().catch(e => { console.error(e); process.exit(1); });
