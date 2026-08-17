#!/usr/bin/env bun
import { cpSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { BackupService } from "../packages/server/src/backup/service.ts";
import { resolvePaths } from "../packages/server/src/paths.ts";

async function main() {
  const customOutputPath = process.argv[2];
  const paths = resolvePaths();
  const backupService = new BackupService({ paths });

  console.log("📦 Starting Olive backup creation...");
  console.log(`- Config directory:   ${paths.configDir}`);
  console.log(`- Meetings directory: ${paths.meetingsDir}`);
  console.log(`- Database path:      ${paths.databasePath}`);

  const startTime = Date.now();
  const result = await backupService.createBackup();

  let finalPath = result.path;
  if (customOutputPath) {
    const resolvedCustom = resolve(customOutputPath);
    cpSync(result.path, resolvedCustom);
    finalPath = resolvedCustom;
  }

  const durationSecs = ((Date.now() - startTime) / 1000).toFixed(1);
  const sizeMb = (statSync(finalPath).size / (1024 * 1024)).toFixed(2);
  const audioMb = (result.manifest.stats.totalAudioSizeBytes / (1024 * 1024)).toFixed(2);

  console.log("\n✅ Backup created successfully!");
  console.log(`- Archive file:       ${finalPath}`);
  console.log(`- Archive size:       ${sizeMb} MB`);
  console.log(`- Time elapsed:       ${durationSecs}s`);
  console.log(`- Meetings archived:  ${result.manifest.stats.meetingCount}`);
  console.log(`- Audio files:        ${result.manifest.stats.audioFilesCount} (${audioMb} MB)`);
  console.log(`- Summaries/Notes:    ${result.manifest.stats.summaryCount}`);
  console.log(`- Speakers enrolled:  ${result.manifest.stats.speakerCount}`);
  console.log(`- Prompt templates:   ${result.manifest.stats.templateCount}`);
}

main().catch((err) => {
  console.error("❌ Backup failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
