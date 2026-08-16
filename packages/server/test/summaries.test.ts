import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import type { Database, Transcript } from "@olive/shared";
import { runMigrations } from "@olive/shared/migrations";
import { SummaryService } from "../src/summaries/service.ts";
import { LlmService } from "../src/llm/service.ts";
import { TemplateService } from "../src/templates/service.ts";
import { meetingPaths } from "../src/layout.ts";
import { getMeeting } from "../src/meetings.ts";
import { createApp } from "../src/app.ts";

function createTestContext() {
  const sqlite = new BunDatabase(":memory:");
  runMigrations(sqlite);
  const db = new Kysely<Database>({ dialect: new BunSqliteDialect({ database: sqlite }) });
  const meetingsDir = join(tmpdir(), `olive-summaries-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(meetingsDir, { recursive: true });

  const templateService = new TemplateService(db);
  const llmService = new LlmService({ db });

  // Mock llmService.generateText to avoid network calls during tests if needed
  llmService.generateText = async (options) => {
    return {
      text: `# Generated Summary for Prompt\n\nPrompt was:\n${options.prompt.slice(0, 100)}...`,
      provider: options.provider || "google",
      model: options.model || "gemini-2.5-flash",
      durationMs: 150,
      usage: {
        inputTokens: 120,
        outputTokens: 45,
        totalTokens: 165
      }
    };
  };

  const summaryService = new SummaryService({
    db,
    meetingsDir,
    llmService,
    templateService
  });

  return { db, sqlite, meetingsDir, llmService, templateService, summaryService };
}

async function seedMeetingWithTranscript(
  db: Kysely<Database>,
  meetingsDir: string
): Promise<{ meetingId: string; transcriptArtifactId: string }> {
  const now = Date.now();
  const meetingId = "meeting-summary-1";
  const title = "Product Roadmap Sync";

  const paths = meetingPaths(meetingsDir, now, title, meetingId);
  mkdirSync(paths.transcriptsDir, { recursive: true });

  const transcript: Transcript = {
    segments: [
      { startMs: 0, endMs: 5000, speaker: "Alice", text: "Welcome everyone. Let's discuss Q4 roadmap goals." },
      { startMs: 5200, endMs: 12000, speaker: "Bob", text: "We completed the authentication migration on time." }
    ]
  };

  const transcriptFilename = "transcript.json";
  const transcriptRelPath = `transcripts/${transcriptFilename}`;
  writeFileSync(join(paths.folder, transcriptRelPath), JSON.stringify(transcript), "utf8");

  const transcriptArtifactId = "artifact-transcript-1";

  await db
    .insertInto("meetings")
    .values({
      id: meetingId,
      title,
      start_time: now,
      end_time: now + 600_000,
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

  await db
    .insertInto("artifacts")
    .values({
      id: transcriptArtifactId,
      meeting_id: meetingId,
      kind: "transcript",
      provider: "speechmatics",
      format: "json",
      path: transcriptRelPath,
      created_at: now
    })
    .execute();

  await db
    .updateTable("meetings")
    .set({ primary_transcript_artifact_id: transcriptArtifactId })
    .where("id", "=", meetingId)
    .execute();

  return { meetingId, transcriptArtifactId };
}

describe("SummaryService", () => {
  test("generates and stores summary artifact for meeting", async () => {
    const { db, meetingsDir, summaryService } = createTestContext();
    const { meetingId } = await seedMeetingWithTranscript(db, meetingsDir);

    const result = await summaryService.generateSummary({
      meetingId
    });

    expect(result.artifactId).toBeDefined();
    expect(result.content).toContain("Generated Summary");
    expect(result.isPrimary).toBe(true);

    const meetingDetail = await getMeeting(db, meetingId, meetingsDir);
    expect(meetingDetail).not.toBeNull();
    expect(meetingDetail?.meeting.primarySummaryArtifactId).toBe(result.artifactId);
    expect(meetingDetail?.summaries.length).toBe(1);
    expect(meetingDetail?.summaries[0].id).toBe(result.artifactId);
    expect(meetingDetail?.summaries[0].isPrimary).toBe(true);
  });

  test("supports generating multiple summaries with different templates", async () => {
    const { db, meetingsDir, summaryService, templateService } = createTestContext();
    const { meetingId } = await seedMeetingWithTranscript(db, meetingsDir);

    const templates = await templateService.listTemplates();
    const execTemplate = templates.find((t) => t.name === "Executive Summary")!;
    const actionItemsTemplate = templates.find((t) => t.name.includes("Action Items"))!;

    const sum1 = await summaryService.generateSummary({
      meetingId,
      templateId: execTemplate.id,
      setPrimary: true
    });

    const sum2 = await summaryService.generateSummary({
      meetingId,
      templateId: actionItemsTemplate.id,
      setPrimary: false
    });

    const meetingDetail = await getMeeting(db, meetingId, meetingsDir);
    expect(meetingDetail?.summaries.length).toBe(2);
    expect(meetingDetail?.meeting.primarySummaryArtifactId).toBe(sum1.artifactId);

    // Switch primary summary
    await summaryService.setPrimarySummary(meetingId, sum2.artifactId);
    const updatedDetail = await getMeeting(db, meetingId, meetingsDir);
    expect(updatedDetail?.meeting.primarySummaryArtifactId).toBe(sum2.artifactId);
  });

  test("deletes summary and updates primary fallback", async () => {
    const { db, meetingsDir, summaryService } = createTestContext();
    const { meetingId } = await seedMeetingWithTranscript(db, meetingsDir);

    const sum1 = await summaryService.generateSummary({ meetingId, setPrimary: true });
    const sum2 = await summaryService.generateSummary({ meetingId, setPrimary: false });

    // Delete primary summary (sum1)
    await summaryService.deleteSummary(meetingId, sum1.artifactId);

    const detailAfterDelete = await getMeeting(db, meetingId, meetingsDir);
    expect(detailAfterDelete?.summaries.length).toBe(1);
    // Should fallback to sum2
    expect(detailAfterDelete?.meeting.primarySummaryArtifactId).toBe(sum2.artifactId);

    // Delete remaining summary
    await summaryService.deleteSummary(meetingId, sum2.artifactId);
    const detailEmpty = await getMeeting(db, meetingId, meetingsDir);
    expect(detailEmpty?.summaries.length).toBe(0);
    expect(detailEmpty?.meeting.primarySummaryArtifactId).toBeNull();
  });
});

describe("Summaries API", () => {
  test("POST, SET PRIMARY, and DELETE /api/meetings/:id/summaries endpoints", async () => {
    const { db, meetingsDir, summaryService, llmService, templateService } = createTestContext();
    const { meetingId } = await seedMeetingWithTranscript(db, meetingsDir);
    const app = createApp({ db, meetingsDir, summaryService, llmService, templateService });

    // Generate summary via POST /api/meetings/:id/summarize
    const res = await app.request(`http://localhost/api/meetings/${meetingId}/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setPrimary: true })
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.artifactId).toBeDefined();

    // Set primary via POST /api/meetings/:id/summaries/:artifactId/primary
    const primaryRes = await app.request(
      `http://localhost/api/meetings/${meetingId}/summaries/${body.artifactId}/primary`,
      { method: "POST" }
    );
    expect(primaryRes.status).toBe(200);

    // Delete summary via DELETE /api/meetings/:id/summaries/:artifactId
    const deleteRes = await app.request(
      `http://localhost/api/meetings/${meetingId}/summaries/${body.artifactId}`,
      { method: "DELETE" }
    );
    expect(deleteRes.status).toBe(200);
  });
});
