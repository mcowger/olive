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
  )`,
  `CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    system_prompt TEXT NOT NULL DEFAULT '',
    user_prompt TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS logs (
    id TEXT PRIMARY KEY,
    level TEXT NOT NULL,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    meeting_id TEXT REFERENCES meetings(id),
    details TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id),
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    usage TEXT,
    created_at INTEGER NOT NULL
  )`
];

const CREATE_INDEX_STATEMENTS = [
  "CREATE INDEX IF NOT EXISTS idx_meetings_start_time ON meetings(start_time DESC)",
  "CREATE INDEX IF NOT EXISTS idx_recordings_meeting ON recordings(meeting_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_recordings_provider_id ON recordings(provider, provider_recording_id) WHERE provider_recording_id IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_artifacts_meeting ON artifacts(meeting_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_stage_runs_meeting_stage ON stage_runs(meeting_id, stage)",
  "CREATE INDEX IF NOT EXISTS idx_templates_name ON templates(name)",
  "CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level)",
  "CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category)",
  "CREATE INDEX IF NOT EXISTS idx_logs_meeting_id ON logs(meeting_id)",
  "CREATE INDEX IF NOT EXISTS idx_chat_messages_meeting_created ON chat_messages(meeting_id, created_at)"
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

export const DEFAULT_TEMPLATES = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Executive Summary",
    description: "Structured meeting overview with context, key discussion points, decisions made, and assigned action items.",
    system_prompt: "You are an expert executive assistant and meeting analyst. Produce clear, structured, professional meeting summaries in Markdown format with precise speaker attribution and actionable next steps. Do not invent, guess, or hallucinate participant names or speaker identities that are not explicitly stated in the transcript or participant list. Only attribute statements to the actual speaker labels provided in the transcript.",
    user_prompt: `# Meeting Summary: {{title}}
**Date:** {{date}}
**Participants:** {{speakers}}

## Executive Overview
Summarize the main purpose, high-level context, and outcome of the meeting in 2-3 concise paragraphs.

## Key Discussion Points
- Detail each key topic discussed, noting differing perspectives, relevant metrics, and context.

## Decisions Made
- Clear, bulleted list of all explicit decisions agreed upon during the conversation.

## Action Items & Next Steps
- [ ] **[Owner]**: Specific task description (include deadlines/timeline if mentioned)

---
### Meeting Transcript:
{{transcript}}`,
    is_default: 1,
    is_builtin: 1
  },
  {
    id: "00000000-0000-0000-0000-000000000002",
    name: "1-on-1 Catchup",
    description: "Focused on individual priorities, project updates, blockers, feedback, and mutual commitments.",
    system_prompt: "You are an executive coach and engineering manager summarizing a 1-on-1 meeting. Emphasize personal updates, blockers, feedback, and commitments. Do not invent, guess, or hallucinate participant names or speaker identities that are not explicitly stated in the transcript or participant list. Only attribute statements to the actual speaker labels provided in the transcript.",
    user_prompt: `# 1-on-1 Summary: {{title}}
**Date:** {{date}}
**Participants:** {{speakers}}

## Progress & Wins
- Recent achievements, project updates, and positive milestones discussed.

## Blockers & Concerns
- Any obstacles, risks, team dependencies, or challenges raised that need resolution.

## Feedback & Career Growth
- Feedback exchanged, development opportunities, coaching notes, or long-term goals.

## Commitments & Follow-ups
- [ ] **[Owner]**: Agreed action item or follow-up

---
### Meeting Transcript:
{{transcript}}`,
    is_default: 0,
    is_builtin: 1
  },
  {
    id: "00000000-0000-0000-0000-000000000003",
    name: "Technical Architecture & Design Review",
    description: "Detailed engineering review covering architecture, technical trade-offs, scalability, and open questions.",
    system_prompt: "You are a principal software engineer and technical architect reviewing meeting notes. Focus on architectural decisions, trade-offs, constraints, and engineering action items. Do not invent, guess, or hallucinate participant names or speaker identities that are not explicitly stated in the transcript or participant list. Only attribute statements to the actual speaker labels provided in the transcript.",
    user_prompt: `# Technical Architecture Review: {{title}}
**Date:** {{date}}
**Participants:** {{speakers}}

## Problem Statement & Context
- Technical goals, motivation, and scope of the proposed system or change.

## Architecture & Design Decisions
- Architectural approach, component responsibilities, data flow, and key decisions.

## Trade-offs & Alternatives Considered
- Alternatives discussed, pros/cons, and explicit trade-offs.

## Non-Functional Requirements & Risks
- Security, performance, scale, reliability, failure modes, and monitoring needs.

## Open Questions & Action Items
- [ ] **[Owner]**: Follow-up task, benchmark, prototype, or design doc update

---
### Meeting Transcript:
{{transcript}}`,
    is_default: 0,
    is_builtin: 1
  },
  {
    id: "00000000-0000-0000-0000-000000000004",
    name: "Action Items & Decisions",
    description: "Concise, zero-fluff extraction of decisions made and task assignments with owners.",
    system_prompt: "You are an agile project manager extracting strictly decisions and actionable next steps. Omit general conversational filler. Do not invent, guess, or hallucinate participant names or speaker identities that are not explicitly stated in the transcript or participant list.",
    user_prompt: `# Decisions & Action Items: {{title}}
**Date:** {{date}}
**Participants:** {{speakers}}

## Decisions Log
- **Decision**: Context and agreed outcome.

## Action Items Matrix
- [ ] **[Owner]**: Task description (Due date / milestone if mentioned)

---
### Meeting Transcript:
{{transcript}}`,
    is_default: 0,
    is_builtin: 1
  }
];

function seedBuiltinTemplates(db: BunDatabase): void {
  const now = Date.now();
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO templates (id, name, description, system_prompt, user_prompt, is_default, is_builtin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateBuiltinStmt = db.prepare(`
    UPDATE templates
    SET system_prompt = ?
    WHERE id = ? AND is_builtin = 1
  `);

  for (const tpl of DEFAULT_TEMPLATES) {
    insertStmt.run(
      tpl.id,
      tpl.name,
      tpl.description,
      tpl.system_prompt,
      tpl.user_prompt,
      tpl.is_default,
      tpl.is_builtin,
      now,
      now
    );
    updateBuiltinStmt.run(tpl.system_prompt, tpl.id);
  }
}

function repairCorruptedPlaudDurations(db: BunDatabase): void {
  // If a Plaud meeting has a duration > 24h that was erroneously multiplied by 1000,
  // repair it back to actual milliseconds.
  db.run(`
    UPDATE meetings
    SET end_time = start_time + ((end_time - start_time) / 1000)
    WHERE source = 'plaud'
      AND (end_time - start_time) > 86400000
      AND ((end_time - start_time) % 1000) = 0;
  `);

  db.run(`
    UPDATE recordings
    SET duration_ms = duration_ms / 1000
    WHERE provider = 'plaud'
      AND duration_ms IS NOT NULL
      AND duration_ms > 86400000
      AND (duration_ms % 1000) = 0;
  `);
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

  seedBuiltinTemplates(db);
  repairCorruptedPlaudDurations(db);
}
