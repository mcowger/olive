import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { type Database } from "@olive/shared";
import { runMigrations } from "@olive/shared/migrations";
import { resolvePaths } from "./paths.ts";

export interface DbHandle {
  sqlite: BunDatabase;
  db: Kysely<Database>;
}

export function createDb(databasePath: string): DbHandle {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const sqlite = new BunDatabase(databasePath);
  runMigrations(sqlite);
  const db = new Kysely<Database>({ dialect: new BunSqliteDialect({ database: sqlite }) });
  return { sqlite, db };
}

let activeHandle: DbHandle | undefined;

export function getDbHandle(): DbHandle {
  if (!activeHandle) {
    activeHandle = createDb(resolvePaths().databasePath);
  }

  return activeHandle;
}

export function getDb(): Kysely<Database> {
  return getDbHandle().db;
}

export function setDbForTests(handle: DbHandle | undefined): void {
  activeHandle?.db.destroy();
  activeHandle?.sqlite.close();
  activeHandle = handle;
}

export async function closeDb(): Promise<void> {
  if (!activeHandle) {
    return;
  }

  await activeHandle.db.destroy();
  activeHandle.sqlite.close();
  activeHandle = undefined;
}
