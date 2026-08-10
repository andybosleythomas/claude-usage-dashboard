-- claude-usage-dashboard SQLite schema.
-- Applied automatically by db.js on every startup (all CREATEs are
-- IF NOT EXISTS, so this is safe to re-run against an existing file).
--
-- Column type notes (differences from the retired SQL Server schema,
-- sql/schema.sql, kept for reference / anyone still on that backend):
--   dbo.<Table>      -> <Table>        (SQLite has no schema-qualification here)
--   IDENTITY(1,1)    -> INTEGER PRIMARY KEY AUTOINCREMENT
--   NVARCHAR(n)      -> TEXT (SQLite has no length limit or benefit from one)
--   DATE / DATETIME2 -> TEXT, ISO-8601 strings ('YYYY-MM-DD' / 'YYYY-MM-DD HH:MM:SS'),
--                       exactly the string shape the app already reads/writes
--   DECIMAL(x,y)     -> REAL. The app already treats every money/hours value as a
--                       JS float the moment it crosses the driver boundary (the old
--                       mssql driver returns DECIMAL columns as plain JS numbers,
--                       and every total in server.js/lib/calc.js is already computed
--                       and rounded in JS, e.g. Math.round(x*100)/100) -- so REAL
--                       here is not a new source of imprecision, just an honest
--                       reflection of what the app already does. Rounding discipline
--                       (round before storing a computed total, round before display)
--                       is unchanged from the SQL Server version.
--   BIT              -> INTEGER (0/1)
--   SYSUTCDATETIME() -> CURRENT_TIMESTAMP (SQLite's default UTC timestamp)
--   MERGE            -> INSERT ... ON CONFLICT(...) DO UPDATE / DO NOTHING (in app code)
--
-- Foreign keys are NOT enforced unless the connection turns them on -- db.js
-- runs `PRAGMA foreign_keys = ON` on every connection open, which is required
-- for the ON DELETE CASCADE clauses below to actually do anything.

CREATE TABLE IF NOT EXISTS Clients (
    ClientId     INTEGER PRIMARY KEY AUTOINCREMENT,
    Name         TEXT NOT NULL UNIQUE,
    ActiveRate   REAL NOT NULL DEFAULT 0,
    IdleRate     REAL NOT NULL DEFAULT 0,
    ManualMultiplier REAL NOT NULL DEFAULT 1.5,
    RoundingIncrementMinutes INTEGER NOT NULL DEFAULT 15,
    CreatedAt    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS Repos (
    RepoId       INTEGER PRIMARY KEY AUTOINCREMENT,
    RepoKey      TEXT NOT NULL UNIQUE, -- raw ~/.claude/projects folder name
    ClientId     INTEGER NULL REFERENCES Clients(ClientId),
    CwdPath      TEXT NULL, -- actual working directory (from JSONL obj.cwd), for git-log correlation
    FirstSeen    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One row per (repo, calendar day, Brisbane tz). This is the aggregate the
-- dashboard reads from; sync.js recomputes and upserts it wholesale per repo.
CREATE TABLE IF NOT EXISTS DailyUsage (
    RepoId        INTEGER NOT NULL REFERENCES Repos(RepoId),
    UsageDate     TEXT NOT NULL,
    Cost          REAL NOT NULL DEFAULT 0,
    Messages      INTEGER NOT NULL DEFAULT 0,
    SessionCount  INTEGER NOT NULL DEFAULT 0,
    StartTime     TEXT NULL,   -- 'HH:MM' Brisbane
    EndTime       TEXT NULL,
    SpanHours     REAL NOT NULL DEFAULT 0,
    ActiveHours   REAL NOT NULL DEFAULT 0,
    ToolExecHours REAL NOT NULL DEFAULT 0,
    ModelLatencyHours REAL NOT NULL DEFAULT 0,
    InputTokens   INTEGER NOT NULL DEFAULT 0,
    OutputTokens  INTEGER NOT NULL DEFAULT 0,
    CacheWriteTokens INTEGER NOT NULL DEFAULT 0,
    CacheReadTokens  INTEGER NOT NULL DEFAULT 0,
    CommitCount   INTEGER NOT NULL DEFAULT 0,
    UpdatedAt     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (RepoId, UsageDate)
);

-- Per (repo, day, model) message-count breakdown -> "model mix" chart.
CREATE TABLE IF NOT EXISTS ModelUsage (
    RepoId       INTEGER NOT NULL,
    UsageDate    TEXT NOT NULL,
    Model        TEXT NOT NULL,
    MessageCount INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (RepoId, UsageDate, Model),
    FOREIGN KEY (RepoId, UsageDate) REFERENCES DailyUsage(RepoId, UsageDate) ON DELETE CASCADE
);

-- One row per session (.jsonl) file ever seen, so we can compute distinct
-- session counts per month/all-time without re-deriving them from DailyUsage.
CREATE TABLE IF NOT EXISTS SessionFiles (
    RepoId     INTEGER NOT NULL REFERENCES Repos(RepoId),
    SessionId  TEXT NOT NULL,
    FirstSeen  TEXT NOT NULL,
    LastSeen   TEXT NOT NULL,
    MessageCount INTEGER NOT NULL DEFAULT 0,
    GitBranch  TEXT NULL,
    PRIMARY KEY (RepoId, SessionId)
);

-- Tool-call breakdown per session (Read/Edit/Bash/...) -- "hot files" and
-- "tool mix" insights read from here.
CREATE TABLE IF NOT EXISTS ToolUsage (
    RepoId     INTEGER NOT NULL,
    SessionId  TEXT NOT NULL,
    ToolName   TEXT NOT NULL,
    CallCount  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (RepoId, SessionId, ToolName),
    FOREIGN KEY (RepoId, SessionId) REFERENCES SessionFiles(RepoId, SessionId) ON DELETE CASCADE
);

-- Skill invocations per session (the skill name from the Skill tool's own
-- input, not just a generic "Skill" tool-call count) -- lets "Things to
-- try" detect specific underused capabilities, e.g. never having run
-- code-review or security-review against a repo with real code changes.
CREATE TABLE IF NOT EXISTS SkillUsage (
    RepoId     INTEGER NOT NULL,
    SessionId  TEXT NOT NULL,
    SkillName  TEXT NOT NULL,
    CallCount  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (RepoId, SessionId, SkillName),
    FOREIGN KEY (RepoId, SessionId) REFERENCES SessionFiles(RepoId, SessionId) ON DELETE CASCADE
);

-- Distinct file paths touched (from Read/Edit/Write tool_use inputs) --
-- powers a "hot files" / most-touched-file insight per repo.
CREATE TABLE IF NOT EXISTS FileTouches (
    RepoId     INTEGER NOT NULL REFERENCES Repos(RepoId),
    FilePath   TEXT NOT NULL,
    UsageDate  TEXT NOT NULL,
    TouchCount INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (RepoId, FilePath, UsageDate)
);

-- Manual time entries: 'adjustment' overrides the auto-computed ActiveHours
-- for a repo/day (sync.js upserts DailyUsage wholesale per repo, so an
-- override can't live there or it'd be wiped on the next sync); 'manual' is
-- additive non-Claude time (meetings, planning) either against a repo or,
-- when there's no Claude session history at all, directly against a client.
CREATE TABLE IF NOT EXISTS TimeEntries (
    TimeEntryId INTEGER PRIMARY KEY AUTOINCREMENT,
    RepoId      INTEGER NULL REFERENCES Repos(RepoId),
    ClientId    INTEGER NULL REFERENCES Clients(ClientId),
    EntryDate   TEXT NOT NULL,
    EntryType   TEXT NOT NULL,
    Hours       REAL NOT NULL DEFAULT 0,
    Note        TEXT NULL,
    UpdatedAt   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (EntryType IN ('adjustment', 'manual')),
    CHECK (EntryType = 'manual' OR RepoId IS NOT NULL),
    CHECK (RepoId IS NOT NULL OR ClientId IS NOT NULL)
);

-- One adjustment per repo/day.
CREATE UNIQUE INDEX IF NOT EXISTS UX_TimeEntries_Adjustment ON TimeEntries(RepoId, EntryDate) WHERE EntryType = 'adjustment';
-- One manual entry per repo/day (when tied to a repo).
CREATE UNIQUE INDEX IF NOT EXISTS UX_TimeEntries_ManualRepo ON TimeEntries(RepoId, EntryDate) WHERE EntryType = 'manual' AND RepoId IS NOT NULL;
-- One manual entry per client/day when there's no repo (e.g. a client meeting).
CREATE UNIQUE INDEX IF NOT EXISTS UX_TimeEntries_ManualClient ON TimeEntries(ClientId, EntryDate) WHERE EntryType = 'manual' AND RepoId IS NULL;

-- Client-incurred expenses (travel, subscriptions, software, ...), one-off
-- or recurring. Recurring rows are templates (IsRecurring=1); server.js
-- materializes concrete dated occurrences on read (ParentExpenseId points
-- back to the template) up through today, so there's no cron dependency.
CREATE TABLE IF NOT EXISTS Expenses (
    ExpenseId          INTEGER PRIMARY KEY AUTOINCREMENT,
    ClientId           INTEGER NOT NULL REFERENCES Clients(ClientId),
    RepoId             INTEGER NULL REFERENCES Repos(RepoId),
    ExpenseDate        TEXT NOT NULL,
    Category           TEXT NOT NULL DEFAULT 'Other',
    Description        TEXT NOT NULL,
    Amount              REAL NOT NULL,
    IsRecurring         INTEGER NOT NULL DEFAULT 0,
    RecurrenceInterval  TEXT NULL,
    RecurrenceEndDate   TEXT NULL,
    ParentExpenseId     INTEGER NULL REFERENCES Expenses(ExpenseId),
    CreatedAt           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (RecurrenceInterval IS NULL OR RecurrenceInterval IN ('weekly', 'monthly', 'yearly')),
    CHECK (IsRecurring = 0 OR RecurrenceInterval IS NOT NULL)
);

-- Prevents double-materialization if two browser tabs both trigger
-- generate-on-read at once.
CREATE UNIQUE INDEX IF NOT EXISTS UX_Expenses_ParentOccurrence ON Expenses(ParentExpenseId, ExpenseDate) WHERE ParentExpenseId IS NOT NULL;

-- One-line "what was the key deliverable" summary per repo/day, shown next
-- to the day on Invoicing/Dashboard the same way a Time-tab note is. Kept
-- separate from DailyUsage for the same reason as TimeEntries (sync.js
-- upserts that table wholesale per repo). Source='ai' rows are generated by
-- sync.js from that day's session-recap files (or by a one-off backfill for
-- history that predates the recap hook); Source='manual' rows are
-- user-edited and sync.js never overwrites an existing row of either kind.
CREATE TABLE IF NOT EXISTS DaySummaries (
    RepoId     INTEGER NOT NULL REFERENCES Repos(RepoId),
    UsageDate  TEXT NOT NULL,
    Summary    TEXT NOT NULL,
    Source     TEXT NOT NULL DEFAULT 'ai',
    UpdatedAt  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (RepoId, UsageDate),
    CHECK (Source IN ('ai', 'manual'))
);

CREATE TABLE IF NOT EXISTS SyncRuns (
    SyncRunId    INTEGER PRIMARY KEY AUTOINCREMENT,
    StartedAt    TEXT NOT NULL,
    FinishedAt   TEXT NULL,
    ReposScanned INTEGER NULL,
    DaysUpserted INTEGER NULL,
    Notes        TEXT NULL
);
