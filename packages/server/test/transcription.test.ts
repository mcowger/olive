import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { createDb } from "../src/db.ts";
import { meetingPaths } from "../src/layout.ts";
import { SpeechmaticsClient } from "../src/providers/speechmatics/client.ts";
import type { SpeechmaticsJsonV2 } from "../src/providers/speechmatics/types.ts";
import { STAGE_SPEECHMATICS_TRANSCRIBE, TranscriptionService } from "../src/transcription/service.ts";

const AUDIO_BYTES = new TextEncoder().encode("fake audio bytes");

const SAMPLE_JSON_V2: SpeechmaticsJsonV2 = {
  format: "2.0",
  job: {
    id: "sm-job-456",
    duration: 5.0,
    lang: "en"
  },
  results: [
    {
      type: "word",
      start_time: 0.1,
      end_time: 0.5,
      alternatives: [{ content: "Welcome", confidence: 0.99, speaker: "Alice" }]
    },
    {
      type: "word",
      start_time: 0.6,
      end_time: 1.0,
      alternatives: [{ content: "everyone", confidence: 0.98, speaker: "Alice" }]
    },
    {
      type: "punctuation",
      start_time: 1.0,
      end_time: 1.0,
      alternatives: [{ content: ".", confidence: 1.0, speaker: "Alice" }]
    }
  ],
  speakers: [
    { speaker: "Alice", speaker_identifiers: ["voice-alice-id-1"] }
  ]
};

function createMockSpeechmaticsClient(jsonV2: SpeechmaticsJsonV2 = SAMPLE_JSON_V2) {
  let deleteCalls: string[] = [];

  const mockBatchClient: any = {
    createTranscriptionJob: async () => ({ id: "sm-job-456" }),
    getJob: async (id: string) => ({
      job: {
        id,
        status: "done",
        created_at: "2026-08-16T12:00:00Z",
        data_name: "test.m4a",
        duration: 5.0
      }
    }),
    getJobResult: async (_id: string, format?: string) => {
      if (format === "json-v2") {
        return jsonV2;
      }
      return "Alice: Welcome everyone.";
    },
    deleteJob: async (id: string) => {
      deleteCalls.push(id);
      return { job: { id, status: "deleted", created_at: "", data_name: "" } };
    }
  };

  const client = new SpeechmaticsClient({
    apiKey: "test-key",
    batchClient: mockBatchClient
  });

  return { client, getDeleteCalls: () => deleteCalls };
}

describe("Transcription Service & Pipeline", () => {
  test("transcribes a meeting recording and persists artifacts, speakers, and stage run", async () => {
    const handle = createDb(":memory:");
    const meetingsDir = await mkdtemp(join(import.meta.dir, "transcribe-test-"));
    const now = 1_700_000_000_000;
    const meetingId = "m-test-1";

    const paths = meetingPaths(meetingsDir, now, "Test Meeting", meetingId);
    await mkdir(paths.audioDir, { recursive: true });
    await writeFile(join(paths.folder, "audio/test.m4a"), AUDIO_BYTES);

    await handle.db
      .insertInto("meetings")
      .values({
        id: meetingId,
        title: "Test Meeting",
        start_time: now,
        end_time: now + 5000,
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

    await handle.db
      .insertInto("recordings")
      .values({
        id: "rec-1",
        meeting_id: meetingId,
        path: "audio/test.m4a",
        mime: "audio/mp4",
        duration_ms: 5000,
        size_bytes: AUDIO_BYTES.byteLength,
        sha256: "fake-sha256-test",
        provider: "upload",
        provider_recording_id: null,
        created_at: now
      })
      .execute();

    const { client, getDeleteCalls } = createMockSpeechmaticsClient();
    const service = new TranscriptionService({
      db: handle.db,
      meetingsDir,
      speechmaticsClient: client,
      now: () => now + 1000
    });

    const result = await service.transcribeMeeting(meetingId, { poll: true, pollIntervalMs: 10 });

    expect(result.status).toBe("done");
    expect(result.jobId).toBe("sm-job-456");
    expect(result.transcriptArtifactId).toBeTruthy();

    const stageRun = await handle.db
      .selectFrom("stage_runs")
      .selectAll()
      .where("meeting_id", "=", meetingId)
      .where("stage", "=", STAGE_SPEECHMATICS_TRANSCRIBE)
      .executeTakeFirstOrThrow();
    expect(stageRun.status).toBe("done");
    expect(stageRun.provider_job_id).toBe("sm-job-456");

    const artifacts = await handle.db
      .selectFrom("artifacts")
      .selectAll()
      .where("meeting_id", "=", meetingId)
      .execute();
    expect(artifacts).toHaveLength(2);
    expect(artifacts.map((a) => [a.provider, a.format])).toEqual([
      ["speechmatics", "json"],
      ["speechmatics", "txt"]
    ]);

    const meeting = await handle.db
      .selectFrom("meetings")
      .selectAll()
      .where("id", "=", meetingId)
      .executeTakeFirstOrThrow();
    expect(meeting.primary_transcript_artifact_id).toBe(result.transcriptArtifactId!);

    const speakers = await handle.db.selectFrom("speakers").selectAll().execute();
    expect(speakers).toHaveLength(1);
    expect(speakers[0].name).toBe("Alice");
    expect(JSON.parse(speakers[0].provider_ids)).toEqual({ speechmatics: ["voice-alice-id-1"] });

    const meetingSpeakers = await handle.db.selectFrom("meeting_speakers").selectAll().execute();
    expect(meetingSpeakers).toHaveLength(1);
    expect(meetingSpeakers[0].speaker_id).toBe(speakers[0].id);

    expect(existsSync(join(paths.folder, "transcripts/speechmatics.json"))).toBe(true);
    expect(existsSync(join(paths.folder, "transcripts/speechmatics.txt"))).toBe(true);
    const txtContent = await readFile(join(paths.folder, "transcripts/speechmatics.txt"), "utf8");
    expect(txtContent).toContain("Alice: Welcome everyone.");

    // Verify retention cleanup delete call was made
    expect(getDeleteCalls()).toHaveLength(1);

    await handle.db.destroy();
    handle.sqlite.close();
    await rm(meetingsDir, { recursive: true, force: true });
  });

  test("API endpoints: triggers transcription, handles webhook, and retrieves meeting detail", async () => {
    const handle = createDb(":memory:");
    const meetingsDir = await mkdtemp(join(import.meta.dir, "transcribe-api-test-"));
    const now = 1_700_000_000_000;
    const meetingId = "m-api-2";

    const paths = meetingPaths(meetingsDir, now, "API Meeting", meetingId);
    await mkdir(paths.audioDir, { recursive: true });
    await writeFile(join(paths.folder, "audio/api.m4a"), AUDIO_BYTES);

    await handle.db
      .insertInto("meetings")
      .values({
        id: meetingId,
        title: "API Meeting",
        start_time: now,
        end_time: now + 5000,
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

    await handle.db
      .insertInto("recordings")
      .values({
        id: "rec-api-2",
        meeting_id: meetingId,
        path: "audio/api.m4a",
        mime: "audio/mp4",
        duration_ms: 5000,
        size_bytes: AUDIO_BYTES.byteLength,
        sha256: "sha-api-2",
        provider: "upload",
        provider_recording_id: null,
        created_at: now
      })
      .execute();

    const { client } = createMockSpeechmaticsClient();
    const service = new TranscriptionService({
      db: handle.db,
      meetingsDir,
      speechmaticsClient: client,
      webhookSecret: "secret-test-123"
    });

    const app = createApp({
      db: handle.db,
      meetingsDir,
      transcriptionService: service,
      speechmaticsWebhookSecret: "secret-test-123"
    });

    // 1. Trigger transcription via POST /api/meetings/:id/transcribe
    const triggerRes = await app.request(`http://olive.test/api/meetings/${meetingId}/transcribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ poll: false })
    });
    expect(triggerRes.status).toBe(200);
    const triggerData = await triggerRes.json();
    expect(triggerData.status).toBe("running");
    expect(triggerData.jobId).toBe("sm-job-456");
    const stageRunId = triggerData.stageRunId;

    // 2. Webhook post from Speechmatics
    const webhookRes = await app.request(
      `http://olive.test/api/webhooks/speechmatics?meetingId=${meetingId}&stageRunId=${stageRunId}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer secret-test-123"
        },
        body: JSON.stringify(SAMPLE_JSON_V2)
      }
    );
    expect(webhookRes.status).toBe(200);
    const webhookData = await webhookRes.json();
    expect(webhookData.status).toBe("done");

    // 3. GET /api/meetings/:id should now have transcript content and artifacts
    const detailRes = await app.request(`http://olive.test/api/meetings/${meetingId}`);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    expect(detail.meeting.id).toBe(meetingId);
    expect(detail.artifacts).toHaveLength(2);
    expect(detail.speakers).toHaveLength(1);
    expect(detail.speakers[0].name).toBe("Alice");
    expect(detail.transcriptContent).toBeTruthy();
    expect(detail.transcriptContent).toContain("Welcome");

    await handle.db.destroy();
    handle.sqlite.close();
    await rm(meetingsDir, { recursive: true, force: true });
  });
});
