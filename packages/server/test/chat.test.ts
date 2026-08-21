import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import type { Database, Transcript } from "@olive/shared";
import { runMigrations } from "@olive/shared/migrations";
import { createApp } from "../src/app.ts";
import { ChatService } from "../src/chat/service.ts";
import { LlmService } from "../src/llm/service.ts";
import { meetingPaths } from "../src/layout.ts";

describe("meeting chat API", () => {
  test("persists messages, streams responses, and clears a meeting thread", async () => {
    const sqlite = new BunDatabase(":memory:");
    runMigrations(sqlite);
    const db = new Kysely<Database>({ dialect: new BunSqliteDialect({ database: sqlite }) });
    const meetingsDir = join(tmpdir(), `olive-chat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const meetingId = "meeting-chat-1";
    const now = Date.now();
    const title = "Chat Fixture";
    const paths = meetingPaths(meetingsDir, now, title, meetingId);
    mkdirSync(paths.transcriptsDir, { recursive: true });
    const transcript: Transcript = {
      segments: [{ startMs: 0, endMs: 5_000, speaker: "Alice", text: "We will ship the olive feature on Friday." }]
    };
    writeFileSync(join(paths.folder, "transcripts/transcript.json"), JSON.stringify(transcript), "utf8");

    await db.insertInto("meetings").values({
      id: meetingId,
      title,
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
    }).execute();
    await db.insertInto("artifacts").values({
      id: "chat-transcript-1",
      meeting_id: meetingId,
      recording_id: null,
      kind: "transcript",
      provider: "fixture",
      format: "json",
      path: "transcripts/transcript.json",
      created_at: now
    }).execute();
    await db.updateTable("meetings")
      .set({ primary_transcript_artifact_id: "chat-transcript-1" })
      .where("id", "=", meetingId)
      .execute();

    const llmService = new LlmService({ db });
    const messageLengths: number[] = [];
    llmService.streamText = async (options, onDelta) => {
      messageLengths.push(options.messages?.length || 0);
      await onDelta("The feature ships on Friday.");
      return {
        text: "The feature ships on Friday.",
        provider: "fixture",
        model: "fixture-model",
        durationMs: 1,
        usage: { inputTokens: 10, outputTokens: 6, totalTokens: 16 }
      };
    };

    const chatService = new ChatService({ db, meetingsDir, llmService });
    const app = createApp({ db, meetingsDir, chatService });

    const emptyResponse = await app.request(`http://olive.test/api/meetings/${meetingId}/chat/messages`);
    expect(emptyResponse.status).toBe(200);
    expect(await emptyResponse.json()).toEqual({ messages: [] });

    const firstResponse = await app.request(`http://olive.test/api/meetings/${meetingId}/chat/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ content: "When will it ship?" })
    });
    const firstStream = await firstResponse.text();
    expect(firstResponse.status).toBe(200);
    expect(firstStream).toContain('event: delta');
    expect(firstStream).toContain('event: done');

    const secondResponse = await app.request(`http://olive.test/api/meetings/${meetingId}/chat/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ content: "Repeat that briefly." })
    });
    expect(secondResponse.status).toBe(200);
    await secondResponse.text();
    expect(messageLengths).toEqual([1, 3]);

    const populatedResponse = await app.request(`http://olive.test/api/meetings/${meetingId}/chat/messages`);
    const populated = await populatedResponse.json() as { messages: Array<{ role: string; content: string }> };
    expect(populated.messages).toHaveLength(4);
    expect(populated.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);

    const clearResponse = await app.request(`http://olive.test/api/meetings/${meetingId}/chat/messages`, { method: "DELETE" });
    expect(clearResponse.status).toBe(200);
    expect(await clearResponse.json()).toEqual({ status: "cleared" });

    const afterClearResponse = await app.request(`http://olive.test/api/meetings/${meetingId}/chat/messages`);
    expect(await afterClearResponse.json()).toEqual({ messages: [] });

    await db.destroy();
    sqlite.close();
  });
});
