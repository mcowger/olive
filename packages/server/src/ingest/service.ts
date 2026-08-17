import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Kysely } from "kysely";
import type { Database, MeetingListItem, MeetingRow, RecordingRow } from "@olive/shared";
import { ensureMeetingFolder, meetingPaths } from "../layout.ts";
import { logger as defaultLogger, type Logger } from "../logger.ts";
import type { TranscriptionService } from "../transcription/service.ts";

export interface IngestAudioOptions {
  audioBytes: Uint8Array;
  filename?: string;
  mime?: string;
  title?: string;
  source?: "upload" | "ios-shortcut" | "plaud";
  startTime?: number;
  durationMs?: number;
  autoTranscribe?: boolean;
  transcriptionProvider?: "speechmatics" | "local";
}

export interface IngestAudioResult {
  meetingId: string;
  recordingId: string;
  deduped: boolean;
  meeting: MeetingListItem;
  audioPath: string;
}

export interface IngestServiceOptions {
  db: Kysely<Database>;
  meetingsDir: string;
  transcriptionService?: TranscriptionService;
  logger?: Logger;
  now?: () => number;
}

function parseTags(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function toMeeting(row: MeetingRow): MeetingListItem {
  return {
    id: row.id,
    title: row.title,
    startTime: row.start_time,
    endTime: row.end_time,
    source: row.source,
    status: row.status,
    tags: parseTags(row.tags),
    primaryTranscriptArtifactId: row.primary_transcript_artifact_id,
    primarySummaryArtifactId: row.primary_summary_artifact_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function resolveExtensionAndMime(
  mimeHeader?: string,
  filename?: string
): { extension: string; mime: string } {
  let ext = filename ? extname(filename).slice(1).toLowerCase() : "";
  const normalizedMime = (mimeHeader || "").split(";", 1)[0].trim().toLowerCase();

  const mimeToExt: Record<string, string> = {
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/m4a": "m4a",
    "audio/aac": "aac",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/ogg": "ogg",
    "audio/vorbis": "ogg",
    "audio/flac": "flac",
    "audio/x-flac": "flac",
    "audio/webm": "webm"
  };

  const extToMime: Record<string, string> = {
    m4a: "audio/mp4",
    aac: "audio/aac",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    flac: "audio/flac",
    webm: "audio/webm"
  };

  if (!ext && mimeToExt[normalizedMime]) {
    ext = mimeToExt[normalizedMime];
  } else if (!ext) {
    ext = "m4a";
  }

  const finalMime =
    normalizedMime.startsWith("audio/") && normalizedMime !== "audio/x-m4a"
      ? normalizedMime
      : extToMime[ext] || "audio/mp4";

  return { extension: ext, mime: finalMime };
}

export class IngestService {
  private readonly db: Kysely<Database>;
  private readonly meetingsDir: string;
  private readonly transcriptionService?: TranscriptionService;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(options: IngestServiceOptions) {
    this.db = options.db;
    this.meetingsDir = options.meetingsDir;
    this.transcriptionService = options.transcriptionService;
    this.logger = options.logger ?? defaultLogger;
    this.now = options.now ?? Date.now;
  }

  async ingestAudio(options: IngestAudioOptions): Promise<IngestAudioResult> {
    const currentTime = this.now();
    const startTime = options.startTime || currentTime;
    const sha256 = createHash("sha256").update(options.audioBytes).digest("hex");

    this.logger.debug("Ingesting audio payload", {
      category: "ingest",
      sizeBytes: options.audioBytes.byteLength,
      mime: options.mime,
      filename: options.filename,
      sha256
    });

    // 1. SHA-256 Deduplication check
    const existingRecording = await this.db
      .selectFrom("recordings")
      .selectAll()
      .where("sha256", "=", sha256)
      .executeTakeFirst();

    if (existingRecording) {
      const existingMeeting = await this.db
        .selectFrom("meetings")
        .selectAll()
        .where("id", "=", existingRecording.meeting_id)
        .executeTakeFirst();

      if (existingMeeting) {
        this.logger.info("Audio upload deduplicated via SHA-256", {
          category: "ingest",
          sha256,
          meetingId: existingMeeting.id,
          recordingId: existingRecording.id
        });

        return {
          meetingId: existingMeeting.id,
          recordingId: existingRecording.id,
          deduped: true,
          meeting: toMeeting(existingMeeting),
          audioPath: existingRecording.path
        };
      }
    }

    // 2. Resolve filename, extension, and mime
    const { extension, mime } = resolveExtensionAndMime(options.mime, options.filename);
    const meetingId = randomUUID();
    const recordingId = randomUUID();
    const source = options.source || "upload";
    const durationMs = options.durationMs ?? null;
    const endTime = startTime + (durationMs || 0);

    const title =
      options.title?.trim() ||
      (options.filename
        ? options.filename.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " ")
        : `Audio Recording ${new Date(startTime).toLocaleDateString()}`);

    // 3. Write audio bytes to disk
    const paths = ensureMeetingFolder(meetingPaths(this.meetingsDir, startTime, title, meetingId));
    const relativePath = join("audio", `${recordingId}.${extension}`);
    const destinationAbsolutePath = join(paths.folder, relativePath);

    this.logger.debug("Writing ingested audio file to disk", {
      category: "ingest",
      meetingId,
      recordingId,
      destinationAbsolutePath,
      extension,
      mime
    });

    await writeFile(destinationAbsolutePath, options.audioBytes);

    // 4. Create Meeting and Recording records in database
    await this.db
      .insertInto("meetings")
      .values({
        id: meetingId,
        title,
        start_time: startTime,
        end_time: endTime,
        source,
        status: "ready",
        tags: "[]",
        primary_transcript_artifact_id: null,
        primary_summary_artifact_id: null,
        last_error: null,
        created_at: currentTime,
        updated_at: currentTime
      })
      .execute();

    await this.db
      .insertInto("recordings")
      .values({
        id: recordingId,
        meeting_id: meetingId,
        path: relativePath,
        mime,
        duration_ms: durationMs,
        size_bytes: options.audioBytes.byteLength,
        sha256,
        provider: source,
        provider_recording_id: null,
        created_at: currentTime
      })
      .execute();

    const createdMeeting = await this.db
      .selectFrom("meetings")
      .selectAll()
      .where("id", "=", meetingId)
      .executeTakeFirstOrThrow();

    this.logger.info("Audio ingested successfully", {
      category: "ingest",
      meetingId,
      recordingId,
      source,
      sizeBytes: options.audioBytes.byteLength,
      sha256
    });

    // 5. Trigger automatic transcription if requested
    if (options.autoTranscribe && this.transcriptionService) {
      this.logger.debug("Triggering auto-transcription after audio ingest", {
        category: "transcription",
        meetingId,
        provider: options.transcriptionProvider || "speechmatics"
      });

      void this.transcriptionService
        .transcribeMeeting(meetingId, {
          provider: options.transcriptionProvider || "speechmatics"
        })
        .catch((err) => {
          this.logger.error("Auto-transcription after ingest failed", {
            category: "transcription",
            meetingId,
            error: err instanceof Error ? err.message : String(err)
          });
        });
    }

    return {
      meetingId,
      recordingId,
      deduped: false,
      meeting: toMeeting(createdMeeting),
      audioPath: relativePath
    };
  }
}
