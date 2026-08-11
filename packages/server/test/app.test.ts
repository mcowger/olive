import { describe, expect, test } from "bun:test";
import { createDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";

describe("HTTP API", () => {
  test("serves health and lists an empty database, then a manually inserted meeting", async () => {
    const handle = createDb(":memory:");
    const app = createApp({ db: handle.db });

    const healthResponse = await app.request("http://olive.test/api/health");
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.json()).toEqual({ status: "ok" });

    const emptyResponse = await app.request("http://olive.test/api/meetings");
    expect(emptyResponse.status).toBe(200);
    expect(await emptyResponse.json()).toEqual({
      meetings: [],
      pagination: {
        limit: 50,
        offset: 0,
        total: 0
      }
    });

    const now = Date.now();
    await handle.db
      .insertInto("meetings")
      .values({
        id: "meeting-api-1",
        title: "API fixture",
        start_time: now,
        end_time: now + 30_000,
        source: "upload",
        status: "ready",
        tags: JSON.stringify(["test", "api"]),
        primary_transcript_artifact_id: null,
        primary_summary_artifact_id: null,
        last_error: null,
        created_at: now,
        updated_at: now
      })
      .execute();
    await handle.db
      .insertInto("artifacts")
      .values({
        id: "artifact-api-1",
        meeting_id: "meeting-api-1",
        recording_id: null,
        kind: "summary",
        provider: "fixture",
        format: "md",
        path: "summaries/fixture.md",
        created_at: now
      })
      .execute();
    await handle.db
      .updateTable("meetings")
      .set({ primary_summary_artifact_id: "artifact-api-1" })
      .where("id", "=", "meeting-api-1")
      .execute();

    const populatedResponse = await app.request("http://olive.test/api/meetings");
    expect(populatedResponse.status).toBe(200);
    expect(await populatedResponse.json()).toEqual({
      meetings: [
        {
          id: "meeting-api-1",
          title: "API fixture",
          startTime: now,
          endTime: now + 30_000,
          source: "upload",
          status: "ready",
          tags: ["test", "api"],
          primaryTranscriptArtifactId: null,
          primarySummaryArtifactId: "artifact-api-1",
          lastError: null,
          createdAt: now,
          updatedAt: now
        }
      ],
      pagination: {
        limit: 50,
        offset: 0,
        total: 1
      }
    });

    await handle.db.destroy();
    handle.sqlite.close();
  });
});
