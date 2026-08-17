import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { FileDetail, FileSummary } from "@mcowger/plaud-client";
import { createApp } from "../src/app.ts";
import { createDb } from "../src/db.ts";
import { PlaudPoller, type PlaudClientLike, type PlaudOAuthManager } from "../src/plaud/poller.ts";
import { createPlaudClient } from "../src/plaud/client.ts";

const AUDIO_BYTES = new TextEncoder().encode("fake plaud audio");
const FIXTURE_FILE: FileSummary = {
  id: "plaud-file-1",
  name: "Fixture planning",
  created_at: "2026-08-11T10:00:00.000Z",
  start_at: "2026-08-11T10:00:00.000Z",
  duration: 12,
  serial_number: "fixture-device"
};

function readyDetail(): FileDetail {
  return {
    ...FIXTURE_FILE,
    presigned_url: "https://audio.test/fixture.m4a",
    source_list: [
      {
        data_type: "transcript",
        data_content: JSON.stringify([
          { start_time: 0, end_time: 5000, speaker: "Alice", content: "Let's ship it." },
          { start_time: 5000, end_time: 12000, speaker: "Speaker 1", content: "Generic label." }
        ])
      }
    ],
    note_list: [{ data_type: "summary", data_content: JSON.stringify({ summary: "A fixture summary." }) }]
  };
}

function pendingDetail(): FileDetail {
  return {
    ...FIXTURE_FILE,
    presigned_url: "https://audio.test/fixture.m4a",
    source_list: [],
    note_list: []
  };
}

function createFakeClient(detail: FileDetail | (() => FileDetail)): PlaudClientLike & { readonly getFileCalls: number } {
  let getFileCalls = 0;
  const oauth: PlaudOAuthManager = {
    startManualLogin: async () => ({
      authUrl: "https://auth.test/authorize",
      verifier: "server-held-verifier",
      state: "server-held-state"
    }),
    completeManualLogin: async () => ({ access_token: "fake-token" }),
    getAccessToken: async () => "fake-token"
  };

  return {
    oauth,
    getCurrentUser: async () => ({ id: "fake-user" }),
    listFilesIterator: async function* () {
      yield FIXTURE_FILE;
    },
    getFile: async () => {
      getFileCalls += 1;
      return typeof detail === "function" ? detail() : detail;
    },
    get getFileCalls() {
      return getFileCalls;
    }
  };
}

function fakeFetch(): (input: string) => Promise<Response> {
  return async () => new Response(AUDIO_BYTES, { headers: { "content-type": "audio/mp4" } });
}

async function closeDatabase(handle: ReturnType<typeof createDb>): Promise<void> {
  await handle.db.destroy();
  handle.sqlite.close();
}

describe("Plaud poller", () => {
  test("ingests a ready recording and is idempotent on re-poll", async () => {
    const handle = createDb(":memory:");
    const meetingsDir = await mkdtemp(join(import.meta.dir, "plaud-idempotency-"));
    const client = createFakeClient(readyDetail());
    const poller = new PlaudPoller({ db: handle.db, meetingsDir, client, fetchImpl: fakeFetch(), now: () => 1_000_000 });

    const first = await poller.trigger();
    const second = await poller.trigger();

    expect(first.discoveryCompleted).toBe(true);
    expect(first.discoveryError).toBeNull();
    expect(first.discovered).toBe(1);
    expect(first.error).toBeNull();
    expect(second.discoveryCompleted).toBe(true);
    expect(second.discovered).toBe(0);
    expect(await handle.db.selectFrom("meetings").selectAll().execute()).toHaveLength(1);
    expect(await handle.db.selectFrom("recordings").selectAll().execute()).toHaveLength(1);
    expect(await handle.db.selectFrom("artifacts").selectAll().execute()).toHaveLength(3);
    expect(await handle.db.selectFrom("speakers").selectAll().execute()).toHaveLength(1);
    expect(await handle.db.selectFrom("meeting_speakers").selectAll().execute()).toHaveLength(1);

    const meeting = await handle.db.selectFrom("meetings").selectAll().executeTakeFirstOrThrow();
    const recording = await handle.db.selectFrom("recordings").selectAll().executeTakeFirstOrThrow();
    const transcript = await handle.db
      .selectFrom("artifacts")
      .selectAll()
      .where("format", "=", "txt")
      .executeTakeFirstOrThrow();
    expect(meeting.source).toBe("plaud");
    expect(meeting.status).toBe("ready");
    expect(meeting.primary_transcript_artifact_id).toBeTruthy();
    expect(meeting.primary_summary_artifact_id).toBeTruthy();
    expect(recording.provider).toBe("plaud");
    expect(recording.provider_recording_id).toBe(FIXTURE_FILE.id);
    expect(
      (await handle.db.selectFrom("artifacts").selectAll().execute()).map((artifact) => [artifact.provider, artifact.kind, artifact.format])
    ).toEqual([
      ["plaud", "transcript", "json"],
      ["plaud", "transcript", "txt"],
      ["plaud", "summary", "md"]
    ]);
    expect((await handle.db.selectFrom("speakers").selectAll().executeTakeFirstOrThrow()).name).toBe("Alice");
    expect(
      new Uint8Array(await readFile(join(meetingsDir, dateFolder(meeting.start_time, meeting.title, meeting.id), recording.path)))
    ).toEqual(AUDIO_BYTES);
    expect(await readFile(join(meetingsDir, dateFolder(meeting.start_time, meeting.title, meeting.id), transcript.path), "utf8")).toContain(
      "Alice: Let's ship it."
    );

    await closeDatabase(handle);
    await rm(meetingsDir, { recursive: true, force: true });
  });

  test("falls back to audio-only once the injected PCS deadline passes", async () => {
    const handle = createDb(":memory:");
    const meetingsDir = await mkdtemp(join(import.meta.dir, "plaud-fallback-"));
    const client = createFakeClient(pendingDetail());
    let now = 10_000;
    const poller = new PlaudPoller({
      db: handle.db,
      meetingsDir,
      client,
      fetchImpl: fakeFetch(),
      now: () => now,
      pcsWaitMs: 1_000
    });

    const pending = await poller.trigger();
    expect(pending.discoveryCompleted).toBe(true);
    expect(pending.discoveryError).toBeNull();
    expect(pending.resolved).toBe(0);
    expect(pending.pcsPending).toBe(1);
    expect((await handle.db.selectFrom("meetings").selectAll().executeTakeFirstOrThrow()).status).toBe("processing");

    now = 11_000;
    const fallback = await poller.trigger();
    const repeat = await poller.trigger();
    const meeting = await handle.db.selectFrom("meetings").selectAll().executeTakeFirstOrThrow();
    const state = await handle.db.selectFrom("plaud_ingest_state").selectAll().executeTakeFirstOrThrow();

    expect(fallback.resolved).toBe(1);
    expect(fallback.pcsPending).toBe(0);
    expect(repeat.resolved).toBe(0);
    expect(client.getFileCalls).toBe(2);
    expect(meeting.status).toBe("ready");
    expect(state.pcs_resolved).toBe(1);
    expect(await handle.db.selectFrom("recordings").selectAll().execute()).toHaveLength(1);
    expect(await handle.db.selectFrom("artifacts").selectAll().execute()).toHaveLength(0);

    await closeDatabase(handle);
    await rm(meetingsDir, { recursive: true, force: true });
  });
});

describe("Plaud API", () => {
  test("reports Plaud status and returns the manual sync result envelope", async () => {
    const handle = createDb(":memory:");
    const meetingsDir = await mkdtemp(join(import.meta.dir, "plaud-api-"));
    const client = createFakeClient(pendingDetail());
    const poller = new PlaudPoller({
      db: handle.db,
      meetingsDir,
      client,
      fetchImpl: fakeFetch(),
      now: () => 1_000
    });
    const app = createApp({ db: handle.db, plaudPoller: poller });

    const initialStatus = await app.request("http://olive.test/api/plaud/status");
    expect(initialStatus.status).toBe(200);
    expect(await initialStatus.json()).toEqual({ connected: true, lastPollAt: null, pcsPending: 0 });

    const triggerResponse = await app.request("http://olive.test/api/plaud/sync/trigger", { method: "POST" });
    expect(triggerResponse.status).toBe(200);
    expect(await triggerResponse.json()).toEqual({
      status: "completed",
      discoveryCompleted: true,
      discoveryError: null,
      discovered: 1,
      resolved: 0,
      pcsPending: 1,
      startedAt: 1_000,
      completedAt: 1_000,
      error: null
    });

    await closeDatabase(handle);
    await rm(meetingsDir, { recursive: true, force: true });
  });

  test("stores PKCE verifier and state server-side across auth routes", async () => {
    const handle = createDb(":memory:");
    const meetingsDir = await mkdtemp(join(import.meta.dir, "plaud-auth-"));
    const client = createFakeClient(pendingDetail());
    const completed: string[] = [];
    const oauth: PlaudOAuthManager = {
      startManualLogin: async () => ({
        authUrl: "https://auth.test/authorize?code_challenge=abc",
        verifier: "verifier-not-returned",
        state: "state-not-returned"
      }),
      completeManualLogin: async (input, verifier, state) => {
        completed.push(`${input}|${verifier}|${state}`);
        return {};
      }
    };
    const app = createApp({ db: handle.db, meetingsDir, plaudClient: client, oauthManager: oauth });

    const startResponse = await app.request("http://olive.test/api/plaud/auth/start", { method: "POST" });
    const startBody = await startResponse.json();
    expect(startResponse.status).toBe(200);
    expect(startBody).toEqual({
      authUrl: "https://auth.test/authorize?code_challenge=abc",
      sessionId: expect.any(String)
    });
    expect(startBody.verifier).toBeUndefined();
    expect(startBody.state).toBeUndefined();

    const completeResponse = await app.request("http://olive.test/api/plaud/auth/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: startBody.sessionId, pastedUrlOrCode: "https://localhost/callback?code=fake" })
    });
    expect(completeResponse.status).toBe(200);
    expect(await completeResponse.json()).toEqual({ status: "completed" });
    expect(completed).toEqual(["https://localhost/callback?code=fake|verifier-not-returned|state-not-returned"]);

    const reusedResponse = await app.request("http://olive.test/api/plaud/auth/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: startBody.sessionId, pastedUrlOrCode: "fake" })
    });
    expect(reusedResponse.status).toBe(400);

    await closeDatabase(handle);
    await rm(meetingsDir, { recursive: true, force: true });
  });

  test("stores Plaud tokens in persistent configDir/plaud-tokens.json to survive container restarts", async () => {
    const customConfigDir = await mkdtemp(join(tmpdir(), "plaud-config-test-"));
    const customMeetingsDir = await mkdtemp(join(tmpdir(), "plaud-meetings-test-"));
    const customTokensPath = join(customConfigDir, "plaud-tokens.json");

    const paths = {
      configDir: customConfigDir,
      meetingsDir: customMeetingsDir,
      backupsDir: join(customConfigDir, "backups"),
      modelsDir: join(customConfigDir, "models"),
      databasePath: join(customConfigDir, "olive.sqlite"),
      settingsPath: join(customConfigDir, "settings.json"),
      plaudTokensPath: customTokensPath
    };

    const client = createPlaudClient(paths);
    const tokenStore = (client as any).oauth?.tokenStore || (client as any).tokenStore;
    if (tokenStore) {
      expect(tokenStore.filePath).toBe(customTokensPath);
    }

    // Save tokens via FileTokenStore at resolved path
    const { FileTokenStore } = await import("@mcowger/plaud-client");
    const store = new FileTokenStore(customTokensPath);
    await store.save({
      access_token: "persisted-access-token",
      token_type: "Bearer",
      refresh_token: "persisted-refresh-token",
      expires_at: Date.now() + 3600_000
    });

    expect(existsSync(customTokensPath)).toBe(true);

    // Simulate restart with fresh client using the same paths
    const reloadedStore = new FileTokenStore(customTokensPath);
    const loaded = await reloadedStore.load();
    expect(loaded?.access_token).toBe("persisted-access-token");
    expect(loaded?.refresh_token).toBe("persisted-refresh-token");

    await rm(customConfigDir, { recursive: true, force: true });
    await rm(customMeetingsDir, { recursive: true, force: true });
  });

  test("accurately converts Plaud millisecond and second durations without erroneously inflating them", () => {
    const { durationToMs } = require("../src/plaud/poller.ts");

    // 4 minutes 12 seconds in Plaud API milliseconds (252,960 ms)
    expect(durationToMs(252_960)).toBe(252_960);

    // 7 minutes 42 seconds in Plaud API milliseconds (462,960 ms)
    expect(durationToMs(462_960)).toBe(462_960);

    // 7 minutes 46 seconds in Plaud API milliseconds (466,980 ms)
    expect(durationToMs(466_980)).toBe(466_980);

    // 1 hour in Plaud API milliseconds (3,600,000 ms)
    expect(durationToMs(3_600_000)).toBe(3_600_000);

    // Seconds fallback (< 1000)
    expect(durationToMs(12)).toBe(12_000);
    expect(durationToMs(0.5)).toBe(500);
    expect(durationToMs(null)).toBe(0);
    expect(durationToMs(undefined)).toBe(0);
  });

  test("idempotently repairs legacy inflated Plaud durations during migration", async () => {
    const handle = createDb(":memory:");
    const now = 1_700_000_000_000;
    const meetingId = "corrupted-plaud-meeting";

    // Insert artificially inflated duration (252,960,000 ms = 70h 16m instead of 4m 12s)
    await handle.db
      .insertInto("meetings")
      .values({
        id: meetingId,
        title: "2026-08-14 16:26:26",
        start_time: now,
        end_time: now + 252_960_000,
        source: "plaud",
        status: "processing",
        tags: "[]",
        primary_transcript_artifact_id: null,
        primary_summary_artifact_id: null,
        last_error: null,
        created_at: now,
        updated_at: now
      })
      .execute();

    const { runMigrations } = await import("@olive/shared/migrations");
    runMigrations(handle.sqlite);

    const repaired = await handle.db
      .selectFrom("meetings")
      .select(["start_time", "end_time"])
      .where("id", "=", meetingId)
      .executeTakeFirstOrThrow();

    // Duration should be exactly 252,960 ms (4m 12s)
    expect(repaired.end_time - repaired.start_time).toBe(252_960);
  });
});

function resolveLiveTokenPath(value: string | undefined): string {
  const configured = value?.trim();
  if (!configured) {
    return join(homedir(), ".plaud", "tokens.json");
  }
  if (configured === "~") {
    return homedir();
  }
  return configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
}

const liveTokenPath = resolveLiveTokenPath(process.env.PLAUD_TOKEN_PATH);

const shouldRunLivePlaud = process.env.RUN_LIVE_PLAUD_TEST === "true" && existsSync(liveTokenPath);

test.skipIf(!shouldRunLivePlaud)("runs one poll against the live Plaud account", async () => {
  const handle = createDb(":memory:");
  const meetingsDir = await mkdtemp(join(import.meta.dir, "plaud-live-"));
  const client = createPlaudClient();
  const poller = new PlaudPoller({ db: handle.db, meetingsDir, client });

  const result = await poller.trigger();
  expect(result.discoveryCompleted).toBe(true);
  expect(result.discoveryError).toBeNull();

  const meetings = await handle.db.selectFrom("meetings").selectAll().execute();
  const recordings = await handle.db.selectFrom("recordings").selectAll().execute();
  const artifacts = await handle.db.selectFrom("artifacts").selectAll().execute();
  expect(meetings).toHaveLength(result.discovered);
  if (result.discovered > 0) {
    expect(meetings.length).toBeGreaterThan(0);
    expect(meetings.every((meeting) => meeting.source === "plaud")).toBe(true);
    expect(recordings.every((recording) => recording.provider === "plaud" && recording.provider_recording_id)).toBe(true);
    expect(artifacts.every((artifact) => artifact.provider === "plaud")).toBe(true);
    expect(artifacts.every((artifact) => ["json", "txt", "md"].includes(artifact.format))).toBe(true);
    expect(
      recordings.every((recording) => {
        const meeting = meetings.find((candidate) => candidate.id === recording.meeting_id);
        return meeting ? existsSync(join(meetingsDir, dateFolder(meeting.start_time, meeting.title, meeting.id), recording.path)) : false;
      })
    ).toBe(true);
    expect(
      artifacts.every((artifact) => {
        const meeting = meetings.find((candidate) => candidate.id === artifact.meeting_id);
        return meeting ? existsSync(join(meetingsDir, dateFolder(meeting.start_time, meeting.title, meeting.id), artifact.path)) : false;
      })
    ).toBe(true);
  } else {
    expect(meetings).toHaveLength(0);
  }
  console.log(
    `Live Plaud poll: discovered=${result.discovered}, meetings=${meetings.length}, recordings=${recordings.length}, artifacts=${artifacts.length}, pending=${result.pcsPending}`
  );

  await closeDatabase(handle);
  await rm(meetingsDir, { recursive: true, force: true });
}, 120_000);

function dateFolder(startTimeMs: number, title: string, id: string): string {
  const date = new Date(startTimeMs);
  const stamp = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
    .map((value, index) => (index === 0 ? String(value) : String(value).padStart(2, "0")))
    .join("-");
  const safeTitle = title
    .replace(/[/\\:*?"<>|\r\n\t]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 100);
  return `${stamp}_${safeTitle || "meeting"}__${id.slice(0, 8)}`;
}
