import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { createDb } from "../src/db.ts";
import { meetingPaths } from "../src/layout.ts";
import { SpeechmaticsClient } from "../src/providers/speechmatics/client.ts";
import type { SpeechmaticsJsonV2 } from "../src/providers/speechmatics/types.ts";
import { SpeakerService } from "../src/speakers/service.ts";

const AUDIO_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

const ENROLL_JSON_V2: SpeechmaticsJsonV2 = {
  format: "2.0",
  job: {
    id: "sm-enroll-1",
    duration: 3.0,
    lang: "en"
  },
  results: [
    {
      type: "word",
      start_time: 0.1,
      end_time: 2.0,
      alternatives: [{ content: "Hello", confidence: 0.99, speaker: "S1" }]
    }
  ],
  speakers: [
    { label: "S1", speaker_identifiers: ["voice-id-alpha", "voice-id-beta"] }
  ]
};

function createMockSpeechmaticsClient(jsonV2: SpeechmaticsJsonV2 = ENROLL_JSON_V2) {
  let deletedId = "";

  const mockBatchClient: any = {
    createTranscriptionJob: async () => ({ id: "sm-enroll-1" }),
    getJob: async (id: string) => ({
      job: {
        id,
        status: "done",
        created_at: "2026-08-16T12:00:00Z",
        data_name: "clip.wav",
        duration: 3.0
      }
    }),
    getJobResult: async (_id: string, format?: string) => {
      if (format === "json-v2") {
        return jsonV2;
      }
      return "Hello";
    },
    deleteJob: async (id: string) => {
      deletedId = id;
      return { job: { id, status: "deleted", created_at: "", data_name: "" } };
    }
  };

  const client = new SpeechmaticsClient({
    apiKey: "test-key",
    batchClient: mockBatchClient
  });

  return { client, getDeletedId: () => deletedId };
}

describe("SpeakerService & Speaker Registry", () => {
  test("enrolls a speaker, extracts Speechmatics voiceprint identifiers, and saves audio clip", async () => {
    const handle = createDb(":memory:");
    const configDir = await mkdtemp(join(import.meta.dir, "speaker-test-config-"));
    const now = 1_700_000_000_000;

    const { client, getDeletedId } = createMockSpeechmaticsClient();
    const service = new SpeakerService({
      db: handle.db,
      configDir,
      speechmaticsClient: client,
      now: () => now
    });

    const speaker = await service.enrollSpeaker({
      name: "Matt",
      audioBytes: AUDIO_BYTES,
      mime: "audio/wav",
      filename: "matt-intro.wav",
      pollIntervalMs: 10
    });

    expect(speaker.name).toBe("Matt");
    expect(speaker.enrolledAt).toBe(now);
    expect(speaker.providerIds.speechmatics).toEqual(["voice-id-alpha", "voice-id-beta"]);
    expect(speaker.enrollmentClipPaths).toHaveLength(1);

    const clipDiskPath = join(configDir, speaker.enrollmentClipPaths[0]);
    expect(existsSync(clipDiskPath)).toBe(true);
    expect(new Uint8Array(await readFile(clipDiskPath))).toEqual(AUDIO_BYTES);
    expect(getDeletedId()).toBe("sm-enroll-1");

    const listed = await service.listSpeakers();
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe("Matt");
    expect(listed[0].meetingCount).toBe(0);

    await handle.db.destroy();
    handle.sqlite.close();
    await rm(configDir, { recursive: true, force: true });
  });

  test("in-meeting speaker reassignment updates transcript and adopts voiceprint", async () => {
    const handle = createDb(":memory:");
    const configDir = await mkdtemp(join(import.meta.dir, "speaker-reassign-cfg-"));
    const meetingsDir = await mkdtemp(join(import.meta.dir, "speaker-reassign-mtg-"));
    const now = 1_700_000_000_000;
    const meetingId = "m-reassign-1";

    const paths = meetingPaths(meetingsDir, now, "Planning Sync", meetingId);
    await mkdir(paths.transcriptsDir, { recursive: true });

    // Initial transcript on disk with S1 and S2
    const initialTranscript = {
      segments: [
        { startMs: 0, endMs: 2000, speaker: "S1", text: "Let's review the architecture." },
        { startMs: 2500, endMs: 5000, speaker: "S2", text: "Looks great to me." },
        { startMs: 5500, endMs: 8000, speaker: "S1", text: "Let's ship it." }
      ],
      language: "en",
      durationMs: 8000,
      speakers: [
        { label: "S1", speaker_identifiers: ["voiceprint-matt-1", "voiceprint-matt-2"] },
        { label: "S2", speaker_identifiers: ["voiceprint-other-1"] }
      ]
    };

    await writeFile(
      join(paths.folder, "transcripts/speechmatics.json"),
      JSON.stringify(initialTranscript, null, 2),
      "utf8"
    );
    await writeFile(
      join(paths.folder, "transcripts/speechmatics.txt"),
      "S1: Let's review the architecture.\n\nS2: Looks great to me.\n\nS1: Let's ship it.",
      "utf8"
    );

    await handle.db
      .insertInto("meetings")
      .values({
        id: meetingId,
        title: "Planning Sync",
        start_time: now,
        end_time: now + 8000,
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
      .insertInto("artifacts")
      .values([
        {
          id: "art-sm-json",
          meeting_id: meetingId,
          recording_id: null,
          kind: "transcript",
          provider: "speechmatics",
          format: "json",
          path: "transcripts/speechmatics.json",
          created_at: now
        },
        {
          id: "art-sm-txt",
          meeting_id: meetingId,
          recording_id: null,
          kind: "transcript",
          provider: "speechmatics",
          format: "txt",
          path: "transcripts/speechmatics.txt",
          created_at: now
        }
      ])
      .execute();

    await handle.db
      .updateTable("meetings")
      .set({ primary_transcript_artifact_id: "art-sm-json" })
      .where("id", "=", meetingId)
      .execute();

    const { client } = createMockSpeechmaticsClient();
    const service = new SpeakerService({
      db: handle.db,
      configDir,
      meetingsDir,
      speechmaticsClient: client,
      now: () => now + 100
    });

    const app = createApp({
      db: handle.db,
      configDir,
      meetingsDir,
      speakerService: service
    });

    // Reassign S1 to Matt Cowger in meeting
    const reassignRes = await app.request(`http://olive.test/api/meetings/${meetingId}/speakers/reassign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fromLabel: "S1",
        toSpeakerName: "Matt Cowger",
        adoptVoiceprint: true
      })
    });

    expect(reassignRes.status).toBe(200);
    const result = await reassignRes.json();
    expect(result.speaker.name).toBe("Matt Cowger");
    expect(result.updatedSegmentsCount).toBe(2);
    expect(result.extractedVoiceprintsCount).toBe(2);
    expect(result.speaker.providerIds.speechmatics).toEqual(["voiceprint-matt-1", "voiceprint-matt-2"]);

    // Verify disk files were updated
    const updatedTxt = await readFile(join(paths.folder, "transcripts/speechmatics.txt"), "utf8");
    expect(updatedTxt).toContain("Matt Cowger: Let's review the architecture.");
    expect(updatedTxt).toContain("Matt Cowger: Let's ship it.");
    expect(updatedTxt).toContain("S2: Looks great to me.");

    const updatedJson = JSON.parse(await readFile(join(paths.folder, "transcripts/speechmatics.json"), "utf8"));
    expect(updatedJson.segments[0].speaker).toBe("Matt Cowger");
    expect(updatedJson.segments[2].speaker).toBe("Matt Cowger");
    expect(updatedJson.segments[1].speaker).toBe("S2");

    // Verify meeting_speakers link
    const meetingSpeakers = await handle.db.selectFrom("meeting_speakers").selectAll().execute();
    expect(meetingSpeakers).toHaveLength(1);
    expect(meetingSpeakers[0].speaker_id).toBe(result.speaker.id);

    // Test merging speakers
    const secondSpeaker = await service.enrollSpeaker({
      name: "Matthew C.",
      audioBytes: AUDIO_BYTES
    });

    const mergeRes = await app.request("http://olive.test/api/speakers/merge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceSpeakerId: secondSpeaker.id,
        targetSpeakerId: result.speaker.id
      })
    });
    expect(mergeRes.status).toBe(200);
    const mergedData = await mergeRes.json();
    expect(mergedData.speaker.id).toBe(result.speaker.id);
    expect(mergedData.speaker.providerIds.speechmatics).toContain("voiceprint-matt-1");

    const allSpeakers = await service.listSpeakers();
    expect(allSpeakers).toHaveLength(1);
    expect(allSpeakers[0].name).toBe("Matt Cowger");

    await handle.db.destroy();
    handle.sqlite.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(meetingsDir, { recursive: true, force: true });
  });
});
