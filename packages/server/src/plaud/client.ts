import { homedir } from "node:os";
import { join } from "node:path";
import { FileTokenStore, PlaudClient } from "@mcowger/plaud-client";

function expandHomePath(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }

  return path;
}

export function createPlaudClient(env: NodeJS.ProcessEnv = process.env): PlaudClient {
  const configuredTokenPath = env.PLAUD_TOKEN_PATH?.trim();
  const tokenStore = configuredTokenPath
    ? new FileTokenStore(expandHomePath(configuredTokenPath))
    : new FileTokenStore();

  return new PlaudClient({ tokenStore });
}
