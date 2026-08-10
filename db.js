// SQLite connection -- a single local file, no server, no driver install.
// Replaces the old SQL Server pool (Windows-auth via msnodesqlv8) -- see
// sql/schema.sql and git history for that version.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'claude_usage_dashboard.sqlite');
const SCHEMA_PATH = path.join(__dirname, 'sql', 'schema.sqlite.sql');

let db = null;

// Synchronous by design (that's how better-sqlite3 works) -- callers that
// still write `const db = await getDb();` keep working unchanged, since
// awaiting a non-promise just resolves immediately.
function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  // Required for the ON DELETE CASCADE clauses in schema.sqlite.sql
  // (ModelUsage/ToolUsage -> DailyUsage/SessionFiles) to actually fire --
  // SQLite ignores them by default.
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

module.exports = { getDb };
