import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Kysely } from "kysely";
import type {
  Artifact,
  ArtifactRow,
  Database,
  MeetingDetailAggregate,
  MeetingListItem,
  MeetingRow,
  MeetingSummaryItem,
  Recording,
  RecordingRow,
  Speaker,
  SpeakerRow,
  StageRunRow
} from "@olive/shared";
import { meetingPaths } from "./layout.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface MeetingListQuery {
  limit: number;
  offset: number;
  search?: string;
  source?: MeetingRow["source"];
  startTime?: number;
  endTime?: number;
}

export interface MeetingListResponse {
  meetings: MeetingListItem[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
}

export type MeetingDetailResponse = MeetingDetailAggregate;

function parseTags(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonField<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
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

function toRecording(row: RecordingRow): Recording {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    path: row.path,
    mime: row.mime,
    durationMs: row.duration_ms,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    provider: row.provider,
    providerRecordingId: row.provider_recording_id,
    createdAt: row.created_at
  };
}

function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    recordingId: row.recording_id,
    kind: row.kind,
    provider: row.provider,
    format: row.format,
    path: row.path,
    createdAt: row.created_at
  };
}

function toSpeaker(row: SpeakerRow): Speaker {
  return {
    id: row.id,
    name: row.name,
    providerIds: parseJsonField<Record<string, string[]>>(row.provider_ids, {}),
    enrolledAt: row.enrolled_at,
    enrollmentClipPaths: parseJsonField<string[]>(row.enrollment_clip_paths, []),
    createdAt: row.created_at
  };
}

export async function listMeetings(
  db: Kysely<Database>,
  query: Partial<MeetingListQuery> = {},
  meetingsDir?: string
): Promise<MeetingListResponse> {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
  const search = query.search?.trim();

  let matchingIds: Set<string> | null = null;

  if (search) {
    matchingIds = new Set<string>();
    const pattern = `%${search}%`;

    // 1. Direct title and tags match
    const titleTagMatches = await db
      .selectFrom("meetings")
      .select("id")
      .where((eb) => eb.or([eb("title", "like", pattern), eb("tags", "like", pattern)]))
      .execute();

    for (const m of titleTagMatches) {
      matchingIds.add(m.id);
    }

    // 2. Full-text search in transcript and summary artifacts
    if (meetingsDir) {
      const contentArtifacts = await db
        .selectFrom("artifacts")
        .innerJoin("meetings", "meetings.id", "artifacts.meeting_id")
        .select([
          "artifacts.meeting_id",
          "artifacts.path",
          "meetings.start_time",
          "meetings.title",
          "meetings.id as m_id"
        ])
        .where("artifacts.kind", "in", ["transcript", "summary"])
        .execute();

      const searchLower = search.toLowerCase();
      for (const a of contentArtifacts) {
        if (matchingIds.has(a.meeting_id)) continue;
        try {
          const folder = meetingPaths(meetingsDir, a.start_time, a.title, a.m_id).folder;
          const fullPath = join(folder, a.path);
          if (existsSync(fullPath)) {
            const text = await readFile(fullPath, "utf8");
            if (text.toLowerCase().includes(searchLower)) {
              matchingIds.add(a.meeting_id);
            }
          }
        } catch {
          // ignore
        }
      }
    }
  }

  const applyFilters = <T extends { where: (...args: any[]) => T }>(builder: T): T => {
    if (!matchingIds) {
      return builder;
    }
    if (matchingIds.size === 0) {
      return builder.where("id", "=", "__no_match__");
    }
    return builder.where("id", "in", Array.from(matchingIds));
  };

  let rowsQuery = applyFilters(db.selectFrom("meetings"));
  let countQuery = applyFilters(db.selectFrom("meetings"));
  if (query.source) {
    rowsQuery = rowsQuery.where("source", "=", query.source);
    countQuery = countQuery.where("source", "=", query.source);
  }
  if (query.startTime !== undefined) {
    rowsQuery = rowsQuery.where("start_time", ">=", query.startTime);
    countQuery = countQuery.where("start_time", ">=", query.startTime);
  }
  if (query.endTime !== undefined) {
    rowsQuery = rowsQuery.where("start_time", "<=", query.endTime);
    countQuery = countQuery.where("start_time", "<=", query.endTime);
  }
  const [rows, totalRow] = await Promise.all([
    rowsQuery.selectAll().orderBy("start_time", "desc").limit(limit).offset(offset).execute(),
    countQuery.select(({ fn }) => fn.count<number>("id").as("count")).executeTakeFirstOrThrow()
  ]);

  return {
    meetings: rows.map((row) => toMeeting(row)),
    pagination: {
      limit,
      offset,
      total: Number(totalRow.count)
    }
  };
}

export async function getMeeting(
  db: Kysely<Database>,
  id: string,
  meetingsDir?: string
): Promise<MeetingDetailResponse | null> {
  const meetingRow = await db
    .selectFrom("meetings")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();

  if (!meetingRow) {
    return null;
  }

  const [recordingRows, artifactRows, meetingSpeakerRows, stageRuns] = await Promise.all([
    db.selectFrom("recordings").selectAll().where("meeting_id", "=", id).orderBy("created_at", "asc").execute(),
    db.selectFrom("artifacts").selectAll().where("meeting_id", "=", id).orderBy("created_at", "asc").execute(),
    db.selectFrom("meeting_speakers").selectAll().where("meeting_id", "=", id).execute(),
    db.selectFrom("stage_runs").selectAll().where("meeting_id", "=", id).orderBy("created_at", "asc").execute()
  ]);

  const speakerIds = meetingSpeakerRows.map((ms) => ms.speaker_id);
  const speakerRows =
    speakerIds.length > 0
      ? await db.selectFrom("speakers").selectAll().where("id", "in", speakerIds).execute()
      : [];

  let transcriptContent: string | null = null;
  let summaryContent: string | null = null;
  const summaries: MeetingSummaryItem[] = [];

  if (meetingsDir) {
    const folder = meetingPaths(meetingsDir, meetingRow.start_time, meetingRow.title, meetingRow.id).folder;

    const primaryTranscript = artifactRows.find((a) => a.id === meetingRow.primary_transcript_artifact_id);
    if (primaryTranscript) {
      try {
        transcriptContent = await readFile(join(folder, primaryTranscript.path), "utf8");
      } catch {
        // file unreadable or not on disk yet
      }
    }

    const primarySummary = artifactRows.find((a) => a.id === meetingRow.primary_summary_artifact_id);
    if (primarySummary) {
      try {
        summaryContent = await readFile(join(folder, primarySummary.path), "utf8");
      } catch {
        // file unreadable or not on disk yet
      }
    }

    // Load all summary artifacts
    const summaryArtifacts = artifactRows.filter((a) => a.kind === "summary");
    for (const sa of summaryArtifacts) {
      try {
        const content = await readFile(join(folder, sa.path), "utf8");
        summaries.push({
          id: sa.id,
          provider: sa.provider,
          format: sa.format,
          path: sa.path,
          createdAt: sa.created_at,
          content,
          isPrimary: sa.id === meetingRow.primary_summary_artifact_id
        });
      } catch {
        // file not yet on disk
      }
    }
  }

  // Sort summaries newest first
  summaries.sort((a, b) => b.createdAt - a.createdAt);

  let activeSpeakerRows = speakerRows;
  if (transcriptContent) {
    try {
      const parsed = JSON.parse(transcriptContent);
      const segs = Array.isArray(parsed.segments)
        ? parsed.segments
        : Array.isArray(parsed)
        ? parsed
        : [];
      const namesInTranscript = new Set(
        segs.map((s: any) => (s.speaker || s.name || "").trim().toLowerCase()).filter(Boolean)
      );
      if (namesInTranscript.size > 0) {
        activeSpeakerRows = speakerRows.filter((s) => namesInTranscript.has(s.name.trim().toLowerCase()));
      }
    } catch {
      // ignore json parse errors
    }
  }

  return {
    meeting: toMeeting(meetingRow),
    recordings: recordingRows.map((r) => toRecording(r)),
    artifacts: artifactRows.map((a) => toArtifact(a)),
    speakers: activeSpeakerRows.map((s) => toSpeaker(s)),
    stageRuns,
    transcriptContent,
    summaryContent,
    summaries
  };
}

export async function deleteMeeting(db: Kysely<Database>, id: string, meetingsDir?: string): Promise<boolean> {
  const meetingRow = await db.selectFrom("meetings").selectAll().where("id", "=", id).executeTakeFirst();
  if (!meetingRow) {
    return false;
  }

  await db.transaction().execute(async (trx) => {
    // Clear the meeting's references to artifacts first to avoid FK violations.
    await trx
      .updateTable("meetings")
      .set({ primary_transcript_artifact_id: null, primary_summary_artifact_id: null })
      .where("id", "=", id)
      .execute();

    await trx.deleteFrom("meeting_speakers").where("meeting_id", "=", id).execute();
    await trx.deleteFrom("stage_runs").where("meeting_id", "=", id).execute();
    await trx.deleteFrom("plaud_ingest_state").where("meeting_id", "=", id).execute();
    await trx.deleteFrom("chat_messages").where("meeting_id", "=", id).execute();
    await trx.deleteFrom("logs").where("meeting_id", "=", id).execute();
    await trx.deleteFrom("artifacts").where("meeting_id", "=", id).execute();
    await trx.deleteFrom("recordings").where("meeting_id", "=", id).execute();
    await trx.deleteFrom("meetings").where("id", "=", id).execute();
  });

  if (meetingsDir) {
    const folder = meetingPaths(meetingsDir, meetingRow.start_time, meetingRow.title, meetingRow.id).folder;
    try {
      await rm(folder, { recursive: true, force: true });
    } catch {
      // folder may not exist on disk
    }
  }

  return true;
}
