import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, stat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createDb } from "../src/db.ts";
import { meetingPaths } from "../src/layout.ts";
import { SpeechmaticsClient } from "../src/providers/speechmatics/client.ts";
import { STAGE_SPEECHMATICS_TRANSCRIBE, TranscriptionService } from "../src/transcription/service.ts";
import { SpeakerService } from "../src/speakers/service.ts";

const FIXTURES_DIR = join(import.meta.dir, "fixtures/audio");
const SAMPLE_SPEECHMATICS_WAV = join(FIXTURES_DIR, "speechmatics-sample.wav");
const SAMPLE_MULTI_SPEAKER_WAV = join(FIXTURES_DIR, "sample-multi-speaker.wav");

const shouldRunLive =
  (process.env.RUN_LIVE_TESTS === "true" || process.env.RUN_LIVE_SPEECHMATICS_TEST === "true") &&
  Boolean(process.env.SPEECHMATICS_API_KEY?.trim());

describe("Live Speechmatics integration tests (opt-in)", () => {
  test.skipIf(!shouldRunLive)(
    "transcribes a real English audio recording and stores diarized transcript artifacts",
    async () => {
      expect(existsSync(SAMPLE_SPEECHMATICS_WAV)).toBe(true);

      const handle = createDb(":memory:");
      const meetingsDir = await mkdtemp(join(import.meta.dir, "sm-live-real-"));
      const now = Date.now();
      const meetingId = "live-real-meeting-1";

      const paths = meetingPaths(meetingsDir, now, "Speechmatics Demo Recording", meetingId);
      await mkdir(paths.audioDir, { recursive: true });
      const targetAudioPath = join(paths.folder, "audio/example.wav");
      await copyFile(SAMPLE_SPEECHMATICS_WAV, targetAudioPath);
      const audioStats = await stat(targetAudioPath);

      await handle.db
        .insertInto("meetings")
        .values({
          id: meetingId,
          title: "Speechmatics Demo Recording",
          start_time: now,
          end_time: now + 30_000,
          source: "upload",
          status: "ready",
          tags: JSON.stringify(["live-test", "speechmatics"]),
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
          id: "live-rec-example",
          meeting_id: meetingId,
          path: "audio/example.wav",
          mime: "audio/wav",
          duration_ms: 30_000,
          size_bytes: audioStats.size,
          sha256: "live-sha256-example-wav",
          provider: "upload",
          provider_recording_id: null,
          created_at: now
        })
        .execute();

      const client = new SpeechmaticsClient();
      const service = new TranscriptionService({
        db: handle.db,
        meetingsDir,
        speechmaticsClient: client
      });

      const result = await service.transcribeMeeting(meetingId, {
        poll: true,
        pollIntervalMs: 2500,
        maxPollWaitMs: 180_000
      });

      console.log(`Live single-speaker transcript result: status=${result.status}, jobId=${result.jobId}`);
      expect(result.status).toBe("done");
      expect(result.jobId).toBeTruthy();
      expect(result.transcriptArtifactId).toBeTruthy();

      const stageRun = await handle.db
        .selectFrom("stage_runs")
        .selectAll()
        .where("meeting_id", "=", meetingId)
        .where("stage", "=", STAGE_SPEECHMATICS_TRANSCRIBE)
        .executeTakeFirstOrThrow();
      expect(stageRun.status).toBe("done");

      const jsonArtifactPath = join(paths.folder, "transcripts/speechmatics.json");
      const txtArtifactPath = join(paths.folder, "transcripts/speechmatics.txt");
      expect(existsSync(jsonArtifactPath)).toBe(true);
      expect(existsSync(txtArtifactPath)).toBe(true);

      const txtContent = await readFile(txtArtifactPath, "utf8");
      expect(txtContent.length).toBeGreaterThan(10);
      console.log("Transcribed text excerpt:\n", txtContent.slice(0, 300));

      const jsonContent = JSON.parse(await readFile(jsonArtifactPath, "utf8"));
      expect(jsonContent.segments).toBeArray();
      expect(jsonContent.segments.length).toBeGreaterThan(0);
      expect(jsonContent.segments[0].speaker).toBeTruthy();
      expect(jsonContent.segments[0].text).toBeTruthy();

      const meeting = await handle.db
        .selectFrom("meetings")
        .selectAll()
        .where("id", "=", meetingId)
        .executeTakeFirstOrThrow();
      expect(meeting.primary_transcript_artifact_id).toBe(result.transcriptArtifactId!);

      await handle.db.destroy();
      handle.sqlite.close();
      await rm(meetingsDir, { recursive: true, force: true });
    },
    180_000
  );

  test.skipIf(!shouldRunLive)(
    "transcribes a multi-speaker conversation with diarization into distinct speaker turns",
    async () => {
      expect(existsSync(SAMPLE_MULTI_SPEAKER_WAV)).toBe(true);

      const handle = createDb(":memory:");
      const meetingsDir = await mkdtemp(join(import.meta.dir, "sm-live-multi-"));
      const now = Date.now();
      const meetingId = "live-multi-meeting-2";

      const paths = meetingPaths(meetingsDir, now, "Multi-speaker Conversation", meetingId);
      await mkdir(paths.audioDir, { recursive: true });
      const targetAudioPath = join(paths.folder, "audio/multi-speaker.wav");
      await copyFile(SAMPLE_MULTI_SPEAKER_WAV, targetAudioPath);
      const audioStats = await stat(targetAudioPath);

      await handle.db
        .insertInto("meetings")
        .values({
          id: meetingId,
          title: "Multi-speaker Conversation",
          start_time: now,
          end_time: now + 30_000,
          source: "upload",
          status: "ready",
          tags: JSON.stringify(["multi-speaker", "diarization"]),
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
          id: "live-rec-multi",
          meeting_id: meetingId,
          path: "audio/multi-speaker.wav",
          mime: "audio/wav",
          duration_ms: 30_000,
          size_bytes: audioStats.size,
          sha256: "live-sha256-multi-wav",
          provider: "upload",
          provider_recording_id: null,
          created_at: now
        })
        .execute();

      const client = new SpeechmaticsClient();
      const service = new TranscriptionService({
        db: handle.db,
        meetingsDir,
        speechmaticsClient: client
      });

      const result = await service.transcribeMeeting(meetingId, {
        poll: true,
        pollIntervalMs: 2500,
        maxPollWaitMs: 180_000
      });

      console.log(`Live multi-speaker transcript result: status=${result.status}, jobId=${result.jobId}`);
      expect(result.status).toBe("done");

      const txtArtifactPath = join(paths.folder, "transcripts/speechmatics.txt");
      const txtContent = await readFile(txtArtifactPath, "utf8");
      console.log("Multi-speaker transcribed text:\n", txtContent.slice(0, 400));

      const meetingSpeakers = await handle.db
        .selectFrom("meeting_speakers")
        .selectAll()
        .where("meeting_id", "=", meetingId)
        .execute();
      expect(meetingSpeakers.length).toBeGreaterThan(0);

      await handle.db.destroy();
      handle.sqlite.close();
      await rm(meetingsDir, { recursive: true, force: true });
    },
    180_000
  );

  test.skipIf(!shouldRunLive)(
    "enrolls a speaker voiceprint and recognizes the speaker by name across recordings",
    async () => {
      const handle = createDb(":memory:");
      const configDir = await mkdtemp(join(import.meta.dir, "sm-live-enroll-config-"));
      const meetingsDir = await mkdtemp(join(import.meta.dir, "sm-live-enroll-meetings-"));
      const now = Date.now();

      const client = new SpeechmaticsClient();
      const speakerService = new SpeakerService({
        db: handle.db,
        configDir,
        meetingsDir,
        speechmaticsClient: client
      });
      const transcriptionService = new TranscriptionService({
        db: handle.db,
        meetingsDir,
        speechmaticsClient: client
      });

      // 1. Enroll voice clip as "Alice"
      const clipBytes = await readFile(SAMPLE_SPEECHMATICS_WAV);
      const enrolled = await speakerService.enrollSpeaker({
        name: "Alice",
        audioBytes: new Uint8Array(clipBytes),
        mime: "audio/wav",
        filename: "speechmatics-sample.wav"
      });

      console.log(`Enrolled speaker: name=${enrolled.name}, speechmaticsIds=${JSON.stringify(enrolled.providerIds.speechmatics)}`);
      expect(enrolled.name).toBe("Alice");
      expect(enrolled.providerIds.speechmatics).toBeArray();
      expect(enrolled.providerIds.speechmatics.length).toBeGreaterThan(0);

      // 2. Create a meeting with the same voice audio
      const meetingId = "live-id-meeting-3";
      const paths = meetingPaths(meetingsDir, now, "Recognition Verification", meetingId);
      await mkdir(paths.audioDir, { recursive: true });
      const targetAudioPath = join(paths.folder, "audio/test.wav");
      await copyFile(SAMPLE_SPEECHMATICS_WAV, targetAudioPath);
      const audioStats = await stat(targetAudioPath);

      await handle.db
        .insertInto("meetings")
        .values({
          id: meetingId,
          title: "Recognition Verification",
          start_time: now,
          end_time: now + 30_000,
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
          id: "live-rec-verif",
          meeting_id: meetingId,
          path: "audio/test.wav",
          mime: "audio/wav",
          duration_ms: 30_000,
          size_bytes: audioStats.size,
          sha256: "live-sha256-verif-wav",
          provider: "upload",
          provider_recording_id: null,
          created_at: now
        })
        .execute();

      // 3. Transcribe meeting — TranscriptionService passes Alice's enrolled voiceprint identifiers
      const result = await transcriptionService.transcribeMeeting(meetingId, {
        poll: true,
        pollIntervalMs: 2500,
        maxPollWaitMs: 180_000
      });

      expect(result.status).toBe("done");

      const txtArtifactPath = join(paths.folder, "transcripts/speechmatics.txt");
      const txtContent = await readFile(txtArtifactPath, "utf8");
      console.log("Speaker Identification output:\n", txtContent.slice(0, 300));

      // Assert Speechmatics tagged the segment with the enrolled label "Alice"
      expect(txtContent).toContain("Alice:");

      await handle.db.destroy();
      handle.sqlite.close();
      await rm(configDir, { recursive: true, force: true });
      await rm(meetingsDir, { recursive: true, force: true });
    },
    240_000
  );
});
