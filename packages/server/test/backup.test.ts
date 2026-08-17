import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { BackupService } from "../src/backup/service.ts";
import { createDb, setDbForTests, type DbHandle } from "../src/db.ts";
import { meetingPaths } from "../src/layout.ts";

const SAMPLE_AUDIO = new TextEncoder().encode("RIFF....WAVEfmt ....dataFAKEAUDIOBYTES12345");

describe("Backup & Restore Pipeline", () => {
  let testRoot: string;
  let configDir: string;
  let meetingsDir: string;
  let backupsDir: string;
  let databasePath: string;
  let settingsPath: string;
  let dbHandle: DbHandle;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "olive-backup-test-"));
    configDir = join(testRoot, "config");
    meetingsDir = join(testRoot, "meetings");
    backupsDir = join(testRoot, "backups");
    databasePath = join(configDir, "olive.sqlite");
    settingsPath = join(configDir, "settings.json");

    mkdirSync(configDir, { recursive: true });
    mkdirSync(meetingsDir, { recursive: true });
    mkdirSync(backupsDir, { recursive: true });

    dbHandle = createDb(databasePath);
    setDbForTests(dbHandle);
  });

  afterEach(async () => {
    setDbForTests(undefined);
    await rm(testRoot, { recursive: true, force: true });
  });

  test("creates backup archive containing sqlite db, settings, and all audio files", async () => {
    const meetingId = "11111111-1111-4111-8111-111111111111";
    const recordingId = "22222222-2222-4222-8222-222222222222";
    const speakerId = "33333333-3333-4333-8333-333333333333";
    const now = 1_700_000_000_000;

    // 1. Seed database
    await dbHandle.db
      .insertInto("meetings")
      .values({
        id: meetingId,
        title: "Architecture Planning",
        start_time: now,
        end_time: now + 3600_000,
        source: "upload",
        status: "ready",
        tags: '["arch","q3"]',
        primary_transcript_artifact_id: null,
        primary_summary_artifact_id: null,
        last_error: null,
        created_at: now,
        updated_at: now
      })
      .execute();

    await dbHandle.db
      .insertInto("recordings")
      .values({
        id: recordingId,
        meeting_id: meetingId,
        path: "audio/sample.wav",
        mime: "audio/wav",
        duration_ms: 120_000,
        size_bytes: SAMPLE_AUDIO.byteLength,
        sha256: "fake-sha-256",
        provider: "upload",
        provider_recording_id: null,
        created_at: now
      })
      .execute();

    await dbHandle.db
      .insertInto("speakers")
      .values({
        id: speakerId,
        name: "Alice Engineer",
        provider_ids: "{}",
        enrolled_at: now,
        enrollment_clip_paths: "[]",
        created_at: now
      })
      .execute();

    // 2. Create meeting audio file and summary on disk
    const paths = meetingPaths(meetingsDir, now, "Architecture Planning", meetingId);
    mkdirSync(paths.audioDir, { recursive: true });
    mkdirSync(paths.summariesDir, { recursive: true });
    mkdirSync(paths.transcriptsDir, { recursive: true });

    writeFileSync(join(paths.audioDir, "sample.wav"), SAMPLE_AUDIO);
    writeFileSync(join(paths.summariesDir, "summary_1700000000000_note1.md"), "# Architecture Summary\nKey points discussed.");
    writeFileSync(join(paths.transcriptsDir, "transcript.json"), JSON.stringify({ segments: [] }));

    // 3. Create settings.json
    writeFileSync(settingsPath, JSON.stringify({ defaultProvider: "google", defaultModel: "gemini-2.5-flash" }), "utf8");

    // 4. Run backup
    const backupService = new BackupService({
      db: dbHandle.db,
      configDir,
      meetingsDir,
      backupsDir,
      databasePath,
      settingsPath
    });

    const result = await backupService.createBackup();

    expect(existsSync(result.path)).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(100);
    expect(result.manifest.stats.meetingCount).toBe(1);
    expect(result.manifest.stats.recordingCount).toBe(1);
    expect(result.manifest.stats.audioFilesCount).toBe(1);
    expect(result.manifest.stats.totalAudioSizeBytes).toBe(SAMPLE_AUDIO.byteLength);
    expect(result.manifest.stats.speakerCount).toBe(1);
    expect(result.manifest.stats.summaryCount).toBe(1);

    // 5. Check listing
    const list = await backupService.listBackups();
    expect(list).toHaveLength(1);
    expect(list[0].filename).toBe(result.filename);
    expect(list[0].manifest?.stats.meetingCount).toBe(1);
  });

  test("restores database, settings, and all audio files from a backup archive", async () => {
    const meetingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const recordingId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const now = 1_700_000_000_000;

    // Seed original data
    await dbHandle.db
      .insertInto("meetings")
      .values({
        id: meetingId,
        title: "Sprint Review",
        start_time: now,
        end_time: now + 1800_000,
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

    await dbHandle.db
      .insertInto("recordings")
      .values({
        id: recordingId,
        meeting_id: meetingId,
        path: "audio/sprint.wav",
        mime: "audio/wav",
        duration_ms: 60_000,
        size_bytes: SAMPLE_AUDIO.byteLength,
        sha256: "fake-sha",
        provider: "upload",
        provider_recording_id: null,
        created_at: now
      })
      .execute();

    const mPaths = meetingPaths(meetingsDir, now, "Sprint Review", meetingId);
    mkdirSync(mPaths.audioDir, { recursive: true });
    mkdirSync(mPaths.summariesDir, { recursive: true });
    writeFileSync(join(mPaths.audioDir, "sprint.wav"), SAMPLE_AUDIO);
    writeFileSync(join(mPaths.summariesDir, "summary_1_sprint.md"), "# Sprint Review Note");
    writeFileSync(settingsPath, JSON.stringify({ defaultProvider: "anthropic" }), "utf8");

    const backupService = new BackupService({
      db: dbHandle.db,
      configDir,
      meetingsDir,
      backupsDir,
      databasePath,
      settingsPath
    });

    const backupResult = await backupService.createBackup({ filename: "sprint-backup.tar.gz" });

    // Wipe current state to simulate clean or corrupted instance
    await rm(meetingsDir, { recursive: true, force: true });
    mkdirSync(meetingsDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ defaultProvider: "wiped" }), "utf8");

    // Perform restore
    const restoreResult = await backupService.restoreBackup(backupResult.path);

    expect(restoreResult.success).toBe(true);
    expect(restoreResult.stats.meetings).toBe(1);
    expect(restoreResult.stats.recordings).toBe(1);
    expect(restoreResult.stats.audioFiles).toBe(1);

    // Verify audio file was restored
    const restoredAudioPath = join(mPaths.audioDir, "sprint.wav");
    expect(existsSync(restoredAudioPath)).toBe(true);
    expect(readFileSync(restoredAudioPath)).toEqual(Buffer.from(SAMPLE_AUDIO));

    // Verify summary was restored
    const restoredSummaryPath = join(mPaths.summariesDir, "summary_1_sprint.md");
    expect(existsSync(restoredSummaryPath)).toBe(true);

    // Verify settings was restored
    const restoredSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(restoredSettings.defaultProvider).toBe("anthropic");
  });

  test("REST API endpoints support create, list, download, export, delete, and restore", async () => {
    const meetingId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const now = 1_700_000_000_000;

    await dbHandle.db
      .insertInto("meetings")
      .values({
        id: meetingId,
        title: "API Meeting",
        start_time: now,
        end_time: now + 3600_000,
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

    const mPaths = meetingPaths(meetingsDir, now, "API Meeting", meetingId);
    mkdirSync(mPaths.audioDir, { recursive: true });
    writeFileSync(join(mPaths.audioDir, "recording.wav"), SAMPLE_AUDIO);

    const backupService = new BackupService({
      db: dbHandle.db,
      configDir,
      meetingsDir,
      backupsDir,
      databasePath,
      settingsPath
    });

    const app = createApp({
      db: dbHandle.db,
      configDir,
      meetingsDir,
      backupsDir,
      backupService
    });

    // 1. POST /api/backup
    const createRes = await app.request("http://olive.test/api/backup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "api-test-backup.tar.gz" })
    });
    expect(createRes.status).toBe(201);
    const createData = await createRes.json();
    expect(createData.ok).toBe(true);
    expect(createData.backup.filename).toBe("api-test-backup.tar.gz");
    expect(createData.backup.manifest.stats.meetingCount).toBe(1);
    expect(createData.backup.manifest.stats.audioFilesCount).toBe(1);

    // 2. GET /api/backup/list
    const listRes = await app.request("http://olive.test/api/backup/list");
    expect(listRes.status).toBe(200);
    const listData = await listRes.json();
    expect(listData.ok).toBe(true);
    expect(listData.backups).toHaveLength(1);
    expect(listData.backups[0].filename).toBe("api-test-backup.tar.gz");

    // 3. GET /api/backup/download/:filename
    const downloadRes = await app.request("http://olive.test/api/backup/download/api-test-backup.tar.gz");
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("content-type")).toBe("application/gzip");
    const downloadedBytes = await downloadRes.arrayBuffer();
    expect(downloadedBytes.byteLength).toBeGreaterThan(100);

    // 4. GET /api/backup/export
    const exportRes = await app.request("http://olive.test/api/backup/export");
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers.get("content-type")).toBe("application/gzip");
    const exportBytes = await exportRes.arrayBuffer();
    expect(exportBytes.byteLength).toBeGreaterThan(100);

    // 5. POST /api/backup/restore with multipart form data
    const formData = new FormData();
    formData.append("file", new Blob([downloadedBytes], { type: "application/gzip" }), "upload-backup.tar.gz");
    const restoreRes = await app.request("http://olive.test/api/backup/restore", {
      method: "POST",
      body: formData
    });
    expect(restoreRes.status).toBe(200);
    const restoreData = await restoreRes.json();
    expect(restoreData.ok).toBe(true);
    expect(restoreData.result.stats.meetings).toBe(1);
    expect(restoreData.result.stats.audioFiles).toBe(1);

    // 6. DELETE /api/backup/:filename
    const deleteRes = await app.request("http://olive.test/api/backup/api-test-backup.tar.gz", {
      method: "DELETE"
    });
    expect(deleteRes.status).toBe(200);
    const deleteData = await deleteRes.json();
    expect(deleteData.ok).toBe(true);

    const listAfterDelete = await app.request("http://olive.test/api/backup/list");
    const listAfterDeleteData = await listAfterDelete.json();
    // Only the export backup remains or 1 item
    expect(listAfterDeleteData.backups.some((b: { filename: string }) => b.filename === "api-test-backup.tar.gz")).toBe(false);
  });
});
