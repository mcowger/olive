import { existsSync, statSync } from "node:fs";
import { join, normalize, relative } from "node:path";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import type { Database } from "@olive/shared";
import { getDb } from "./db.ts";
import { listMeetings } from "./meetings.ts";

export interface AppOptions {
  db?: Kysely<Database>;
  webRoot?: string;
}

function numericQueryParam(value: string | undefined): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function safeWebPath(webRoot: string, requestPath: string): string | undefined {
  const normalizedPath = normalize(requestPath).replace(/^([/\\])+/, "");
  const candidate = join(webRoot, normalizedPath || "index.html");
  const relativePath = relative(webRoot, candidate);
  return relativePath.startsWith("..") || relativePath.includes(`..${process.platform === "win32" ? "\\" : "/"}`)
    ? undefined
    : candidate;
}

async function serveWebAsset(webRoot: string, requestPath: string): Promise<Response | undefined> {
  const requestedPath = safeWebPath(webRoot, requestPath);
  if (requestedPath && existsSync(requestedPath) && statSync(requestedPath).isFile()) {
    return new Response(Bun.file(requestedPath));
  }

  const indexPath = join(webRoot, "index.html");
  return existsSync(indexPath) ? new Response(Bun.file(indexPath)) : undefined;
}

export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();
  const db = options.db ?? getDb();

  app.get("/api/health", (c) => c.json({ status: "ok" }));

  app.get("/api/meetings", async (c) => {
    const response = await listMeetings(db, {
      limit: numericQueryParam(c.req.query("limit")),
      offset: numericQueryParam(c.req.query("offset")),
      search: c.req.query("search")
    });

    return c.json(response);
  });

  if (options.webRoot) {
    app.all("*", async (c) => {
      if (c.req.path.startsWith("/api/")) {
        return c.notFound();
      }

      const asset = await serveWebAsset(options.webRoot!, c.req.path);
      return asset ?? c.notFound();
    });
  }

  return app;
}
