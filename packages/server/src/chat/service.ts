import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { ChatMessage, ChatMessageRow, Database, Transcript } from "@olive/shared";
import { meetingPaths } from "../layout.ts";
import { resolvePaths } from "../paths.ts";
import { LlmService } from "../llm/service.ts";

export interface ChatServiceOptions {
  db: Kysely<Database>;
  meetingsDir?: string;
  llmService?: LlmService;
}

export interface ChatStreamOptions {
  meetingId: string;
  content: string;
  onDelta: (delta: string) => void;
}

interface MeetingContext {
  systemPrompt: string;
}

function parseUsage(value: string | null): ChatMessage["usage"] {
  if (!value) return null;
  try {
    return JSON.parse(value) as ChatMessage["usage"];
  } catch {
    return null;
  }
}

function toChatMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    role: row.role,
    content: row.content,
    provider: row.provider,
    model: row.model,
    usage: parseUsage(row.usage),
    createdAt: row.created_at
  };
}

function formatTranscript(rawTranscript: string): string {
  try {
    const parsed = JSON.parse(rawTranscript) as Transcript;
    if (Array.isArray(parsed.segments)) {
      return parsed.segments
        .map((segment) => `${segment.speaker || "Unknown"}: ${segment.text}`)
        .join("\n\n");
    }
  } catch {
    // Keep plain-text transcript artifacts unchanged.
  }
  return rawTranscript;
}

export class ChatService {
  private readonly db: Kysely<Database>;
  private readonly meetingsDir: string;
  private readonly llmService: LlmService;

  constructor(options: ChatServiceOptions) {
    this.db = options.db;
    this.meetingsDir = options.meetingsDir ?? resolvePaths().meetingsDir;
    this.llmService = options.llmService ?? new LlmService({ db: this.db });
  }

  async getMessages(meetingId: string): Promise<ChatMessage[]> {
    const meeting = await this.db
      .selectFrom("meetings")
      .select("id")
      .where("id", "=", meetingId)
      .executeTakeFirst();
    if (!meeting) throw new Error(`Meeting not found: ${meetingId}`);

    const rows = await this.db
      .selectFrom("chat_messages")
      .selectAll()
      .where("meeting_id", "=", meetingId)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
    return rows.map(toChatMessage);
  }

  async clearMessages(meetingId: string): Promise<void> {
    const meeting = await this.db
      .selectFrom("meetings")
      .select("id")
      .where("id", "=", meetingId)
      .executeTakeFirst();
    if (!meeting) throw new Error(`Meeting not found: ${meetingId}`);
    await this.db.deleteFrom("chat_messages").where("meeting_id", "=", meetingId).execute();
  }

  async streamMessage(options: ChatStreamOptions): Promise<ChatMessage> {
    const content = options.content.trim();
    if (!content) throw new Error("Message content is required");

    const context = await this.loadMeetingContext(options.meetingId);
    const history = await this.getMessages(options.meetingId);
    const createdAt = Math.max(Date.now(), (history.at(-1)?.createdAt ?? 0) + 1);
    const userMessage: ChatMessage = {
      id: randomUUID(),
      meetingId: options.meetingId,
      role: "user",
      content,
      provider: null,
      model: null,
      usage: null,
      createdAt
    };

    await this.db.insertInto("chat_messages").values({
      id: userMessage.id,
      meeting_id: userMessage.meetingId,
      role: userMessage.role,
      content: userMessage.content,
      provider: null,
      model: null,
      usage: null,
      created_at: userMessage.createdAt
    }).execute();

    try {
      const result = await this.llmService.streamText(
        {
          systemPrompt: context.systemPrompt,
          prompt: content,
          messages: [
            ...history.map((message) => ({
              role: message.role,
              content: message.content,
              timestamp: message.createdAt
            })),
            { role: "user" as const, content, timestamp: createdAt }
          ]
        },
        options.onDelta
      );

      const assistantMessage: ChatMessage = {
        id: randomUUID(),
        meetingId: options.meetingId,
        role: "assistant",
        content: result.text,
        provider: result.provider,
        model: result.model,
        usage: result.usage,
        createdAt: Math.max(Date.now(), createdAt + 1)
      };

      await this.db.insertInto("chat_messages").values({
        id: assistantMessage.id,
        meeting_id: assistantMessage.meetingId,
        role: assistantMessage.role,
        content: assistantMessage.content,
        provider: assistantMessage.provider,
        model: assistantMessage.model,
        usage: JSON.stringify(assistantMessage.usage),
        created_at: assistantMessage.createdAt
      }).execute();

      return assistantMessage;
    } catch (error) {
      await this.db.deleteFrom("chat_messages").where("id", "=", userMessage.id).execute();
      throw error;
    }
  }

  private async loadMeetingContext(meetingId: string): Promise<MeetingContext> {
    const meeting = await this.db
      .selectFrom("meetings")
      .selectAll()
      .where("id", "=", meetingId)
      .executeTakeFirst();
    if (!meeting) throw new Error(`Meeting not found: ${meetingId}`);

    const folder = meetingPaths(this.meetingsDir, meeting.start_time, meeting.title, meeting.id).folder;
    const artifacts = await this.db
      .selectFrom("artifacts")
      .selectAll()
      .where("meeting_id", "=", meetingId)
      .orderBy("created_at", "asc")
      .execute();
    const speakers = await this.db
      .selectFrom("meeting_speakers")
      .innerJoin("speakers", "speakers.id", "meeting_speakers.speaker_id")
      .select("speakers.name")
      .where("meeting_speakers.meeting_id", "=", meetingId)
      .execute();

    const readArtifact = async (path: string): Promise<string | null> => {
      const fullPath = join(folder, path);
      return existsSync(fullPath) ? readFile(fullPath, "utf8") : null;
    };

    const transcriptArtifact = artifacts.find((artifact) =>
      artifact.id === meeting.primary_transcript_artifact_id || artifact.kind === "transcript"
    );
    const transcriptRaw = transcriptArtifact ? await readArtifact(transcriptArtifact.path) : null;
    const summaryArtifacts = artifacts.filter((artifact) => artifact.kind === "summary");
    const summaries: string[] = [];
    for (const artifact of summaryArtifacts) {
      const content = await readArtifact(artifact.path);
      if (content) summaries.push(`Summary (${artifact.provider}):\n${content}`);
    }

    const date = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(meeting.start_time));
    const transcript = transcriptRaw ? formatTranscript(transcriptRaw) : "No transcript is available for this meeting.";
    const summaryText = summaries.length > 0 ? summaries.join("\n\n---\n\n") : "No summaries are available for this meeting.";
    const speakerNames = speakers.map((speaker) => speaker.name).join(", ") || "Unknown participants";

    return {
      systemPrompt: `You are Olive's meeting assistant. Answer questions using only the meeting context below. Be accurate and concise. If the answer is not present in the context, say that you cannot find it in this meeting. Do not invent facts, decisions, dates, owners, or speaker identities.\n\nMeeting: ${meeting.title}\nDate: ${date}\nParticipants: ${speakerNames}\n\nSummaries:\n${summaryText}\n\nTranscript:\n${transcript}`
    };
  }
}
