import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { createDb, type DbHandle } from "../src/db.ts";
import { meetingPaths } from "../src/layout.ts";
import {
  encodeWav,
  LocalTranscriptionWorkerRunner
} from "../src/providers/local/index.ts";
import { TranscriptionService } from "../src/transcription/service.ts";

function createDummyWav(freqHz = 220, durationSec = 3.5, sampleRate = 16000): Uint8Array {
  const numSamples = Math.floor(sampleRate * durationSec);
  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    samples[i] = 0.4 * Math.sin(2 * Math.PI * freqHz * t);
  }
  return encodeWav(samples, sampleRate);
}

describe("LocalTranscriptionWorkerRunner and Background Concurrency", () => {
  let tempDir: string;
  let dbHandle: DbHandle;
  let runner: LocalTranscriptionWorkerRunner;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "olive-worker-test-"));
    dbHandle = createDb(":memory:");
    runner = new LocalTranscriptionWorkerRunner();
  });

  afterEach(async () => {
    runner.stop();
    try {
      dbHandle.sqlite.close(true);
    } catch {}
    await rm(tempDir, { recursive: true, force: true });
  });

  test("Worker runner transcribes audio in background thread and reports progress", async () => {
    const audioBytes = createDummyWav(260, 3.5);
    const audioPath = join(tempDir, "test.wav");
    await writeFile(audioPath, audioBytes);

    const progressUpdates: any[] = [];
    const result = await runner.transcribe({
      audioPath,
      onProgress: (update) => {
        progressUpdates.push(update);
      }
    });

    expect(result).toBeDefined();
    expect(result.transcript).toBeDefined();
    expect(Array.isArray(result.transcript.segments)).toBe(true);
    expect(result.transcript.segments.length).toBeGreaterThan(0);
    expect(progressUpdates.length).toBeGreaterThan(0);
  });

  test("Worker runner handles cancellation via AbortSignal", async () => {
    const audioBytes = createDummyWav(260, 4.0);
    const audioPath = join(tempDir, "cancel.wav");
    await writeFile(audioPath, audioBytes);

    const abortController = new AbortController();

    const transcribePromise = runner.transcribe({
      audioPath,
      signal: abortController.signal
    });

    // Abort after small delay
    setTimeout(() => {
      abortController.abort();
    }, 50);

    expect(transcribePromise).rejects.toThrow();
  });

  test("HTTP server stays responsive while transcription is running in background", async () => {
    const app = createApp({
      meetingsDir: tempDir,
      db: dbHandle.db,
      webRoot: "/tmp"
    });

    // 1. Seed meeting and recording
    const meetingId = "11111111-2222-3333-4444-555555555555";
    const recordingId = "22222222-3333-4444-5555-666666666666";
    const startTime = Date.now();
    const paths = meetingPaths(tempDir, startTime, "Non-Blocking Test Meeting", meetingId);
    await mkdir(paths.audioDir, { recursive: true });

    const audioBytes = createDummyWav(330, 4.0);
    await writeFile(join(paths.folder, "audio", "sample.wav"), audioBytes);

    await dbHandle.db
      .insertInto("meetings")
      .values({
        id: meetingId,
        title: "Non-Blocking Test Meeting",
        start_time: startTime,
        end_time: startTime + 4000,
        source: "upload",
        status: "processing",
        tags: JSON.stringify([]),
        primary_transcript_artifact_id: null,
        primary_summary_artifact_id: null,
        last_error: null,
        created_at: startTime,
        updated_at: startTime
      })
      .execute();

    await dbHandle.db
      .insertInto("recordings")
      .values({
        id: recordingId,
        meeting_id: meetingId,
        path: "audio/sample.wav",
        mime: "audio/wav",
        duration_ms: 4000,
        size_bytes: audioBytes.byteLength,
        sha256: "test-hash",
        provider: "upload",
        provider_recording_id: null,
        created_at: startTime
      })
      .execute();

    // 2. Start transcription asynchronously (simulating starting from phone)
    const transcriptionPromise = app.fetch(
      new Request(`http://localhost/api/meetings/${meetingId}/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "local" })
      })
    );

    // 3. Immediately test HTTP requests (simulating opening desktop browser while transcription runs)
    const startReqTime = performance.now();
    const meetingsRes = await app.fetch(new Request("http://localhost/api/meetings"));
    const activeRes = await app.fetch(new Request("http://localhost/api/transcriptions/active"));
    const endReqTime = performance.now();

    expect(meetingsRes.status).toBe(200);
    const meetingsData = (await meetingsRes.json()) as any;
    expect(Array.isArray(meetingsData.meetings)).toBe(true);

    expect(activeRes.status).toBe(200);

    // Verify response took < 200ms without being blocked by transcription
    expect(endReqTime - startReqTime).toBeLessThan(200);

    const transcribeRes = await transcriptionPromise;
    expect(transcribeRes.status).toBe(200);
  });
});
