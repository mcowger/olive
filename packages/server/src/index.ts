import { join } from "node:path";
import { loadAppConfig, loadRuntimeConfig } from "./config.ts";
import { createApp } from "./app.ts";
import { logger } from "./logger.ts";

const runtimeConfig = loadRuntimeConfig();
const appConfig = loadAppConfig(runtimeConfig.paths);
const webRoot = process.env.OLIVE_WEB_ROOT || join(import.meta.dir, "../../web/dist");
const app = createApp({ webRoot });

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
