import { existsSync, statSync } from "node:fs";
import { join, normalize, relative } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Kysely } from "kysely";
import type { Database, LogItem, LogLevel } from "@olive/shared";
import { logger } from "./logger.ts";
import { loadAppConfig, saveAppConfig } from "./config.ts";
import { getDb } from "./db.ts";
import { resolvePaths } from "./paths.ts";
import { getMeeting, listMeetings } from "./meetings.ts";
import { createPlaudClient } from "./plaud/client.ts";
import { PlaudAuthSessionStore } from "./plaud/auth.ts";
import { PlaudPoller, type PlaudClientLike, type PlaudOAuthManager } from "./plaud/poller.ts";
import { SpeechmaticsClient, type SpeechmaticsJsonV2 } from "./providers/speechmatics/index.ts";
import { TranscriptionService } from "./transcription/service.ts";
import { SpeakerService } from "./speakers/service.ts";
import { IngestService } from "./ingest/service.ts";
import { TemplateService } from "./templates/service.ts";
import { LlmService } from "./llm/service.ts";
import { SummaryService } from "./summaries/service.ts";
import { BackupService } from "./backup/service.ts";
import { meetingPaths } from "./layout.ts";
import { enhanceAudioFile } from "./providers/local/wav.ts";

export interface AppOptions {
  db?: Kysely<Database>;
  webRoot?: string;
  configDir?: string;
  meetingsDir?: string;
  backupsDir?: string;
  plaudClient?: PlaudClientLike;
  plaudPoller?: PlaudPoller;
  oauthManager?: PlaudOAuthManager;
  authSessions?: PlaudAuthSessionStore;
  pollIntervalMinutes?: number;
  startPlaudPoller?: boolean;
  syncOnStartup?: boolean;
  speechmaticsClient?: SpeechmaticsClient;
  transcriptionService?: TranscriptionService;
  speakerService?: SpeakerService;
  ingestService?: IngestService;
  templateService?: TemplateService;
  llmService?: LlmService;
  summaryService?: SummaryService;
  backupService?: BackupService;
  speechmaticsWebhookSecret?: string;
  ingestToken?: string;
  defaultTranscriptionProvider?: "speechmatics" | "local";
}

function parseJsonField<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function numericQueryParam(value: string | undefined): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function safeWebPath(webRoot: string, requestPath: string): string | undefined {
  const normalizedPath = normalize(requestPath).replace(/^([/\\])+/, "");
  const candidate = join(webRoot, normalizedPath || "index.html");
  const relativePath = relative(webRoot, candidate);
  return relativePath.startsWith("..") || relativePath.includes(`..${process.platform === "win32" ? "\\" : "/"}`)
    ? undefined
    : candidate;
}

async function serveWebAsset(webRoot: string, requestPath: string): Promise<Response | undefined> {
  const requestedPath = safeWebPath(webRoot, requestPath);
  if (requestedPath && existsSync(requestedPath) && statSync(requestedPath).isFile()) {
    return new Response(Bun.file(requestedPath));
  }

  const indexPath = join(webRoot, "index.html");
  return existsSync(indexPath)
    ? new Response(Bun.file(indexPath), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      })
    : undefined;
}

export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();
  const db = options.db ?? getDb();
  const paths = resolvePaths();
  const configDir = options.configDir ?? paths.configDir;
  const meetingsDir = options.meetingsDir ?? paths.meetingsDir;
  const backupsDir = options.backupsDir ?? paths.backupsDir;
  const appConfigPaths = options.configDir
    ? { ...paths, configDir, settingsPath: join(configDir, "settings.json") }
    : paths;
  const configuredProvider = loadAppConfig(appConfigPaths).transcriptionProvider;
  const speechmaticsWebhookSecret = options.speechmaticsWebhookSecret || process.env.SPEECHMATICS_WEBHOOK_SECRET;

  const speechmaticsClient = options.speechmaticsClient ?? new SpeechmaticsClient();

  const transcriptionService =
    options.transcriptionService ??
    new TranscriptionService({
      db,
      meetingsDir,
      speechmaticsClient,
      defaultProvider: options.defaultTranscriptionProvider ?? configuredProvider,
      webhookSecret: speechmaticsWebhookSecret
    });

  const speakerService =
    options.speakerService ??
    new SpeakerService({
      db,
      configDir,
      meetingsDir,
      speechmaticsClient
    });

  const ingestToken = options.ingestToken || process.env.OLIVE_INGEST_TOKEN;

  const ingestService =
    options.ingestService ??
    new IngestService({
      db,
      meetingsDir,
      transcriptionService,
      defaultTranscriptionProvider: options.defaultTranscriptionProvider ?? configuredProvider
    });

  const templateService =
    options.templateService ??
    new TemplateService(db);

  const llmService =
    options.llmService ??
    new LlmService({
      db,
      configDir
    });

  const summaryService =
    options.summaryService ??
    new SummaryService({
      db,
      meetingsDir,
      llmService,
      templateService
    });

  transcriptionService.setSummaryService(summaryService);

  const backupService =
    options.backupService ??
    new BackupService({
      db,
      paths,
      configDir,
      meetingsDir,
      backupsDir
    });

  const plaudPoller =
    options.plaudPoller ??
    new PlaudPoller({
      db,
      meetingsDir,
      client: options.plaudClient ?? createPlaudClient(paths),
      transcriptionService
    });
  const oauthManager = options.oauthManager ?? plaudPoller.oauth;
  const authSessions = options.authSessions ?? new PlaudAuthSessionStore();

  if (options.startPlaudPoller || options.syncOnStartup) {
    void speakerService.syncMeetingSpeakersAndTranscripts().then((res) => {
      if (res.repairedMeetings > 0 || res.prunedSpeakers > 0) {
        logger.info("Synchronized meeting speakers and transcripts on startup", res);
      }
    }).catch((err) => {
      logger.warn("Could not sync meeting speakers and transcripts on startup", {
        error: err instanceof Error ? err.message : String(err)
      });
    });
  }

  app.get("/api/health", (c) => c.json({ status: "ok" }));

  app.get("/api/meetings", async (c) => {
    const response = await listMeetings(
      db,
      {
        limit: numericQueryParam(c.req.query("limit")),
        offset: numericQueryParam(c.req.query("offset")),
        search: c.req.query("search")
      },
      meetingsDir
    );

    return c.json(response);
  });

  app.post("/api/ingest", async (c) => {
    if (ingestToken) {
      const authHeader = c.req.header("authorization") || "";
      const expected = `Bearer ${ingestToken}`;
      if (authHeader !== expected) {
        return c.json({ error: "Unauthorized: invalid or missing ingest token" }, 401);
      }
    }

    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.json({ error: "Multipart form data required" }, 400);
    }

    const file = formData.get("file");
    if (!file || !(file instanceof Blob)) {
      return c.json({ error: "file field (audio blob) is required" }, 400);
    }

    const title = formData.get("title");
    const sourceParam = formData.get("source");
    const autoTranscribeParam = formData.get("autoTranscribe");
    const providerParam = formData.get("provider");
    const modelIdParam = formData.get("modelId");

    const userAgent = c.req.header("user-agent") || "";
    const isShortcut = userAgent.includes("Shortcuts") || sourceParam === "ios-shortcut";
    const source = isShortcut
      ? "ios-shortcut"
      : typeof sourceParam === "string" && sourceParam === "plaud"
      ? "plaud"
      : "upload";

    const audioBytes = new Uint8Array(await file.arrayBuffer());
    const filename = file instanceof File ? file.name : "audio.m4a";
    const mime = file.type || "audio/mp4";

    const autoTranscribe =
      autoTranscribeParam === "true" || autoTranscribeParam === "1";
    let transcriptionProvider: "speechmatics" | "local" = loadAppConfig(appConfigPaths).transcriptionProvider;
    if (providerParam === "local" || providerParam === "speechmatics") {
      transcriptionProvider = providerParam;
    }
    const modelId = typeof modelIdParam === "string" && modelIdParam.trim() ? modelIdParam.trim() : undefined;

    try {
      const result = await ingestService.ingestAudio({
        audioBytes,
        filename,
        mime,
        title: typeof title === "string" ? title : undefined,
        source,
        autoTranscribe,
        transcriptionProvider,
        modelId
      });

      return c.json(result, result.deduped ? 200 : 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/meetings/:id", async (c) => {
    const meetingId = c.req.param("id");
    const detail = await getMeeting(db, meetingId, meetingsDir);
    if (!detail) {
      return c.json({ error: "Meeting not found" }, 404);
    }
    const activeProgress = transcriptionService.getTranscriptionProgress(meetingId);
    return c.json({
      ...detail,
      transcriptionProgress: activeProgress,
      summaryGeneration: summaryService.getSummaryGenerationStatus(meetingId)
    });
  });

  app.get("/api/meetings/:id/audio", async (c) => {
    const meetingId = c.req.param("id");
    const meeting = await db
      .selectFrom("meetings")
      .selectAll()
      .where("id", "=", meetingId)
      .executeTakeFirst();

    if (!meeting) {
      return c.json({ error: "Meeting not found" }, 404);
    }

    const recording = await db
      .selectFrom("recordings")
      .selectAll()
      .where("meeting_id", "=", meetingId)
      .orderBy("created_at", "asc")
      .executeTakeFirst();

    if (!recording) {
      return c.json({ error: "Recording not found" }, 404);
    }

    const folder = meetingPaths(meetingsDir, meeting.start_time, meeting.title, meeting.id).folder;
    const fullPath = join(folder, recording.path);

    if (!existsSync(fullPath)) {
      return c.json({ error: "Audio file not found on disk" }, 404);
    }

    let targetPath = fullPath;
    let targetMime = recording.mime || "audio/mp4";

    if (c.req.query("enhanced") === "true") {
      const enhancedRelativePath = join("audio", `${recording.id}.enhanced.mp3`);
      const enhancedFullPath = join(folder, enhancedRelativePath);

      if (!existsSync(enhancedFullPath)) {
        enhanceAudioFile(fullPath, enhancedFullPath);
      }

      if (existsSync(enhancedFullPath)) {
        targetPath = enhancedFullPath;
        targetMime = "audio/mpeg";
      }
    }

    const file = Bun.file(targetPath);
    const size = file.size;
    const mime = targetMime;

    const rangeHeader = c.req.header("range");
    if (rangeHeader && rangeHeader.startsWith("bytes=")) {
      const parts = rangeHeader.replace("bytes=", "").split("-");
      const start = Number(parts[0]);
      const end = parts[1] ? Number(parts[1]) : size - 1;

      if (!Number.isNaN(start) && start >= 0 && start <= end && end < size) {
        const chunkSize = end - start + 1;
        const sliced = file.slice(start, end + 1);

        return new Response(sliced, {
          status: 206,
          headers: {
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Accept-Ranges": "bytes",
            "Content-Length": String(chunkSize),
            "Content-Type": mime
          }
        });
      }
    }

    return new Response(file, {
      status: 200,
      headers: {
        "Content-Length": String(size),
        "Content-Type": mime,
        "Accept-Ranges": "bytes"
      }
    });
  });

  app.post("/api/meetings/:id/transcribe", async (c) => {
    const meetingId = c.req.param("id");
    let body: {
      provider?: "speechmatics" | "local";
      language?: string;
      poll?: boolean;
      force?: boolean;
      pollIntervalMs?: number;
      maxPollWaitMs?: number;
      similarityThreshold?: number;
      clusteringThreshold?: number;
      modelId?: string;
      stream?: boolean;
    } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      // json body is optional
    }

    try {
      let similarityThreshold = body.similarityThreshold;
      let clusteringThreshold = body.clusteringThreshold;
      let modelId = body.modelId;

      try {
        const cfg = loadAppConfig(appConfigPaths);
        if (similarityThreshold === undefined) similarityThreshold = cfg.localSimilarityThreshold;
        if (clusteringThreshold === undefined) clusteringThreshold = cfg.localClusteringThreshold;
        if (modelId === undefined) modelId = cfg.localAsrModel;
      } catch {}

      const wantsStream =
        body.stream === true ||
        c.req.query("stream") === "true" ||
        (c.req.header("accept") || "").includes("text/event-stream");

      if (wantsStream) {
        return streamSSE(c, async (stream) => {
          const pingInterval = setInterval(() => {
            try {
              void stream.writeSSE({
                event: "ping",
                data: "{}"
              });
            } catch {}
          }, 3000);

          try {
            await stream.writeSSE({
              event: "progress",
              data: JSON.stringify({
                stage: "decoding",
                percent: 2,
                message: "Initializing transcription..."
              })
            });

            const result = await transcriptionService.transcribeMeeting(meetingId, {
              provider: body.provider,
              language: body.language,
              poll: body.poll,
              force: body.force,
              pollIntervalMs: body.pollIntervalMs,
              maxPollWaitMs: body.maxPollWaitMs,
              similarityThreshold,
              clusteringThreshold,
              modelId,
              onProgress: async (update) => {
                try {
                  await stream.writeSSE({
                    event: "progress",
                    data: JSON.stringify(update)
                  });
                } catch {}
              }
            });

            if (result.status === "cancelled") {
              await stream.writeSSE({
                event: "cancelled",
                data: JSON.stringify({
                  stage: "cancelled",
                  percent: 0,
                  message: "Transcription was cancelled.",
                  result
                })
              });
            } else if (result.status === "error") {
              await stream.writeSSE({
                event: "error",
                data: JSON.stringify({
                  stage: "error",
                  percent: 0,
                  message: result.error || "Transcription failed",
                  error: result.error || "Transcription failed",
                  result
                })
              });
            } else {
              await stream.writeSSE({
                event: "result",
                data: JSON.stringify({
                  stage: "done",
                  percent: 100,
                  message: "Transcription complete!",
                  result
                })
              });
            }
          } catch (err) {
            const isCancelled = err instanceof Error && err.message.toLowerCase().includes("cancel");
            if (isCancelled) {
              await stream.writeSSE({
                event: "cancelled",
                data: JSON.stringify({
                  stage: "cancelled",
                  percent: 0,
                  message: "Transcription was cancelled."
                })
              });
            } else {
              await stream.writeSSE({
                event: "error",
                data: JSON.stringify({
                  stage: "error",
                  percent: 0,
                  message: err instanceof Error ? err.message : String(err),
                  error: err instanceof Error ? err.message : String(err)
                })
              });
            }
          } finally {
            clearInterval(pingInterval);
          }
        });
      }

      const result = await transcriptionService.transcribeMeeting(meetingId, {
        provider: body.provider,
        language: body.language,
        poll: body.poll,
        force: body.force,
        pollIntervalMs: body.pollIntervalMs,
        maxPollWaitMs: body.maxPollWaitMs,
        similarityThreshold,
        clusteringThreshold,
        modelId
      });

      return c.json(result, result.status === "error" ? 502 : 200);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.get("/api/meetings/:id/transcribe/progress", async (c) => {
    const meetingId = c.req.param("id");
    const wantsStream =
      c.req.query("stream") === "true" ||
      (c.req.header("accept") || "").includes("text/event-stream");

    if (wantsStream) {
      return streamSSE(c, async (stream) => {
        const pingInterval = setInterval(() => {
          try {
            void stream.writeSSE({ event: "ping", data: "{}" });
          } catch {}
        }, 3000);

        const current = transcriptionService.getTranscriptionProgress(meetingId);
        if (current) {
          try {
            await stream.writeSSE({
              event: "progress",
              data: JSON.stringify(current)
            });
          } catch {}
        }

        const unsubscribe = transcriptionService.subscribeTranscriptionProgress(
          meetingId,
          async (update) => {
            try {
              const eventName =
                update.stage === "done"
                  ? "result"
                  : update.stage === "cancelled"
                  ? "cancelled"
                  : update.stage === "error"
                  ? "error"
                  : "progress";

              await stream.writeSSE({
                event: eventName,
                data: JSON.stringify(update)
              });
            } catch {}
          }
        );

        stream.onAbort(() => {
          clearInterval(pingInterval);
          unsubscribe();
        });

        await new Promise<void>((resolve) => {
          stream.onAbort(() => resolve());
        });
      });
    }

    const progress = transcriptionService.getTranscriptionProgress(meetingId);
    return c.json({ progress });
  });

  app.get("/api/transcriptions/active", (c) => {
    const active = transcriptionService.getAllActiveTranscriptionProgress();
    return c.json({ active });
  });

  app.post("/api/meetings/:id/transcribe/cancel", async (c) => {
    const meetingId = c.req.param("id");
    try {
      const result = await transcriptionService.cancelTranscription(meetingId);
      return c.json(result, 200);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post("/api/meetings/:id/summarize", async (c) => {
    const meetingId = c.req.param("id");
    let body: {
      templateId?: string;
      provider?: string;
      model?: string;
      thinkingLevel?: string;
      setPrimary?: boolean;
    } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {}

    try {
      const status = await summaryService.startSummaryGeneration({
        meetingId,
        templateId: body.templateId,
        provider: body.provider,
        model: body.model,
        thinkingLevel: body.thinkingLevel as any,
        setPrimary: body.setPrimary
      });

      return c.json({ started: true, status }, 202);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.get("/api/meetings/:id/summarize/status", (c) => {
    const meetingId = c.req.param("id");
    const status = summaryService.getSummaryGenerationStatus(meetingId);
    return c.json({ generating: status?.stage === "running", status });
  });

  app.delete("/api/meetings/:id/summaries/:artifactId", async (c) => {
    const meetingId = c.req.param("id");
    const artifactId = c.req.param("artifactId");

    try {
      await summaryService.deleteSummary(meetingId, artifactId);
      return c.json({ status: "deleted" });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post("/api/meetings/:id/summaries/:artifactId/primary", async (c) => {
    const meetingId = c.req.param("id");
    const artifactId = c.req.param("artifactId");

    try {
      await summaryService.setPrimarySummary(meetingId, artifactId);
      return c.json({ status: "updated", primarySummaryArtifactId: artifactId });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post("/api/webhooks/speechmatics", async (c) => {
    if (speechmaticsWebhookSecret) {
      const authHeader = c.req.header("authorization") || "";
      const expected = `Bearer ${speechmaticsWebhookSecret}`;
      if (authHeader !== expected) {
        return c.json({ error: "Unauthorized" }, 401);
      }
    }

    const meetingId = c.req.query("meetingId");
    const stageRunId = c.req.query("stageRunId");

    if (!meetingId || !stageRunId) {
      return c.json({ error: "meetingId and stageRunId query params are required" }, 400);
    }

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    try {
      const jsonV2 = payload as SpeechmaticsJsonV2;
      const jobId = jsonV2.job?.id || "";
      const result = await transcriptionService.completeTranscription(meetingId, stageRunId, jobId, jsonV2);
      return c.json(result);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  // Speakers API
  app.get("/api/speakers", async (c) => {
    const speakers = await speakerService.listSpeakers();
    return c.json({ speakers });
  });

  app.get("/api/speakers/:id", async (c) => {
    const id = c.req.param("id");
    const result = await speakerService.getSpeaker(id);
    if (!result) {
      return c.json({ error: "Speaker not found" }, 404);
    }
    return c.json(result);
  });

  app.post("/api/speakers/enroll", async (c) => {
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch (err) {
      return c.json({ error: "Multipart form data required" }, 400);
    }

    const name = formData.get("name");
    const file = formData.get("file");
    const speakerId = formData.get("speakerId");
    const provider = formData.get("provider");
    const language = formData.get("language");

    if (!name || typeof name !== "string" || !name.trim()) {
      return c.json({ error: "name field is required" }, 400);
    }

    if (!file || !(file instanceof Blob)) {
      return c.json({ error: "file field (audio blob) is required" }, 400);
    }

    try {
      const audioBytes = new Uint8Array(await file.arrayBuffer());
      const filename = file instanceof File ? file.name : "audio.wav";
      const mime = file.type || "audio/wav";

      const speaker = await speakerService.enrollSpeaker({
        name: name.trim(),
        audioBytes,
        mime,
        filename,
        speakerId: typeof speakerId === "string" ? speakerId : undefined,
        provider: typeof provider === "string" ? (provider as "speechmatics" | "local" | "both") : undefined,
        language: typeof language === "string" ? language : undefined
      });

      return c.json({ status: "enrolled", speaker });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/speakers/backfill", async (c) => {
    let body: { speakerId?: string; force?: boolean } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {}

    try {
      const result = await speakerService.backfillVoiceprints({
        speakerId: body.speakerId,
        force: body.force
      });
      return c.json({ status: "completed", ...result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/speakers/rebuild", async (c) => {
    let body: { speakerId?: string; force?: boolean } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {}

    try {
      const result = await speakerService.rebuildSpeakerProfiles({
        speakerId: body.speakerId,
        force: body.force
      });
      return c.json({ status: "completed", ...result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/speakers/:id/rebuild", async (c) => {
    const id = c.req.param("id");
    let body: { force?: boolean } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {}

    try {
      const result = await speakerService.rebuildSpeakerProfiles({
        speakerId: id,
        force: body.force
      });
      return c.json({ status: "completed", ...result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/speakers/:id/backfill", async (c) => {
    const id = c.req.param("id");
    let body: { force?: boolean } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {}

    try {
      const result = await speakerService.backfillVoiceprints({
        speakerId: id,
        force: body.force
      });
      return c.json({ status: "completed", ...result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/speakers/merge", async (c) => {
    let body: { sourceSpeakerId?: string; targetSpeakerId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Valid JSON body required" }, 400);
    }

    if (!body.sourceSpeakerId || !body.targetSpeakerId) {
      return c.json({ error: "sourceSpeakerId and targetSpeakerId are required" }, 400);
    }

    try {
      const merged = await speakerService.mergeSpeakers(body.sourceSpeakerId, body.targetSpeakerId);
      return c.json({ speaker: merged });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/meetings/:id/speakers/reassign", async (c) => {
    const meetingId = c.req.param("id");
    let body: {
      fromLabel?: string;
      toSpeakerName?: string;
      toSpeakerId?: string;
      adoptVoiceprint?: boolean;
      segmentIndex?: number;
      scope?: "single" | "all";
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Valid JSON body required" }, 400);
    }

    if (!body.fromLabel || (!body.toSpeakerName && !body.toSpeakerId)) {
      return c.json({ error: "fromLabel and either toSpeakerName or toSpeakerId are required" }, 400);
    }

    try {
      const result = await speakerService.reassignMeetingSpeaker({
        meetingId,
        fromLabel: body.fromLabel,
        toSpeakerName: body.toSpeakerName,
        toSpeakerId: body.toSpeakerId,
        adoptVoiceprint: body.adoptVoiceprint,
        segmentIndex: body.segmentIndex,
        scope: body.scope
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/meetings/:id/speakers/confirm-segment", async (c) => {
    const meetingId = c.req.param("id");
    let body: { segmentIndex?: number; speakerName?: string; speakerId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Valid JSON body required" }, 400);
    }

    if (body.segmentIndex === undefined || typeof body.segmentIndex !== "number") {
      return c.json({ error: "segmentIndex is required and must be a number" }, 400);
    }

    try {
      const result = await speakerService.confirmMeetingSegmentSpeaker({
        meetingId,
        segmentIndex: body.segmentIndex,
        speakerName: body.speakerName,
        speakerId: body.speakerId
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/meetings/:id/speakers/unassign-segment", async (c) => {
    const meetingId = c.req.param("id");
    let body: { segmentIndex?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Valid JSON body required" }, 400);
    }

    if (body.segmentIndex === undefined || typeof body.segmentIndex !== "number") {
      return c.json({ error: "segmentIndex is required and must be a number" }, 400);
    }

    try {
      const result = await speakerService.unassignMeetingSegmentSpeaker({
        meetingId,
        segmentIndex: body.segmentIndex
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/meetings/:id/speakers/split-segment", async (c) => {
    const meetingId = c.req.param("id");
    let body: {
      segmentIndex?: number;
      wordIndex?: number;
      splitMs?: number;
      newSpeakerName?: string;
      newSpeakerId?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Valid JSON body required" }, 400);
    }

    if (body.segmentIndex === undefined || typeof body.segmentIndex !== "number") {
      return c.json({ error: "segmentIndex is required and must be a number" }, 400);
    }

    try {
      const result = await speakerService.splitMeetingSegment({
        meetingId,
        segmentIndex: body.segmentIndex,
        wordIndex: body.wordIndex,
        splitMs: body.splitMs,
        newSpeakerName: body.newSpeakerName,
        newSpeakerId: body.newSpeakerId
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/meetings/:id/speakers/merge-segments", async (c) => {
    const meetingId = c.req.param("id");
    let body: { segmentIndex?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Valid JSON body required" }, 400);
    }

    if (body.segmentIndex === undefined || typeof body.segmentIndex !== "number") {
      return c.json({ error: "segmentIndex is required and must be a number" }, 400);
    }

    try {
      const result = await speakerService.mergeMeetingSegments({
        meetingId,
        segmentIndex: body.segmentIndex
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.patch("/api/speakers/:id", async (c) => {
    const id = c.req.param("id");
    let body: { name?: string; providerIds?: Record<string, string[]> };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Valid JSON body required" }, 400);
    }

    try {
      const updated = await speakerService.updateSpeaker(id, body);
      return c.json({ speaker: updated });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/speakers/:id", async (c) => {
    const id = c.req.param("id");
    await speakerService.deleteSpeaker(id);
    return c.json({ status: "deleted" });
  });

  // Templates API
  app.get("/api/templates", async (c) => {
    const templates = await templateService.listTemplates();
    return c.json({ templates });
  });

  app.get("/api/templates/:id", async (c) => {
    const id = c.req.param("id");
    const template = await templateService.getTemplate(id);
    if (!template) {
      return c.json({ error: "Template not found" }, 404);
    }
    return c.json({ template });
  });

  app.post("/api/templates", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Valid JSON body required" }, 400);
    }

    try {
      const template = await templateService.createTemplate(body as any);
      return c.json({ template }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  const handleUpdateTemplate = async (c: any) => {
    const id = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Valid JSON body required" }, 400);
    }

    try {
      const template = await templateService.updateTemplate(id, body as any);
      return c.json({ template });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes("not found") ? 404 : 400;
      return c.json({ error: message }, status);
    }
  };

  app.patch("/api/templates/:id", handleUpdateTemplate);
  app.put("/api/templates/:id", handleUpdateTemplate);

  app.delete("/api/templates/:id", async (c) => {
    const id = c.req.param("id");
    try {
      await templateService.deleteTemplate(id);
      return c.json({ status: "deleted" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes("not found") ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.post("/api/templates/:id/default", async (c) => {
    const id = c.req.param("id");
    try {
      const template = await templateService.setDefaultTemplate(id);
      return c.json({ template });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes("not found") ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  // LLM API
  app.get("/api/llm/providers", async (c) => {
    const providers = await llmService.listProviders();
    return c.json({ providers });
  });

  app.get("/api/llm/models", async (c) => {
    const provider = c.req.query("provider");
    const search = c.req.query("search");
    const limit = numericQueryParam(c.req.query("limit"));

    const models = await llmService.listModels({ provider, search, limit });
    return c.json({ models });
  });

  app.post("/api/llm/refresh-catalog", async (c) => {
    const result = await llmService.refreshCatalog();
    return c.json({ status: "refreshed", ...result });
  });

  app.get("/api/llm/config", async (c) => {
    const settings = await llmService.getSettings();
    // Return sanitized settings (masking API keys for privacy in UI)
    const sanitizedProviders: Record<string, { hasApiKey: boolean; baseUrl?: string; headers?: Record<string, string> }> = {};
    for (const [pId, pCfg] of Object.entries(settings.providers)) {
      sanitizedProviders[pId] = {
        hasApiKey: Boolean(pCfg.apiKey),
        baseUrl: pCfg.baseUrl,
        headers: pCfg.headers
      };
    }

    return c.json({
      defaultProvider: settings.defaultProvider,
      defaultModel: settings.defaultModel,
      defaultThinkingLevel: settings.defaultThinkingLevel || "off",
      providers: sanitizedProviders,
      customModels: settings.customModels
    });
  });

  app.post("/api/llm/config", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Valid JSON body required" }, 400);
    }

    try {
      const updated = await llmService.updateSettings(body as any);
      return c.json({ status: "updated", settings: updated });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/config", (c) => {
    try {
      const config = loadAppConfig(appConfigPaths);
      return c.json(config);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/config", async (c) => {
    try {
      const body = await c.req.json();
      const current = loadAppConfig(appConfigPaths);
      const merged = { ...current, ...(body as object) };
      const updated = saveAppConfig(merged, appConfigPaths);
      transcriptionService.setDefaultProvider(updated.transcriptionProvider);
      ingestService.setDefaultTranscriptionProvider(updated.transcriptionProvider);
      return c.json({ status: "updated", config: updated });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/llm/generate", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Valid JSON body required" }, 400);
    }

    try {
      const result = await llmService.generateText(body as any);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/llm/test", async (c) => {
    let body: { provider?: string; model?: string; apiKey?: string; baseUrl?: string; thinkingLevel?: string } = {};
    try {
      body = await c.req.json();
    } catch {}

    try {
      const result = await llmService.generateText({
        provider: body.provider,
        model: body.model,
        prompt: "Reply with strictly the word: PONG",
        apiKeyOverride: body.apiKey,
        baseUrlOverride: body.baseUrl,
        thinkingLevel: body.thinkingLevel as any,
        maxTokens: 50
      });

      const text = result.text.trim();
      return c.json({
        ok: text.toLowerCase().includes("pong") || text.length > 0,
        response: text,
        provider: result.provider,
        model: result.model,
        durationMs: result.durationMs,
        usage: result.usage
      });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/meetings/:id/speakers/link", async (c) => {
    const meetingId = c.req.param("id");
    let body: { speakerId?: string; speechmaticsLabel?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Valid JSON body required" }, 400);
    }

    if (!body.speakerId) {
      return c.json({ error: "speakerId is required" }, 400);
    }

    try {
      const result = await speakerService.linkMeetingSpeaker({
        meetingId,
        speakerId: body.speakerId,
        speechmaticsLabel: body.speechmaticsLabel
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/plaud/status", async (c) => c.json(await plaudPoller.getStatus()));

  app.post("/api/plaud/sync/trigger", async (c) => {
    const result = await plaudPoller.trigger();
    return c.json({ status: result.error ? "error" : "completed", ...result }, result.error ? 502 : 200);
  });

  app.post("/api/plaud/auth/start", async (c) => {
    try {
      const login = await oauthManager.startManualLogin();
      const sessionId = authSessions.create({ verifier: login.verifier, state: login.state });
      return c.json({ authUrl: login.authUrl, sessionId });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  });

  app.post("/api/plaud/auth/complete", async (c) => {
    let parsedBody: unknown;
    try {
      parsedBody = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be valid JSON" }, 400);
    }

    if (!parsedBody || typeof parsedBody !== "object") {
      return c.json({ error: "Request body must be a JSON object" }, 400);
    }

    const body = parsedBody as { pastedUrlOrCode?: unknown; sessionId?: unknown };

    if (typeof body.pastedUrlOrCode !== "string" || !body.pastedUrlOrCode.trim()) {
      return c.json({ error: "pastedUrlOrCode is required" }, 400);
    }
    if (typeof body.sessionId !== "string" || !body.sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    const session = authSessions.get(body.sessionId);
    if (!session) {
      return c.json({ error: "Unknown or expired Plaud auth session" }, 400);
    }

    try {
      await oauthManager.completeManualLogin(body.pastedUrlOrCode, session.verifier, session.state);
      authSessions.delete(body.sessionId);
      return c.json({ status: "completed" });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  });

  // Backup & Restore API
  app.post("/api/backup", async (c) => {
    try {
      let filename: string | undefined;
      const contentType = c.req.header("content-type") || "";
      if (contentType.includes("application/json")) {
        const body = (await c.req.json().catch(() => ({}))) as { filename?: string };
        if (typeof body.filename === "string" && body.filename.trim()) {
          filename = body.filename.trim();
        }
      }
      const result = await backupService.createBackup({ filename });
      return c.json({ ok: true, backup: result }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/backup/list", async (c) => {
    try {
      const backups = await backupService.listBackups();
      return c.json({ ok: true, backups });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/backup/download/:filename", async (c) => {
    const filename = c.req.param("filename");
    try {
      const fullPath = backupService.getBackupPath(filename);
      const file = Bun.file(fullPath);
      return new Response(file, {
        headers: {
          "Content-Type": "application/gzip",
          "Content-Disposition": `attachment; filename="${filename}"`
        }
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  app.get("/api/backup/export", async (c) => {
    try {
      const result = await backupService.createBackup();
      const file = Bun.file(result.path);
      return new Response(file, {
        headers: {
          "Content-Type": "application/gzip",
          "Content-Disposition": `attachment; filename="${result.filename}"`
        }
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.delete("/api/backup/:filename", async (c) => {
    const filename = c.req.param("filename");
    try {
      await backupService.deleteBackup(filename);
      return c.json({ ok: true, message: `Backup ${filename} deleted` });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  app.post("/api/backup/restore", async (c) => {
    try {
      const contentType = c.req.header("content-type") || "";
      if (contentType.includes("multipart/form-data")) {
        const formData = await c.req.formData();
        const file = formData.get("file");
        if (!file || !(file instanceof Blob)) {
          return c.json({ error: "file field (backup .tar.gz archive) is required" }, 400);
        }
        const buffer = Buffer.from(await file.arrayBuffer());
        const result = await backupService.restoreBackup(buffer);
        return c.json({ ok: true, result });
      } else if (contentType.includes("application/json")) {
        const body = (await c.req.json().catch(() => ({}))) as { filename?: string };
        if (!body.filename || typeof body.filename !== "string") {
          return c.json({ error: "filename is required when restoring from stored backups" }, 400);
        }
        const result = await backupService.restoreBackup(body.filename);
        return c.json({ ok: true, result });
      } else {
        return c.json({ error: "Content-Type must be multipart/form-data or application/json" }, 400);
      }
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // Logs API
  app.get("/api/logs", async (c) => {
    try {
      const minLevel = (c.req.query("level")?.toLowerCase() || "debug") as LogLevel;
      const category = c.req.query("category")?.trim();
      const meetingId = c.req.query("meetingId")?.trim();
      const search = c.req.query("search")?.trim();
      const limit = Math.min(Math.max(numericQueryParam(c.req.query("limit")) ?? 100, 1), 500);
      const offset = Math.max(numericQueryParam(c.req.query("offset")) ?? 0, 0);

      const levelHierarchy: Record<LogLevel, LogLevel[]> = {
        debug: ["debug", "info", "warn", "error"],
        info: ["info", "warn", "error"],
        warn: ["warn", "error"],
        error: ["error"]
      };

      const allowedLevels = levelHierarchy[minLevel] || levelHierarchy.debug;

      let query = db
        .selectFrom("logs")
        .leftJoin("meetings", "meetings.id", "logs.meeting_id")
        .select([
          "logs.id",
          "logs.level",
          "logs.category",
          "logs.message",
          "logs.meeting_id as meetingId",
          "meetings.title as meetingTitle",
          "logs.details",
          "logs.created_at as createdAt"
        ])
        .where("logs.level", "in", allowedLevels);

      let countQuery = db
        .selectFrom("logs")
        .select((eb) => eb.fn.count<number>("id").as("total"))
        .where("logs.level", "in", allowedLevels);

      if (category) {
        query = query.where("logs.category", "=", category);
        countQuery = countQuery.where("logs.category", "=", category);
      }

      if (meetingId) {
        query = query.where("logs.meeting_id", "=", meetingId);
        countQuery = countQuery.where("logs.meeting_id", "=", meetingId);
      }

      if (search) {
        const searchPattern = `%${search}%`;
        query = query.where((eb) =>
          eb.or([
            eb("logs.message", "like", searchPattern),
            eb("logs.details", "like", searchPattern),
            eb("meetings.title", "like", searchPattern),
            eb("logs.category", "like", searchPattern)
          ])
        );
        countQuery = countQuery.where((eb) =>
          eb.or([
            eb("logs.message", "like", searchPattern),
            eb("logs.details", "like", searchPattern),
            eb("logs.category", "like", searchPattern)
          ])
        );
      }

      const [rows, countRow, categoriesRows] = await Promise.all([
        query.orderBy("logs.created_at", "desc").limit(limit).offset(offset).execute(),
        countQuery.executeTakeFirst(),
        db.selectFrom("logs").select("category").distinct().orderBy("category", "asc").execute()
      ]);

      const logs: LogItem[] = rows.map((r) => ({
        id: r.id,
        level: r.level as LogLevel,
        category: r.category,
        message: r.message,
        meetingId: r.meetingId,
        meetingTitle: r.meetingTitle,
        details: parseJsonField(r.details, null),
        createdAt: r.createdAt
      }));

      const total = Number(countRow?.total ?? 0);
      const categories = categoriesRows.map((cat) => cat.category).filter(Boolean);

      return c.json({
        ok: true,
        logs,
        pagination: {
          total,
          limit,
          offset
        },
        categories
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.delete("/api/logs", async (c) => {
    try {
      const olderThan = numericQueryParam(c.req.query("olderThanMs"));
      let deleteQuery = db.deleteFrom("logs");
      if (olderThan) {
        deleteQuery = deleteQuery.where("created_at", "<", olderThan);
      }
      await deleteQuery.execute();
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  if (options.startPlaudPoller) {
    plaudPoller.start(options.pollIntervalMinutes ?? 15);
  }

  if (options.webRoot) {
    app.all("*", async (c) => {
      if (c.req.path.startsWith("/api/")) {
        return c.notFound();
      }

      const asset = await serveWebAsset(options.webRoot!, c.req.path);
      return asset ?? c.notFound();
    });
  }

  return app;
}
