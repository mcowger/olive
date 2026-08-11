import type { Database as BunDatabase } from "bun:sqlite";

const CREATE_TABLE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    start_time INTEGER NOT NULL,
    end_time INTEGER NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    tags TEXT NOT NULL DEFAULT '[]',
    primary_transcript_artifact_id TEXT REFERENCES artifacts(id),
    primary_summary_artifact_id TEXT REFERENCES artifacts(id),
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id),
    path TEXT NOT NULL,
    mime TEXT NOT NULL,
    duration_ms INTEGER,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    provider_recording_id TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id),
    recording_id TEXT REFERENCES recordings(id),
    kind TEXT NOT NULL,
    provider TEXT NOT NULL,
    format TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS speakers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider_ids TEXT NOT NULL DEFAULT '{}',
    enrolled_at INTEGER,
    enrollment_clip_paths TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS meeting_speakers (
    meeting_id TEXT NOT NULL REFERENCES meetings(id),
    speaker_id TEXT NOT NULL REFERENCES speakers(id),
    evidence_artifact_id TEXT REFERENCES artifacts(id),
    PRIMARY KEY (meeting_id, speaker_id)
  )`,
  `CREATE TABLE IF NOT EXISTS stage_runs (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id),
    stage TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    provider_job_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    started_at INTEGER,
    finished_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS plaud_ingest_state (
    meeting_id TEXT PRIMARY KEY REFERENCES meetings(id),
    plaud_file_id TEXT NOT NULL UNIQUE,
    first_seen_at INTEGER NOT NULL,
    pcs_deadline_at INTEGER NOT NULL,
    pcs_resolved INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`
];

const CREATE_INDEX_STATEMENTS = [
  "CREATE INDEX IF NOT EXISTS idx_meetings_start_time ON meetings(start_time DESC)",
  "CREATE INDEX IF NOT EXISTS idx_recordings_meeting ON recordings(meeting_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_recordings_provider_id ON recordings(provider, provider_recording_id) WHERE provider_recording_id IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_artifacts_meeting ON artifacts(meeting_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_stage_runs_meeting_stage ON stage_runs(meeting_id, stage)"
];

const ADDITIVE_COLUMNS = [
  ["meetings", "last_error", "TEXT"],
  ["recordings", "provider_recording_id", "TEXT"],
  ["artifacts", "recording_id", "TEXT REFERENCES recordings(id)"],
  ["speakers", "provider_ids", "TEXT NOT NULL DEFAULT '{}'"],
  ["speakers", "enrolled_at", "INTEGER"],
  ["speakers", "enrollment_clip_paths", "TEXT NOT NULL DEFAULT '[]'"],
  ["stage_runs", "provider_job_id", "TEXT"],
  ["stage_runs", "attempts", "INTEGER NOT NULL DEFAULT 0"],
  ["stage_runs", "last_error", "TEXT"],
  ["stage_runs", "started_at", "INTEGER"],
  ["stage_runs", "finished_at", "INTEGER"],
  ["plaud_ingest_state", "pcs_resolved", "INTEGER NOT NULL DEFAULT 0"]
] as const;

function addColumnIfMissing(db: BunDatabase, table: string, column: string, definition: string): void {
  try {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("duplicate column name")) {
      throw error;
    }
  }
}

export function runMigrations(db: BunDatabase): void {
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA journal_mode = WAL");

  for (const statement of CREATE_TABLE_STATEMENTS) {
    db.run(statement);
  }

  for (const [table, column, definition] of ADDITIVE_COLUMNS) {
    addColumnIfMissing(db, table, column, definition);
  }

  for (const statement of CREATE_INDEX_STATEMENTS) {
    db.run(statement);
  }
}
