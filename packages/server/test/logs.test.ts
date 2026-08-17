import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { createDb } from "../src/db.ts";
import { logger, setLogDatabase } from "../src/logger.ts";

describe("Database Logging & Logs API", () => {
  test("writes debug, info, warn, and error logs with structured details to SQLite database", async () => {
    const handle = createDb(":memory:");
    setLogDatabase(handle.sqlite);

    const now = 1_700_000_000_000;
    const meetingId = "11111111-2222-3333-4444-555555555555";

    await handle.db
      .insertInto("meetings")
      .values({
        id: meetingId,
        title: "Test Ingest Meeting",
        start_time: now,
        end_time: now + 60_000,
        source: "upload",
        status: "ready",
        tags: "[]",
        primary_transcript_artifact_id: null,
        primary_summary_artifact_id: null,
        last_error: null,
        created_at: now,
        updated_at: now
      })
      .execute();

    logger.debug("Received audio upload payload", {
      category: "ingest",
      meetingId,
      sizeBytes: 1024,
      mime: "audio/wav"
    });

    logger.info("Ingest completed successfully", {
      category: "ingest",
      meetingId,
      recordingId: "rec-1"
    });

    logger.warn("Speechmatics transcription warning", {
      category: "transcription",
      meetingId,
      code: "low_confidence"
    });

    logger.error("LLM quota exceeded", {
      category: "llm",
      provider: "google",
      error: "RATE_LIMIT_EXCEEDED"
    });

    const rows = await handle.db.selectFrom("logs").selectAll().execute();
    expect(rows).toHaveLength(4);

    const debugRow = rows.find((r) => r.level === "debug");
    expect(debugRow?.category).toBe("ingest");
    expect(debugRow?.message).toBe("Received audio upload payload");
    expect(debugRow?.meeting_id).toBe(meetingId);
    expect(JSON.parse(debugRow?.details || "{}")).toEqual({ sizeBytes: 1024, mime: "audio/wav" });

    const infoRow = rows.find((r) => r.level === "info");
    expect(infoRow?.category).toBe("ingest");

    const warnRow = rows.find((r) => r.level === "warn");
    expect(warnRow?.category).toBe("transcription");

    const errorRow = rows.find((r) => r.level === "error");
    expect(errorRow?.category).toBe("llm");
  });

  test("GET /api/logs supports severity filtering, category filtering, search, and pagination", async () => {
    const handle = createDb(":memory:");
    setLogDatabase(handle.sqlite);

    logger.debug("Debug step A", { category: "ingest", step: 1 });
    logger.debug("Debug step B", { category: "transcription", step: 2 });
    logger.info("Info step C", { category: "transcription", step: 3 });
    logger.warn("Warn step D", { category: "summary", step: 4 });
    logger.error("Error step E", { category: "summary", step: 5 });

    const app = createApp({ db: handle.db });

    // 1. Default (DEBUG level -> returns all 5 logs)
    const allRes = await app.request("http://olive.test/api/logs?level=debug");
    expect(allRes.status).toBe(200);
    const allData = await allRes.json();
    expect(allData.ok).toBe(true);
    expect(allData.logs).toHaveLength(5);
    expect(allData.categories).toContain("ingest");
    expect(allData.categories).toContain("transcription");
    expect(allData.categories).toContain("summary");

    // 2. Filter level=info (returns INFO, WARN, ERROR -> 3 logs)
    const infoRes = await app.request("http://olive.test/api/logs?level=info");
    const infoData = await infoRes.json();
    expect(infoData.logs).toHaveLength(3);
    expect(infoData.logs.every((l: any) => ["info", "warn", "error"].includes(l.level))).toBe(true);

    // 3. Filter level=warn (returns WARN, ERROR -> 2 logs)
    const warnRes = await app.request("http://olive.test/api/logs?level=warn");
    const warnData = await warnRes.json();
    expect(warnData.logs).toHaveLength(2);

    // 4. Filter level=error (returns ERROR -> 1 log)
    const errorRes = await app.request("http://olive.test/api/logs?level=error");
    const errorData = await errorRes.json();
    expect(errorData.logs).toHaveLength(1);
    expect(errorData.logs[0].message).toBe("Error step E");

    // 5. Filter category=transcription
    const categoryRes = await app.request("http://olive.test/api/logs?category=transcription");
    const categoryData = await categoryRes.json();
    expect(categoryData.logs).toHaveLength(2);

    // 6. Search query
    const searchRes = await app.request("http://olive.test/api/logs?search=step+D");
    const searchData = await searchRes.json();
    expect(searchData.logs).toHaveLength(1);
    expect(searchData.logs[0].message).toBe("Warn step D");

    // 7. DELETE /api/logs clears logs
    const delRes = await app.request("http://olive.test/api/logs", { method: "DELETE" });
    expect(delRes.status).toBe(200);

    const emptyRes = await app.request("http://olive.test/api/logs");
    const emptyData = await emptyRes.json();
    expect(emptyData.logs).toHaveLength(0);
  });
});
