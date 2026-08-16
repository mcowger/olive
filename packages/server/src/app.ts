import { existsSync, statSync } from "node:fs";
import { join, normalize, relative } from "node:path";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import type { Database } from "@olive/shared";
import { getDb } from "./db.ts";
import { resolvePaths } from "./paths.ts";
import { getMeeting, listMeetings } from "./meetings.ts";
import { createPlaudClient } from "./plaud/client.ts";
import { PlaudAuthSessionStore } from "./plaud/auth.ts";
import { PlaudPoller, type PlaudClientLike, type PlaudOAuthManager } from "./plaud/poller.ts";
import { SpeechmaticsClient, type SpeechmaticsJsonV2 } from "./providers/speechmatics/index.ts";
import { TranscriptionService } from "./transcription/service.ts";
import { SpeakerService } from "./speakers/service.ts";

export interface AppOptions {
  db?: Kysely<Database>;
  webRoot?: string;
  configDir?: string;
  meetingsDir?: string;
  plaudClient?: PlaudClientLike;
  plaudPoller?: PlaudPoller;
  oauthManager?: PlaudOAuthManager;
  authSessions?: PlaudAuthSessionStore;
  pollIntervalMinutes?: number;
  startPlaudPoller?: boolean;
  speechmaticsClient?: SpeechmaticsClient;
  transcriptionService?: TranscriptionService;
  speakerService?: SpeakerService;
  speechmaticsWebhookSecret?: string;
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
  return existsSync(indexPath) ? new Response(Bun.file(indexPath)) : undefined;
}

export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();
  const db = options.db ?? getDb();
  const paths = resolvePaths();
  const configDir = options.configDir ?? paths.configDir;
  const meetingsDir = options.meetingsDir ?? paths.meetingsDir;
  const speechmaticsWebhookSecret = options.speechmaticsWebhookSecret || process.env.SPEECHMATICS_WEBHOOK_SECRET;

  const speechmaticsClient = options.speechmaticsClient ?? new SpeechmaticsClient();

  const transcriptionService =
    options.transcriptionService ??
    new TranscriptionService({
      db,
      meetingsDir,
      speechmaticsClient,
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

  const plaudPoller =
    options.plaudPoller ??
    new PlaudPoller({
      db,
      meetingsDir,
      client: options.plaudClient ?? createPlaudClient(),
      transcriptionService
    });
  const oauthManager = options.oauthManager ?? plaudPoller.oauth;
  const authSessions = options.authSessions ?? new PlaudAuthSessionStore();

  app.get("/api/health", (c) => c.json({ status: "ok" }));

  app.get("/api/meetings", async (c) => {
    const response = await listMeetings(db, {
      limit: numericQueryParam(c.req.query("limit")),
      offset: numericQueryParam(c.req.query("offset")),
      search: c.req.query("search")
    });

    return c.json(response);
  });

  app.get("/api/meetings/:id", async (c) => {
    const meetingId = c.req.param("id");
    const detail = await getMeeting(db, meetingId, meetingsDir);
    if (!detail) {
      return c.json({ error: "Meeting not found" }, 404);
    }
    return c.json(detail);
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
    } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      // json body is optional
    }

    try {
      const result = await transcriptionService.transcribeMeeting(meetingId, {
        provider: body.provider,
        language: body.language,
        poll: body.poll,
        force: body.force,
        pollIntervalMs: body.pollIntervalMs,
        maxPollWaitMs: body.maxPollWaitMs,
        similarityThreshold: body.similarityThreshold
      });

      return c.json(result, result.status === "error" ? 502 : 200);
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
    let body: { fromLabel?: string; toSpeakerName?: string; toSpeakerId?: string; adoptVoiceprint?: boolean };
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
        adoptVoiceprint: body.adoptVoiceprint
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
