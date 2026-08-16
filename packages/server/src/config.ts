import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appConfigSchema, DEFAULT_CONFIG, type AppConfig } from "@olive/shared";
import { resolvePaths, type OlivePaths } from "./paths.ts";

export interface RuntimeConfig {
  paths: OlivePaths;
  bindHost: string;
  bindPort: number;
}

let cachedAppConfig: { settingsPath: string; config: AppConfig } | undefined;

function parsePort(value: string | undefined): number {
  if (!value) {
    return 4471;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("OLIVE_BIND_PORT must be an integer between 1 and 65535");
  }

  return port;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const portValue = env.OLIVE_BIND_PORT || env.PORT || env.PASEO_PORT;
  return {
    paths: resolvePaths(env),
    bindHost: env.OLIVE_BIND_HOST || "127.0.0.1",
    bindPort: parsePort(portValue)
  };
}

export function loadAppConfig(paths: OlivePaths = resolvePaths()): AppConfig {
  mkdirSync(paths.configDir, { recursive: true });

  if (cachedAppConfig?.settingsPath === paths.settingsPath) {
    return cachedAppConfig.config;
  }

  try {
    const contents = readFileSync(paths.settingsPath, "utf8");
    const config = appConfigSchema.parse(JSON.parse(contents));
    cachedAppConfig = { settingsPath: paths.settingsPath, config };
    return config;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return saveAppConfig(DEFAULT_CONFIG, paths);
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${paths.settingsPath}`, { cause: error });
    }

    throw new Error(`Invalid settings in ${paths.settingsPath}`, { cause: error });
  }
}

export function saveAppConfig(config: unknown, paths: OlivePaths = resolvePaths()): AppConfig {
  const validated = appConfigSchema.parse(config);
  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(paths.settingsPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  cachedAppConfig = { settingsPath: paths.settingsPath, config: validated };
  return validated;
}
