// Weekly backup of the live SQLite database. Copies data/claude_usage_dashboard.sqlite
// to backups/<date>.sqlite via better-sqlite3's native online-backup API (safe to run
// while the server is up -- it captures a consistent snapshot including any pages
// still sitting in the WAL, unlike a plain file copy).
//
// backups/ is gitignored -- this repo is shared publicly on GitHub, so backups never
// get committed. Run manually with:
//   node scripts/backup-db.js
// Scheduled weekly via Windows Task Scheduler (task name: "claude-usage-dashboard weekly DB backup").
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db');

const REPO_ROOT = path.join(__dirname, '..');
const BACKUP_DIR = path.join(REPO_ROOT, 'backups');
const dateStr = new Date().toISOString().slice(0, 10);
const destFile = path.join(BACKUP_DIR, `claude_usage_dashboard_${dateStr}.sqlite`);

fs.mkdirSync(BACKUP_DIR, { recursive: true });

const db = getDb();
db.backup(destFile)
  .then(() => {
    console.log(`Backup written: ${destFile}`);
  })
  .catch((err) => {
    console.error('Backup failed:', err.message);
    process.exit(1);
  });
