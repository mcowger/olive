import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Database as BunDatabase } from "bun:sqlite";
import type { Kysely } from "kysely";
import * as tar from "tar";
import {
  type BackupInfo,
  type BackupManifest,
  type Database,
  type RestoreResult
} from "@olive/shared";
import { clearAppConfigCache } from "../config.ts";
import { closeDb, getDb, resetDbHandle } from "../db.ts";
import { logger, type Logger } from "../logger.ts";
import { resolvePaths, type OlivePaths } from "../paths.ts";

export interface BackupServiceOptions {
  db?: Kysely<Database>;
  paths?: OlivePaths;
  configDir?: string;
  meetingsDir?: string;
  backupsDir?: string;
  databasePath?: string;
  settingsPath?: string;
  plaudTokensPath?: string;
  logger?: Logger;
}

export interface CreateBackupResult {
  filename: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
  manifest: BackupManifest;
}

export class BackupService {
  private readonly db: Kysely<Database>;
  private readonly configDir: string;
  private readonly meetingsDir: string;
  private readonly backupsDir: string;
  private readonly databasePath: string;
  private readonly settingsPath: string;
  private readonly plaudTokensPath: string;
  private readonly logger: Logger;

  constructor(options: BackupServiceOptions = {}) {
    const resolved = options.paths || resolvePaths();
    this.configDir = options.configDir || resolved.configDir;
    this.meetingsDir = options.meetingsDir || resolved.meetingsDir;
    this.backupsDir = options.backupsDir || resolved.backupsDir;
    this.databasePath = options.databasePath || resolved.databasePath;
    this.settingsPath = options.settingsPath || resolved.settingsPath;
    this.plaudTokensPath = options.plaudTokensPath || resolved.plaudTokensPath;
    this.db = options.db || getDb();
    this.logger = options.logger || logger;
  }

  /**
   * Generates a safe filename timestamp for backup archives.
   */
  private generateBackupFilename(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const year = now.getUTCFullYear();
    const month = pad(now.getUTCMonth() + 1);
    const day = pad(now.getUTCDate());
    const hours = pad(now.getUTCHours());
    const mins = pad(now.getUTCMinutes());
    const secs = pad(now.getUTCSeconds());
    return `olive-backup-${year}${month}${day}-${hours}${mins}${secs}.tar.gz`;
  }

  /**
   * Scans a meetings directory to calculate audio files and summaries metrics.
   */
  private scanMeetingsDirectory(meetingsDir: string): {
    audioFilesCount: number;
    totalAudioSizeBytes: number;
    summaryFilesCount: number;
  } {
    let audioFilesCount = 0;
    let totalAudioSizeBytes = 0;
    let summaryFilesCount = 0;

    if (!existsSync(meetingsDir)) {
      return { audioFilesCount, totalAudioSizeBytes, summaryFilesCount };
    }

    try {
      const entries = readdirSync(meetingsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const meetingPath = join(meetingsDir, entry.name);

        const audioDirPath = join(meetingPath, "audio");
        if (existsSync(audioDirPath)) {
          const audioFiles = readdirSync(audioDirPath, { withFileTypes: true });
          for (const af of audioFiles) {
            if (af.isFile()) {
              audioFilesCount++;
              try {
                const st = statSync(join(audioDirPath, af.name));
                totalAudioSizeBytes += st.size;
              } catch {}
            }
          }
        }

        const summariesDirPath = join(meetingPath, "summaries");
        if (existsSync(summariesDirPath)) {
          const summaryFiles = readdirSync(summariesDirPath, { withFileTypes: true });
          for (const sf of summaryFiles) {
            if (sf.isFile() && sf.name.endsWith(".md")) {
              summaryFilesCount++;
            }
          }
        }
      }
    } catch (err) {
      this.logger.warn("Failed scanning meetings directory for metrics", {
        error: err instanceof Error ? err.message : String(err)
      });
    }

    return { audioFilesCount, totalAudioSizeBytes, summaryFilesCount };
  }

  /**
   * Creates a complete, self-contained backup archive (.tar.gz) including:
   * - Consistent snapshot of the SQLite database
   * - User configuration & settings (settings.json, models.json)
   * - All meeting folders containing all audio recordings, transcripts, and markdown summaries
   * - Archive metadata manifest (manifest.json)
   */
  async createBackup(options: { filename?: string } = {}): Promise<CreateBackupResult> {
    const filename = options.filename || this.generateBackupFilename();
    mkdirSync(this.backupsDir, { recursive: true });
    const targetArchivePath = join(this.backupsDir, filename);

    const stagingDir = mkdtempSync(join(tmpdir(), "olive-backup-staging-"));

    try {
      this.logger.info("Creating Olive backup archive", { targetArchivePath });

      // 1. Snapshot database
      const stagingDbPath = join(stagingDir, "olive.sqlite");
      if (existsSync(this.databasePath)) {
        try {
          const sourceDb = new BunDatabase(this.databasePath);
          sourceDb.exec("PRAGMA wal_checkpoint(TRUNCATE);");
          sourceDb.exec(`VACUUM INTO '${stagingDbPath.replace(/'/g, "''")}';`);
          sourceDb.close();
        } catch (vacuumErr) {
          this.logger.warn("VACUUM INTO failed, falling back to direct copy", {
            error: vacuumErr instanceof Error ? vacuumErr.message : String(vacuumErr)
          });
          cpSync(this.databasePath, stagingDbPath);
        }
      } else {
        // In-memory or empty database fallback: create an initialized sqlite db
        const tempSqlite = new BunDatabase(stagingDbPath);
        tempSqlite.close();
      }

      // 2. Query stats for the manifest
      let meetingCount = 0;
      let recordingCount = 0;
      let speakerCount = 0;
      let templateCount = 0;
      let summaryCount = 0;

      try {
        const countsDb = new BunDatabase(stagingDbPath);
        const getCount = (table: string): number => {
          try {
            const row = countsDb.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM ${table}`).get();
            return row?.count ?? 0;
          } catch {
            return 0;
          }
        };

        meetingCount = getCount("meetings");
        recordingCount = getCount("recordings");
        speakerCount = getCount("speakers");
        templateCount = getCount("templates");
        try {
          const sumRow = countsDb.query<{ count: number }, []>(
            `SELECT COUNT(*) as count FROM artifacts WHERE kind = 'summary'`
          ).get();
          summaryCount = sumRow?.count ?? 0;
        } catch {
          summaryCount = 0;
        }
        countsDb.close();
      } catch (err) {
        this.logger.warn("Could not query staging DB stats", {
          error: err instanceof Error ? err.message : String(err)
        });
      }

      // 3. Copy settings, tokens & custom model catalog
      if (existsSync(this.settingsPath)) {
        cpSync(this.settingsPath, join(stagingDir, "settings.json"));
      }

      if (existsSync(this.plaudTokensPath)) {
        cpSync(this.plaudTokensPath, join(stagingDir, "plaud-tokens.json"));
      }

      const modelsPath = join(this.configDir, "models.json");
      if (existsSync(modelsPath)) {
        cpSync(modelsPath, join(stagingDir, "models.json"));
      }

      // 4. Copy meetings directory containing all audio files, transcripts, summaries
      const stagingMeetingsDir = join(stagingDir, "meetings");
      if (existsSync(this.meetingsDir)) {
        cpSync(this.meetingsDir, stagingMeetingsDir, { recursive: true });
      } else {
        mkdirSync(stagingMeetingsDir, { recursive: true });
      }

      const diskMetrics = this.scanMeetingsDirectory(stagingMeetingsDir);
      if (summaryCount === 0 && diskMetrics.summaryFilesCount > 0) {
        summaryCount = diskMetrics.summaryFilesCount;
      }

      // 5. Generate and write manifest.json
      const manifest: BackupManifest = {
        version: "1.0.0",
        createdAt: new Date().toISOString(),
        oliveVersion: "0.1.0",
        app: "olive",
        stats: {
          meetingCount,
          recordingCount,
          audioFilesCount: diskMetrics.audioFilesCount,
          totalAudioSizeBytes: diskMetrics.totalAudioSizeBytes,
          summaryCount,
          speakerCount,
          templateCount
        }
      };

      writeFileSync(join(stagingDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

      // 6. Build the compressed tar.gz archive
      await tar.c(
        {
          gzip: true,
          file: targetArchivePath,
          cwd: stagingDir
        },
        ["."]
      );

      const stat = statSync(targetArchivePath);
      this.logger.info("Olive backup archive created successfully", {
        filename,
        sizeBytes: stat.size,
        stats: manifest.stats
      });

      return {
        filename,
        path: targetArchivePath,
        sizeBytes: stat.size,
        createdAt: manifest.createdAt,
        manifest
      };
    } finally {
      try {
        rmSync(stagingDir, { recursive: true, force: true });
      } catch {}
    }
  }

  /**
   * Reads manifest.json metadata directly from a .tar.gz archive without extracting the entire file.
   */
  async readManifestFromArchive(archivePath: string): Promise<BackupManifest | null> {
    if (!existsSync(archivePath)) {
      return null;
    }

    let manifest: BackupManifest | null = null;

    try {
      await tar.t({
        file: archivePath,
        onentry: (entry) => {
          const entryPath = entry.path.replace(/^\.\//, "");
          if (entryPath === "manifest.json" || entryPath === "backup_manifest.json") {
            const chunks: Buffer[] = [];
            entry.on("data", (chunk: Buffer) => chunks.push(chunk));
            entry.on("end", () => {
              try {
                manifest = JSON.parse(Buffer.concat(chunks).toString("utf8")) as BackupManifest;
              } catch {}
            });
          }
        }
      });
    } catch (err) {
      this.logger.warn("Failed reading manifest from archive", {
        archivePath,
        error: err instanceof Error ? err.message : String(err)
      });
    }

    return manifest;
  }

  /**
   * Lists all backup archives stored in the backups directory.
   */
  async listBackups(): Promise<BackupInfo[]> {
    if (!existsSync(this.backupsDir)) {
      return [];
    }

    const files = readdirSync(this.backupsDir, { withFileTypes: true });
    const backupFiles = files.filter(
      (f) => f.isFile() && (f.name.endsWith(".tar.gz") || f.name.endsWith(".tgz"))
    );

    const results: BackupInfo[] = [];

    for (const file of backupFiles) {
      const fullPath = join(this.backupsDir, file.name);
      try {
        const st = statSync(fullPath);
        const manifest = await this.readManifestFromArchive(fullPath);
        results.push({
          filename: file.name,
          sizeBytes: st.size,
          createdAt: manifest?.createdAt || st.mtime.toISOString(),
          manifest
        });
      } catch (err) {
        this.logger.warn("Failed inspecting backup file", {
          file: file.name,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    // Sort newest first
    return results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /**
   * Resolves safe local path for a stored backup file.
   */
  getBackupPath(filename: string): string {
    const cleanName = basename(filename);
    if (cleanName !== filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
      throw new Error("Invalid backup filename");
    }

    const fullPath = join(this.backupsDir, filename);
    if (!existsSync(fullPath)) {
      throw new Error(`Backup file ${filename} not found`);
    }

    return fullPath;
  }

  /**
   * Deletes a backup archive from disk.
   */
  async deleteBackup(filename: string): Promise<void> {
    const fullPath = this.getBackupPath(filename);
    unlinkSync(fullPath);
    this.logger.info("Deleted backup archive", { filename });
  }

  /**
   * Restores an Olive archive (.tar.gz).
   *
   * @param source - Archive file path or raw binary buffer
   */
  async restoreBackup(
    source: string | Buffer | Uint8Array,
    options: { rollbackOnError?: boolean } = { rollbackOnError: true }
  ): Promise<RestoreResult> {
    const extractDir = mkdtempSync(join(tmpdir(), "olive-restore-extract-"));
    const rollbackDir = mkdtempSync(join(tmpdir(), "olive-restore-rollback-"));

    let archivePathOnDisk: string;
    let isTempArchive = false;

    if (typeof source === "string") {
      if (existsSync(source)) {
        archivePathOnDisk = source;
      } else {
        archivePathOnDisk = this.getBackupPath(source);
      }
    } else {
      archivePathOnDisk = join(extractDir, "upload-archive.tar.gz");
      writeFileSync(archivePathOnDisk, Buffer.from(source));
      isTempArchive = true;
    }

    try {
      this.logger.info("Starting Olive restore", { archivePath: archivePathOnDisk });

      // 1. Extract archive to staging directory
      await tar.x({
        file: archivePathOnDisk,
        cwd: extractDir
      });

      // 2. Validate extracted contents
      let extractedDbPath = join(extractDir, "olive.sqlite");
      if (!existsSync(extractedDbPath)) {
        // Check database/ subfolder
        const altPath = join(extractDir, "database", "olive.sqlite");
        if (existsSync(altPath)) {
          extractedDbPath = altPath;
        } else {
          throw new Error("Invalid backup archive: missing 'olive.sqlite' database");
        }
      }

      // Verify SQLite database integrity
      try {
        const testDb = new BunDatabase(extractedDbPath);
        testDb.query("SELECT 1;").get();
        testDb.close();
      } catch (dbErr) {
        throw new Error(`Corrupted database in backup archive: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
      }

      // Read manifest if present
      let manifest: BackupManifest | null = null;
      const manifestPath = join(extractDir, "manifest.json");
      if (existsSync(manifestPath)) {
        try {
          manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
        } catch {}
      }

      // 3. Create rollback checkpoint of active data if exists
      if (options.rollbackOnError) {
        try {
          if (existsSync(this.databasePath)) {
            cpSync(this.databasePath, join(rollbackDir, "olive.sqlite"));
          }
          if (existsSync(this.settingsPath)) {
            cpSync(this.settingsPath, join(rollbackDir, "settings.json"));
          }
          if (existsSync(this.plaudTokensPath)) {
            cpSync(this.plaudTokensPath, join(rollbackDir, "plaud-tokens.json"));
          }
        } catch (rbErr) {
          this.logger.warn("Could not create local rollback snapshot", {
            error: rbErr instanceof Error ? rbErr.message : String(rbErr)
          });
        }
      }

      // 4. Close existing DB handles before replacing files
      await closeDb();
      if (this.db) {
        try {
          await this.db.destroy();
        } catch {}
      }

      // 5. Replace database file (safely unlinking old db/wal/shm inodes first)
      mkdirSync(dirname(this.databasePath), { recursive: true });
      const walPath = `${this.databasePath}-wal`;
      const shmPath = `${this.databasePath}-shm`;
      if (existsSync(walPath)) {
        try {
          unlinkSync(walPath);
        } catch {}
      }
      if (existsSync(shmPath)) {
        try {
          unlinkSync(shmPath);
        } catch {}
      }
      if (existsSync(this.databasePath)) {
        try {
          unlinkSync(this.databasePath);
        } catch {}
      }
      cpSync(extractedDbPath, this.databasePath);

      // 6. Restore settings.json, plaud-tokens.json and models.json if present
      const extractedSettings = join(extractDir, "settings.json");
      if (existsSync(extractedSettings)) {
        cpSync(extractedSettings, this.settingsPath);
      }

      const extractedPlaudTokens = join(extractDir, "plaud-tokens.json");
      if (existsSync(extractedPlaudTokens)) {
        cpSync(extractedPlaudTokens, this.plaudTokensPath);
      }

      const extractedModels = join(extractDir, "models.json");
      if (existsSync(extractedModels)) {
        cpSync(extractedModels, join(this.configDir, "models.json"));
      }

      // 7. Restore meetings folder (audio files, transcripts, summaries)
      const extractedMeetings = join(extractDir, "meetings");
      if (existsSync(extractedMeetings)) {
        mkdirSync(this.meetingsDir, { recursive: true });
        cpSync(extractedMeetings, this.meetingsDir, { recursive: true });
      }

      // 8. Re-open database handle and run any migrations
      const handle = await resetDbHandle(this.databasePath);
      clearAppConfigCache();

      // 9. Query restored database stats
      const countsDb = handle.sqlite;
      const getCount = (table: string): number => {
        try {
          const row = countsDb.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM ${table}`).get();
          return row?.count ?? 0;
        } catch {
          return 0;
        }
      };

      const meetingCount = getCount("meetings");
      const recordingCount = getCount("recordings");
      const speakerCount = getCount("speakers");
      const templateCount = getCount("templates");
      let summaryCount = 0;
      try {
        const sumRow = countsDb.query<{ count: number }, []>(
          `SELECT COUNT(*) as count FROM artifacts WHERE kind = 'summary'`
        ).get();
        summaryCount = sumRow?.count ?? 0;
      } catch {
        summaryCount = 0;
      }

      const diskMetrics = this.scanMeetingsDirectory(this.meetingsDir);
      if (summaryCount === 0 && diskMetrics.summaryFilesCount > 0) {
        summaryCount = diskMetrics.summaryFilesCount;
      }

      const result: RestoreResult = {
        success: true,
        restoredAt: new Date().toISOString(),
        manifest,
        stats: {
          meetings: meetingCount,
          recordings: recordingCount,
          audioFiles: diskMetrics.audioFilesCount,
          summaries: summaryCount,
          speakers: speakerCount,
          templates: templateCount
        }
      };

      this.logger.info("Olive restore completed successfully", {
        stats: result.stats
      });

      return result;
    } catch (error) {
      this.logger.error("Restore failed", {
        error: error instanceof Error ? error.message : String(error)
      });

      // Attempt rollback if error occurred
      if (options.rollbackOnError && existsSync(join(rollbackDir, "olive.sqlite"))) {
        try {
          const walPath = `${this.databasePath}-wal`;
          const shmPath = `${this.databasePath}-shm`;
          if (existsSync(walPath)) try { unlinkSync(walPath); } catch {}
          if (existsSync(shmPath)) try { unlinkSync(shmPath); } catch {}
          cpSync(join(rollbackDir, "olive.sqlite"), this.databasePath);
          if (existsSync(join(rollbackDir, "settings.json"))) {
            cpSync(join(rollbackDir, "settings.json"), this.settingsPath);
          }
          if (existsSync(join(rollbackDir, "plaud-tokens.json"))) {
            cpSync(join(rollbackDir, "plaud-tokens.json"), this.plaudTokensPath);
          }
          await resetDbHandle(this.databasePath);
          clearAppConfigCache();
          this.logger.info("Rollback restored previous state after restore failure");
        } catch (rbErr) {
          this.logger.error("Rollback failed", {
            error: rbErr instanceof Error ? rbErr.message : String(rbErr)
          });
        }
      }

      throw error;
    } finally {
      try {
        rmSync(extractDir, { recursive: true, force: true });
        rmSync(rollbackDir, { recursive: true, force: true });
      } catch {}
    }
  }
}
