import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { createDb } from "../src/db.ts";
import { meetingPaths } from "../src/layout.ts";

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  Host: "127.0.0.1"
};

async function mcpRequest(app: ReturnType<typeof createApp>, method: string, params: Record<string, unknown> = {}) {
  const response = await app.request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params
    })
  });

  const body = await response.text();
  const dataLine = body
    .split(/\r?\n/)
    .reverse()
    .find((line: string) => line.startsWith("data: "));
  const json = dataLine ? JSON.parse(dataLine.slice(6).trim()) : JSON.parse(body);
  return { response, body: json };
}

describe("MCP API", () => {
  test("is available at /mcp without a token on loopback and lists read-only tools", async () => {
    const handle = createDb(":memory:");
    const meetingsDir = await mkdtemp(join(import.meta.dir, "mcp-test-"));
    const app = createApp({ db: handle.db, meetingsDir });

    const initialize = await mcpRequest(app, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "olive-test", version: "1.0.0" }
    });

    expect(initialize.response.status).toBe(200);
    expect(initialize.body.result.serverInfo.name).toBe("olive");

    const tools = await mcpRequest(app, "tools/list");
    const toolNames = tools.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual([
      "list_meetings",
      "get_meeting",
      "search_transcripts",
      "get_action_items",
      "list_speakers",
      "get_speaker_profile"
    ]);

    await handle.db.destroy();
    handle.sqlite.close();
    await rm(meetingsDir, { recursive: true, force: true });
  });

  test("uses MCP token authentication when configured", async () => {
    const handle = createDb(":memory:");
    const app = createApp({ db: handle.db, mcpToken: "mcp-secret" });

    const unauthorized = await app.request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer");

    const authorized = await app.request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: "Bearer mcp-secret" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    expect(authorized.status).toBe(200);

    await handle.db.destroy();
    handle.sqlite.close();
  });

  test("falls back to the ingest token and rejects unauthenticated non-loopback binding", async () => {
    const handle = createDb(":memory:");
    const app = createApp({ db: handle.db, ingestToken: "shared-secret" });

    const response = await app.request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    expect(response.status).toBe(401);

    expect(() => createApp({ db: handle.db, bindHost: "0.0.0.0" })).toThrow(
      "OLIVE_MCP_TOKEN or OLIVE_INGEST_TOKEN is required when OLIVE_BIND_HOST is not loopback"
    );

    await handle.db.destroy();
    handle.sqlite.close();
  });

  test("calls meeting, transcript, action item, and speaker tools", async () => {
    const handle = createDb(":memory:");
    const meetingsDir = await mkdtemp(join(import.meta.dir, "mcp-data-test-"));
    const meetingId = "meeting-mcp-1";
    const speakerId = "speaker-mcp-1";
    const now = 1_700_000_000_000;
    const paths = meetingPaths(meetingsDir, now, "MCP fixture", meetingId);

    await mkdir(paths.transcriptsDir, { recursive: true });
    await mkdir(paths.summariesDir, { recursive: true });
    await writeFile(join(paths.folder, "transcripts/local.txt"), "Discussed the launch plan and owner follow-up.", "utf8");
    await writeFile(join(paths.folder, "summaries/local.md"), "- [ ] Matt: confirm launch date\n- [x] Alex: send agenda", "utf8");

    await handle.db
      .insertInto("meetings")
      .values({
        id: meetingId,
        title: "MCP fixture",
        start_time: now,
        end_time: now + 60_000,
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
      .insertInto("speakers")
      .values({
        id: speakerId,
        name: "Matt",
        provider_ids: "{}",
        enrolled_at: null,
        enrollment_clip_paths: "[]",
        created_at: now
      })
      .execute();
    await handle.db
      .insertInto("meeting_speakers")
      .values({ meeting_id: meetingId, speaker_id: speakerId, evidence_artifact_id: null })
      .execute();
    await handle.db
      .insertInto("artifacts")
      .values([
        {
          id: "artifact-mcp-transcript",
          meeting_id: meetingId,
          recording_id: null,
          kind: "transcript",
          provider: "local",
          format: "txt",
          path: "transcripts/local.txt",
          created_at: now
        },
        {
          id: "artifact-mcp-summary",
          meeting_id: meetingId,
          recording_id: null,
          kind: "summary",
          provider: "local",
          format: "md",
          path: "summaries/local.md",
          created_at: now
        }
      ])
      .execute();
    await handle.db
      .updateTable("meetings")
      .set({
        primary_transcript_artifact_id: "artifact-mcp-transcript",
        primary_summary_artifact_id: "artifact-mcp-summary"
      })
      .where("id", "=", meetingId)
      .execute();

    const app = createApp({ db: handle.db, meetingsDir });
    const list = await mcpRequest(app, "tools/call", { name: "list_meetings", arguments: { search: "MCP fixture" } });
    expect(list.body.result.isError).not.toBe(true);
    expect(JSON.parse(list.body.result.content[0].text).meetings[0].id).toBe(meetingId);

    const transcript = await mcpRequest(app, "tools/call", { name: "search_transcripts", arguments: { query: "launch plan" } });
    expect(JSON.parse(transcript.body.result.content[0].text).matches[0].meeting.id).toBe(meetingId);

    const actions = await mcpRequest(app, "tools/call", { name: "get_action_items", arguments: { meetingId, includeCompleted: false } });
    expect(JSON.parse(actions.body.result.content[0].text).actionItems).toEqual([
      { meetingId, meetingTitle: "MCP fixture", text: "Matt: confirm launch date", completed: false }
    ]);

    const speaker = await mcpRequest(app, "tools/call", { name: "get_speaker_profile", arguments: { speakerId } });
    expect(JSON.parse(speaker.body.result.content[0].text).speaker.name).toBe("Matt");

    await handle.db.destroy();
    handle.sqlite.close();
    await rm(meetingsDir, { recursive: true, force: true });
  });
});
