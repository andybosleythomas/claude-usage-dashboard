# Weekly backup of the live SQLite database. Thin wrapper around backup-db.js
# (uses better-sqlite3's native backup API) so the scheduled task has a stable
# entry point. backups/ is gitignored -- this repo is shared publicly on GitHub,
# so backups never get committed or pushed. Run manually with:
#   powershell -File scripts\backup-db.ps1
# Scheduled weekly via Windows Task Scheduler (task name: "claude-usage-dashboard weekly DB backup").

param(
    [string]$RepoPath = "C:\code\claude-usage-dashboard"
)

$ErrorActionPreference = "Stop"

node (Join-Path $RepoPath "scripts\backup-db.js")
if ($LASTEXITCODE -ne 0) {
    throw "backup-db.js failed with exit code $LASTEXITCODE"
}
