import { randomUUID } from "node:crypto";
import type { Database as BunDatabase, Statement } from "bun:sqlite";
import type { LogLevel } from "@olive/shared";
import { getDbHandle } from "./db.ts";

export interface LogFields extends Record<string, unknown> {
  category?: string;
  meetingId?: string;
  meeting_id?: string;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

let activeSqliteDb: BunDatabase | null = null;
let insertStmt: Statement | null = null;

export function setLogDatabase(db: BunDatabase | null): void {
  activeSqliteDb = db;
  insertStmt = null;
}

function getInsertStatement(): Statement | null {
  if (insertStmt) {
    return insertStmt;
  }

  try {
    const sqlite = activeSqliteDb || getDbHandle()?.sqlite;
    if (!sqlite) {
      return null;
    }
    insertStmt = sqlite.prepare(`
      INSERT INTO logs (id, level, category, message, meeting_id, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    return insertStmt;
  } catch {
    return null;
  }
}

function write(level: LogLevel, message: string, fields: LogFields = {}): void {
  const now = Date.now();
  const timestamp = new Date(now).toISOString();

  const {
    category = "system",
    meetingId = fields.meeting_id as string | undefined,
    meeting_id: _ignored,
    ...restFields
  } = fields;

  const line = JSON.stringify({
    timestamp,
    level,
    category,
    message,
    meetingId,
    ...restFields
  });

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }

  // Persist to database
  try {
    const stmt = getInsertStatement();
    if (stmt) {
      const detailsJson = Object.keys(restFields).length > 0 ? JSON.stringify(restFields) : null;
      stmt.run(
        randomUUID(),
        level,
        String(category),
        message,
        meetingId ? String(meetingId) : null,
        detailsJson,
        now
      );
    }
  } catch {
    // Non-blocking: database logging errors must never disrupt business operations
  }
}

export const logger: Logger = {
  debug: (message, fields) => write("debug", message, fields),
  info: (message, fields) => write("info", message, fields),
  warn: (message, fields) => write("warn", message, fields),
  error: (message, fields) => write("error", message, fields)
};
