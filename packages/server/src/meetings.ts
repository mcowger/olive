import type { Kysely } from "kysely";
import type { Database, MeetingListItem, MeetingRow } from "@olive/shared";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface MeetingListQuery {
  limit: number;
  offset: number;
  search?: string;
}

export interface MeetingListResponse {
  meetings: MeetingListItem[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
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

export async function listMeetings(
  db: Kysely<Database>,
  query: Partial<MeetingListQuery> = {}
): Promise<MeetingListResponse> {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
  const search = query.search?.trim();
  const applyFilters = <T extends { where: (...args: any[]) => T }>(builder: T): T => {
    if (!search) {
      return builder;
    }

    const pattern = `%${search}%`;
    return builder.where((expressionBuilder: any) =>
      expressionBuilder.or([
        expressionBuilder("title", "like", pattern),
        expressionBuilder("tags", "like", pattern)
      ])
    );
  };

  const rowsQuery = applyFilters(db.selectFrom("meetings"));
  const countQuery = applyFilters(db.selectFrom("meetings"));
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
