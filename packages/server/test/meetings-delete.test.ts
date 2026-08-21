import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import type { Database } from "@olive/shared";
import { runMigrations } from "@olive/shared/migrations";
import { meetingPaths } from "../src/layout.ts";
import { deleteMeeting, getMeeting } from "../src/meetings.ts";

function createTestContext() {
  const sqlite = new BunDatabase(":memory:");
  runMigrations(sqlite);
  const db = new Kysely<Database>({ dialect: new BunSqliteDialect({ database: sqlite }) });
  const meetingsDir = join(tmpdir(), `olive-delete-meeting-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(meetingsDir, { recursive: true });
  return { db, meetingsDir };
}

async function seedFullMeeting(db: Kysely<Database>, meetingsDir: string) {
  const now = Date.now();
  const meetingId = "meeting-delete-1";
  const title = "Meeting To Delete";

  const paths = meetingPaths(meetingsDir, now, title, meetingId);
  mkdirSync(paths.transcriptsDir, { recursive: true });
  mkdirSync(paths.audioDir, { recursive: true });

  const transcriptRelPath = "transcripts/transcript.json";
  writeFileSync(join(paths.folder, transcriptRelPath), JSON.stringify({ segments: [] }), "utf8");
  const audioRelPath = "audio/recording.wav";
  writeFileSync(join(paths.folder, audioRelPath), "fake-audio", "utf8");

  await db
    .insertInto("meetings")
    .values({
      id: meetingId,
      title,
      start_time: now,
      end_time: now + 600_000,
      source: "upload",
      status: "ready",
      tags: "[]",
      primary_transcript_artifact_id: null,
      primary_summary_artifact_id: null,
      last_error: null,
      created_at: now,
      updated_at: now
    })
    .execute();

  const recordingId = "recording-delete-1";
  await db
    .insertInto("recordings")
    .values({
      id: recordingId,
      meeting_id: meetingId,
      path: audioRelPath,
      mime: "audio/wav",
      duration_ms: 600_000,
      size_bytes: 10,
      sha256: "deadbeef",
      provider: "upload",
      provider_recording_id: null,
      created_at: now
    })
    .execute();

  const transcriptArtifactId = "artifact-transcript-delete-1";
  await db
    .insertInto("artifacts")
    .values({
      id: transcriptArtifactId,
      meeting_id: meetingId,
      recording_id: recordingId,
      kind: "transcript",
      provider: "speechmatics",
      format: "json",
      path: transcriptRelPath,
      created_at: now
    })
    .execute();

  await db
    .updateTable("meetings")
    .set({ primary_transcript_artifact_id: transcriptArtifactId })
    .where("id", "=", meetingId)
    .execute();

  const speakerId = "speaker-delete-1";
  await db
    .insertInto("speakers")
    .values({
      id: speakerId,
      name: "Alice",
      provider_ids: "{}",
      enrolled_at: null,
      enrollment_clip_paths: "[]",
      created_at: now
    })
    .execute();

  await db
    .insertInto("meeting_speakers")
    .values({ meeting_id: meetingId, speaker_id: speakerId, evidence_artifact_id: transcriptArtifactId })
    .execute();

  await db
    .insertInto("stage_runs")
    .values({
      id: "stage-run-delete-1",
      meeting_id: meetingId,
      stage: "transcribe",
      status: "completed",
      provider_job_id: null,
      attempts: 1,
      last_error: null,
      started_at: now,
      finished_at: now,
      created_at: now,
      updated_at: now
    })
    .execute();

  await db
    .insertInto("chat_messages")
    .values({
      id: "chat-delete-1",
      meeting_id: meetingId,
      role: "user",
      content: "hello",
      provider: null,
      model: null,
      usage: null,
      created_at: now
    })
    .execute();

  await db
    .insertInto("logs")
    .values({
      id: "log-delete-1",
      level: "info",
      category: "test",
      message: "seeded log",
      meeting_id: meetingId,
      details: null,
      created_at: now
    })
    .execute();

  return { meetingId, folder: paths.folder };
}

describe("deleteMeeting", () => {
  test("removes meeting, related rows, and files from disk", async () => {
    const { db, meetingsDir } = createTestContext();
    const { meetingId, folder } = await seedFullMeeting(db, meetingsDir);

    expect(existsSync(folder)).toBe(true);

    const result = await deleteMeeting(db, meetingId, meetingsDir);
    expect(result).toBe(true);

    expect(await getMeeting(db, meetingId, meetingsDir)).toBeNull();
    expect(existsSync(folder)).toBe(false);

    const remainingRecordings = await db.selectFrom("recordings").selectAll().where("meeting_id", "=", meetingId).execute();
    const remainingArtifacts = await db.selectFrom("artifacts").selectAll().where("meeting_id", "=", meetingId).execute();
    const remainingMeetingSpeakers = await db
      .selectFrom("meeting_speakers")
      .selectAll()
      .where("meeting_id", "=", meetingId)
      .execute();
    const remainingStageRuns = await db.selectFrom("stage_runs").selectAll().where("meeting_id", "=", meetingId).execute();
    const remainingChatMessages = await db
      .selectFrom("chat_messages")
      .selectAll()
      .where("meeting_id", "=", meetingId)
      .execute();
    const remainingLogs = await db.selectFrom("logs").selectAll().where("meeting_id", "=", meetingId).execute();

    expect(remainingRecordings.length).toBe(0);
    expect(remainingArtifacts.length).toBe(0);
    expect(remainingMeetingSpeakers.length).toBe(0);
    expect(remainingStageRuns.length).toBe(0);
    expect(remainingChatMessages.length).toBe(0);
    expect(remainingLogs.length).toBe(0);

    // Speaker itself is not tied to a single meeting, so it should remain.
    const speaker = await db.selectFrom("speakers").selectAll().where("id", "=", "speaker-delete-1").executeTakeFirst();
    expect(speaker).not.toBeUndefined();
  });

  test("returns false when meeting does not exist", async () => {
    const { db, meetingsDir } = createTestContext();
    const result = await deleteMeeting(db, "does-not-exist", meetingsDir);
    expect(result).toBe(false);
  });
});
