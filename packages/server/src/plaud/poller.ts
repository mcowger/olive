import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type {
  FileDetail,
  FileSummary,
  Segment
} from "@mcowger/plaud-client";
import {
  extractSummaryNotes,
  parseTranscriptSegments,
  segmentsToText
} from "@mcowger/plaud-client";
import type { Kysely } from "kysely";
import type { Database, MeetingRow, PlaudIngestStateRow } from "@olive/shared";
import { ensureMeetingFolder, meetingPaths } from "../layout.ts";
import { logger as defaultLogger, type Logger } from "../logger.ts";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_PCS_WAIT_MS = 5 * 60 * 1000;
const DEFAULT_AUDIO_EXTENSION = "m4a";
const PLAUD_PROVIDER = "plaud";

export interface PlaudOAuthManager {
  startManualLogin(): Promise<{ authUrl: string; verifier: string; state: string }>;
  completeManualLogin(inputUrlOrCode: string, verifier: string, expectedState?: string): Promise<unknown>;
  getAccessToken?(): Promise<string | null>;
}

export interface PlaudClientLike {
  readonly oauth: PlaudOAuthManager;
  getCurrentUser(): Promise<unknown>;
  listFilesIterator(options?: {
    pageSize?: number;
    dateFrom?: Date | string;
    dateTo?: Date | string;
  }): AsyncIterableIterator<FileSummary>;
  getFile(id: string): Promise<FileDetail>;
}

export interface PlaudPollerOptions {
  db: Kysely<Database>;
  meetingsDir: string;
  client: PlaudClientLike;
  transcriptionService?: { transcribeMeeting(meetingId: string, options?: any): Promise<any> };
  retranscribePlaudWhenUnnamed?: boolean;
  autoTranscribeWithSpeechmatics?: boolean;
  now?: () => number;
  fetchImpl?: (input: string) => Promise<Response>;
  logger?: Logger;
  pageSize?: number;
  pcsWaitMs?: number;
}

export interface PlaudPollResult {
  discoveryCompleted: boolean;
  discoveryError: string | null;
  discovered: number;
  resolved: number;
  pcsPending: number;
  startedAt: number;
  completedAt: number;
  error: string | null;
}

export interface PlaudStatus {
  connected: boolean;
  lastPollAt: number | null;
  pcsPending: number;
}

interface DownloadedAudio {
  bytes: Uint8Array;
  extension: string;
  mime: string;
  sha256: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseTimestamp(value: string | null | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const numericValue = Number(value);
  if (Number.isFinite(numericValue)) {
    return numericValue < 1_000_000_000_000 ? Math.round(numericValue * 1000) : Math.round(numericValue);
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function durationToMs(duration: number | null | undefined): number {
  if (duration === null || duration === undefined || !Number.isFinite(duration) || duration <= 0) {
    return 0;
  }

  // If duration is under 1000, it represents seconds (e.g. 12s -> 12000ms).
  // Otherwise, durations from Plaud API are in milliseconds (e.g. 252960ms -> ~4.2m).
  return duration < 1000 ? Math.round(duration * 1000) : Math.round(duration);
}

function normalizeSpeakerName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

export function isGenericPlaudSpeaker(name: string | null | undefined): boolean {
  if (!name?.trim()) {
    return true;
  }

  const normalized = name.trim().toLowerCase();
  return /^(?:speaker|speakers|spk|participant|person|unknown)(?:[\s_-]*\d+)?$/.test(normalized);
}

function extensionFromMime(mime: string): string | undefined {
  const normalized = mime.split(";", 1)[0].trim().toLowerCase();
  const extensions: Record<string, string> = {
    "audio/aac": "aac",
    "audio/flac": "flac",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/webm": "webm",
    "audio/x-m4a": "m4a",
    "audio/x-wav": "wav"
  };

  return extensions[normalized];
}

function extensionFromUrl(url: string): string | undefined {
  try {
    const extension = extname(new URL(url).pathname).slice(1).toLowerCase();
    return /^[a-z0-9]{1,8}$/.test(extension) ? extension : undefined;
  } catch {
    return undefined;
  }
}

function mimeForExtension(extension: string): string {
  const mimeTypes: Record<string, string> = {
    aac: "audio/aac",
    flac: "audio/flac",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    wav: "audio/wav",
    webm: "audio/webm"
  };

  return mimeTypes[extension] || "application/octet-stream";
}

function summaryToMarkdown(notes: Array<{ type: string; content: string }>): string {
  if (notes.length === 0) {
    return "";
  }

  return `${notes
    .map((note) => {
      const heading = note.type.trim() || "Summary";
      return `## ${heading.charAt(0).toUpperCase()}${heading.slice(1)}\n\n${note.content}`;
    })
    .join("\n\n")}\n`;
}

function contentIsReady(detail: FileDetail): boolean {
  return (detail.source_list?.length ?? 0) > 0 || (detail.note_list?.length ?? 0) > 0;
}

export class PlaudPoller {
  private readonly db: Kysely<Database>;
  private readonly meetingsDir: string;
  private readonly client: PlaudClientLike;
  private readonly transcriptionService?: { transcribeMeeting(meetingId: string, options?: any): Promise<any> };
  private readonly retranscribePlaudWhenUnnamed: boolean;
  private readonly autoTranscribeWithSpeechmatics: boolean;
  private readonly now: () => number;
  private readonly fetchImpl: (input: string) => Promise<Response>;
  private readonly logger: Logger;
  private readonly pageSize: number;
  private readonly pcsWaitMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<PlaudPollResult> | undefined;
  private connected = false;
  private lastPollAt: number | null = null;

  constructor(options: PlaudPollerOptions) {
    this.db = options.db;
    this.meetingsDir = options.meetingsDir;
    this.client = options.client;
    this.transcriptionService = options.transcriptionService;
    this.retranscribePlaudWhenUnnamed = options.retranscribePlaudWhenUnnamed ?? false;
    this.autoTranscribeWithSpeechmatics = options.autoTranscribeWithSpeechmatics ?? false;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger ?? defaultLogger;
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.pcsWaitMs = options.pcsWaitMs ?? DEFAULT_PCS_WAIT_MS;
  }

  get oauth(): PlaudOAuthManager {
    return this.client.oauth;
  }

  start(intervalMinutes: number): void {
    this.stop();
    const intervalMs = intervalMinutes * 60 * 1000;
    this.timer = setInterval(() => {
      void this.trigger();
    }, intervalMs);
    void this.trigger();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  trigger(): Promise<PlaudPollResult> {
    if (this.inFlight) {
      return this.inFlight;
    }

    const inFlight = this.runPoll().finally(() => {
      if (this.inFlight === inFlight) {
        this.inFlight = undefined;
      }
    });
    this.inFlight = inFlight;
    return inFlight;
  }

  async getStatus(): Promise<PlaudStatus> {
    if (this.lastPollAt === null) {
      const storedLastPoll = await this.db
        .selectFrom("sync_state")
        .select("value")
        .where("key", "=", "plaud:last_poll_at")
        .executeTakeFirst();
      const parsedLastPoll = storedLastPoll ? Number(storedLastPoll.value) : NaN;
      this.lastPollAt = Number.isFinite(parsedLastPoll) ? parsedLastPoll : null;
    }

    if (!this.connected && this.client.oauth.getAccessToken) {
      try {
        this.connected = Boolean(await this.client.oauth.getAccessToken());
      } catch {
        this.connected = false;
      }
    }

    if (!this.connected && !this.client.oauth.getAccessToken) {
      try {
        await this.client.getCurrentUser();
        this.connected = true;
      } catch {
        this.connected = false;
      }
    }

    return {
      connected: this.connected,
      lastPollAt: this.lastPollAt,
      pcsPending: await this.pendingCount()
    };
  }

  private async runPoll(): Promise<PlaudPollResult> {
    const startedAt = this.now();
    let discoveryCompleted = false;
    let discoveryError: string | null = null;
    let discovered = 0;
    let resolved = 0;
    let error: string | null = null;

    try {
      this.logger.debug("Starting Plaud polling cycle", {
        category: "plaud",
        pageSize: this.pageSize
      });
      discovered = await this.discover();
      discoveryCompleted = true;
      this.connected = true;
      const assetResult = await this.fetchPendingAssets();
      resolved = assetResult.resolved;
      error = assetResult.error;
      this.logger.debug("Plaud polling cycle finished", {
        category: "plaud",
        discovered,
        resolved,
        durationMs: this.now() - startedAt
      });
    } catch (pollError) {
      discoveryError = errorMessage(pollError);
      error = discoveryError;
      this.connected = false;
      this.logger.error("Plaud poll failed", { error });
    }

    const completedAt = this.now();
    const pcsPending = await this.pendingCount();
    this.lastPollAt = completedAt;
    await this.savePollState(completedAt, error);

    return {
      discoveryCompleted,
      discoveryError,
      discovered,
      resolved,
      pcsPending,
      startedAt,
      completedAt,
      error
    };
  }

  private async discover(): Promise<number> {
    let discovered = 0;

    for await (const file of this.client.listFilesIterator({ pageSize: this.pageSize })) {
      const existingRecording = await this.db
        .selectFrom("recordings")
        .select("id")
        .where("provider", "=", PLAUD_PROVIDER)
        .where("provider_recording_id", "=", file.id)
        .executeTakeFirst();
      const existingState = await this.db
        .selectFrom("plaud_ingest_state")
        .select("meeting_id")
        .where("plaud_file_id", "=", file.id)
        .executeTakeFirst();

      if (existingRecording || existingState) {
        continue;
      }

      const seenAt = this.now();
      const startTime = parseTimestamp(file.start_at ?? file.created_at, seenAt);
      const durationMs = durationToMs(file.duration);
      const meetingId = randomUUID();
      const title = file.name?.trim() || `Plaud recording ${file.id}`;

      await this.db.transaction().execute(async (transaction) => {
        const stateAlreadyExists = await transaction
          .selectFrom("plaud_ingest_state")
          .select("meeting_id")
          .where("plaud_file_id", "=", file.id)
          .executeTakeFirst();
        if (stateAlreadyExists) {
          return;
        }

        await transaction
          .insertInto("meetings")
          .values({
            id: meetingId,
            title,
            start_time: startTime,
            end_time: startTime + durationMs,
            source: "plaud",
            status: "processing",
            tags: "[]",
            primary_transcript_artifact_id: null,
            primary_summary_artifact_id: null,
            last_error: null,
            created_at: seenAt,
            updated_at: seenAt
          })
          .execute();
        await transaction
          .insertInto("plaud_ingest_state")
          .values({
            meeting_id: meetingId,
            plaud_file_id: file.id,
            first_seen_at: seenAt,
            pcs_deadline_at: seenAt + this.pcsWaitMs,
            pcs_resolved: 0
          })
          .execute();
        this.logger.debug("Discovered new Plaud recording", {
          category: "plaud",
          meetingId,
          plaudFileId: file.id,
          title,
          durationMs
        });
        discovered += 1;
      });
    }

    return discovered;
  }

  private async fetchPendingAssets(): Promise<{ resolved: number; error: string | null }> {
    const states = await this.db
      .selectFrom("plaud_ingest_state")
      .selectAll()
      .where("pcs_resolved", "=", 0)
      .execute();
    let resolved = 0;
    const errors: string[] = [];

    for (const state of states) {
      const meeting = await this.db
        .selectFrom("meetings")
        .selectAll()
        .where("id", "=", state.meeting_id)
        .executeTakeFirst();
      if (!meeting) {
        continue;
      }

      try {
        const detail = await this.client.getFile(state.plaud_file_id);
        const hasContent = contentIsReady(detail);
        const deadlineExpired =
          this.now() >= state.pcs_deadline_at ||
          this.now() - state.first_seen_at >= this.pcsWaitMs;

        if (hasContent) {
          await this.ingestReadyMeeting(meeting, state, detail);
          resolved += 1;
        } else if (deadlineExpired) {
          await this.ingestAudioOnlyMeeting(meeting, state, detail);
          resolved += 1;
        }
      } catch (error) {
        const message = errorMessage(error);
        errors.push(`${state.plaud_file_id}: ${message}`);
        await this.db
          .updateTable("meetings")
          .set({ last_error: message, status: "error", updated_at: this.now() })
          .where("id", "=", meeting.id)
          .execute();
        this.logger.error("Plaud asset fetch failed", {
          error: message,
          meetingId: meeting.id,
          plaudFileId: state.plaud_file_id
        });
      }
    }

    return { resolved, error: errors.length > 0 ? errors.join("; ") : null };
  }

  private async ingestReadyMeeting(meeting: MeetingRow, state: PlaudIngestStateRow, detail: FileDetail): Promise<void> {
    const recording = await this.ensureRecording(meeting, state, detail);
    const segments = parseTranscriptSegments(detail.source_list);
    const notes = extractSummaryNotes(detail.note_list);
    const paths = ensureMeetingFolder(meetingPaths(this.meetingsDir, meeting.start_time, meeting.title, meeting.id));

    let transcriptJsonArtifactId: string | null = null;
    if (segments.length > 0) {
      const transcriptJson = `${JSON.stringify(segments, null, 2)}\n`;
      const transcriptText = `${segmentsToText(segments)}\n`;
      transcriptJsonArtifactId = await this.ensureArtifact(
        meeting.id,
        recording.id,
        "transcript",
        "json",
        "transcripts/plaud.json",
        transcriptJson,
        paths.transcriptsDir
      );
      await this.ensureArtifact(
        meeting.id,
        recording.id,
        "transcript",
        "txt",
        "transcripts/plaud.txt",
        transcriptText,
        paths.transcriptsDir
      );
      await this.persistNamedSpeakers(meeting.id, transcriptJsonArtifactId, segments);
    }

    let summaryArtifactId: string | null = null;
    if (notes.length > 0) {
      const summaryMarkdown = summaryToMarkdown(notes);
      summaryArtifactId = await this.ensureArtifact(
        meeting.id,
        recording.id,
        "summary",
        "md",
        "summaries/plaud.md",
        summaryMarkdown,
        paths.summariesDir
      );
    }

    const resolvedAt = this.now();
    await this.db
      .updateTable("meetings")
      .set({
        primary_transcript_artifact_id: transcriptJsonArtifactId,
        primary_summary_artifact_id: summaryArtifactId,
        status: "ready",
        last_error: null,
        updated_at: resolvedAt
      })
      .where("id", "=", meeting.id)
      .execute();
    await this.db
      .updateTable("plaud_ingest_state")
      .set({ pcs_resolved: 1 })
      .where("meeting_id", "=", meeting.id)
      .execute();

    const hasOnlyGenericSpeakers = segments.length === 0 || segments.every((s) => isGenericPlaudSpeaker(s.speaker));
    if (this.transcriptionService && (this.autoTranscribeWithSpeechmatics || (this.retranscribePlaudWhenUnnamed && hasOnlyGenericSpeakers))) {
      try {
        await this.transcriptionService.transcribeMeeting(meeting.id);
      } catch (err) {
        this.logger.warn("Automatic Speechmatics transcription failed for Plaud meeting", {
          meetingId: meeting.id,
          error: errorMessage(err)
        });
      }
    }
  }

  private async ingestAudioOnlyMeeting(meeting: MeetingRow, state: PlaudIngestStateRow, detail: FileDetail): Promise<void> {
    this.logger.debug("Ingesting audio-only Plaud recording", {
      category: "plaud",
      meetingId: meeting.id,
      plaudFileId: state.plaud_file_id
    });
    await this.ensureRecording(meeting, state, detail);
    const resolvedAt = this.now();
    await this.db
      .updateTable("meetings")
      .set({ status: "ready", last_error: null, updated_at: resolvedAt })
      .where("id", "=", meeting.id)
      .execute();
    await this.db
      .updateTable("plaud_ingest_state")
      .set({ pcs_resolved: 1 })
      .where("meeting_id", "=", meeting.id)
      .execute();

    if (this.transcriptionService) {
      try {
        await this.transcriptionService.transcribeMeeting(meeting.id);
      } catch (err) {
        this.logger.warn("Automatic Speechmatics transcription failed for audio-only Plaud meeting", {
          meetingId: meeting.id,
          error: errorMessage(err)
        });
      }
    }
  }

  private async ensureRecording(
    meeting: MeetingRow,
    state: PlaudIngestStateRow,
    detail: FileDetail
  ): Promise<{ id: string; path: string }> {
    const existing = await this.db
      .selectFrom("recordings")
      .select(["id", "path"])
      .where("provider", "=", PLAUD_PROVIDER)
      .where("provider_recording_id", "=", state.plaud_file_id)
      .executeTakeFirst();
    if (existing) {
      const existingAbsolutePath = join(
        meetingPaths(this.meetingsDir, meeting.start_time, meeting.title, meeting.id).folder,
        existing.path
      );
      if (existsSync(existingAbsolutePath)) {
        return existing;
      }
    }

    const downloaded = await this.downloadAudio(detail);
    const existingByHash = await this.db
      .selectFrom("recordings")
      .select(["id", "meeting_id", "path"])
      .where("sha256", "=", downloaded.sha256)
      .executeTakeFirst();
    if (existingByHash) {
      if (existingByHash.meeting_id !== meeting.id) {
        throw new Error(`Audio hash already belongs to meeting ${existingByHash.meeting_id}`);
      }

      if (!existing) {
        await this.db
          .updateTable("recordings")
          .set({ provider_recording_id: state.plaud_file_id })
          .where("id", "=", existingByHash.id)
          .execute();
      }
      const meetingFolder = meetingPaths(this.meetingsDir, meeting.start_time, meeting.title, meeting.id).folder;
      const existingAbsolutePath = join(meetingFolder, existingByHash.path);
      await mkdir(join(meetingFolder, "audio"), { recursive: true });
      if (!existsSync(existingAbsolutePath)) {
        await writeFile(existingAbsolutePath, downloaded.bytes);
      }
      return { id: existingByHash.id, path: existingByHash.path };
    }

    const recordingId = existing?.id ?? randomUUID();
    const relativePath = join("audio", `${recordingId}.${downloaded.extension}`);
    const paths = ensureMeetingFolder(meetingPaths(this.meetingsDir, meeting.start_time, meeting.title, meeting.id));
    await writeFile(join(paths.folder, relativePath), downloaded.bytes);

    if (existing) {
      await this.db
        .updateTable("recordings")
        .set({
          path: relativePath,
          mime: downloaded.mime,
          duration_ms: durationToMs(detail.duration) || meeting.end_time - meeting.start_time,
          size_bytes: downloaded.bytes.byteLength,
          sha256: downloaded.sha256
        })
        .where("id", "=", existing.id)
        .execute();
      return { id: existing.id, path: relativePath };
    }

    await this.db
      .insertInto("recordings")
      .values({
        id: recordingId,
        meeting_id: meeting.id,
        path: relativePath,
        mime: downloaded.mime,
        duration_ms: durationToMs(detail.duration) || meeting.end_time - meeting.start_time,
        size_bytes: downloaded.bytes.byteLength,
        sha256: downloaded.sha256,
        provider: "plaud",
        provider_recording_id: state.plaud_file_id,
        created_at: this.now()
      })
      .execute();

    return { id: recordingId, path: relativePath };
  }

  private async downloadAudio(detail: FileDetail): Promise<DownloadedAudio> {
    if (!detail.presigned_url) {
      throw new Error("Plaud recording has no presigned audio URL");
    }

    const response = await this.fetchImpl(detail.presigned_url);
    if (!response.ok) {
      throw new Error(`Audio download failed with HTTP ${response.status}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const responseMime = response.headers.get("content-type") || "";
    const extension = extensionFromUrl(detail.presigned_url) || extensionFromMime(responseMime) || DEFAULT_AUDIO_EXTENSION;
    const mime = responseMime.toLowerCase().startsWith("audio/") ? responseMime.split(";", 1)[0] : mimeForExtension(extension);
    return { bytes, extension, mime, sha256 };
  }

  private async ensureArtifact(
    meetingId: string,
    recordingId: string,
    kind: "transcript" | "summary",
    format: "md" | "txt" | "json",
    relativePath: string,
    content: string,
    directory: string
  ): Promise<string> {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, relativePath.split("/").at(-1)!), content, "utf8");
    const existing = await this.db
      .selectFrom("artifacts")
      .select("id")
      .where("meeting_id", "=", meetingId)
      .where("provider", "=", PLAUD_PROVIDER)
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
        provider: PLAUD_PROVIDER,
        format,
        path: relativePath,
        created_at: this.now()
      })
      .execute();
    return id;
  }

  private async persistNamedSpeakers(meetingId: string, evidenceArtifactId: string, segments: Segment[]): Promise<void> {
    const names = new Set(
      segments
        .map((segment) => (segment.speaker ? normalizeSpeakerName(segment.speaker) : ""))
        .filter((name) => name && !isGenericPlaudSpeaker(name))
    );

    for (const name of names) {
      const speakers = await this.db.selectFrom("speakers").selectAll().execute();
      const normalizedName = name.toLocaleLowerCase();
      const existing = speakers.find((speaker) => speaker.name.trim().toLocaleLowerCase() === normalizedName);
      const speakerId = existing?.id ?? randomUUID();
      if (!existing) {
        await this.db
          .insertInto("speakers")
          .values({
            id: speakerId,
            name,
            provider_ids: "{}",
            enrolled_at: null,
            enrollment_clip_paths: "[]",
            created_at: this.now()
          })
          .execute();
      }

      await this.db
        .insertInto("meeting_speakers")
        .values({ meeting_id: meetingId, speaker_id: speakerId, evidence_artifact_id: evidenceArtifactId })
        .onConflict((conflict) =>
          conflict.columns(["meeting_id", "speaker_id"]).doUpdateSet({ evidence_artifact_id: evidenceArtifactId })
        )
        .execute();
    }
  }

  private async pendingCount(): Promise<number> {
    const row = await this.db
      .selectFrom("plaud_ingest_state")
      .select(({ fn }) => fn.count<number>("meeting_id").as("count"))
      .where("pcs_resolved", "=", 0)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  private async savePollState(completedAt: number, error: string | null): Promise<void> {
    await this.db
      .insertInto("sync_state")
      .values([
        { key: "plaud:last_poll_at", value: String(completedAt) },
        { key: "plaud:last_poll_error", value: error ?? "" }
      ])
      .onConflict((conflict) => conflict.column("key").doUpdateSet(({ ref }) => ({ value: ref("excluded.value") })))
      .execute();
  }
}
