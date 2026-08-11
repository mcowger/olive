import { describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import type { Database } from "@olive/shared";
import { runMigrations } from "@olive/shared/migrations";

function createTestDatabase(): { sqlite: BunDatabase; db: Kysely<Database> } {
  const sqlite = new BunDatabase(":memory:");
  runMigrations(sqlite);
  return {
    sqlite,
    db: new Kysely<Database>({ dialect: new BunSqliteDialect({ database: sqlite }) })
  };
}

describe("domain migrations", () => {
  test("apply idempotently and round-trip a fixture row in every table", async () => {
    const { sqlite, db } = createTestDatabase();
    const now = Date.now();

    runMigrations(sqlite);

    await db
      .insertInto("meetings")
      .values({
        id: "meeting-1",
        title: "Migration fixture",
        start_time: now,
        end_time: now + 60_000,
        source: "upload",
        status: "pending",
        tags: JSON.stringify(["fixture"]),
        primary_transcript_artifact_id: null,
        primary_summary_artifact_id: null,
        last_error: null,
        created_at: now,
        updated_at: now
      })
      .execute();

    await db
      .insertInto("speakers")
      .values({
        id: "speaker-1",
        name: "Fixture Speaker",
        provider_ids: JSON.stringify({ speechmatics: ["voice-1"] }),
        enrolled_at: now,
        enrollment_clip_paths: JSON.stringify(["clips/fixture.wav"]),
        created_at: now
      })
      .execute();

    await db
      .insertInto("recordings")
      .values({
        id: "recording-1",
        meeting_id: "meeting-1",
        path: "audio/recording-1.m4a",
        mime: "audio/mp4",
        duration_ms: 60_000,
        size_bytes: 1234,
        sha256: "sha256-fixture",
        provider: "upload",
        provider_recording_id: "provider-recording-1",
        created_at: now
      })
      .execute();

    await db
      .insertInto("artifacts")
      .values({
        id: "artifact-1",
        meeting_id: "meeting-1",
        recording_id: "recording-1",
        kind: "transcript",
        provider: "upload",
        format: "json",
        path: "transcripts/upload.json",
        created_at: now
      })
      .execute();

    await db
      .insertInto("meeting_speakers")
      .values({
        meeting_id: "meeting-1",
        speaker_id: "speaker-1",
        evidence_artifact_id: "artifact-1"
      })
      .execute();

    await db
      .insertInto("stage_runs")
      .values({
        id: "stage-run-1",
        meeting_id: "meeting-1",
        stage: "speechmatics_transcribe",
        status: "pending",
        provider_job_id: null,
        attempts: 0,
        last_error: null,
        started_at: null,
        finished_at: null,
        created_at: now,
        updated_at: now
      })
      .execute();

    await db
      .insertInto("plaud_ingest_state")
      .values({
        meeting_id: "meeting-1",
        plaud_file_id: "plaud-file-1",
        first_seen_at: now,
        pcs_deadline_at: now + 86_400_000,
        pcs_resolved: 0
      })
      .execute();

    await db.insertInto("sync_state").values({ key: "last-sync", value: String(now) }).execute();

    expect(await db.selectFrom("meetings").selectAll().where("id", "=", "meeting-1").executeTakeFirst()).toEqual({
      id: "meeting-1",
      title: "Migration fixture",
      start_time: now,
      end_time: now + 60_000,
      source: "upload",
      status: "pending",
      tags: '["fixture"]',
      primary_transcript_artifact_id: null,
      primary_summary_artifact_id: null,
      last_error: null,
      created_at: now,
      updated_at: now
    });
    expect(await db.selectFrom("recordings").selectAll().where("id", "=", "recording-1").executeTakeFirst()).toMatchObject({
      id: "recording-1",
      meeting_id: "meeting-1",
      sha256: "sha256-fixture"
    });
    expect(await db.selectFrom("artifacts").selectAll().where("id", "=", "artifact-1").executeTakeFirst()).toMatchObject({
      id: "artifact-1",
      meeting_id: "meeting-1",
      recording_id: "recording-1"
    });
    expect(await db.selectFrom("speakers").selectAll().where("id", "=", "speaker-1").executeTakeFirst()).toMatchObject({
      id: "speaker-1",
      name: "Fixture Speaker",
      provider_ids: '{"speechmatics":["voice-1"]}'
    });
    expect(await db.selectFrom("meeting_speakers").selectAll().where("meeting_id", "=", "meeting-1").executeTakeFirst()).toEqual({
      meeting_id: "meeting-1",
      speaker_id: "speaker-1",
      evidence_artifact_id: "artifact-1"
    });
    expect(await db.selectFrom("stage_runs").selectAll().where("id", "=", "stage-run-1").executeTakeFirst()).toMatchObject({
      id: "stage-run-1",
      meeting_id: "meeting-1",
      stage: "speechmatics_transcribe"
    });
    expect(await db.selectFrom("plaud_ingest_state").selectAll().where("meeting_id", "=", "meeting-1").executeTakeFirst()).toMatchObject({
      meeting_id: "meeting-1",
      plaud_file_id: "plaud-file-1",
      pcs_resolved: 0
    });
    expect(await db.selectFrom("sync_state").selectAll().where("key", "=", "last-sync").executeTakeFirst()).toEqual({
      key: "last-sync",
      value: String(now)
    });

    await db.destroy();
    sqlite.close();
  });
});
