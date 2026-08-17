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
import { encodeWav } from "../src/providers/local/wav.ts";

const AUDIO_BYTES = encodeWav(new Float32Array(16000 * 4));

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
    expect(new Uint8Array(await readFile(clipDiskPath)).byteLength).toBe(AUDIO_BYTES.byteLength);
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

  test("coalesces sequential same-speaker turns and prunes placeholder speakers", async () => {
    const handle = createDb(":memory:");
    const configDir = await mkdtemp(join(import.meta.dir, "speaker-test-config-2-"));
    const meetingsDir = await mkdtemp(join(import.meta.dir, "speaker-test-meetings-2-"));
    const now = 1_700_000_000_000;

    const meetingId = "m-coalesce-test";
    const artifactId = "art-trans-1";
    const placeholderSpeakerId1 = "sp-1";
    const placeholderSpeakerId3 = "sp-3";
    const speaker2Id = "sp-2";

    await handle.db
      .insertInto("meetings")
      .values({
        id: meetingId,
        title: "Coalescing & Pruning Test",
        start_time: now,
        end_time: now + 60000,
        source: "upload",
        status: "ready",
        tags: "[]",
        primary_transcript_artifact_id: null,
        created_at: now,
        updated_at: now
      })
      .execute();

    await handle.db
      .insertInto("artifacts")
      .values({
        id: artifactId,
        meeting_id: meetingId,
        kind: "transcript",
        provider: "local",
        format: "json",
        path: "transcripts/local.json",
        created_at: now
      })
      .execute();

    await handle.db
      .updateTable("meetings")
      .set({ primary_transcript_artifact_id: artifactId })
      .where("id", "=", meetingId)
      .execute();

    await handle.db
      .insertInto("speakers")
      .values([
        {
          id: placeholderSpeakerId1,
          name: "Speaker 1",
          provider_ids: "{}",
          enrolled_at: null,
          enrollment_clip_paths: "[]",
          created_at: now
        },
        {
          id: placeholderSpeakerId3,
          name: "Speaker 3",
          provider_ids: "{}",
          enrolled_at: null,
          enrollment_clip_paths: "[]",
          created_at: now
        },
        {
          id: speaker2Id,
          name: "Speaker 2",
          provider_ids: "{}",
          enrolled_at: null,
          enrollment_clip_paths: "[]",
          created_at: now
        }
      ])
      .execute();

    await handle.db
      .insertInto("meeting_speakers")
      .values([
        { meeting_id: meetingId, speaker_id: placeholderSpeakerId1, evidence_artifact_id: artifactId },
        { meeting_id: meetingId, speaker_id: placeholderSpeakerId3, evidence_artifact_id: artifactId },
        { meeting_id: meetingId, speaker_id: speaker2Id, evidence_artifact_id: artifactId }
      ])
      .execute();

    const paths = meetingPaths(meetingsDir, now, "Coalescing & Pruning Test", meetingId);
    await mkdir(join(paths.folder, "transcripts"), { recursive: true });

    // Initial transcript with Speaker 1, Speaker 2, and Speaker 3
    const transcriptData = {
      language: "en",
      segments: [
        { startMs: 0, endMs: 2000, speaker: "Speaker 1", text: "It's weird." },
        { startMs: 3000, endMs: 4500, speaker: "Speaker 2", text: "strategic stuff." },
        { startMs: 5000, endMs: 8000, speaker: "Speaker 1", text: "Is that a reasonable statement?" },
        { startMs: 8500, endMs: 11000, speaker: "Speaker 3", text: "Okay, I got a weird strategic stuff for you." },
        { startMs: 11500, endMs: 14000, speaker: "Speaker 1", text: "I was just talking to Colin." }
      ]
    };

    await writeFile(join(paths.folder, "transcripts/local.json"), JSON.stringify(transcriptData, null, 2), "utf8");

    const service = new SpeakerService({
      db: handle.db,
      configDir,
      meetingsDir,
      now: () => now + 100
    });

    const app = createApp({
      db: handle.db,
      configDir,
      meetingsDir,
      speakerService: service
    });

    // 1. Reassign Speaker 1 to "Matt Cowger"
    const res1 = await app.request(`http://olive.test/api/meetings/${meetingId}/speakers/reassign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fromLabel: "Speaker 1",
        toSpeakerName: "Matt Cowger",
        adoptVoiceprint: false
      })
    });
    if (res1.status !== 200) {
      console.log("res1 error:", await res1.text());
    }
    expect(res1.status).toBe(200);

    // 2. Reassign Speaker 3 to "Matt Cowger"
    const res2 = await app.request(`http://olive.test/api/meetings/${meetingId}/speakers/reassign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fromLabel: "Speaker 3",
        toSpeakerName: "Matt Cowger",
        adoptVoiceprint: false
      })
    });
    if (res2.status !== 200) {
      console.log("res2 error:", await res2.text());
    }
    expect(res2.status).toBe(200);

    // Verify transcript segments were coalesced:
    // Segments 2, 3, 4 were all assigned to "Matt Cowger" and should now be 1 segment!
    const updatedJson = JSON.parse(await readFile(join(paths.folder, "transcripts/local.json"), "utf8"));
    expect(updatedJson.segments).toHaveLength(3);
    expect(updatedJson.segments[0].speaker).toBe("Matt Cowger");
    expect(updatedJson.segments[0].text).toBe("It's weird.");
    expect(updatedJson.segments[1].speaker).toBe("Speaker 2");
    expect(updatedJson.segments[1].text).toBe("strategic stuff.");
    expect(updatedJson.segments[2].speaker).toBe("Matt Cowger");
    expect(updatedJson.segments[2].text).toBe(
      "Is that a reasonable statement? Okay, I got a weird strategic stuff for you. I was just talking to Colin."
    );

    // Verify Speaker 1 and Speaker 3 were pruned from meeting_speakers and deleted from speakers table
    const meetingSpeakers = await handle.db.selectFrom("meeting_speakers").selectAll().where("meeting_id", "=", meetingId).execute();
    expect(meetingSpeakers).toHaveLength(2); // Only Matt Cowger and Speaker 2

    const remainingSpeakers = await service.listSpeakers();
    const names = remainingSpeakers.map((s) => s.name);
    expect(names).toContain("Matt Cowger");
    expect(names).toContain("Speaker 2");
    expect(names).not.toContain("Speaker 1");
    expect(names).not.toContain("Speaker 3");

    // Verify GET /api/meetings/:id returns only active speakers
    const meetingRes = await app.request(`http://olive.test/api/meetings/${meetingId}`);
    expect(meetingRes.status).toBe(200);
    const meetingDetail = await meetingRes.json();
    const detailSpeakerNames = meetingDetail.speakers.map((s: any) => s.name);
    expect(detailSpeakerNames).toHaveLength(2);
    expect(detailSpeakerNames).toContain("Matt Cowger");
    expect(detailSpeakerNames).toContain("Speaker 2");
    expect(detailSpeakerNames).not.toContain("Speaker 1");
    expect(detailSpeakerNames).not.toContain("Speaker 3");

    await handle.db.destroy();
    handle.sqlite.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(meetingsDir, { recursive: true, force: true });
  });

  test("enforces Protected Anchor + Diversity Cap (max 8 clips) on segment confirmation", async () => {
    const handle = createDb(":memory:");
    const configDir = await mkdtemp(join(import.meta.dir, "speaker-cap-cfg-"));
    const meetingsDir = await mkdtemp(join(import.meta.dir, "speaker-cap-mtg-"));
    let now = 1_700_000_000_000;
    const meetingId = "m-cap-test";

    const service = new SpeakerService({
      db: handle.db,
      configDir,
      meetingsDir,
      now: () => now++
    });

    // 1. Initial Anchor Enrollment for Alice (4.0s voice tone)
    const numSamples = 16000 * 4;
    const anchorSamples = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      const t = i / 16000;
      anchorSamples[i] = 0.5 * Math.sin(2 * Math.PI * 220 * t) + 0.25 * Math.sin(2 * Math.PI * 440 * t) + 0.1 * Math.sin(2 * Math.PI * 660 * t);
    }
    const anchorWav = encodeWav(anchorSamples, 16000);

    const initialSpeaker = await service.enrollSpeaker({
      name: "Alice",
      audioBytes: anchorWav,
      provider: "local"
    });

    expect(initialSpeaker.enrollmentClipPaths).toHaveLength(1);
    const anchorPath = initialSpeaker.enrollmentClipPaths[0];

    // 2. Set up a meeting recording with 12 segments of 4.0s each (same voice with subtle acoustic variation)
    const totalSec = 60;
    const meetingSamples = new Float32Array(16000 * totalSec);
    for (let i = 0; i < meetingSamples.length; i++) {
      const t = i / 16000;
      const segIdx = Math.floor(t / 4.5);
      // Variations in pitch and formants to simulate natural continuous speech
      const baseFreq = 220 + ((segIdx + 1) * 3.5);
      const harmonic2 = 0.25 + ((segIdx + 1) * 0.03);
      const harmonic3 = 0.08 + ((segIdx + 1) * 0.015);
      meetingSamples[i] = 0.5 * Math.sin(2 * Math.PI * baseFreq * t) + harmonic2 * Math.sin(2 * Math.PI * (baseFreq * 2) * t) + harmonic3 * Math.sin(2 * Math.PI * (baseFreq * 3) * t);
    }
    const meetingWav = encodeWav(meetingSamples, 16000);

    const paths = meetingPaths(meetingsDir, 1_700_000_000_000, "Cap Test Meeting", meetingId);
    await mkdir(paths.audioDir, { recursive: true });
    await mkdir(paths.transcriptsDir, { recursive: true });
    await writeFile(join(paths.folder, "audio/meeting.wav"), meetingWav);

    const segments = [];
    for (let i = 0; i < 10; i++) {
      segments.push({
        startMs: i * 4500,
        endMs: i * 4500 + 4000,
        speaker: "Speaker 1",
        text: `Segment ${i}`
      });
    }

    const transcriptData = { language: "en", durationMs: totalSec * 1000, segments };
    await writeFile(join(paths.folder, "transcripts/local.json"), JSON.stringify(transcriptData, null, 2), "utf8");
    await writeFile(join(paths.folder, "transcripts/local.txt"), "Transcript content", "utf8");

    await handle.db
      .insertInto("meetings")
      .values({
        id: meetingId,
        title: "Cap Test Meeting",
        start_time: 1_700_000_000_000,
        end_time: 1_700_000_000_000 + totalSec * 1000,
        source: "upload",
        status: "ready",
        tags: "[]",
        primary_transcript_artifact_id: null,
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000
      })
      .execute();

    await handle.db
      .insertInto("recordings")
      .values({
        id: "rec-cap-1",
        meeting_id: meetingId,
        path: "audio/meeting.wav",
        mime: "audio/wav",
        duration_ms: totalSec * 1000,
        size_bytes: meetingWav.byteLength,
        sha256: "fake-sha-cap",
        provider: "upload",
        provider_recording_id: null,
        created_at: 1_700_000_000_000
      })
      .execute();

    await handle.db
      .insertInto("artifacts")
      .values([
        {
          id: "art-cap-json",
          meeting_id: meetingId,
          recording_id: "rec-cap-1",
          kind: "transcript",
          provider: "local",
          format: "json",
          path: "transcripts/local.json",
          created_at: 1_700_000_000_000
        },
        {
          id: "art-cap-txt",
          meeting_id: meetingId,
          recording_id: "rec-cap-1",
          kind: "transcript",
          provider: "local",
          format: "txt",
          path: "transcripts/local.txt",
          created_at: 1_700_000_000_000
        }
      ])
      .execute();

    await handle.db
      .updateTable("meetings")
      .set({ primary_transcript_artifact_id: "art-cap-json" })
      .where("id", "=", meetingId)
      .execute();

    // 3. Confirm segments 0 through 6 (which brings total clips to 8 = 1 anchor + 7 confirmed)
    for (let i = 0; i < 7; i++) {
      const res = await service.confirmMeetingSegmentSpeaker({
        meetingId,
        segmentIndex: i,
        speakerId: initialSpeaker.id
      });
      expect(res.voiceprintEnrolled).toBe(true);
      expect(res.voiceprintStatus).toBe("enrolled");
    }

    let updatedSpeaker = (await service.getSpeaker(initialSpeaker.id))!.speaker;
    expect(updatedSpeaker.enrollmentClipPaths).toHaveLength(8);
    expect(updatedSpeaker.enrollmentClipPaths[0]).toBe(anchorPath); // Anchor preserved
    const clip1Path = updatedSpeaker.enrollmentClipPaths[1];

    // 4. Confirm segment 7 (9th total sample) -> Cap of 8 reached: oldest non-anchor clip (clip 1) is evicted
    const res8 = await service.confirmMeetingSegmentSpeaker({
      meetingId,
      segmentIndex: 7,
      speakerId: initialSpeaker.id
    });

    expect(res8.voiceprintEnrolled).toBe(true);
    expect(res8.voiceprintStatus).toBe("enrolled_evicted");

    updatedSpeaker = (await service.getSpeaker(initialSpeaker.id))!.speaker;
    expect(updatedSpeaker.enrollmentClipPaths).toHaveLength(8);
    expect(updatedSpeaker.enrollmentClipPaths[0]).toBe(anchorPath); // Anchor MUST still be index 0
    expect(updatedSpeaker.enrollmentClipPaths).not.toContain(clip1Path); // Oldest non-anchor clip was evicted
    expect(existsSync(join(configDir, clip1Path))).toBe(false); // Evicted file was unlinked from disk

    // 5. Test duration gating: confirm short segment (< 3.0s)
    const shortSegIdx = 8;
    transcriptData.segments[shortSegIdx] = {
      startMs: 36000,
      endMs: 37500, // 1.5s duration
      speaker: "Speaker 1",
      text: "Too short segment"
    };
    await writeFile(join(paths.folder, "transcripts/local.json"), JSON.stringify(transcriptData, null, 2), "utf8");

    const shortRes = await service.confirmMeetingSegmentSpeaker({
      meetingId,
      segmentIndex: shortSegIdx,
      speakerId: initialSpeaker.id
    });
    expect(shortRes.voiceprintEnrolled).toBe(false);
    expect(shortRes.voiceprintStatus).toBe("duration_skipped");
    expect(shortRes.transcript.segments[shortSegIdx].verified).toBe(true); // Transcript verified anyway

    // 6. Test redundancy check: re-confirming identical audio slice is skipped as redundant
    const redundantRes = await service.confirmMeetingSegmentSpeaker({
      meetingId,
      segmentIndex: 7, // exact same segment as confirmed above in step 4
      speakerId: initialSpeaker.id
    });
    expect(redundantRes.voiceprintEnrolled).toBe(false);
    expect(redundantRes.voiceprintStatus).toBe("redundant_skipped");

    // 7. Test rebuildSpeakerProfiles prunes oversized profiles to 8 clips and cleans disk
    // Manually add dummy clips to test pruning
    const dummyClips = [...updatedSpeaker.enrollmentClipPaths];
    for (let d = 0; d < 5; d++) {
      const dummyRel = `speakers/${initialSpeaker.id}/dummy_${d}.wav`;
      await writeFile(join(configDir, dummyRel), anchorWav);
      dummyClips.push(dummyRel);
    }
    await handle.db
      .updateTable("speakers")
      .set({ enrollment_clip_paths: JSON.stringify(dummyClips) })
      .where("id", "=", initialSpeaker.id)
      .execute();

    const rebuildResult = await service.rebuildSpeakerProfiles({ speakerId: initialSpeaker.id });
    expect(rebuildResult.cleanedClipsCount).toBeGreaterThanOrEqual(5);
    expect(rebuildResult.retainedClipsCount).toBe(8);

    const postRebuildSpeaker = (await service.getSpeaker(initialSpeaker.id))!.speaker;
    expect(postRebuildSpeaker.enrollmentClipPaths).toHaveLength(8);
    expect(postRebuildSpeaker.enrollmentClipPaths[0]).toBe(anchorPath);

    await handle.db.destroy();
    handle.sqlite.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(meetingsDir, { recursive: true, force: true });
  });
});
