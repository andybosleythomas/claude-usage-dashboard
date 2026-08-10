// Creates (or verifies) an empty, schema-only SQLite database -- the
// starting point for a brand-new install, distinct from the migration
// script (which copies real data out of an existing SQL Server instance).
// db.js already does this automatically on first connect, so this script
// mostly exists to make that step explicit and inspectable: run it, see
// exactly where the file landed and that it's empty, before ever starting
// the server. Safe to re-run -- CREATE TABLE IF NOT EXISTS, never touches
// existing rows.
const path = require('path');
const { getDb } = require('../db');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'claude_usage_dashboard.sqlite');

const db = getDb();
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
const counts = tables.map(t => ({ table: t.name, rows: db.prepare(`SELECT COUNT(*) AS n FROM ${t.name}`).get().n }));

console.log(`Database ready: ${DB_PATH}`);
console.log(`${tables.length} tables:`);
for (const { table, rows } of counts) console.log(`  ${table}: ${rows} row${rows === 1 ? '' : 's'}`);

const totalRows = counts.reduce((a, c) => a + c.rows, 0);
if (totalRows === 0) {
  console.log('\nEmpty database, ready for a new install. Next steps:');
  console.log('  1. node sync.js       -- scan ~/.claude/projects and populate it');
  console.log('  2. node server.js     -- start the app at http://localhost:4173');
} else {
  console.log(`\n${totalRows} existing rows found -- this is not a blank database.`);
  console.log('If you meant to start fresh, remove the file above (and its -wal/-shm siblings) and re-run this script.');
}
