import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createDb } from "../src/db.ts";
import { meetingPaths } from "../src/layout.ts";
import {
  AcousticFeatureEmbeddingExtractor,
  cosineSimilarity,
  decodeWav,
  LocalSpeakerDiarizer,
  LocalTranscriptionPipeline,
  TransformersAsrEngine
} from "../src/providers/local/index.ts";
import { SpeakerService } from "../src/speakers/service.ts";
import {
  PROVIDER_LOCAL,
  STAGE_LOCAL_TRANSCRIBE,
  TranscriptionService
} from "../src/transcription/service.ts";

const FIXTURES_DIR = join(import.meta.dir, "fixtures/audio");
const SAMPLE_SPEECHMATICS_WAV = join(FIXTURES_DIR, "speechmatics-sample.wav");
const SAMPLE_MULTI_SPEAKER_WAV = join(FIXTURES_DIR, "sample-multi-speaker.wav");

const shouldRunLive =
  process.env.RUN_LIVE_TESTS === "true" ||
  process.env.RUN_LIVE_LOCAL_TEST === "true" ||
  process.env.RUN_LIVE_COHERE_TEST === "true";

describe("Live Local SOTA ASR & Diarization integration tests (opt-in)", () => {
  test.skipIf(!shouldRunLive)(
    "Live Diarization: extracts speaker segments and distinct voiceprints from multi-speaker recording",
    async () => {
      expect(existsSync(SAMPLE_MULTI_SPEAKER_WAV)).toBe(true);

      const audioBytes = new Uint8Array(await readFile(SAMPLE_MULTI_SPEAKER_WAV));
      const decoded = decodeWav(audioBytes);

      const extractor = new AcousticFeatureEmbeddingExtractor(192);
      const diarizer = new LocalSpeakerDiarizer(extractor, {
        minSpeechDurationMs: 400,
        minSilenceDurationMs: 400,
        clusteringThreshold: 0.65
      });

      const segments = await diarizer.diarize(decoded.samples, decoded.sampleRate);
      console.log(`Live diarization produced ${segments.length} segment(s)`);

      expect(segments.length).toBeGreaterThan(0);
      for (const seg of segments) {
        expect(seg.speakerId).toBeTruthy();
        expect(seg.embedding).toBeArray();
        expect(seg.embedding!.length).toBe(192);
        expect(seg.endMs).toBeGreaterThan(seg.startMs);
      }
    },
    60_000
  );

  test.skipIf(!shouldRunLive)(
    "Live Cohere Transcribe: transcribes speech from real WAV audio via Transformers.js on CPU",
    async () => {
      expect(existsSync(SAMPLE_SPEECHMATICS_WAV)).toBe(true);

      const audioBytes = new Uint8Array(await readFile(SAMPLE_SPEECHMATICS_WAV));
      const decoded = decodeWav(audioBytes);

      // Slice first 5 seconds for fast test execution
      const fiveSecSamples = decoded.samples.subarray(0, Math.min(decoded.samples.length, 16000 * 5));

      const asrEngine = new TransformersAsrEngine({
        modelId: "onnx-community/cohere-transcribe-03-2026-ONNX",
        dtype: "q4",
        device: "cpu",
        language: "en"
      });

      console.log("Loading Cohere Transcribe 2B model via Transformers.js...");
      const result = await asrEngine.transcribeSegment(fiveSecSamples, 16000, {
        language: "en",
        strict: false
      });

      console.log("Cohere Transcribe Result:", result.text);
      expect(result.text).toBeTruthy();
      expect(result.text.length).toBeGreaterThan(3);
    },
    180_000
  );

  test.skipIf(!shouldRunLive)(
    "Live Local Pipeline & Speaker Identification: transcribes and matches enrolled speaker across recordings",
    async () => {
      expect(existsSync(SAMPLE_SPEECHMATICS_WAV)).toBe(true);

      const handle = createDb(":memory:");
      const configDir = await mkdtemp(join(import.meta.dir, "local-live-cfg-"));
      const meetingsDir = await mkdtemp(join(import.meta.dir, "local-live-mtg-"));
      const now = Date.now();

      const speakerService = new SpeakerService({
        db: handle.db,
        configDir,
        meetingsDir
      });

      // 1. Enroll real voice sample
      const clipBytes = new Uint8Array(await readFile(SAMPLE_SPEECHMATICS_WAV));
      const speaker = await speakerService.enrollSpeaker({
        name: "Alice Real",
        audioBytes: clipBytes.subarray(0, Math.min(clipBytes.byteLength, 44 + 16000 * 2 * 3)),
        mime: "audio/wav",
        provider: "local",
        filename: "alice.wav"
      });

      console.log(`Enrolled speaker with local voiceprint: name=${speaker.name}`);
      expect(speaker.providerIds.local).toBeArray();
      expect(speaker.providerIds.local!.length).toBeGreaterThan(0);

      // 2. Setup meeting with the same voice audio
      const meetingId = "live-local-meeting-1";
      const paths = meetingPaths(meetingsDir, now, "Local SOTA Voice Verification", meetingId);
      await mkdir(paths.audioDir, { recursive: true });
      const targetAudioPath = join(paths.folder, "audio/test.wav");
      await copyFile(SAMPLE_SPEECHMATICS_WAV, targetAudioPath);
      const audioStats = await stat(targetAudioPath);

      await handle.db
        .insertInto("meetings")
        .values({
          id: meetingId,
          title: "Local SOTA Voice Verification",
          start_time: now,
          end_time: now + 10_000,
          source: "upload",
          status: "ready",
          tags: JSON.stringify(["local", "cohere", "diarization"]),
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
          id: "rec-live-local",
          meeting_id: meetingId,
          path: "audio/test.wav",
          mime: "audio/wav",
          duration_ms: 10_000,
          size_bytes: audioStats.size,
          sha256: "sha-local-live-test",
          provider: "upload",
          provider_recording_id: null,
          created_at: now
        })
        .execute();

      const asrEngine = new TransformersAsrEngine({
        modelId: "onnx-community/cohere-transcribe-03-2026-ONNX",
        dtype: "q4"
      });
      const localPipeline = new LocalTranscriptionPipeline(
        { voiceprintConfig: { similarityThreshold: 0.65 } },
        undefined,
        undefined,
        asrEngine
      );

      const transcriptionService = new TranscriptionService({
        db: handle.db,
        meetingsDir,
        localPipeline,
        defaultProvider: "local"
      });

      // 3. Transcribe meeting
      const result = await transcriptionService.transcribeMeeting(meetingId, { provider: "local" });
      console.log(`Live local transcription result: status=${result.status}, jobId=${result.jobId}`);
      expect(result.status).toBe("done");

      const txtArtifactPath = join(paths.folder, "transcripts/local.txt");
      expect(existsSync(txtArtifactPath)).toBe(true);
      const txtContent = await readFile(txtArtifactPath, "utf8");
      console.log("Live Local Transcribed Text:\n", txtContent);

      const meetingSpeakers = await handle.db
        .selectFrom("meeting_speakers")
        .selectAll()
        .where("meeting_id", "=", meetingId)
        .execute();
      expect(meetingSpeakers.length).toBeGreaterThan(0);

      await handle.db.destroy();
      handle.sqlite.close();
      await rm(configDir, { recursive: true, force: true });
      await rm(meetingsDir, { recursive: true, force: true });
    },
    240_000
  );
});
