import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Kysely } from "kysely";
import type { Database, MeetingListItem } from "@olive/shared";
import { getMeeting, listMeetings } from "../meetings.ts";
import { meetingPaths } from "../layout.ts";
import { SpeakerService } from "../speakers/service.ts";

export interface McpToolOptions {
  db: Kysely<Database>;
  meetingsDir: string;
  speakerService: SpeakerService;
}

const meetingFilters = {
  source: z.enum(["plaud", "upload", "ios-shortcut"]).optional().describe("Meeting source filter"),
  startTime: z.number().finite().optional().describe("Inclusive start timestamp in milliseconds"),
  endTime: z.number().finite().optional().describe("Inclusive end timestamp in milliseconds")
};

const pagination = {
  limit: z.number().int().min(1).max(100).optional().describe("Maximum number of results"),
  offset: z.number().int().min(0).optional().describe("Number of results to skip")
};

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }]
  };
}

function errorResult(error: unknown) {
  return {
    isError: true,
    content: [{
      type: "text" as const,
      text: error instanceof Error ? error.message : String(error)
    }]
  };
}

function parseSummaryActionItems(summary: string | null | undefined): Array<{ text: string; completed: boolean }> {
  if (!summary) return [];

  return summary
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      text: match[2],
      completed: match[1].toLowerCase() === "x"
    }));
}

async function loadTranscriptText(
  db: Kysely<Database>,
  meetingsDir: string,
  meeting: MeetingListItem
): Promise<string> {
  const artifacts = await db
    .selectFrom("artifacts")
    .select(["path", "format"])
    .where("meeting_id", "=", meeting.id)
    .where("kind", "=", "transcript")
    .orderBy("created_at", "desc")
    .execute();

  const artifact = artifacts.find((item) => item.format === "txt") || artifacts[0];
  if (!artifact) return "";

  try {
    return await readFile(join(meetingPaths(meetingsDir, meeting.startTime, meeting.title, meeting.id).folder, artifact.path), "utf8");
  } catch {
    return "";
  }
}

function transcriptSnippet(text: string, query: string): string | undefined {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerText.indexOf(lowerQuery);
  if (matchIndex < 0) return undefined;

  const start = Math.max(0, matchIndex - 160);
  const end = Math.min(text.length, matchIndex + query.length + 240);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

async function listAllMeetings(options: McpToolOptions, query: {
  source?: "plaud" | "upload" | "ios-shortcut";
  startTime?: number;
  endTime?: number;
}): Promise<MeetingListItem[]> {
  const meetings: MeetingListItem[] = [];
  let offset = 0;
  let total = 0;

  do {
    const response = await listMeetings(options.db, { ...query, limit: 100, offset }, options.meetingsDir);
    meetings.push(...response.meetings);
    total = response.pagination.total;
    offset += response.meetings.length;
  } while (offset < total && offset > 0);

  return meetings;
}

export function createMcpServer(options: McpToolOptions): McpServer {
  const server = new McpServer({
    name: "olive",
    version: "0.1.0"
  });

  server.registerTool(
    "list_meetings",
    {
      description: "List Olive meetings with optional text, source, and date filters.",
      inputSchema: z.object({
        search: z.string().trim().min(1).optional().describe("Search meeting titles, tags, transcripts, and summaries"),
        ...meetingFilters,
        ...pagination
      })
    },
    async ({ search, source, startTime, endTime, limit, offset }) => {
      try {
        const response = await listMeetings(options.db, { search, source, startTime, endTime, limit, offset }, options.meetingsDir);
        const meetings = response.meetings;
        return textResult({
          meetings,
          pagination: response.pagination
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "get_meeting",
    {
      description: "Get a complete Olive meeting record, including transcript and summaries.",
      inputSchema: z.object({
        meetingId: z.string().min(1).describe("Meeting ID")
      })
    },
    async ({ meetingId }) => {
      try {
        const meeting = await getMeeting(options.db, meetingId, options.meetingsDir);
        if (!meeting) return errorResult("Meeting not found");
        return textResult(meeting);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "search_transcripts",
    {
      description: "Search transcript text across Olive meetings and return matching snippets.",
      inputSchema: z.object({
        query: z.string().trim().min(1).describe("Text to search for"),
        ...meetingFilters,
        ...pagination
      })
    },
    async ({ query, source, startTime, endTime, limit = 50, offset = 0 }) => {
      try {
        const candidates = await listAllMeetings(options, { source, startTime, endTime });
        const matches: Array<{ meeting: MeetingListItem; snippet: string }> = [];

        for (const meeting of candidates) {
          const text = await loadTranscriptText(options.db, options.meetingsDir, meeting);
          const snippet = transcriptSnippet(text, query);
          if (snippet) matches.push({ meeting, snippet });
        }

        return textResult({
          matches: matches.slice(offset, offset + limit),
          pagination: { limit, offset, total: matches.length }
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "get_action_items",
    {
      description: "Extract checklist-style action items from Olive meeting summaries.",
      inputSchema: z.object({
        meetingId: z.string().min(1).optional().describe("Meeting ID; omit to search all meetings"),
        includeCompleted: z.boolean().optional().default(true).describe("Include completed checklist items"),
        ...meetingFilters,
        ...pagination
      })
    },
    async ({ meetingId, includeCompleted = true, source, startTime, endTime, limit = 50, offset = 0 }) => {
      try {
        let meetings: MeetingListItem[];
        if (meetingId) {
          const detail = await getMeeting(options.db, meetingId, options.meetingsDir);
          if (!detail) return errorResult("Meeting not found");
          meetings = [detail.meeting];
        } else {
          meetings = await listAllMeetings(options, { source, startTime, endTime });
        }

        const actionItems: Array<{ meetingId: string; meetingTitle: string; text: string; completed: boolean }> = [];
        for (const meeting of meetings) {
          const detail = await getMeeting(options.db, meeting.id, options.meetingsDir);
          for (const item of parseSummaryActionItems(detail?.summaryContent)) {
            if (includeCompleted || !item.completed) {
              actionItems.push({ meetingId: meeting.id, meetingTitle: meeting.title, ...item });
            }
          }
        }

        return textResult({
          actionItems: actionItems.slice(offset, offset + limit),
          pagination: { limit, offset, total: actionItems.length }
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "list_speakers",
    {
      description: "List Olive speaker profiles and meeting counts.",
      inputSchema: z.object({})
    },
    async () => {
      try {
        return textResult({ speakers: await options.speakerService.listSpeakers() });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "get_speaker_profile",
    {
      description: "Get a speaker profile and associated meetings.",
      inputSchema: z.object({
        speakerId: z.string().min(1).describe("Speaker ID")
      })
    },
    async ({ speakerId }) => {
      try {
        const speaker = await options.speakerService.getSpeaker(speakerId);
        if (!speaker) return errorResult("Speaker not found");
        return textResult(speaker);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  return server;
}
