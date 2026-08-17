#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { BackupService } from "../packages/server/src/backup/service.ts";
import { resolvePaths } from "../packages/server/src/paths.ts";

async function main() {
  const archiveArg = process.argv[2];
  if (!archiveArg) {
    console.error("Usage: bun run scripts/restore.ts <path-to-backup.tar.gz>");
    process.exit(1);
  }

  const archivePath = resolve(archiveArg);
  if (!existsSync(archivePath)) {
    console.error(`❌ Archive file not found at: ${archivePath}`);
    process.exit(1);
  }

  const paths = resolvePaths();
  const backupService = new BackupService({ paths });

  console.log("♻️ Starting Olive restore...");
  console.log(`- Archive source:     ${archivePath}`);
  console.log(`- Target config dir:  ${paths.configDir}`);
  console.log(`- Target meetings:    ${paths.meetingsDir}`);
  console.log(`- Target database:    ${paths.databasePath}`);

  const startTime = Date.now();
  const result = await backupService.restoreBackup(archivePath);

  const durationSecs = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n✅ Restore completed successfully!");
  console.log(`- Time elapsed:       ${durationSecs}s`);
  console.log(`- Meetings restored:  ${result.stats.meetings}`);
  console.log(`- Recordings:         ${result.stats.recordings}`);
  console.log(`- Audio files:        ${result.stats.audioFiles}`);
  console.log(`- Summaries/Notes:    ${result.stats.summaries}`);
  console.log(`- Speakers:           ${result.stats.speakers}`);
  console.log(`- Prompt templates:   ${result.stats.templates}`);
}

main().catch((err) => {
  console.error("❌ Restore failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
