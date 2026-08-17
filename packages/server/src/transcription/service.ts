import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Kysely } from "kysely";
import type { Database, EnrolledSpeaker, Transcript, TranscriptionProgressUpdate } from "@olive/shared";
import { ensureMeetingFolder, meetingPaths } from "../layout.ts";
import { logger as defaultLogger, type Logger } from "../logger.ts";
import {
  SpeechmaticsClient,
  type SpeechmaticsJsonV2,
  type SpeechmaticsSpeakerConfig
} from "../providers/speechmatics/index.ts";
import { parseSpeechmaticsJsonV2, transcriptToText } from "../providers/speechmatics/normalize.ts";
import {
  LocalTranscriptionPipeline,
  type DiscoveredSpeakerVoiceprint
} from "../providers/local/index.ts";

import type { SummaryService } from "../summaries/service.ts";

export const STAGE_SPEECHMATICS_TRANSCRIBE = "speechmatics_transcribe";
export const STAGE_LOCAL_TRANSCRIBE = "local_transcribe";
export const PROVIDER_SPEECHMATICS = "speechmatics";
export const PROVIDER_LOCAL = "local";

export type TranscriptionProviderName = "speechmatics" | "local";

export interface TranscriptionServiceOptions {
  db: Kysely<Database>;
  meetingsDir: string;
  speechmaticsClient?: SpeechmaticsClient;
  localPipeline?: LocalTranscriptionPipeline;
  defaultProvider?: TranscriptionProviderName;
  logger?: Logger;
  webhookUrl?: string;
  webhookSecret?: string;
  now?: () => number;
  summaryService?: SummaryService;
}

export interface TranscribeMeetingOptions {
  provider?: TranscriptionProviderName;
  language?: string;
  candidateSpeakers?: string[];
  expectedSpeakerCount?: number;
  poll?: boolean;
  pollIntervalMs?: number;
  maxPollWaitMs?: number;
  force?: boolean;
  similarityThreshold?: number;
  clusteringThreshold?: number;
  modelId?: string;
  signal?: AbortSignal;
  onProgress?: (update: TranscriptionProgressUpdate) => void | Promise<void>;
}

export interface TranscribeMeetingResult {
  stageRunId: string;
  jobId: string;
  status: "running" | "done" | "error" | "cancelled";
  transcriptArtifactId?: string;
  transcriptTextArtifactId?: string;
  error?: string | null;
}

export interface ActiveTranscriptionJob {
  abortController: AbortController;
  provider: TranscriptionProviderName;
  stageRunId?: string;
  jobId?: string;
}

function parseJsonField<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class TranscriptionService {
  private readonly db: Kysely<Database>;
  private readonly meetingsDir: string;
  private readonly client: SpeechmaticsClient;
  private readonly localPipeline: LocalTranscriptionPipeline;
  private readonly defaultProvider: TranscriptionProviderName;
  private readonly logger: Logger;
  private readonly webhookUrl?: string;
  private readonly webhookSecret?: string;
  private readonly now: () => number;
  private summaryService?: SummaryService;
  private readonly activeJobs = new Map<string, ActiveTranscriptionJob>();

  constructor(options: TranscriptionServiceOptions) {
    this.db = options.db;
    this.meetingsDir = options.meetingsDir;
    this.client = options.speechmaticsClient ?? new SpeechmaticsClient();
    this.localPipeline = options.localPipeline ?? new LocalTranscriptionPipeline();
    this.defaultProvider =
      options.defaultProvider ??
      (options.speechmaticsClient || process.env.SPEECHMATICS_API_KEY ? "speechmatics" : "local");
    this.logger = options.logger ?? defaultLogger;
    this.webhookUrl = options.webhookUrl;
    this.webhookSecret = options.webhookSecret;
    this.now = options.now ?? Date.now;
    this.summaryService = options.summaryService;
  }

  setSummaryService(service: SummaryService): void {
    this.summaryService = service;
  }

  private async autoSummarize(meetingId: string): Promise<void> {
    if (!this.summaryService) return;
    try {
      const meeting = await this.db
        .selectFrom("meetings")
        .select(["id", "primary_summary_artifact_id"])
        .where("id", "=", meetingId)
        .executeTakeFirst();

      if (meeting && !meeting.primary_summary_artifact_id) {
        this.logger.debug("Triggering auto-summarization on transcript completion", {
          category: "summary",
          meetingId
        });
        await this.summaryService.generateSummary({ meetingId, setPrimary: true });
        this.logger.info("Auto-generated summary on transcript completion", {
          category: "summary",
          meetingId
        });
      }
    } catch (err) {
      this.logger.warn("Auto-summarization skipped or failed on transcript completion", {
        category: "summary",
        meetingId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  get speechmatics(): SpeechmaticsClient {
    return this.client;
  }

  get local(): LocalTranscriptionPipeline {
    return this.localPipeline;
  }

  async cancelTranscription(meetingId: string): Promise<{ success: boolean; message: string }> {
    this.logger.info("Cancelling transcription for meeting", { category: "transcription", meetingId });
    const active = this.activeJobs.get(meetingId);
    if (active) {
      active.abortController.abort();
      if (active.provider === "speechmatics" && active.jobId) {
        try {
          await this.client.deleteJob(active.jobId);
        } catch (err) {
          this.logger.warn("Failed to delete Speechmatics job during cancellation", {
            jobId: active.jobId,
            error: String(err)
          });
        }
      }
    }

    const cancelTime = this.now();
    await this.db
      .updateTable("stage_runs")
      .set({
        status: "cancelled",
        last_error: "Cancelled by user",
        finished_at: cancelTime,
        updated_at: cancelTime
      })
      .where("meeting_id", "=", meetingId)
      .where("status", "=", "running")
      .execute();

    const meeting = await this.db
      .selectFrom("meetings")
      .select(["primary_transcript_artifact_id", "status"])
      .where("id", "=", meetingId)
      .executeTakeFirst();

    if (meeting) {
      await this.db
        .updateTable("meetings")
        .set({
          status: meeting.primary_transcript_artifact_id ? "ready" : "pending",
          last_error: null,
          updated_at: cancelTime
        })
        .where("id", "=", meetingId)
        .execute();
    }

    return { success: true, message: "Transcription cancelled successfully" };
  }

  async transcribeMeeting(
    meetingId: string,
    options: TranscribeMeetingOptions = {}
  ): Promise<TranscribeMeetingResult> {
    const provider = options.provider ?? this.defaultProvider;

    this.logger.debug("Initiating meeting transcription", {
      category: "transcription",
      meetingId,
      provider,
      language: options.language,
      force: Boolean(options.force)
    });

    const abortController = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) {
        abortController.abort();
      } else {
        options.signal.addEventListener("abort", () => abortController.abort(), { once: true });
      }
    }

    const activeJob: ActiveTranscriptionJob = {
      abortController,
      provider
    };
    this.activeJobs.set(meetingId, activeJob);

    try {
      if (provider === "local") {
        return await this.transcribeMeetingLocal(meetingId, { ...options, signal: abortController.signal });
      }

      return await this.transcribeMeetingSpeechmatics(meetingId, { ...options, signal: abortController.signal });
    } finally {
      this.activeJobs.delete(meetingId);
    }
  }

  /**
   * Transcribes a meeting using the Local SOTA ASR (Cohere Transcribe / ONNX)
   * + Pyannote/Acoustic Diarization & Cross-recording Voiceprints.
   */
  async transcribeMeetingLocal(
    meetingId: string,
    options: TranscribeMeetingOptions = {}
  ): Promise<TranscribeMeetingResult> {
    const meeting = await this.db
      .selectFrom("meetings")
      .selectAll()
      .where("id", "=", meetingId)
      .executeTakeFirst();

    if (!meeting) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }

    const recording = await this.db
      .selectFrom("recordings")
      .selectAll()
      .where("meeting_id", "=", meetingId)
      .orderBy("created_at", "asc")
      .executeTakeFirst();

    if (!recording) {
      throw new Error(`No recording found for meeting ${meetingId}`);
    }

    const folder = meetingPaths(this.meetingsDir, meeting.start_time, meeting.title, meeting.id).folder;
    const audioFullPath = join(folder, recording.path);

    if (!existsSync(audioFullPath)) {
      throw new Error(`Audio file not found on disk at ${audioFullPath}`);
    }

    let stageRun = await this.db
      .selectFrom("stage_runs")
      .selectAll()
      .where("meeting_id", "=", meetingId)
      .where("stage", "=", STAGE_LOCAL_TRANSCRIBE)
      .executeTakeFirst();

    if (stageRun?.status === "done" && !options.force) {
      const existingArtifact = await this.db
        .selectFrom("artifacts")
        .select("id")
        .where("meeting_id", "=", meetingId)
        .where("provider", "=", PROVIDER_LOCAL)
        .where("kind", "=", "transcript")
        .where("format", "=", "json")
        .executeTakeFirst();

      return {
        stageRunId: stageRun.id,
        jobId: stageRun.provider_job_id ?? "",
        status: "done",
        transcriptArtifactId: existingArtifact?.id
      };
    }

    const stageRunId = stageRun?.id ?? randomUUID();
    const currentTime = this.now();

    // Mark stage run as running
    if (stageRun) {
      await this.db
        .updateTable("stage_runs")
        .set({
          status: "running",
          attempts: stageRun.attempts + 1,
          last_error: null,
          started_at: currentTime,
          updated_at: currentTime
        })
        .where("id", "=", stageRun.id)
        .execute();
    } else {
      await this.db
        .insertInto("stage_runs")
        .values({
          id: stageRunId,
          meeting_id: meetingId,
          stage: STAGE_LOCAL_TRANSCRIBE,
          status: "running",
          provider_job_id: `local-${stageRunId.slice(0, 8)}`,
          attempts: 1,
          last_error: null,
          started_at: currentTime,
          finished_at: null,
          created_at: currentTime,
          updated_at: currentTime
        })
        .execute();
    }

    try {
      // 1. Fetch enrolled speakers for cross-recording identification
      const enrolledSpeakers = await this.getEnrolledSpeakers();

      // Extract candidate speakers and expected speaker count from meeting title if not explicitly passed
      const candidateSpeakers: string[] = [];
      const titleLower = meeting.title.toLowerCase();

      // Look for enrolled speaker names mentioned in meeting title (e.g. "Matt", "Harrison", etc.)
      for (const spk of enrolledSpeakers) {
        const nameParts = spk.name.trim().toLowerCase().split(/\s+/);
        if (nameParts.some((part) => part.length >= 3 && titleLower.includes(part))) {
          candidateSpeakers.push(spk.name);
        }
      }

      let expectedSpeakerCount = options.expectedSpeakerCount;
      if (!expectedSpeakerCount) {
        if (/1[:\-_/]?1|1-on-1|one-on-one|interview/i.test(meeting.title)) {
          expectedSpeakerCount = 2;
        } else if (candidateSpeakers.length > 0) {
          expectedSpeakerCount = candidateSpeakers.length;
        }
      }

      // 2. Execute local transcription pipeline
      const { transcript, discoveredSpeakers } = await this.localPipeline.transcribe({
        audioPath: audioFullPath,
        language: options.language,
        enrolledSpeakers,
        candidateSpeakers: candidateSpeakers.length > 0 ? candidateSpeakers : undefined,
        expectedSpeakerCount,
        similarityThreshold: options.similarityThreshold,
        clusteringThreshold: options.clusteringThreshold,
        modelId: options.modelId,
        signal: options.signal,
        onProgress: options.onProgress
      });

      // 3. Write artifacts to disk
      const paths = ensureMeetingFolder(
        meetingPaths(this.meetingsDir, meeting.start_time, meeting.title, meeting.id)
      );

      const transcriptText = transcriptToText(transcript);
      const transcriptJson = `${JSON.stringify(transcript, null, 2)}\n`;

      const jsonArtifactId = await this.ensureArtifact(
        meeting.id,
        recording.id,
        "transcript",
        "json",
        "transcripts/local.json",
        transcriptJson,
        paths.transcriptsDir,
        PROVIDER_LOCAL
      );

      const txtArtifactId = await this.ensureArtifact(
        meeting.id,
        recording.id,
        "transcript",
        "txt",
        "transcripts/local.txt",
        `${transcriptText}\n`,
        paths.transcriptsDir,
        PROVIDER_LOCAL
      );

      // 4. Persist discovered/updated speakers & links
      await this.persistLocalDiscoveredSpeakers(
        meeting.id,
        jsonArtifactId,
        discoveredSpeakers
      );

      const completedAt = this.now();

      // 5. Update meeting primary transcript artifact
      await this.db
        .updateTable("meetings")
        .set({
          primary_transcript_artifact_id: jsonArtifactId,
          status: "ready",
          last_error: null,
          updated_at: completedAt
        })
        .where("id", "=", meeting.id)
        .execute();

      // 6. Mark stage run as done
      await this.db
        .updateTable("stage_runs")
        .set({
          status: "done",
          last_error: null,
          finished_at: completedAt,
          updated_at: completedAt
        })
        .where("id", "=", stageRunId)
        .execute();

      // Trigger auto-summarization hook
      void this.autoSummarize(meeting.id);

      return {
        stageRunId,
        jobId: `local-${stageRunId.slice(0, 8)}`,
        status: "done",
        transcriptArtifactId: jsonArtifactId,
        transcriptTextArtifactId: txtArtifactId
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isCancelled = Boolean(options.signal?.aborted || errorMsg.toLowerCase().includes("cancel"));
      const errTime = this.now();

      if (isCancelled) {
        this.logger.info("Local transcription cancelled by user", { meetingId });
        await this.db
          .updateTable("stage_runs")
          .set({
            status: "cancelled",
            last_error: "Cancelled by user",
            finished_at: errTime,
            updated_at: errTime
          })
          .where("id", "=", stageRunId)
          .execute();

        const existingMeeting = await this.db
          .selectFrom("meetings")
          .select(["primary_transcript_artifact_id"])
          .where("id", "=", meetingId)
          .executeTakeFirst();

        await this.db
          .updateTable("meetings")
          .set({
            status: existingMeeting?.primary_transcript_artifact_id ? "ready" : "pending",
            last_error: null,
            updated_at: errTime
          })
          .where("id", "=", meetingId)
          .execute();

        return {
          stageRunId,
          jobId: "",
          status: "cancelled",
          error: "Cancelled by user"
        };
      }

      this.logger.error("Failed to run local transcription", { meetingId, error: errorMsg });

      await this.db
        .updateTable("stage_runs")
        .set({
          status: "error",
          last_error: errorMsg,
          finished_at: errTime,
          updated_at: errTime
        })
        .where("id", "=", stageRunId)
        .execute();

      await this.db
        .updateTable("meetings")
        .set({ last_error: errorMsg, updated_at: errTime })
        .where("id", "=", meetingId)
        .execute();

      return {
        stageRunId,
        jobId: "",
        status: "error",
        error: errorMsg
      };
    }
  }

  async transcribeMeetingSpeechmatics(
    meetingId: string,
    options: TranscribeMeetingOptions = {}
  ): Promise<TranscribeMeetingResult> {
    const meeting = await this.db
      .selectFrom("meetings")
      .selectAll()
      .where("id", "=", meetingId)
      .executeTakeFirst();

    if (!meeting) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }

    const recording = await this.db
      .selectFrom("recordings")
      .selectAll()
      .where("meeting_id", "=", meetingId)
      .orderBy("created_at", "asc")
      .executeTakeFirst();

    if (!recording) {
      throw new Error(`No recording found for meeting ${meetingId}`);
    }

    const folder = meetingPaths(this.meetingsDir, meeting.start_time, meeting.title, meeting.id).folder;
    const audioFullPath = join(folder, recording.path);

    if (!existsSync(audioFullPath)) {
      throw new Error(`Audio file not found on disk at ${audioFullPath}`);
    }

    let stageRun = await this.db
      .selectFrom("stage_runs")
      .selectAll()
      .where("meeting_id", "=", meetingId)
      .where("stage", "=", STAGE_SPEECHMATICS_TRANSCRIBE)
      .executeTakeFirst();

    if (stageRun?.status === "done" && !options.force) {
      const existingArtifact = await this.db
        .selectFrom("artifacts")
        .select("id")
        .where("meeting_id", "=", meetingId)
        .where("provider", "=", PROVIDER_SPEECHMATICS)
        .where("kind", "=", "transcript")
        .where("format", "=", "json")
        .executeTakeFirst();

      return {
        stageRunId: stageRun.id,
        jobId: stageRun.provider_job_id ?? "",
        status: "done",
        transcriptArtifactId: existingArtifact?.id
      };
    }

    await options.onProgress?.({
      stage: "decoding",
      percent: 5,
      message: "Preparing audio and speaker profiles for Speechmatics..."
    });

    const stageRunId = stageRun?.id ?? randomUUID();
    const currentTime = this.now();

    // Query enrolled speakers to attach to Speechmatics config for cross-recording identification
    const speakers = await this.getEnrolledSpeechmaticsSpeakers();
    const speakerConfigs: SpeechmaticsSpeakerConfig[] = speakers
      .filter((s) => s.providerIds[PROVIDER_SPEECHMATICS]?.length)
      .map((s) => ({
        label: s.name,
        speaker_identifiers: s.providerIds[PROVIDER_SPEECHMATICS]!
      }));

    const webhookUrl = this.webhookUrl
      ? `${this.webhookUrl}?meetingId=${encodeURIComponent(meetingId)}&stageRunId=${encodeURIComponent(stageRunId)}`
      : undefined;

    await options.onProgress?.({
      stage: "diarizing",
      percent: 15,
      message: "Uploading audio to Speechmatics Cloud API..."
    });

    let submitResult;
    try {
      submitResult = await this.client.submitJob({
        audio: { path: audioFullPath },
        filename: basename(recording.path),
        mime: recording.mime,
        language: options.language || "en",
        speakers: speakerConfigs.length > 0 ? speakerConfigs : undefined,
        getSpeakers: true,
        webhookUrl,
        webhookSecret: this.webhookSecret
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error("Failed to submit Speechmatics job", { meetingId, error: errorMsg });

      if (stageRun) {
        await this.db
          .updateTable("stage_runs")
          .set({
            status: "error",
            last_error: errorMsg,
            attempts: stageRun.attempts + 1,
            updated_at: currentTime
          })
          .where("id", "=", stageRun.id)
          .execute();
      } else {
        await this.db
          .insertInto("stage_runs")
          .values({
            id: stageRunId,
            meeting_id: meetingId,
            stage: STAGE_SPEECHMATICS_TRANSCRIBE,
            status: "error",
            provider_job_id: null,
            attempts: 1,
            last_error: errorMsg,
            started_at: currentTime,
            finished_at: currentTime,
            created_at: currentTime,
            updated_at: currentTime
          })
          .execute();
      }

      await this.db
        .updateTable("meetings")
        .set({ last_error: errorMsg, updated_at: currentTime })
        .where("id", "=", meetingId)
        .execute();

      return {
        stageRunId,
        jobId: "",
        status: "error",
        error: errorMsg
      };
    }

    if (stageRun) {
      await this.db
        .updateTable("stage_runs")
        .set({
          status: "running",
          provider_job_id: submitResult.id,
          attempts: stageRun.attempts + 1,
          last_error: null,
          started_at: currentTime,
          updated_at: currentTime
        })
        .where("id", "=", stageRun.id)
        .execute();
    } else {
      await this.db
        .insertInto("stage_runs")
        .values({
          id: stageRunId,
          meeting_id: meetingId,
          stage: STAGE_SPEECHMATICS_TRANSCRIBE,
          status: "running",
          provider_job_id: submitResult.id,
          attempts: 1,
          last_error: null,
          started_at: currentTime,
          finished_at: null,
          created_at: currentTime,
          updated_at: currentTime
        })
        .execute();
    }

    await options.onProgress?.({
      stage: "transcribing",
      percent: 25,
      message: `Job ${submitResult.id.slice(0, 10)}... accepted by Speechmatics. Cloud processing...`
    });

    const currentActive = this.activeJobs.get(meetingId);
    if (currentActive) {
      currentActive.stageRunId = stageRunId;
      currentActive.jobId = submitResult.id;
    }

    if (options.poll) {
      return await this.pollUntilComplete(
        meetingId,
        stageRunId,
        submitResult.id,
        options.pollIntervalMs ?? 2000,
        options.maxPollWaitMs ?? 180_000,
        options.onProgress,
        options.signal
      );
    }

    return {
      stageRunId,
      jobId: submitResult.id,
      status: "running"
    };
  }

  async pollUntilComplete(
    meetingId: string,
    stageRunId: string,
    jobId: string,
    intervalMs = 2000,
    maxWaitMs = 180_000,
    onProgress?: (update: TranscriptionProgressUpdate) => void | Promise<void>,
    signal?: AbortSignal
  ): Promise<TranscribeMeetingResult> {
    const startTime = this.now();
    let pollCount = 0;

    while (this.now() - startTime < maxWaitMs) {
      if (signal?.aborted) {
        try {
          await this.client.deleteJob(jobId);
        } catch {}

        const cancelTime = this.now();
        await this.db
          .updateTable("stage_runs")
          .set({ status: "cancelled", last_error: "Cancelled by user", finished_at: cancelTime, updated_at: cancelTime })
          .where("id", "=", stageRunId)
          .execute();

        const existingMeeting = await this.db
          .selectFrom("meetings")
          .select(["primary_transcript_artifact_id"])
          .where("id", "=", meetingId)
          .executeTakeFirst();

        await this.db
          .updateTable("meetings")
          .set({
            status: existingMeeting?.primary_transcript_artifact_id ? "ready" : "pending",
            last_error: null,
            updated_at: cancelTime
          })
          .where("id", "=", meetingId)
          .execute();

        return {
          stageRunId,
          jobId,
          status: "cancelled",
          error: "Cancelled by user"
        };
      }

      pollCount++;
      const elapsedMs = this.now() - startTime;
      const elapsedSec = Math.round(elapsedMs / 1000);
      const percent = Math.min(92, Math.round(25 + Math.min(67, (elapsedSec / 45) * 67)));

      await onProgress?.({
        stage: "transcribing",
        percent,
        currentMs: elapsedMs,
        message: `Speechmatics cloud processing (poll #${pollCount}, ${elapsedSec}s elapsed)...`
      });

      const status = await this.client.getJob(jobId);

      if (status.status === "done") {
        await onProgress?.({
          stage: "finalizing",
          percent: 96,
          message: "Downloading transcript JSON & enrolling speaker voiceprints..."
        });

        const jsonV2 = (await this.client.getTranscript(jobId, "json-v2")) as SpeechmaticsJsonV2;
        const res = await this.completeTranscription(meetingId, stageRunId, jobId, jsonV2);

        await onProgress?.({
          stage: "done",
          percent: 100,
          message: "Speechmatics transcription complete!"
        });

        return res;
      }

      if (status.status === "rejected" || status.status === "deleted") {
        const errorMsg =
          status.errors && status.errors.length > 0
            ? status.errors.map((e) => e.message).join("; ")
            : `Speechmatics job ${status.status}`;

        const errTime = this.now();
        await this.db
          .updateTable("stage_runs")
          .set({ status: "error", last_error: errorMsg, finished_at: errTime, updated_at: errTime })
          .where("id", "=", stageRunId)
          .execute();

        await this.db
          .updateTable("meetings")
          .set({ last_error: errorMsg, updated_at: errTime })
          .where("id", "=", meetingId)
          .execute();

        return {
          stageRunId,
          jobId,
          status: "error",
          error: errorMsg
        };
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    const timeoutError = `Speechmatics job timed out after ${maxWaitMs}ms`;
    return {
      stageRunId,
      jobId,
      status: "running",
      error: timeoutError
    };
  }

  async completeTranscription(
    meetingId: string,
    stageRunId: string,
    jobId: string,
    jsonV2: SpeechmaticsJsonV2
  ): Promise<TranscribeMeetingResult> {
    const meeting = await this.db
      .selectFrom("meetings")
      .selectAll()
      .where("id", "=", meetingId)
      .executeTakeFirst();

    if (!meeting) {
      throw new Error(`Meeting ${meetingId} not found`);
    }

    const recording = await this.db
      .selectFrom("recordings")
      .select("id")
      .where("meeting_id", "=", meetingId)
      .executeTakeFirst();

    const canonicalTranscript = parseSpeechmaticsJsonV2(jsonV2);
    const transcriptText = transcriptToText(canonicalTranscript);
    const transcriptJson = `${JSON.stringify(canonicalTranscript, null, 2)}\n`;

    const paths = ensureMeetingFolder(
      meetingPaths(this.meetingsDir, meeting.start_time, meeting.title, meeting.id)
    );

    const jsonArtifactId = await this.ensureArtifact(
      meeting.id,
      recording?.id ?? null,
      "transcript",
      "json",
      "transcripts/speechmatics.json",
      transcriptJson,
      paths.transcriptsDir,
      PROVIDER_SPEECHMATICS
    );

    const txtArtifactId = await this.ensureArtifact(
      meeting.id,
      recording?.id ?? null,
      "transcript",
      "txt",
      "transcripts/speechmatics.txt",
      `${transcriptText}\n`,
      paths.transcriptsDir,
      PROVIDER_SPEECHMATICS
    );

    // Save discovered speakers & links
    await this.persistDiscoveredSpeakers(meeting.id, jsonArtifactId, canonicalTranscript, jsonV2);

    const completedAt = this.now();

    // Set primary transcript artifact on meeting
    await this.db
      .updateTable("meetings")
      .set({
        primary_transcript_artifact_id: jsonArtifactId,
        status: "ready",
        last_error: null,
        updated_at: completedAt
      })
      .where("id", "=", meeting.id)
      .execute();

    // Mark stage run as done
    await this.db
      .updateTable("stage_runs")
      .set({
        status: "done",
        last_error: null,
        finished_at: completedAt,
        updated_at: completedAt
      })
      .where("id", "=", stageRunId)
      .execute();

    // Trigger auto-summarization hook
    void this.autoSummarize(meeting.id);

    // Delete job from Speechmatics for 7-day retention cleanup hygiene
    try {
      if (jobId) {
        await this.client.deleteJob(jobId);
      }
    } catch (cleanupError) {
      this.logger.warn("Failed to delete Speechmatics job after completion", {
        jobId,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      });
    }

    return {
      stageRunId,
      jobId,
      status: "done",
      transcriptArtifactId: jsonArtifactId,
      transcriptTextArtifactId: txtArtifactId
    };
  }

  private async ensureArtifact(
    meetingId: string,
    recordingId: string | null,
    kind: "transcript" | "summary",
    format: "json" | "txt" | "md",
    relativePath: string,
    content: string,
    directory: string,
    provider: string
  ): Promise<string> {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, relativePath.split("/").at(-1)!), content, "utf8");

    const existing = await this.db
      .selectFrom("artifacts")
      .select("id")
      .where("meeting_id", "=", meetingId)
      .where("provider", "=", provider)
      .where("kind", "=", kind)
      .where("format", "=", format)
      .where("path", "=", relativePath)
      .executeTakeFirst();

    if (existing) {
      return existing.id;
    }

    const id = randomUUID();
    await this.db
      .insertInto("artifacts")
      .values({
        id,
        meeting_id: meetingId,
        recording_id: recordingId,
        kind,
        provider,
        format,
        path: relativePath,
        created_at: this.now()
      })
      .execute();

    return id;
  }

  private async persistLocalDiscoveredSpeakers(
    meetingId: string,
    evidenceArtifactId: string,
    discoveredSpeakers: DiscoveredSpeakerVoiceprint[]
  ): Promise<void> {
    const currentTime = this.now();

    for (const discovered of discoveredSpeakers) {
      const allSpeakers = await this.db.selectFrom("speakers").selectAll().execute();
      const normalizedName = discovered.name.trim().toLocaleLowerCase();
      const existing = allSpeakers.find(
        (speaker) => speaker.name.trim().toLocaleLowerCase() === normalizedName
      );

      const speakerId = existing?.id ?? (discovered.isEnrolled ? discovered.speakerId : randomUUID());

      // If speaker does not exist in DB, insert a new placeholder record without pretending it's an enrolled voiceprint
      if (!existing) {
        await this.db
          .insertInto("speakers")
          .values({
            id: speakerId,
            name: discovered.name,
            provider_ids: "{}",
            enrolled_at: null,
            enrollment_clip_paths: "[]",
            created_at: currentTime
          })
          .execute();
      }

      await this.db
        .insertInto("meeting_speakers")
        .values({
          meeting_id: meetingId,
          speaker_id: speakerId,
          evidence_artifact_id: evidenceArtifactId
        })
        .onConflict((conflict) =>
          conflict.columns(["meeting_id", "speaker_id"]).doUpdateSet({ evidence_artifact_id: evidenceArtifactId })
        )
        .execute();
    }
  }

  private async persistDiscoveredSpeakers(
    meetingId: string,
    evidenceArtifactId: string,
    transcript: Transcript,
    jsonV2: SpeechmaticsJsonV2
  ): Promise<void> {
    const speakerSummaryMap = new Map<string, string[]>();
    for (const s of (jsonV2.speakers ?? []) as any[]) {
      const name = (s.label || s.speaker || "").trim();
      const identifiers = s.speaker_identifiers instanceof Set
        ? Array.from(s.speaker_identifiers)
        : Array.isArray(s.speaker_identifiers)
        ? s.speaker_identifiers
        : [];
      if (name && identifiers.length > 0) {
        speakerSummaryMap.set(name, identifiers);
      }
    }

    const uniqueSpeakers = new Set(
      transcript.segments.map((s) => s.speaker.trim()).filter(Boolean)
    );

    const currentTime = this.now();

    for (const name of uniqueSpeakers) {
      const allSpeakers = await this.db.selectFrom("speakers").selectAll().execute();
      const normalizedName = name.toLocaleLowerCase();
      const existing = allSpeakers.find(
        (speaker) => speaker.name.trim().toLocaleLowerCase() === normalizedName
      );

      const speakerIdentifiers = speakerSummaryMap.get(name) ?? [];
      const speakerId = existing?.id ?? randomUUID();

      if (existing) {
        const providerIds = parseJsonField<Record<string, string[]>>(existing.provider_ids, {});
        const existingSpeechmaticsIds = new Set(providerIds[PROVIDER_SPEECHMATICS] ?? []);
        for (const id of speakerIdentifiers) {
          existingSpeechmaticsIds.add(id);
        }
        providerIds[PROVIDER_SPEECHMATICS] = Array.from(existingSpeechmaticsIds);

        await this.db
          .updateTable("speakers")
          .set({
            provider_ids: JSON.stringify(providerIds)
          })
          .where("id", "=", existing.id)
          .execute();
      } else {
        const providerIds: Record<string, string[]> = {};
        if (speakerIdentifiers.length > 0) {
          providerIds[PROVIDER_SPEECHMATICS] = speakerIdentifiers;
        }

        const isPlaceholder = /^speaker\s*\d+$/i.test(name.trim()) || /^s\d+$/i.test(name.trim());

        await this.db
          .insertInto("speakers")
          .values({
            id: speakerId,
            name,
            provider_ids: JSON.stringify(providerIds),
            enrolled_at: !isPlaceholder && speakerIdentifiers.length > 0 ? currentTime : null,
            enrollment_clip_paths: "[]",
            created_at: currentTime
          })
          .execute();
      }

      await this.db
        .insertInto("meeting_speakers")
        .values({
          meeting_id: meetingId,
          speaker_id: speakerId,
          evidence_artifact_id: evidenceArtifactId
        })
        .onConflict((conflict) =>
          conflict.columns(["meeting_id", "speaker_id"]).doUpdateSet({ evidence_artifact_id: evidenceArtifactId })
        )
        .execute();
    }
  }

  private async getEnrolledSpeakers(): Promise<EnrolledSpeaker[]> {
    const rows = await this.db.selectFrom("speakers").selectAll().execute();
    return rows
      .filter((row) => {
        const name = row.name.trim();
        const isPlaceholder = /^speaker\s*\d+$/i.test(name) || /^s\d+$/i.test(name);
        return !isPlaceholder;
      })
      .map((row) => ({
        id: row.id,
        name: row.name,
        providerIds: parseJsonField<Record<string, string[]>>(row.provider_ids, {})
      }));
  }

  private async getEnrolledSpeechmaticsSpeakers(): Promise<EnrolledSpeaker[]> {
    const rows = await this.db.selectFrom("speakers").selectAll().execute();
    return rows
      .filter((row) => {
        const name = row.name.trim();
        const isPlaceholder = /^speaker\s*\d+$/i.test(name) || /^s\d+$/i.test(name);
        return !isPlaceholder;
      })
      .map((row) => ({
        id: row.id,
        name: row.name,
        providerIds: parseJsonField<Record<string, string[]>>(row.provider_ids, {})
      }));
  }
}
