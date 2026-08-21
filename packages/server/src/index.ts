import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadAppConfig, loadRuntimeConfig } from "./config.ts";
import { createApp } from "./app.ts";
import { logger } from "./logger.ts";

const runtimeConfig = loadRuntimeConfig();
const appConfig = loadAppConfig(runtimeConfig.paths);

// Ensure persistent models directory exists and set HF_HOME/TRANSFORMERS_CACHE
const hfModelsDir = join(runtimeConfig.paths.modelsDir, "huggingface");
mkdirSync(hfModelsDir, { recursive: true });
if (!process.env.HF_HOME) process.env.HF_HOME = hfModelsDir;
if (!process.env.TRANSFORMERS_CACHE) process.env.TRANSFORMERS_CACHE = hfModelsDir;

const webRoot = process.env.OLIVE_WEB_ROOT || join(import.meta.dir, "../../web/dist");
const app = createApp({
  webRoot,
  meetingsDir: runtimeConfig.paths.meetingsDir,
  pollIntervalMinutes: appConfig.pollIntervalMinutes,
  defaultTranscriptionProvider: appConfig.transcriptionProvider,
  bindHost: runtimeConfig.bindHost,
  startPlaudPoller: import.meta.main
});

if (import.meta.main) {
  const server = Bun.serve({
    fetch: app.fetch,
    hostname: runtimeConfig.bindHost,
    port: runtimeConfig.bindPort
  });

  logger.info("Olive server listening", {
    host: runtimeConfig.bindHost,
    port: server.port,
    webRoot,
    pollIntervalMinutes: appConfig.pollIntervalMinutes
  });
}

export { app };
