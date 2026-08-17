import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface OlivePaths {
  configDir: string;
  meetingsDir: string;
  backupsDir: string;
  databasePath: string;
  settingsPath: string;
}

function defaultConfigDir(platform: NodeJS.Platform, homeDir: string, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") {
    return join(env.APPDATA || join(homeDir, "AppData", "Roaming"), "olive");
  }

  if (platform === "darwin") {
    return join(homeDir, "Library", "Application Support", "olive");
  }

  return join(env.XDG_CONFIG_HOME || join(homeDir, ".config"), "olive");
}

export function resolvePaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = homedir()
): OlivePaths {
  const configDir = resolve(env.OLIVE_CONFIG_DIR || defaultConfigDir(platform, homeDir, env));
  const meetingsDir = resolve(env.OLIVE_MEETINGS_DIR || join(configDir, "meetings"));
  const backupsDir = resolve(env.OLIVE_BACKUPS_DIR || join(configDir, "backups"));

  return {
    configDir,
    meetingsDir,
    backupsDir,
    databasePath: join(configDir, "olive.sqlite"),
    settingsPath: join(configDir, "settings.json")
  };
}
