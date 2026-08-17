import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { createDb } from "../src/db.ts";
import { meetingPaths } from "../src/layout.ts";
import {
  cosineSimilarity,
  decodeWav,
  encodeWav,
  loadAudioSamples,
  LocalSpeakerDiarizer,
  LocalTranscriptionPipeline,
  mergeVoiceprintVectors,
  mergeWeightedVoiceprintVectors,
  MockLocalAsrEngine,
  normalizeVector,
  resample,
  scoreAgainstTrustedVectors,
  SherpaSpeakerDiarizer,
  SherpaSpeakerEmbeddingExtractor,
  updateVoiceprintCentroid
} from "../src/providers/local/index.ts";
import { SpeakerService } from "../src/speakers/service.ts";
import {
  PROVIDER_LOCAL,
  STAGE_LOCAL_TRANSCRIBE,
  TranscriptionService
} from "../src/transcription/service.ts";

const FIXTURE_MULTI_SPEAKER_PATH = join(import.meta.dir, "fixtures/audio/sample-multi-speaker.wav");
const FIXTURE_SPEECHMATICS_PATH = join(import.meta.dir, "fixtures/audio/speechmatics-sample.wav");

function createSingleVoiceWav(freqHz = 220, durationSec = 4.0, sampleRate = 16000): Uint8Array {
  const numSamples = Math.floor(sampleRate * durationSec);
  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    samples[i] = 0.5 * Math.sin(2 * Math.PI * freqHz * t) + 0.2 * Math.sin(2 * Math.PI * (freqHz * 2) * t);
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

  test("Sherpa neural speaker embedding extractor and separation metric gate (>0.25)", async () => {
    const extractor = new SherpaSpeakerEmbeddingExtractor();

    const bufSm = new Uint8Array(await readFile(FIXTURE_SPEECHMATICS_PATH));
    const bufMulti = new Uint8Array(await readFile(FIXTURE_MULTI_SPEAKER_PATH));

    const decSm = decodeWav(bufSm);
    const decMulti = decodeWav(bufMulti);
    const sr = 16000;

    // Two distinct slices from Speaker 1 (Speechmatics sample: 0-5s and 5-10s)
    const spk1_a = decSm.samples.subarray(0, sr * 5);
    const spk1_b = decSm.samples.subarray(sr * 5, sr * 10);

    // One slice from Speaker 2 (Multi-speaker sample: 21.8s - 28.0s)
    const spk2 = decMulti.samples.subarray(Math.floor(21.8 * sr), Math.floor(28.0 * sr));

    const emb1_a = await extractor.extract(spk1_a, sr);
    const emb1_b = await extractor.extract(spk1_b, sr);
    const emb2 = await extractor.extract(spk2, sr);

    expect(emb1_a.length).toBe(512);
    expect(emb1_b.length).toBe(512);
    expect(emb2.length).toBe(512);

    // Intra-speaker similarity (same speaker) should be high
    const withinSim = cosineSimilarity(emb1_a, emb1_b);
    expect(withinSim).toBeGreaterThan(0.70);

    // Inter-speaker similarity (different speakers) should be substantially lower
    const betweenSim = cosineSimilarity(emb1_a, emb2);
    expect(betweenSim).toBeLessThan(0.40);

    // Acceptance separation gate (> 0.25 separation)
    const separation = withinSim - betweenSim;
    expect(separation).toBeGreaterThan(0.25);

    // Scoring against multiple trusted vectors
    const trustedVectors = [emb1_a, emb1_b];
    const matchScore = scoreAgainstTrustedVectors(emb1_b, trustedVectors);
    expect(matchScore).toBeGreaterThanOrEqual(withinSim);

    // Weighted centroid computation
    const weightedCentroid = mergeWeightedVoiceprintVectors([
      { vector: emb1_a, weight: 5000 },
      { vector: emb1_b, weight: 5000 }
    ]);
    expect(weightedCentroid.length).toBe(512);
    expect(cosineSimilarity(weightedCentroid, emb1_a)).toBeGreaterThan(0.85);
  });

  test("Sherpa neural diarizer splits multi-speaker audio into distinct speaker turns", async () => {
    const extractor = new SherpaSpeakerEmbeddingExtractor();
    const diarizer = new SherpaSpeakerDiarizer(extractor, {
      clusteringThreshold: 0.50
    });

    const wavBytes = new Uint8Array(await readFile(FIXTURE_MULTI_SPEAKER_PATH));
    const decoded = decodeWav(wavBytes);

    const segments = await diarizer.diarize(decoded.samples, 16000, 0.50, 2);

    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0].startMs).toBeLessThan(segments[0].endMs);
    expect(segments[0].embedding).toBeArray();
    expect(segments[0].embedding!.length).toBe(512);

    const distinctSpeakers = new Set(segments.map((s) => s.speakerId));
    expect(distinctSpeakers.size).toBeGreaterThanOrEqual(2);
  });

  test("LocalTranscriptionPipeline transcribes with candidate roster, expected speaker count, and decision margin", async () => {
    const extractor = new SherpaSpeakerEmbeddingExtractor();
    const diarizer = new SherpaSpeakerDiarizer(extractor, {
      clusteringThreshold: 0.50
    });
    const asrEngine = new MockLocalAsrEngine([
      "Welcome to the team sync meeting.",
      "Thanks, happy to be here."
    ]);

    const pipeline = new LocalTranscriptionPipeline(
      { voiceprintConfig: { similarityThreshold: 0.60 } },
      diarizer,
      extractor,
      asrEngine
    );

    // Pre-enroll Speaker 1 from clean reference excerpt (speechmatics-sample: 0-6s)
    const bufSm = new Uint8Array(await readFile(FIXTURE_SPEECHMATICS_PATH));
    const decSm = await loadAudioSamples({ audioBytes: bufSm, enhance: false }, 16000);
    const spk1Sample = decSm.samples.subarray(0, 16000 * 6);
    const spk1Embedding = await extractor.extract(spk1Sample, 16000);

    const enrolledAlice = {
      id: "spk-alice-uuid",
      name: "Alice Smith",
      providerIds: {
        local: [JSON.stringify(spk1Embedding)]
      }
    };

    // Transcribe speechmatics audio with candidate roster
    const result = await pipeline.transcribe({
      audioBytes: bufSm,
      language: "en",
      enrolledSpeakers: [enrolledAlice],
      candidateSpeakers: ["Alice Smith"],
      expectedSpeakerCount: 1,
      similarityThreshold: 0.60,
      decisionMargin: 0.05
    });

    expect(result.transcript.segments.length).toBeGreaterThan(0);
    // Verified match to Alice Smith
    expect(result.transcript.segments[0].speaker).toBe("Alice Smith");

    // Check discovered speakers: Alice is marked enrolled, profile was NOT mutated
    const aliceDiscovered = result.discoveredSpeakers.find((s) => s.name === "Alice Smith");
    expect(aliceDiscovered?.isEnrolled).toBe(true);
    expect(aliceDiscovered?.similarityScore).toBeGreaterThan(0.60);
  });

  test("End-to-end meeting transcription using TranscriptionService with provider: local", async () => {
    const handle = createDb(":memory:");
    const meetingsDir = await mkdtemp(join(import.meta.dir, "local-transcribe-mtg-"));
    const now = 1_700_000_000_000;
    const meetingId = "m-local-test-1";

    const paths = meetingPaths(meetingsDir, now, "Architecture Discussion", meetingId);
    await mkdir(paths.audioDir, { recursive: true });

    const audioBytes = new Uint8Array(await readFile(FIXTURE_SPEECHMATICS_PATH));
    await writeFile(join(paths.folder, "audio/meeting.wav"), audioBytes);

    await handle.db
      .insertInto("meetings")
      .values({
        id: meetingId,
        title: "Architecture Discussion",
        start_time: now,
        end_time: now + 12000,
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
        duration_ms: 12000,
        size_bytes: audioBytes.byteLength,
        sha256: "fake-sha-local-wav",
        provider: "upload",
        provider_recording_id: null,
        created_at: now
      })
      .execute();

    const mockAsr = new MockLocalAsrEngine([
      "Let's review the local ASR engine.",
      "The neural diarization works seamlessly."
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
    expect(txtContent).toContain("Let's review the local ASR engine.");

    // 5. Verify meeting speakers linked
    const meetingSpeakers = await handle.db.selectFrom("meeting_speakers").selectAll().execute();
    expect(meetingSpeakers.length).toBeGreaterThan(0);

    await handle.db.destroy();
    handle.sqlite.close();
    await rm(meetingsDir, { recursive: true, force: true });
  });

  test("SpeakerService enrollment validation: rejects clips < 3s, > 30s, and duplicate audio", async () => {
    const handle = createDb(":memory:");
    const configDir = await mkdtemp(join(import.meta.dir, "spk-val-cfg-"));
    const now = 1_700_000_000_000;

    const service = new SpeakerService({
      db: handle.db,
      configDir,
      now: () => now
    });

    // 1. Rejects clip < 3.0s (e.g. 1.0s)
    const shortWav = createSingleVoiceWav(220, 1.0);
    let shortErr: Error | null = null;
    try {
      await service.enrollSpeaker({
        name: "David",
        audioBytes: shortWav,
        mime: "audio/wav"
      });
    } catch (err) {
      shortErr = err as Error;
    }
    expect(shortErr).not.toBeNull();
    expect(shortErr?.message).toContain("too short");

    // 2. Rejects clip > 30.0s (e.g. 40.0s)
    const longWav = createSingleVoiceWav(220, 40.0);
    let longErr: Error | null = null;
    try {
      await service.enrollSpeaker({
        name: "David",
        audioBytes: longWav,
        mime: "audio/wav"
      });
    } catch (err) {
      longErr = err as Error;
    }
    expect(longErr).not.toBeNull();
    expect(longErr?.message).toContain("too long");

    // 3. Successfully enrolls valid 5.0s clip for David
    const validWav = createSingleVoiceWav(220, 5.0);
    const david = await service.enrollSpeaker({
      name: "David",
      audioBytes: validWav,
      mime: "audio/wav",
      provider: "local"
    });
    expect(david.name).toBe("David");
    expect(david.providerIds.local).toBeArray();
    expect(david.providerIds.local!.length).toBe(1);

    // 4. Rejects enrolling exact same audio for a different speaker (Alice)
    let dupErr: Error | null = null;
    try {
      await service.enrollSpeaker({
        name: "Alice",
        audioBytes: validWav,
        mime: "audio/wav",
        provider: "local"
      });
    } catch (err) {
      dupErr = err as Error;
    }
    expect(dupErr).not.toBeNull();
    expect(dupErr?.message).toContain("already enrolled under speaker \"David\"");

    await handle.db.destroy();
    handle.sqlite.close();
    await rm(configDir, { recursive: true, force: true });
  });

  test("SpeakerService rebuildSpeakerProfiles cleans contaminated clips and extracts neural vectors", async () => {
    const handle = createDb(":memory:");
    const configDir = await mkdtemp(join(import.meta.dir, "rebuild-cfg-"));
    const now = 1_700_000_000_000;

    const service = new SpeakerService({
      db: handle.db,
      configDir,
      now: () => now
    });

    const spk1Id = "spk-matt";
    const spk2Id = "spk-harrison";

    const decSm = await loadAudioSamples({ audioBytes: new Uint8Array(await readFile(FIXTURE_SPEECHMATICS_PATH)), enhance: false }, 16000);
    const decMulti = await loadAudioSamples({ audioBytes: new Uint8Array(await readFile(FIXTURE_MULTI_SPEAKER_PATH)), enhance: false }, 16000);

    // Setup contaminated audio clips on disk:
    // Clip A: Valid 5s audio enrolled to Matt (from speechmatics-sample)
    const clipA = encodeWav(decSm.samples.subarray(0, 16000 * 5), 16000);
    const spk1Folder = join(configDir, "speakers", spk1Id);
    await mkdir(spk1Folder, { recursive: true });
    await writeFile(join(spk1Folder, "clip_a.wav"), clipA);

    // Clip B: Contaminated audio (enrolled under BOTH Matt and Harrison)
    const clipB = encodeWav(decMulti.samples.subarray(16000 * 5, 16000 * 11), 16000);
    const spk2Folder = join(configDir, "speakers", spk2Id);
    await mkdir(spk2Folder, { recursive: true });
    await writeFile(join(spk1Folder, "clip_shared.wav"), clipB);
    await writeFile(join(spk2Folder, "clip_shared.wav"), clipB);

    // Clip C: Valid 5s audio enrolled to Harrison (from multi-speaker 22s-27s)
    const clipC = encodeWav(decMulti.samples.subarray(16000 * 22, 16000 * 27), 16000);
    await writeFile(join(spk2Folder, "clip_c.wav"), clipC);

    // Clip D: Invalid sub-second clip (0.5s)
    const clipD = encodeWav(decMulti.samples.subarray(0, 8000), 16000);
    await writeFile(join(spk2Folder, "clip_too_short.wav"), clipD);

    // Insert database records with contaminated data
    await handle.db
      .insertInto("speakers")
      .values([
        {
          id: spk1Id,
          name: "Matt",
          provider_ids: JSON.stringify({ local: ["old-corrupted-vector"] }),
          enrolled_at: now,
          enrollment_clip_paths: JSON.stringify([
            `speakers/${spk1Id}/clip_a.wav`,
            `speakers/${spk1Id}/clip_shared.wav`
          ]),
          created_at: now
        },
        {
          id: spk2Id,
          name: "Harrison",
          provider_ids: JSON.stringify({ local: ["old-corrupted-vector"] }),
          enrolled_at: now,
          enrollment_clip_paths: JSON.stringify([
            `speakers/${spk2Id}/clip_shared.wav`,
            `speakers/${spk2Id}/clip_c.wav`,
            `speakers/${spk2Id}/clip_too_short.wav`
          ]),
          created_at: now
        }
      ])
      .execute();

    // Run rebuild
    const rebuildResult = await service.rebuildSpeakerProfiles();

    expect(rebuildResult.processedSpeakers).toBe(2);
    expect(rebuildResult.cleanedClipsCount).toBeGreaterThanOrEqual(2);
    expect(rebuildResult.retainedClipsCount).toBe(2);

    const matt = rebuildResult.speakers.find((s) => s.name === "Matt")!;
    const harrison = rebuildResult.speakers.find((s) => s.name === "Harrison")!;

    // Matt has only clip A retained
    expect(matt.enrollmentClipPaths).toEqual([`speakers/${spk1Id}/clip_a.wav`]);
    expect(matt.providerIds.local).toHaveLength(1);
    const mattVec = JSON.parse(matt.providerIds.local[0]);
    expect(mattVec).toHaveLength(512);

    // Harrison has only clip C retained (shared contaminated clip and short clip removed)
    expect(harrison.enrollmentClipPaths).toEqual([`speakers/${spk2Id}/clip_c.wav`]);
    expect(harrison.providerIds.local).toHaveLength(1);
    const harrisonVec = JSON.parse(harrison.providerIds.local[0]);
    expect(harrisonVec).toHaveLength(512);

    // Matt and Harrison vectors are now clean and distinct
    const sim = cosineSimilarity(mattVec, harrisonVec);
    expect(sim).toBeLessThan(0.70);

    await handle.db.destroy();
    handle.sqlite.close();
    await rm(configDir, { recursive: true, force: true });
  });

  test("In-meeting reassignment, segment splitting, and merging", async () => {
    const handle = createDb(":memory:");
    const configDir = await mkdtemp(join(import.meta.dir, "reassign-cfg-"));
    const meetingsDir = await mkdtemp(join(import.meta.dir, "reassign-mtg-"));
    const now = 1_700_000_000_000;
    const meetingId = "m-reassign-test";

    const paths = meetingPaths(meetingsDir, now, "Team Huddle", meetingId);
    await mkdir(paths.audioDir, { recursive: true });
    await mkdir(paths.transcriptsDir, { recursive: true });

    const audioBytes = createSingleVoiceWav(440, 10.0);
    await writeFile(join(paths.folder, "audio/huddle.wav"), audioBytes);

    const initialTranscript = {
      segments: [
        { startMs: 0, endMs: 4000, speaker: "Speaker 1", text: "First turn." },
        { startMs: 4500, endMs: 8500, speaker: "Speaker 2", text: "Second turn." }
      ],
      language: "en",
      durationMs: 8500
    };
    await writeFile(
      join(paths.folder, "transcripts/local.json"),
      JSON.stringify(initialTranscript, null, 2),
      "utf8"
    );
    await writeFile(
      join(paths.folder, "transcripts/local.txt"),
      "Speaker 1: First turn.\n\nSpeaker 2: Second turn.",
      "utf8"
    );

    await handle.db
      .insertInto("meetings")
      .values({
        id: meetingId,
        title: "Team Huddle",
        start_time: now,
        end_time: now + 8500,
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
        duration_ms: 8500,
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

    // 1. Reassign Speaker 1 to Jessica Alba with adoptVoiceprint = true
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

    // 2. Confirm segment 1 as "Bob"
    const confirmResult = await speakerService.confirmMeetingSegmentSpeaker({
      meetingId,
      segmentIndex: 1,
      speakerName: "Bob"
    });
    expect(confirmResult.speaker.name).toBe("Bob");
    expect(confirmResult.voiceprintEnrolled).toBe(true);

    // 3. Split segment 0
    const splitResult = await speakerService.splitMeetingSegment({
      meetingId,
      segmentIndex: 0,
      wordIndex: 1,
      newSpeakerName: "Charlie"
    });
    expect(splitResult.transcript.segments.length).toBe(3);

    // 4. Merge segments back
    const mergeResult = await speakerService.mergeMeetingSegments({
      meetingId,
      segmentIndex: 0
    });
    expect(mergeResult.transcript.segments.length).toBe(2);

    await handle.db.destroy();
    handle.sqlite.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(meetingsDir, { recursive: true, force: true });
  });

  test("Cancel inflight local transcription via service and API", async () => {
    const configDir = await mkdtemp(join(process.cwd(), "packages/server/test/cancel-test-"));
    const meetingsDir = join(configDir, "meetings");
    await mkdir(meetingsDir, { recursive: true });

    const handle = createDb(":memory:");
    const meetingId = "m-cancel-test";
    const now = 1700000000000;

    const paths = meetingPaths(meetingsDir, now, "Cancel Test", meetingId);
    await mkdir(paths.audioDir, { recursive: true });
    const audioBytes = createSingleVoiceWav(440, 5.0);
    await writeFile(join(paths.audioDir, "rec.wav"), audioBytes);

    await handle.db
      .insertInto("meetings")
      .values({
        id: meetingId,
        title: "Cancel Test",
        start_time: now,
        end_time: now + 5000,
        source: "upload",
        status: "pending",
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
        id: "rec-cancel-1",
        meeting_id: meetingId,
        path: "audio/rec.wav",
        mime: "audio/wav",
        duration_ms: 5000,
        size_bytes: audioBytes.byteLength,
        sha256: "fake-sha-cancel",
        provider: "upload",
        provider_recording_id: null,
        created_at: now
      })
      .execute();

    const localPipeline = new LocalTranscriptionPipeline(
      {},
      undefined,
      undefined,
      new MockLocalAsrEngine()
    );

    const transcriptionService = new TranscriptionService({
      db: handle.db,
      meetingsDir,
      localPipeline,
      defaultProvider: "local",
      now: () => now + 50
    });

    const abortController = new AbortController();
    abortController.abort();

    // Start with already aborted signal
    const result = await transcriptionService.transcribeMeeting(meetingId, {
      provider: "local",
      signal: abortController.signal
    });

    expect(result.status).toBe("cancelled");

    const stageRun = await handle.db
      .selectFrom("stage_runs")
      .selectAll()
      .where("meeting_id", "=", meetingId)
      .executeTakeFirst();

    expect(stageRun?.status).toBe("cancelled");

    const app = createApp({
      db: handle.db,
      configDir,
      meetingsDir,
      transcriptionService
    });

    const cancelRes = await app.request(`/api/meetings/${meetingId}/transcribe/cancel`, {
      method: "POST"
    });
    expect(cancelRes.status).toBe(200);
    const cancelBody = await cancelRes.json();
    expect(cancelBody.success).toBe(true);

    await handle.db.destroy();
    handle.sqlite.close();
    await rm(configDir, { recursive: true, force: true });
    await rm(meetingsDir, { recursive: true, force: true });
  });
});
