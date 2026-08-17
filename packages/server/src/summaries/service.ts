import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type {
  Database,
  LlmThinkingLevel,
  MeetingDetailAggregate,
  MeetingSummaryItem,
  Template,
  Transcript
} from "@olive/shared";
import { getDb } from "../db.ts";
import { logger } from "../logger.ts";
import { meetingPaths } from "../layout.ts";
import { resolvePaths } from "../paths.ts";
import { LlmService } from "../llm/service.ts";
import { TemplateService } from "../templates/service.ts";

export interface SummaryServiceOptions {
  db?: Kysely<Database>;
  meetingsDir?: string;
  llmService?: LlmService;
  templateService?: TemplateService;
}

export interface GenerateSummaryOptions {
  meetingId: string;
  templateId?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: LlmThinkingLevel;
  setPrimary?: boolean;
}

export interface GenerateSummaryResult {
  artifactId: string;
  provider: string;
  model: string;
  templateName: string;
  content: string;
  isPrimary: boolean;
  durationMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost?: number;
  };
}

export class SummaryService {
  private readonly db: Kysely<Database>;
  private readonly meetingsDir: string;
  private readonly llmService: LlmService;
  private readonly templateService: TemplateService;

  constructor(options: SummaryServiceOptions = {}) {
    this.db = options.db ?? getDb();
    this.meetingsDir = options.meetingsDir ?? resolvePaths().meetingsDir;
    this.llmService = options.llmService ?? new LlmService({ db: this.db });
    this.templateService = options.templateService ?? new TemplateService(this.db);
  }

  async generateSummary(options: GenerateSummaryOptions): Promise<GenerateSummaryResult> {
    const meeting = await this.db
      .selectFrom("meetings")
      .selectAll()
      .where("id", "=", options.meetingId)
      .executeTakeFirst();

    if (!meeting) {
      throw new Error(`Meeting not found: ${options.meetingId}`);
    }

    const folder = meetingPaths(this.meetingsDir, meeting.start_time, meeting.title, meeting.id).folder;

    // 1. Locate transcript artifact
    const artifacts = await this.db
      .selectFrom("artifacts")
      .selectAll()
      .where("meeting_id", "=", options.meetingId)
      .execute();

    let transcriptArtifact = artifacts.find((a) => a.id === meeting.primary_transcript_artifact_id);
    if (!transcriptArtifact) {
      transcriptArtifact = artifacts.find((a) => a.kind === "transcript");
    }

    if (!transcriptArtifact) {
      throw new Error("No transcript found for meeting. Please transcribe the recording first.");
    }

    const transcriptFullPath = join(folder, transcriptArtifact.path);
    if (!existsSync(transcriptFullPath)) {
      throw new Error(`Transcript artifact not found on disk at: ${transcriptArtifact.path}`);
    }

    const rawTranscript = await readFile(transcriptFullPath, "utf8");
    let formattedDialogue: string;

    if (transcriptArtifact.format === "json") {
      try {
        const parsed = JSON.parse(rawTranscript) as Transcript;
        if (parsed.segments && Array.isArray(parsed.segments)) {
          formattedDialogue = parsed.segments
            .map((seg) => `${seg.speaker || "Unknown"}: ${seg.text}`)
            .join("\n\n");
        } else {
          formattedDialogue = rawTranscript;
        }
      } catch {
        formattedDialogue = rawTranscript;
      }
    } else {
      formattedDialogue = rawTranscript;
    }

    // 2. Locate template
    let template: Template | null = null;
    if (options.templateId) {
      template = await this.templateService.getTemplate(options.templateId);
    }
    if (!template) {
      template = await this.templateService.getDefaultTemplate();
    }
    if (!template) {
      const allTemplates = await this.templateService.listTemplates();
      template = allTemplates[0] ?? null;
    }

    if (!template) {
      throw new Error("No summary template available");
    }

    // 3. Fetch meeting speakers
    const meetingSpeakers = await this.db
      .selectFrom("meeting_speakers")
      .selectAll()
      .where("meeting_id", "=", options.meetingId)
      .execute();

    const speakerIds = meetingSpeakers.map((ms) => ms.speaker_id);
    const speakers =
      speakerIds.length > 0
        ? await this.db.selectFrom("speakers").selectAll().where("id", "in", speakerIds).execute()
        : [];

    const speakerNames = speakers.map((s) => s.name).join(", ") || "Participants";
    const dateFormatted = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(meeting.start_time));

    // 4. Populate template variables
    const replaceVariables = (str: string): string => {
      return str
        .replaceAll("{{title}}", meeting.title)
        .replaceAll("{{date}}", dateFormatted)
        .replaceAll("{{speakers}}", speakerNames)
        .replaceAll("{{transcript}}", formattedDialogue);
    };

    const systemPrompt = replaceVariables(template.systemPrompt || "");
    const userPrompt = replaceVariables(template.userPrompt);

    // 5. Run LLM generation
    const stageRunId = randomUUID();
    const now = Date.now();

    await this.db
      .insertInto("stage_runs")
      .values({
        id: stageRunId,
        meeting_id: meeting.id,
        stage: "summary_generate",
        status: "running",
        attempts: 1,
        started_at: now,
        created_at: now,
        updated_at: now
      })
      .onConflict((oc) =>
        oc.columns(["meeting_id", "stage"]).doUpdateSet({
          id: stageRunId,
          status: "running",
          attempts: (eb) => eb("stage_runs.attempts", "+", 1),
          started_at: now,
          finished_at: null,
          last_error: null,
          updated_at: now
        })
      )
      .execute();

    logger.debug("Prompt rendered for summary generation", {
      category: "summary",
      meetingId: meeting.id,
      template: template.name,
      promptLength: userPrompt.length
    });

    let llmResult;
    try {
      llmResult = await this.llmService.generateText({
        provider: options.provider,
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        systemPrompt: systemPrompt || undefined,
        prompt: userPrompt
      });

      logger.debug("LLM summary generation response received", {
        category: "llm",
        meetingId: meeting.id,
        provider: llmResult.provider,
        model: llmResult.model,
        durationMs: llmResult.durationMs,
        usage: llmResult.usage
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.db
        .updateTable("stage_runs")
        .set({
          status: "error",
          last_error: errorMsg,
          finished_at: Date.now(),
          updated_at: Date.now()
        })
        .where("id", "=", stageRunId)
        .execute();
      throw err;
    }

    // 6. Save summary markdown file to disk
    const summariesDir = join(folder, "summaries");
    if (!existsSync(summariesDir)) {
      mkdirSync(summariesDir, { recursive: true });
    }

    const artifactId = randomUUID();
    const filename = `summary_${now}_${artifactId.slice(0, 8)}.md`;
    const relativePath = `summaries/${filename}`;
    const fullPath = join(summariesDir, filename);

    logger.debug("Saving summary markdown artifact to disk", {
      category: "summary",
      meetingId: meeting.id,
      artifactId,
      fullPath,
      sizeBytes: llmResult.text.length
    });

    writeFileSync(fullPath, llmResult.text, "utf8");

    // 7. Insert Artifact
    const providerLabel = `${llmResult.provider}:${llmResult.model}:${template.name}`;
    await this.db
      .insertInto("artifacts")
      .values({
        id: artifactId,
        meeting_id: meeting.id,
        kind: "summary",
        provider: providerLabel,
        format: "md",
        path: relativePath,
        created_at: now
      })
      .execute();

    // 8. Update stage run
    await this.db
      .updateTable("stage_runs")
      .set({
        status: "done",
        finished_at: Date.now(),
        updated_at: Date.now()
      })
      .where("id", "=", stageRunId)
      .execute();

    // 9. Update meeting primary summary if requested or if none set
    const shouldSetPrimary = options.setPrimary !== false && (!meeting.primary_summary_artifact_id || options.setPrimary === true);

    if (shouldSetPrimary) {
      await this.db
        .updateTable("meetings")
        .set({
          primary_summary_artifact_id: artifactId,
          updated_at: Date.now()
        })
        .where("id", "=", meeting.id)
        .execute();
    }

    logger.info("Generated summary for meeting", {
      meetingId: meeting.id,
      artifactId,
      template: template.name,
      provider: llmResult.provider,
      model: llmResult.model,
      durationMs: llmResult.durationMs
    });

    return {
      artifactId,
      provider: llmResult.provider,
      model: llmResult.model,
      templateName: template.name,
      content: llmResult.text,
      isPrimary: shouldSetPrimary,
      durationMs: llmResult.durationMs,
      usage: llmResult.usage
    };
  }

  async deleteSummary(meetingId: string, artifactId: string): Promise<void> {
    const meeting = await this.db
      .selectFrom("meetings")
      .selectAll()
      .where("id", "=", meetingId)
      .executeTakeFirst();

    if (!meeting) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }

    const artifact = await this.db
      .selectFrom("artifacts")
      .selectAll()
      .where("id", "=", artifactId)
      .where("meeting_id", "=", meetingId)
      .where("kind", "=", "summary")
      .executeTakeFirst();

    if (!artifact) {
      throw new Error(`Summary artifact not found: ${artifactId}`);
    }

    // Remove file on disk if exists
    const folder = meetingPaths(this.meetingsDir, meeting.start_time, meeting.title, meeting.id).folder;
    const fullPath = join(folder, artifact.path);
    if (existsSync(fullPath)) {
      try {
        unlinkSync(fullPath);
      } catch {
        // Ignore file delete error
      }
    }

    // If it was the primary summary, assign to another remaining summary or null first to avoid FK violation
    if (meeting.primary_summary_artifact_id === artifactId) {
      const remainingSummary = await this.db
        .selectFrom("artifacts")
        .selectAll()
        .where("meeting_id", "=", meetingId)
        .where("kind", "=", "summary")
        .where("id", "!=", artifactId)
        .orderBy("created_at", "desc")
        .executeTakeFirst();

      await this.db
        .updateTable("meetings")
        .set({
          primary_summary_artifact_id: remainingSummary?.id ?? null,
          updated_at: Date.now()
        })
        .where("id", "=", meetingId)
        .execute();
    }

    // Delete DB record
    await this.db.deleteFrom("artifacts").where("id", "=", artifactId).execute();

    logger.info("Deleted summary artifact", { meetingId, artifactId });
  }

  async setPrimarySummary(meetingId: string, artifactId: string): Promise<void> {
    const meeting = await this.db
      .selectFrom("meetings")
      .selectAll()
      .where("id", "=", meetingId)
      .executeTakeFirst();

    if (!meeting) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }

    const artifact = await this.db
      .selectFrom("artifacts")
      .selectAll()
      .where("id", "=", artifactId)
      .where("meeting_id", "=", meetingId)
      .where("kind", "=", "summary")
      .executeTakeFirst();

    if (!artifact) {
      throw new Error(`Summary artifact not found: ${artifactId}`);
    }

    await this.db
      .updateTable("meetings")
      .set({
        primary_summary_artifact_id: artifactId,
        updated_at: Date.now()
      })
      .where("id", "=", meetingId)
      .execute();

    logger.info("Updated primary summary artifact", { meetingId, artifactId });
  }
}
