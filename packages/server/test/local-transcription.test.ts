import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { createDb } from "../src/db.ts";
import { meetingPaths } from "../src/layout.ts";
import {
  AcousticFeatureEmbeddingExtractor,
  cosineSimilarity,
  decodeWav,
  encodeWav,
  LocalSpeakerDiarizer,
  LocalTranscriptionPipeline,
  mergeVoiceprintVectors,
  MockLocalAsrEngine,
  normalizeVector,
  resample,
  updateVoiceprintCentroid
} from "../src/providers/local/index.ts";
import { SpeakerService } from "../src/speakers/service.ts";
import {
  PROVIDER_LOCAL,
  STAGE_LOCAL_TRANSCRIBE,
  TranscriptionService
} from "../src/transcription/service.ts";

/**
 * Helper to generate synthetic multi-speaker WAV test audio:
 * Speaker A (e.g. 200Hz tone), Pause, Speaker B (e.g. 600Hz tone).
 */
function createSyntheticMultiSpeakerWav(sampleRate = 16000): Uint8Array {
  // 1.0s of 220Hz (Speaker A) + 0.6s silence + 1.0s of 660Hz (Speaker B)
  const durationSec = 2.6;
  const numSamples = Math.floor(sampleRate * durationSec);
  const samples = new Float32Array(numSamples);

  // Speaker A: 0.0s to 1.0s (220 Hz)
  const endA = Math.floor(sampleRate * 1.0);
  for (let i = 0; i < endA; i++) {
    const t = i / sampleRate;
    samples[i] = 0.5 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 440 * t);
  }

  // Silence: 1.0s to 1.6s

  // Speaker B: 1.6s to 2.6s (660 Hz)
  const startB = Math.floor(sampleRate * 1.6);
  for (let i = startB; i < numSamples; i++) {
    const t = (i - startB) / sampleRate;
    samples[i] = 0.5 * Math.sin(2 * Math.PI * 660 * t) + 0.2 * Math.sin(2 * Math.PI * 1320 * t);
  }

  return encodeWav(samples, sampleRate);
}

function createSingleVoiceWav(freqHz = 220, durationSec = 1.2, sampleRate = 16000): Uint8Array {
  const numSamples = Math.floor(sampleRate * durationSec);
  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    samples[i] = 0.5 * Math.sin(2 * Math.PI * freqHz * t);
  }
  return encodeWav(samples, sampleRate);
}

describe("Local ASR, Diarization & Voiceprint Pipeline", () => {
  test("WAV codec roundtrip and resampling", () => {
    const original = new Float32Array([0, 0.5, 1.0, -0.5, -1.0, 0.25]);
    const encoded = encodeWav(original, 16000);
    const decoded = decodeWav(encoded);

    expect(decoded.sampleRate).toBe(16000);
    expect(decoded.channels).toBe(1);
    expect(decoded.samples.length).toBe(original.length);
    expect(Math.abs(decoded.samples[1] - 0.5)).toBeLessThan(0.01);

    // Resampling
    const resampled = resample(decoded.samples, 16000, 8000);
    expect(resampled.length).toBe(Math.round(original.length / 2));
  });

  test("Speaker embedding extractor, vector normalization, and cosine similarity", async () => {
    const extractor = new AcousticFeatureEmbeddingExtractor(192);

    const wavA1 = createSingleVoiceWav(220, 1.0);
    const wavA2 = createSingleVoiceWav(220, 1.0);
    const wavB = createSingleVoiceWav(660, 1.0);

    const embA1 = await extractor.extract(decodeWav(wavA1).samples, 16000);
    const embA2 = await extractor.extract(decodeWav(wavA2).samples, 16000);
    const embB = await extractor.extract(decodeWav(wavB).samples, 16000);

    expect(embA1.length).toBe(192);
    expect(embA2.length).toBe(192);
    expect(embB.length).toBe(192);

    // Intra-speaker similarity (same voice) should be high
    const simA = cosineSimilarity(embA1, embA2);
    expect(simA).toBeGreaterThan(0.90);

    // Inter-speaker similarity (different pitch/timbre) should be distinctly lower
    const simDiff = cosineSimilarity(embA1, embB);
    expect(simDiff).toBeLessThan(simA);

    // Dynamic centroid updating
    const updatedCentroid = updateVoiceprintCentroid(embA1, embA2, 0.85);
    expect(updatedCentroid.length).toBe(192);
    expect(cosineSimilarity(updatedCentroid, embA1)).toBeGreaterThan(0.95);

    // Merge multiple voiceprints
    const merged = mergeVoiceprintVectors([embA1, embA2]);
    expect(merged.length).toBe(192);
  });

  test("LocalSpeakerDiarizer splits audio into distinct speaker turns", async () => {
    const extractor = new AcousticFeatureEmbeddingExtractor(192);
    const diarizer = new LocalSpeakerDiarizer(extractor, {
      minSpeechDurationMs: 300,
      minSilenceDurationMs: 300,
      clusteringThreshold: 0.70
    });

    const multiSpeakerWav = createSyntheticMultiSpeakerWav(16000);
    const decoded = decodeWav(multiSpeakerWav);

    const segments = await diarizer.diarize(decoded.samples, 16000);

    expect(segments.length).toBe(2);
    expect(segments[0].speakerId).not.toBe(segments[1].speakerId);
    expect(segments[0].startMs).toBeLessThan(segments[0].endMs);
    expect(segments[1].startMs).toBeGreaterThanOrEqual(segments[0].endMs);
  });

  test("LocalTranscriptionPipeline transcribes with cross-recording speaker identification", async () => {
    const extractor = new AcousticFeatureEmbeddingExtractor(192);
    const diarizer = new LocalSpeakerDiarizer(extractor, {
      minSpeechDurationMs: 300,
      minSilenceDurationMs: 300
    });
    const asrEngine = new MockLocalAsrEngine([
      "Hello, this is Alice speaking.",
      "And this is Bob responding."
    ]);

    const pipeline = new LocalTranscriptionPipeline(
      { voiceprintConfig: { similarityThreshold: 0.65 } },
      diarizer,
      extractor,
      asrEngine
    );

    // Step 1: Pre-enroll Alice with 220Hz voiceprint
    const aliceVoiceWav = createSingleVoiceWav(220, 1.0);
    const aliceEmbedding = await extractor.extract(decodeWav(aliceVoiceWav).samples, 16000);

    const enrolledAlice = {
      id: "spk-alice-uuid",
      name: "Alice Smith",
      providerIds: {
        local: [JSON.stringify(aliceEmbedding)]
      }
    };

    // Step 2: Transcribe multi-speaker audio containing Alice (220Hz) and Bob (660Hz)
    const multiSpeakerWav = createSyntheticMultiSpeakerWav(16000);
    const result = await pipeline.transcribe({
      audioBytes: multiSpeakerWav,
      language: "en",
      enrolledSpeakers: [enrolledAlice]
    });

    expect(result.transcript.segments.length).toBe(2);

    // Turn 1 should be recognized as "Alice Smith"
    expect(result.transcript.segments[0].speaker).toBe("Alice Smith");
    expect(result.transcript.segments[0].text).toContain("Alice speaking");

    // Turn 2 should be a new un-enrolled speaker (e.g. "Speaker 2")
    expect(result.transcript.segments[1].speaker).toBe("Speaker 2");
    expect(result.transcript.segments[1].text).toContain("Bob responding");

    // Discovered speakers list includes Alice (updated centroid) and Speaker 2
    expect(result.discoveredSpeakers.length).toBe(2);
    const aliceDiscovered = result.discoveredSpeakers.find((s) => s.name === "Alice Smith");
    expect(aliceDiscovered?.isEnrolled).toBe(true);
    expect(aliceDiscovered?.voiceprint).toBeArray();
  });

  test("End-to-end meeting transcription using TranscriptionService with provider: local", async () => {
    const handle = createDb(":memory:");
    const meetingsDir = await mkdtemp(join(import.meta.dir, "local-transcribe-mtg-"));
    const now = 1_700_000_000_000;
    const meetingId = "m-local-test-1";

    const paths = meetingPaths(meetingsDir, now, "Architecture Discussion", meetingId);
    await mkdir(paths.audioDir, { recursive: true });

    const audioBytes = createSyntheticMultiSpeakerWav(16000);
    await writeFile(join(paths.folder, "audio/meeting.wav"), audioBytes);

    await handle.db
      .insertInto("meetings")
      .values({
        id: meetingId,
        title: "Architecture Discussion",
        start_time: now,
        end_time: now + 3000,
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
        id: "rec-local-1",
        meeting_id: meetingId,
        path: "audio/meeting.wav",
        mime: "audio/wav",
        duration_ms: 3000,
        size_bytes: audioBytes.byteLength,
        sha256: "fake-sha-local-wav",
        provider: "upload",
        provider_recording_id: null,
        created_at: now
      })
      .execute();

    const mockAsr = new MockLocalAsrEngine([
      "Let's review the local ASR engine.",
      "The voiceprint updates work seamlessly."
    ]);
    const localPipeline = new LocalTranscriptionPipeline({}, undefined, undefined, mockAsr);

    const service = new TranscriptionService({
      db: handle.db,
      meetingsDir,
      localPipeline,
      defaultProvider: "local",
      now: () => now + 1000
    });

    // 1. Transcribe meeting
    const result = await service.transcribeMeeting(meetingId, { provider: "local" });

    expect(result.status).toBe("done");
    expect(result.jobId).toStartWith("local-");
    expect(result.transcriptArtifactId).toBeTruthy();

    // 2. Check stage runs table
    const stageRun = await handle.db
      .selectFrom("stage_runs")
      .selectAll()
      .where("meeting_id", "=", meetingId)
      .where("stage", "=", STAGE_LOCAL_TRANSCRIBE)
      .executeTakeFirstOrThrow();
    expect(stageRun.status).toBe("done");

    // 3. Check artifacts created
    const artifacts = await handle.db
      .selectFrom("artifacts")
      .selectAll()
      .where("meeting_id", "=", meetingId)
      .execute();
    expect(artifacts).toHaveLength(2);
    expect(artifacts.map((a) => [a.provider, a.format])).toEqual([
      ["local", "json"],
      ["local", "txt"]
    ]);

    // 4. Verify disk files
    expect(existsSync(join(paths.folder, "transcripts/local.json"))).toBe(true);
    expect(existsSync(join(paths.folder, "transcripts/local.txt"))).toBe(true);
    const txtContent = await readFile(join(paths.folder, "transcripts/local.txt"), "utf8");
    expect(txtContent).toContain("Speaker 1: Let's review the local ASR engine.");
    expect(txtContent).toContain("Speaker 2: The voiceprint updates work seamlessly.");

    // 5. Verify speakers persisted with local voiceprint vectors
    const speakers = await handle.db.selectFrom("speakers").selectAll().execute();
    expect(speakers).toHaveLength(2);
    for (const spk of speakers) {
      const providerIds = JSON.parse(spk.provider_ids);
      expect(providerIds.local).toBeArray();
      expect(providerIds.local.length).toBeGreaterThan(0);
      const vec = JSON.parse(providerIds.local[0]);
      expect(vec).toBeArray();
      expect(vec.length).toBe(192);
    }

    const meetingSpeakers = await handle.db.selectFrom("meeting_speakers").selectAll().execute();
    expect(meetingSpeakers).toHaveLength(2);

    await handle.db.destroy();
    handle.sqlite.close();
    await rm(meetingsDir, { recursive: true, force: true });
  });

  test("SpeakerService enrolls local voiceprint and recognizes speaker in subsequent local transcription", async () => {
    const handle = createDb(":memory:");
    const configDir = await mkdtemp(join(import.meta.dir, "local-spk-cfg-"));
    const meetingsDir = await mkdtemp(join(import.meta.dir, "local-spk-mtg-"));
    const now = 1_700_000_000_000;

    const speakerService = new SpeakerService({
      db: handle.db,
      configDir,
      meetingsDir,
      now: () => now
    });

    // 1. Enroll "David" with local voice sample (220 Hz)
    const davidWav = createSingleVoiceWav(220, 1.2);
    const enrolled = await speakerService.enrollSpeaker({
      name: "David",
      audioBytes: davidWav,
      mime: "audio/wav",
      provider: "local",
      filename: "david.wav"
    });

    expect(enrolled.name).toBe("David");
    expect(enrolled.providerIds.local).toBeArray();
    expect(enrolled.providerIds.local!.length).toBeGreaterThan(0);

    // 2. Create a new meeting recording containing David's voice + another voice
    const meetingId = "m-david-mtg";
    const paths = meetingPaths(meetingsDir, now, "Sprint Standup", meetingId);
    await mkdir(paths.audioDir, { recursive: true });

    const multiSpeakerAudio = createSyntheticMultiSpeakerWav(16000);
    await writeFile(join(paths.folder, "audio/standup.wav"), multiSpeakerAudio);

    await handle.db
      .insertInto("meetings")
      .values({
        id: meetingId,
        title: "Sprint Standup",
        start_time: now,
        end_time: now + 3000,
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
        id: "rec-david-1",
        meeting_id: meetingId,
        path: "audio/standup.wav",
        mime: "audio/wav",
        duration_ms: 3000,
        size_bytes: multiSpeakerAudio.byteLength,
        sha256: "fake-sha-david-wav",
        provider: "upload",
        provider_recording_id: null,
        created_at: now
      })
      .execute();

    const mockAsr = new MockLocalAsrEngine([
      "Good morning team, David here.",
      "Thanks David, let's start."
    ]);
    const localPipeline = new LocalTranscriptionPipeline(
      { voiceprintConfig: { similarityThreshold: 0.65 } },
      undefined,
      undefined,
      mockAsr
    );

    const transcriptionService = new TranscriptionService({
      db: handle.db,
      meetingsDir,
      localPipeline,
      defaultProvider: "local",
      now: () => now + 500
    });

    // 3. Transcribe meeting
    const result = await transcriptionService.transcribeMeeting(meetingId, { provider: "local" });
    expect(result.status).toBe("done");

    const txtContent = await readFile(join(paths.folder, "transcripts/local.txt"), "utf8");
    expect(txtContent).toContain("David: Good morning team, David here.");

    // Check meeting speakers
    const meetingSpeakers = await handle.db
      .selectFrom("meeting_speakers")
      .selectAll()
      .where("meeting_id", "=", meetingId)
      .execute();
    expect(meetingSpeakers.some((ms) => ms.speaker_id === enrolled.id)).toBe(true);

    await handle.db.destroy();
    handle.sqlite.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(meetingsDir, { recursive: true, force: true });
  });

  test("API trigger: POST /api/meetings/:id/transcribe with provider: local", async () => {
    const handle = createDb(":memory:");
    const meetingsDir = await mkdtemp(join(import.meta.dir, "local-api-mtg-"));
    const now = 1_700_000_000_000;
    const meetingId = "m-api-local-test";

    const paths = meetingPaths(meetingsDir, now, "API Local Meeting", meetingId);
    await mkdir(paths.audioDir, { recursive: true });

    const audioBytes = createSyntheticMultiSpeakerWav(16000);
    await writeFile(join(paths.folder, "audio/test.wav"), audioBytes);

    await handle.db
      .insertInto("meetings")
      .values({
        id: meetingId,
        title: "API Local Meeting",
        start_time: now,
        end_time: now + 3000,
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
        id: "rec-api-local",
        meeting_id: meetingId,
        path: "audio/test.wav",
        mime: "audio/wav",
        duration_ms: 3000,
        size_bytes: audioBytes.byteLength,
        sha256: "fake-sha-api-local",
        provider: "upload",
        provider_recording_id: null,
        created_at: now
      })
      .execute();

    const mockAsr = new MockLocalAsrEngine(["Testing the local API endpoint."]);
    const localPipeline = new LocalTranscriptionPipeline({}, undefined, undefined, mockAsr);

    const transcriptionService = new TranscriptionService({
      db: handle.db,
      meetingsDir,
      localPipeline
    });

    const app = createApp({
      db: handle.db,
      meetingsDir,
      transcriptionService
    });

    const res = await app.request(`http://olive.test/api/meetings/${meetingId}/transcribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "local" })
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("done");
    expect(data.jobId).toStartWith("local-");

    const detailRes = await app.request(`http://olive.test/api/meetings/${meetingId}`);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    expect(detail.transcriptContent).toContain("Testing the local API endpoint.");

    await handle.db.destroy();
    handle.sqlite.close();
    await rm(meetingsDir, { recursive: true, force: true });
  });

  test("SpeakerService cross-fills both Speechmatics and Local voiceprints simultaneously on enroll", async () => {
    const handle = createDb(":memory:");
    const configDir = await mkdtemp(join(import.meta.dir, "crossfill-cfg-"));
    const now = 1_700_000_000_000;

    const mockSpeechmatics: any = {
      submitJob: async () => ({ id: "mock-sm-enroll-cross" }),
      getJob: async () => ({ status: "done" }),
      getTranscript: async () => ({
        format: "2.0",
        job: { id: "mock-sm-enroll-cross", duration: 1.0, lang: "en" },
        results: [],
        speakers: [{ label: "Elena", speaker_identifiers: ["sm-voice-id-elena-1"] }]
      }),
      deleteJob: async () => {}
    };

    const speakerService = new SpeakerService({
      db: handle.db,
      configDir,
      speechmaticsClient: mockSpeechmatics,
      now: () => now
    });

    const elenaWav = createSingleVoiceWav(330, 1.2);
    const speaker = await speakerService.enrollSpeaker({
      name: "Elena",
      audioBytes: elenaWav,
      mime: "audio/wav",
      provider: "both",
      filename: "elena.wav"
    });

    expect(speaker.name).toBe("Elena");
    // Verify Speechmatics voiceprint is present
    expect(speaker.providerIds.speechmatics).toEqual(["sm-voice-id-elena-1"]);
    // Verify Local voiceprint embedding is cross-filled and present
    expect(speaker.providerIds.local).toBeArray();
    expect(speaker.providerIds.local!.length).toBeGreaterThan(0);
    const vec = JSON.parse(speaker.providerIds.local![0]);
    expect(vec.length).toBe(192);

    await handle.db.destroy();
    handle.sqlite.close();
    await rm(configDir, { recursive: true, force: true });
  });

  test("SpeakerService backfills missing local voiceprints from stored enrollment audio clips on disk", async () => {
    const handle = createDb(":memory:");
    const configDir = await mkdtemp(join(import.meta.dir, "backfill-test-cfg-"));
    const now = 1_700_000_000_000;
    const speakerId = "spk-backfill-legacy";

    // Setup an existing speaker that only has Speechmatics ID, with audio clip on disk
    const clipFolder = join(configDir, "speakers", speakerId);
    await mkdir(clipFolder, { recursive: true });
    const clipWav = createSingleVoiceWav(440, 1.2);
    await writeFile(join(clipFolder, "legacy_clip.wav"), clipWav);

    await handle.db
      .insertInto("speakers")
      .values({
        id: speakerId,
        name: "Legacy Speaker",
        provider_ids: JSON.stringify({ speechmatics: ["sm-legacy-id-1"] }),
        enrolled_at: now,
        enrollment_clip_paths: JSON.stringify([`speakers/${speakerId}/legacy_clip.wav`]),
        created_at: now
      })
      .execute();

    const speakerService = new SpeakerService({
      db: handle.db,
      configDir,
      now: () => now + 1000
    });

    // Run backfill
    const result = await speakerService.backfillVoiceprints();
    expect(result.processed).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.speakers[0].name).toBe("Legacy Speaker");

    // Local voiceprint must now be extracted and stored
    expect(result.speakers[0].providerIds.local).toBeArray();
    expect(result.speakers[0].providerIds.local!.length).toBe(1);
    const vec = JSON.parse(result.speakers[0].providerIds.local![0]);
    expect(vec.length).toBe(192);
    // Speechmatics ID remains preserved
    expect(result.speakers[0].providerIds.speechmatics).toEqual(["sm-legacy-id-1"]);

    await handle.db.destroy();
    handle.sqlite.close();
    await rm(configDir, { recursive: true, force: true });
  });

  test("In-meeting reassignment extracts audio slice to adopt local voiceprint and updates disk clips", async () => {
    const handle = createDb(":memory:");
    const configDir = await mkdtemp(join(import.meta.dir, "reassign-voice-cfg-"));
    const meetingsDir = await mkdtemp(join(import.meta.dir, "reassign-voice-mtg-"));
    const now = 1_700_000_000_000;
    const meetingId = "m-reassign-voice";

    const paths = meetingPaths(meetingsDir, now, "Team Huddle", meetingId);
    await mkdir(paths.audioDir, { recursive: true });
    await mkdir(paths.transcriptsDir, { recursive: true });

    // Multi-speaker audio file
    const audioBytes = createSyntheticMultiSpeakerWav(16000);
    await writeFile(join(paths.folder, "audio/huddle.wav"), audioBytes);

    const initialTranscript = {
      segments: [
        { startMs: 0, endMs: 1000, speaker: "Speaker 1", text: "First speaker turn." },
        { startMs: 1600, endMs: 2600, speaker: "Speaker 2", text: "Second speaker turn." }
      ],
      language: "en",
      durationMs: 2600
    };
    await writeFile(
      join(paths.folder, "transcripts/local.json"),
      JSON.stringify(initialTranscript, null, 2),
      "utf8"
    );
    await writeFile(
      join(paths.folder, "transcripts/local.txt"),
      "Speaker 1: First speaker turn.\n\nSpeaker 2: Second speaker turn.",
      "utf8"
    );

    await handle.db
      .insertInto("meetings")
      .values({
        id: meetingId,
        title: "Team Huddle",
        start_time: now,
        end_time: now + 2600,
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
        id: "rec-huddle",
        meeting_id: meetingId,
        path: "audio/huddle.wav",
        mime: "audio/wav",
        duration_ms: 2600,
        size_bytes: audioBytes.byteLength,
        sha256: "fake-sha-huddle",
        provider: "upload",
        provider_recording_id: null,
        created_at: now
      })
      .execute();

    await handle.db
      .insertInto("artifacts")
      .values([
        {
          id: "art-local-json",
          meeting_id: meetingId,
          recording_id: "rec-huddle",
          kind: "transcript",
          provider: "local",
          format: "json",
          path: "transcripts/local.json",
          created_at: now
        }
      ])
      .execute();

    await handle.db
      .updateTable("meetings")
      .set({ primary_transcript_artifact_id: "art-local-json" })
      .where("id", "=", meetingId)
      .execute();

    const speakerService = new SpeakerService({
      db: handle.db,
      configDir,
      meetingsDir,
      now: () => now + 100
    });

    const reassignResult = await speakerService.reassignMeetingSpeaker({
      meetingId,
      fromLabel: "Speaker 1",
      toSpeakerName: "Jessica Alba",
      adoptVoiceprint: true
    });

    expect(reassignResult.speaker.name).toBe("Jessica Alba");
    expect(reassignResult.speaker.providerIds.local).toBeArray();
    expect(reassignResult.speaker.providerIds.local!.length).toBe(1);
    expect(reassignResult.speaker.enrollmentClipPaths.length).toBe(1);

    const savedClipPath = join(configDir, reassignResult.speaker.enrollmentClipPaths[0]);
    expect(existsSync(savedClipPath)).toBe(true);

    await handle.db.destroy();
    handle.sqlite.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(meetingsDir, { recursive: true, force: true });
  });
});
