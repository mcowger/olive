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

export interface AppOptions {
  db?: Kysely<Database>;
  webRoot?: string;
  meetingsDir?: string;
  plaudClient?: PlaudClientLike;
  plaudPoller?: PlaudPoller;
  oauthManager?: PlaudOAuthManager;
  authSessions?: PlaudAuthSessionStore;
  pollIntervalMinutes?: number;
  startPlaudPoller?: boolean;
  speechmaticsClient?: SpeechmaticsClient;
  transcriptionService?: TranscriptionService;
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
  const meetingsDir = options.meetingsDir ?? resolvePaths().meetingsDir;
  const speechmaticsWebhookSecret = options.speechmaticsWebhookSecret || process.env.SPEECHMATICS_WEBHOOK_SECRET;

  const transcriptionService =
    options.transcriptionService ??
    new TranscriptionService({
      db,
      meetingsDir,
      speechmaticsClient: options.speechmaticsClient ?? new SpeechmaticsClient(),
      webhookSecret: speechmaticsWebhookSecret
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
    let body: { language?: string; poll?: boolean; force?: boolean; pollIntervalMs?: number; maxPollWaitMs?: number } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      // json body is optional
    }

    try {
      const result = await transcriptionService.transcribeMeeting(meetingId, {
        language: body.language,
        poll: body.poll,
        force: body.force,
        pollIntervalMs: body.pollIntervalMs,
        maxPollWaitMs: body.maxPollWaitMs
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
