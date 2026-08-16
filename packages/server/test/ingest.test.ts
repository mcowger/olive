import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { createDb } from "../src/db.ts";
import { IngestService } from "../src/ingest/service.ts";
import { meetingPaths } from "../src/layout.ts";

const SAMPLE_AUDIO = new TextEncoder().encode("arbitrary sample audio bytes for testing");

describe("Audio Ingest Pipeline & Audio Streaming", () => {
  test("ingests arbitrary audio file, persists to disk and DB, and deduplicates identical uploads", async () => {
    const handle = createDb(":memory:");
    const meetingsDir = await mkdtemp(join(import.meta.dir, "ingest-test-"));
    const now = 1_700_000_000_000;

    const ingestService = new IngestService({
      db: handle.db,
      meetingsDir,
      now: () => now
    });

    const app = createApp({
      db: handle.db,
      meetingsDir,
      ingestService
    });

    // 1. Initial Upload
    const formData = new FormData();
    formData.append("file", new Blob([SAMPLE_AUDIO], { type: "audio/mp4" }), "interview.m4a");
    formData.append("title", "Job Candidate Interview");

    const uploadRes = await app.request("http://olive.test/api/ingest", {
      method: "POST",
      body: formData
    });

    expect(uploadRes.status).toBe(201);
    const uploadData = await uploadRes.json();
    expect(uploadData.deduped).toBe(false);
    expect(uploadData.meeting.title).toBe("Job Candidate Interview");
    expect(uploadData.meeting.source).toBe("upload");
    const meetingId = uploadData.meetingId;

    const meetings = await handle.db.selectFrom("meetings").selectAll().execute();
    const recordings = await handle.db.selectFrom("recordings").selectAll().execute();
    expect(meetings).toHaveLength(1);
    expect(recordings).toHaveLength(1);
    expect(recordings[0].mime).toBe("audio/mp4");

    const paths = meetingPaths(meetingsDir, now, "Job Candidate Interview", meetingId);
    const audioDiskPath = join(paths.folder, uploadData.audioPath);
    expect(existsSync(audioDiskPath)).toBe(true);
    expect(new Uint8Array(await readFile(audioDiskPath))).toEqual(SAMPLE_AUDIO);

    // 2. Deduplication on identical upload
    const secondFormData = new FormData();
    secondFormData.append("file", new Blob([SAMPLE_AUDIO], { type: "audio/mp4" }), "duplicate.m4a");

    const secondRes = await app.request("http://olive.test/api/ingest", {
      method: "POST",
      body: secondFormData
    });

    expect(secondRes.status).toBe(200);
    const secondData = await secondRes.json();
    expect(secondData.deduped).toBe(true);
    expect(secondData.meetingId).toBe(meetingId);

    // Still exactly 1 meeting and 1 recording in DB
    expect(await handle.db.selectFrom("meetings").selectAll().execute()).toHaveLength(1);
    expect(await handle.db.selectFrom("recordings").selectAll().execute()).toHaveLength(1);

    // 3. Audio streaming endpoint GET /api/meetings/:id/audio
    const audioStreamRes = await app.request(`http://olive.test/api/meetings/${meetingId}/audio`);
    expect(audioStreamRes.status).toBe(200);
    expect(audioStreamRes.headers.get("content-type")).toBe("audio/mp4");
    expect(audioStreamRes.headers.get("accept-ranges")).toBe("bytes");
    const receivedBytes = new Uint8Array(await audioStreamRes.arrayBuffer());
    expect(receivedBytes).toEqual(SAMPLE_AUDIO);

    // 4. Range request support (seeking)
    const rangeRes = await app.request(`http://olive.test/api/meetings/${meetingId}/audio`, {
      headers: { range: "bytes=0-9" }
    });
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get("content-range")).toContain("bytes 0-9/");
    const partialBytes = new Uint8Array(await rangeRes.arrayBuffer());
    expect(partialBytes).toEqual(SAMPLE_AUDIO.slice(0, 10));

    await handle.db.destroy();
    handle.sqlite.close();
    await rm(meetingsDir, { recursive: true, force: true });
  });

  test("enforces ingest token authentication when configured and identifies iOS Shortcut source", async () => {
    const handle = createDb(":memory:");
    const meetingsDir = await mkdtemp(join(import.meta.dir, "ingest-auth-test-"));
    const now = 1_700_000_000_000;

    const ingestService = new IngestService({
      db: handle.db,
      meetingsDir,
      now: () => now
    });

    const app = createApp({
      db: handle.db,
      meetingsDir,
      ingestService,
      ingestToken: "secret-token-xyz"
    });

    const formData = new FormData();
    formData.append("file", new Blob([SAMPLE_AUDIO], { type: "audio/x-m4a" }), "memo.m4a");

    // Missing token
    const unauthRes = await app.request("http://olive.test/api/ingest", {
      method: "POST",
      body: formData
    });
    expect(unauthRes.status).toBe(401);

    // Authorized upload with iOS Shortcut User-Agent
    const authFormData = new FormData();
    authFormData.append("file", new Blob([SAMPLE_AUDIO], { type: "audio/x-m4a" }), "memo.m4a");

    const authRes = await app.request("http://olive.test/api/ingest", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token-xyz",
        "User-Agent": "Shortcuts/1145.1.1 (iPhone; iOS 17.5)"
      },
      body: authFormData
    });

    expect(authRes.status).toBe(201);
    const data = await authRes.json();
    expect(data.meeting.source).toBe("ios-shortcut");

    await handle.db.destroy();
    handle.sqlite.close();
    await rm(meetingsDir, { recursive: true, force: true });
  });
});
