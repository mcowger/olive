import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { FileTokenStore, PlaudClient } from "@mcowger/plaud-client";
import { resolvePaths, type OlivePaths } from "../paths.ts";

function expandHomePath(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }

  return path;
}

export function resolvePlaudTokenPath(
  paths: OlivePaths = resolvePaths(),
  env: NodeJS.ProcessEnv = process.env
): string {
  const configuredTokenPath = env.PLAUD_TOKEN_PATH?.trim();
  const tokenPath = configuredTokenPath
    ? expandHomePath(configuredTokenPath)
    : paths.plaudTokensPath;

  mkdirSync(dirname(tokenPath), { recursive: true });

  // Migrate legacy tokens from default ~/.plaud/tokens.json if new path is empty
  if (!existsSync(tokenPath)) {
    const legacyPath = join(homedir(), ".plaud", "tokens.json");
    if (existsSync(legacyPath)) {
      try {
        cpSync(legacyPath, tokenPath);
      } catch {}
    }
  }

  return tokenPath;
}

export function createPlaudClient(
  paths: OlivePaths = resolvePaths(),
  env: NodeJS.ProcessEnv = process.env
): PlaudClient {
  const tokenPath = resolvePlaudTokenPath(paths, env);
  const tokenStore = new FileTokenStore(tokenPath);

  return new PlaudClient({ tokenStore });
}
