# Olive — Design (M0–M4)

Technical design for `HIGHLEVEL.md` / `MILESTONES.md` milestones M0 through M4. Everything here is
written fresh for olive's actual domain model (Decision 8: `Meeting` as aggregate root). `applaud`
and the Plaud ecosystem survey are referenced for *conventions* only (config-dir resolution style,
pino logging, webhook HMAC+backoff shape, SPA static serving) — no files are copied from it; its
schema (`recordings`-table-as-aggregate-root) doesn't fit and isn't reused.

The one real dependency is `@mcowger/plaud-client` (npm, published, MIT-equivalent — see
`packages/plaud-client` source at `~/workspace/plaud-client`), used as-is for OAuth/API/formatters.
Its exact surface (verified against source, not guessed) is documented in M1a below.

Out of scope for this doc: all `HIGHLEVEL.md` non-goals.

---

## 1. Stack decisions

(All chosen by you directly, not defaulted — see conversation.)

| Concern | Choice | Why |
|---|---|---|
| Language/runtime | TypeScript on **Bun** | native `bun:sqlite`, native test runner, native bundler/HMR, single toolchain |
| Package manager | **Bun workspaces** | native to the runtime, `bun.lock`, matches `~/workspace/plaud-client`'s own workspace convention |
| Server | **Hono** | lightweight, runs natively on Bun, standard Web `Request`/`FormData` APIs (no framework-specific multipart layer needed) |
| DB driver | **`bun:sqlite`** (built-in) | zero extra native-module dependency under Bun (`better-sqlite3` is explicitly not Bun-compatible) |
| DB query layer | **Kysely** + `kysely-bun-sqlite` dialect | typed query builder over `bun:sqlite`; verified real/maintained package (33k weekly downloads) — not a guess |
| Web UI | **React**, Bun's native bundler/dev-server (HTML imports + HMR, no Vite), **Tailwind CSS** | |
| Test runner | **`bun test`** | native, zero extra dependency |
| Validation | **Zod** | already a transitive dependency via `@mcowger/plaud-client`; one validation approach end-to-end |
| HTTP client | native `fetch` | built into Bun |

Monorepo layout (Bun workspaces, `package.json` `"workspaces"` field):

```
olive/
  packages/
    shared/     @olive/shared   — types, zod schemas shared client/server
    server/     @olive/server   — Hono API, bun:sqlite + Kysely, providers, poller
    web/        @olive/web      — React UI, Bun bundler
  docs/
  .github/workflows/
```

---

## 2. Domain schema (SQLite DDL)

Translates Decision 8 into concrete tables. All timestamps are epoch-ms integers. All ids are UUIDs
(`crypto.randomUUID()`).

```sql
CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  source TEXT NOT NULL,                    -- 'plaud' | 'upload' | 'ios-shortcut'
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'processing' | 'ready' | 'error'
  tags TEXT NOT NULL DEFAULT '[]',         -- JSON string[]
  primary_transcript_artifact_id TEXT REFERENCES artifacts(id),
  primary_summary_artifact_id TEXT REFERENCES artifacts(id),
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_meetings_start_time ON meetings(start_time DESC);

CREATE TABLE recordings (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  path TEXT NOT NULL,
  mime TEXT NOT NULL,
  duration_ms INTEGER,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,             -- dedupe key across all sources
  provider TEXT NOT NULL,                  -- 'plaud' | 'upload' | 'ios-shortcut'
  provider_recording_id TEXT,              -- Plaud file id, for idempotent re-poll matching
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_recordings_meeting ON recordings(meeting_id);
CREATE UNIQUE INDEX idx_recordings_provider_id ON recordings(provider, provider_recording_id)
  WHERE provider_recording_id IS NOT NULL;

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  recording_id TEXT REFERENCES recordings(id),
  kind TEXT NOT NULL,                      -- 'transcript' | 'summary'
  provider TEXT NOT NULL,                  -- 'plaud' | 'speechmatics' | 'llm:openai' | 'llm:anthropic'
  format TEXT NOT NULL,                    -- 'md' | 'txt' | 'json' | 'srt'
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_artifacts_meeting ON artifacts(meeting_id);

CREATE TABLE speakers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_ids TEXT NOT NULL DEFAULT '{}',        -- JSON { speechmatics?: string[] }
  enrolled_at INTEGER,
  enrollment_clip_paths TEXT NOT NULL DEFAULT '[]', -- JSON string[]
  created_at INTEGER NOT NULL
);

CREATE TABLE meeting_speakers (
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  speaker_id TEXT NOT NULL REFERENCES speakers(id),
  evidence_artifact_id TEXT REFERENCES artifacts(id),
  PRIMARY KEY (meeting_id, speaker_id)
);

-- Per-stage, per-meeting processing state (M2/M4). One row per (meeting, stage);
-- retried in place so a crash mid-job doesn't duplicate work or artifacts.
CREATE TABLE stage_runs (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  stage TEXT NOT NULL,                     -- 'speechmatics_transcribe' | 'llm_summarize'
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'running' | 'done' | 'error'
  provider_job_id TEXT,                    -- e.g. Speechmatics job id
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_stage_runs_meeting_stage ON stage_runs(meeting_id, stage);

-- Tracks the Plaud "wait for PCS, then fall back to audio-only" window (M1a).
CREATE TABLE plaud_ingest_state (
  meeting_id TEXT PRIMARY KEY REFERENCES meetings(id),
  plaud_file_id TEXT NOT NULL UNIQUE,
  first_seen_at INTEGER NOT NULL,
  pcs_deadline_at INTEGER NOT NULL,        -- first_seen_at + 24h
  pcs_resolved INTEGER NOT NULL DEFAULT 0  -- 1 once Plaud transcript+summary ingested OR timeout fallback applied
);

CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Migrations are additive (`ALTER TABLE ... ADD COLUMN`, guarded try/catch) following the applaud
convention, applied idempotently on every `getDb()` call — this pattern (not the code) is worth
keeping.

---

## 3. Disk layout

```
<meetingsDir>/<YYYY-MM-DD_title__meetingId8>/
  audio/<recordingId>.<ext>              # one file per Recording
  transcripts/<provider>.json            # e.g. plaud.json, speechmatics.json
  transcripts/<provider>.txt
  summaries/<provider>.md                # e.g. plaud.md, llm-anthropic.md
```

Folder name reuses applaud's `sanitizeFilename`/`dateStamp` **algorithm** (safe-char stripping,
100-char cap, `YYYY-MM-DD_title__id8`), rewritten against `Meeting` fields instead of `RecordingRow`.

---

## 4. Config & env vars

Secrets/endpoints — `.env`, already populated:

| Var | Used by |
|---|---|
| `SPEECHMATICS_API_KEY` | M2 |
| `OPENAI_API_BASE` | M4 (OpenAI-compatible adapter, custom proxy) |
| `ANTHROPIC_API_BASE` | M4 (Anthropic adapter, custom proxy) |
| `LLM_API_KEY` | M4 (Bearer token, both adapters) |
| `OPENAI_MODEL` | M4 default model |
| `ANTHROPIC_MODEL` | M4 default model |

New vars needed, added to `.env` during M0/M1b/M2 implementation:

| Var | Default | Used by |
|---|---|---|
| `OLIVE_CONFIG_DIR` | XDG-style per-OS (applaud convention) | M0 |
| `OLIVE_MEETINGS_DIR` | `<configDir>/meetings` | M0 |
| `OLIVE_BIND_HOST` / `OLIVE_BIND_PORT` | `127.0.0.1` / `4471` | M0 |
| `OLIVE_INGEST_TOKEN` | (required, generated locally, no external access needed per your answer) | M1b |
| `PLAUD_TOKEN_PATH` | `~/.plaud/tokens.json` (already populated) | M1a |
| `SPEECHMATICS_WEBHOOK_SECRET` | generated locally | M2, checked via Speechmatics `auth_headers` |

Mutable user preferences (poll interval, `retranscribePlaudWhenUnnamed`, primary-artifact
preference order, LLM provider selection) live in `<configDir>/settings.json`, loaded/cached/saved
the way applaud's `config.ts` does it (pattern only, rewritten against olive's own `AppConfig`
shape).

---

## 5. Provider interfaces (Decision 7, finalized)

```ts
// packages/shared/src/transcript.ts
export interface TranscriptSegment { start: number; end: number; speaker: string; text: string }
export interface Transcript { segments: TranscriptSegment[] }

// packages/server/src/providers/types.ts
export interface EnrolledSpeaker { id: string; name: string; providerIds: Record<string, string[]> }

export interface TranscriptionProvider {
  readonly name: string;
  readonly caps: { diarization: boolean; speakerId: boolean; customVocab: boolean };
  transcribe(job: {
    audioPath: string;
    vocab?: string[];
    speakers?: EnrolledSpeaker[];
  }): Promise<Transcript>;
}

export interface SpeakerIdentityProvider {
  readonly name: string;
  enroll(label: string, clipPaths: string[]): Promise<string[]>; // returns provider identifier(s)
  // no `list()` at the provider level — enrolled speakers live in olive's own `speakers` table;
  // this only talks to the voiceprint backend for enroll operations.
}

export interface LLMProvider {
  readonly name: string;
  summarize(transcript: Transcript, opts?: { maxTokens?: number }): Promise<string>;  // markdown
  tag(transcript: Transcript, existingTags: string[]): Promise<string[]>;
}
```

`transcribe()` is async and, for Speechmatics, itself polls/awaits the notification webhook — see
M2 for how `stage_runs` makes this resumable across process restarts (the provider call isn't one
blocking round trip in production use; the stage runner submits the job, persists
`provider_job_id`, and returns — completion is driven by the webhook handler, not by blocking on
`transcribe()`).

---

## 6. REST API surface

```
GET    /api/health

GET    /api/meetings?limit&offset&search
GET    /api/meetings/:id                   # Meeting + recordings + artifacts + speakers + stage_runs

POST   /api/ingest                         # M1b — multipart, Bearer OLIVE_INGEST_TOKEN

GET    /api/plaud/status                   # M1a — connected?, last poll, pcs-pending count
POST   /api/plaud/sync/trigger             # M1a — manual poll
POST   /api/plaud/auth/start               # M1a — { authUrl, verifier, state } (headless PKCE)
POST   /api/plaud/auth/complete            # M1a — { pastedUrlOrCode, verifier, state }

GET    /api/speakers                       # M3 (table exists from M2)
POST   /api/speakers/enroll                # M3 — multipart name + clips[]

POST   /api/webhooks/speechmatics          # M2 — Speechmatics notification_config target

GET    /api/settings
PATCH  /api/settings
```

Auth: `/api/ingest` and `/api/webhooks/speechmatics` require their own bearer/secret (not the same
token) since they're hit by external, non-browser clients. All other `/api/*` routes are
loopback-only for M0–M4 (no LAN exposure requirement stated for this scope — binds to
`127.0.0.1` by default per `OLIVE_BIND_HOST`).

---

## 7. M0 — Scaffold + domain schema

- `packages/shared`: DDL above as `runMigrations(db)`; `AppConfig` Zod schema + `DEFAULT_CONFIG`;
  shared `Meeting`/`Recording`/`Artifact`/`Speaker` TS types (Kysely `Database` interface) mirroring
  the SQL.
- `packages/server`: `db.ts` (`bun:sqlite` Database, `kysely-bun-sqlite` dialect, WAL,
  migrate-on-open — pattern from applaud, fresh code/driver), `paths.ts` (config dir resolution —
  pattern from applaud, fresh code), `config.ts` (settings.json load/save, Zod-validated — pattern
  from applaud, fresh code), `logger.ts` (lightweight structured logger — no pino dependency needed
  under Bun), `index.ts` (Hono app bootstrap, `/api/health`, static SPA serving via
  `Bun.serve`/Hono's static middleware — pattern from applaud, fresh code).
- `packages/web`: React shell built/served via Bun's native bundler + HTML-import HMR (no Vite), one
  route rendering an empty meetings list from `GET /api/meetings`, Tailwind for styling.
- `bun test` harness + GitHub Actions CI (`oven-sh/setup-bun`, lint, typecheck, test) + Dockerfile
  (`oven/bun` base image) — written fresh, applaud's CI/Dockerfile read only for what checks/stages
  a mature setup runs.

**Exit gate** (per `MILESTONES.md`): migration round-trip test per table, `GET /api/health` → 200,
empty list renders, manually-inserted fixture Meeting+Artifact appears via `GET /api/meetings`.

---

## 8. M1a — Plaud ingestion

### Confirmed `@mcowger/plaud-client` v0.1.0 surface (verified against source)

```ts
import { PlaudClient, FileTokenStore } from "@mcowger/plaud-client";

const client = new PlaudClient({ tokenStore: new FileTokenStore(process.env.PLAUD_TOKEN_PATH) });

client.getCurrentUser(): Promise<CurrentUser>
client.listFiles({ page, pageSize, dateFrom, dateTo }): Promise<FilesPage>
  // FilesPage.data: FileSummary[] = { id, name, created_at, start_at, duration, serial_number }
  // NOTE: no is_trash, no md5/checksum field on the list endpoint — dedupe must happen at
  // Recording.sha256 (computed after audio download), not at list time.
client.listFilesIterator({ pageSize, dateFrom, dateTo }): AsyncIterableIterator<FileSummary>
client.getFile(id): Promise<FileDetail>
  // FileDetail: { id, name, created_at, start_at, duration, serial_number, presigned_url,
  //               source_list: DataItem[], note_list: DataItem[] }
client.getAudioUrl(id): Promise<string | null>   // = getFile(id).presigned_url

import { parseTranscriptSegments, extractSummaryNotes, segmentsToText } from "@mcowger/plaud-client";
parseTranscriptSegments(fileDetail.source_list): Segment[]   // { start_time, end_time, speaker, content }
extractSummaryNotes(fileDetail.note_list): { type, content }[]
```

`source_list`/`note_list` being empty is exactly Plaud's "PCS not finished yet" signal — there is no
separate ready-flag in this API; readiness is inferred from non-empty arrays.

### Poller design

- `sync/poller.ts`: interval loop (`pollIntervalMinutes` from settings), single-flight (`inFlight`
  guard) + manual `trigger()` — same operational shape as applaud's poller (pattern only), rewritten
  against `Meeting`/`plaud_ingest_state`.
- **Phase 1 — discovery**: `listFilesIterator()` (paginated); for each `FileSummary` not already in
  `recordings.provider_recording_id`, create a `Meeting` (`source: 'plaud'`) with `status:
  'processing'`, insert `plaud_ingest_state` row (`first_seen_at = now`, `pcs_deadline_at = now +
  24h`).
- **Phase 2 — asset fetch**: for every `plaud_ingest_state` row with `pcs_resolved = 0`:
  1. `getFile(id)` → if `source_list`/`note_list` non-empty, ingest: download audio via
     `presigned_url` → write to `audio/<recordingId>.<ext>`, insert `Recording` with computed
     `sha256`; write `transcripts/plaud.json` + `.txt` (via `parseTranscriptSegments`/
     `segmentsToText`) as an `Artifact` (`provider: 'plaud', kind: 'transcript'`); write
     `summaries/plaud.md` (via `extractSummaryNotes`) as an `Artifact` (`kind: 'summary'`); set
     `primary_transcript_artifact_id`/`primary_summary_artifact_id`; set `plaud_ingest_state.
     pcs_resolved = 1`; set `meeting.status = 'ready'`.
  2. Else if `Date.now() >= pcs_deadline_at`: download **only** the audio (still via
     `presigned_url`, no transcript/summary artifacts), mark `pcs_resolved = 1`,
     `meeting.status = 'ready'` — the documented fallback path.
  3. Else: leave `pcs_resolved = 0`, retry next poll — this row is what makes idempotent re-polling
     safe (existing `Meeting`, no duplicate row, just re-checked).
- Named Plaud speaker labels (`Segment.speaker` when not a generic Plaud placeholder) flow into
  `MeetingSpeaker` via match-or-create-by-name on `speakers.name`, per Decision 8 — generic labels
  are left alone for the Speechmatics/M2 path to resolve later.

### Auth flow (server-side, headless-safe)

`POST /api/plaud/auth/start` → `oauth.startManualLogin()` (returns `authUrl`/`verifier`/`state`,
held server-side keyed by a short-lived session id) → user opens `authUrl` in *their own* browser →
pastes the callback URL back into the Settings UI → `POST /api/plaud/auth/complete` →
`oauth.completeManualLogin(pasted, verifier, state)`. Since `~/.plaud/tokens.json` is already
populated in this environment, this flow only needs to be exercised once as a smoke test, not
relied on for the automated M1a test suite.

**Exit gate**: as specified in `MILESTONES.md` M1a (live-account ingest test, idempotent re-poll
test, fallback-timeout test using an injected clock/short deadline in the test harness).

---

## 9. M1b — Manual/iOS ingestion

- `POST /api/ingest`: `multipart/form-data`, field `file` (required), field `title` (optional),
  parsed via Hono's standard `c.req.formData()` (Web API `FormData`, no extra multipart-parser
  dependency needed). Bearer `OLIVE_INGEST_TOKEN` required (generated locally via `openssl rand
  -hex 32`, stored in `.env` — no external access needed, per your answer).
- Accepts `audio/*` and known extensions (`m4a`, `mp3`, `wav`, `ogg`, `aac`) — matches
  `HIGHLEVEL.md`'s documented format list.
- Compute `sha256` of the uploaded bytes **before** touching disk; if a `Recording` with that hash
  already exists, respond `200 { meetingId: <existing>, deduped: true }` without creating a new
  `Meeting`/`Recording`.
- Otherwise create `Meeting` (`source: 'ios-shortcut'` or `'upload'` based on a `User-Agent`/
  explicit field — default `'upload'`), `Recording`, write bytes to
  `audio/<recordingId>.<ext>`, `meeting.status = 'ready'` (no transcript/summary yet — those are
  M2/M4 stages, decoupled).
- iOS Shortcut recipe documented in `README.md`/`docs/` at implementation time; the manual
  device-test step in the exit gate is yours to run — I'll have the endpoint + curl-testable
  contract ready.

**Exit gate**: curl multipart test, dedupe test, auth-rejection test — all automatable, no external
access needed.

---

## 10. M2 — Speechmatics transcription + speaker ID

Base URL `https://asr.speechmatics.com/v2`, `Authorization: Bearer $SPEECHMATICS_API_KEY` (verified
against docs.speechmatics.com, not guessed).

### Job submission (`stage_runs.stage = 'speechmatics_transcribe'`)

`POST /jobs` — `multipart/form-data`: `data_file` (audio bytes; use `fetch_data.url` instead — via a
short-lived signed local URL or Speechmatics' size limit path — when the recording exceeds the 1GB
in-body cap) + `config` (JSON):

```json
{
  "type": "transcription",
  "transcription_config": {
    "language": "en",
    "diarization": "speaker",
    "speaker_diarization_config": {
      "speakers": [{ "label": "<name>", "speaker_identifiers": ["<id1>", "..."] }]
    }
  },
  "notification_config": [{
    "url": "https://<host>/api/webhooks/speechmatics?meetingId=<id>&stageRunId=<id>",
    "contents": ["transcript"],
    "auth_headers": ["Authorization: Bearer <SPEECHMATICS_WEBHOOK_SECRET>"]
  }]
}
```

- `speaker_diarization_config.speakers[]` is populated from all currently-enrolled `speakers` rows
  (`providerIds.speechmatics`), capped at 50 identifiers total per the documented limit.
- On submit, persist `stage_runs.provider_job_id = job.id`, `status = 'running'`.

### Enrollment (`SpeakerIdentityProvider` impl, used by M3's enroll endpoint)

Submit a short-clip job with `speaker_diarization_config.get_speakers = true` (no `speakers[]`);
poll/await its transcript; read `transcript.speakers[].speaker_identifiers` and store on the
`Speaker` row. This is a normal batch job through the same submit/webhook path, not a separate API.

### Webhook completion

`POST /api/webhooks/speechmatics?meetingId&stageRunId`, `Authorization: Bearer
$SPEECHMATICS_WEBHOOK_SECRET` checked against the header Speechmatics was configured to send.
Handler: look up `stage_runs` by id (idempotent — ignore if already `done`), parse the attached
`json-v2` transcript, normalize `results[].alternatives[].speaker` + word timings into the
canonical `Transcript` shape, write `transcripts/speechmatics.json`/`.txt` as an `Artifact`,
`DELETE /jobs/:jobid` (retention hygiene per Decision 3), mark `stage_runs.status = 'done'`,
update `meeting.primary_transcript_artifact_id` per the configured preference order (default:
speechmatics-with-named-speakers > plaud).

### Retry / resumability

`stage_runs` unique on `(meeting_id, stage)` means a crash mid-job is safe to resume: on restart, a
sweep re-checks any `status = 'running'` row whose `provider_job_id` is set by calling
`GET /jobs/:jobid` directly (covers the case where the webhook fired while the process was down)
before deciding whether to resubmit.

### Long audio / >1GB

Per `HIGHLEVEL.md`, use `fetch_data.url` instead of in-body upload — the audio file is already
reachable at a stable path under `OLIVE_MEETINGS_DIR`; expose it via a short-lived signed
`/media/*` route (mirrors applaud's `mediaRouter` pattern) that Speechmatics fetches, then submit
`config.fetch_data.url` instead of `data_file`.

**Exit gate**: webhook-driven transcript artifact test, speaker-ID round-trip test (enroll → submit
→ resolved name in output), retry/resume test (kill process after submit, before webhook; restart;
assert no duplicate submission and eventual completion), retention test (mock `DELETE /jobs/:id`
call asserted).

---

## 11. M3 — Speaker registry UI + enrollment/backfill

- `packages/web`: Speakers page — list `speakers`, "Enroll" form (name + one or more audio clip
  uploads), surfaces meetings with unresolved/generic speaker labels (`MeetingSpeaker` rows absent
  or `Speaker.name` matching the generic-label heuristic).
- `POST /api/speakers/enroll` → calls the Speechmatics `SpeakerIdentityProvider.enroll()` (§10) →
  persists `Speaker` row (`enrolled_at`, `providerIds.speechmatics`, `enrollment_clip_paths`).
- Backfill: on successful enroll, scan `artifacts` of `kind='transcript', provider='speechmatics'`
  whose segments contain the provider's *generic* label for that voice (requires re-running
  identification against stored audio, since generic labels don't retroactively carry an
  identifier) — MVP approach: backfill re-submits a Speechmatics job for each affected meeting's
  audio with the newly-enrolled identifier included, replacing the `speechmatics` transcript
  artifact and updating `MeetingSpeaker`. This reuses the exact §10 job-submission path with a
  narrower `speakers[]` list, not a new mechanism.

**Exit gate**: enroll creates the `Speaker` row correctly; backfill test (fixture meeting with a
generic-labeled segment matching the enrolled voice) ends with the transcript/`MeetingSpeaker` link
updated; UI shows unresolved speakers before enrollment.

---

## 12. M4 — LLM summary/tag stage

Two adapters implementing `LLMProvider`, both hitting **custom proxy base URLs** (already in
`.env`), Bearer `LLM_API_KEY`:

- `providers/llm/openai.ts` — OpenAI-compatible chat completions against `OPENAI_API_BASE`
  (`/chat/completions`), model `OPENAI_MODEL` (settings-overridable). Covers OpenRouter/Ollama/LM
  Studio per Decision 7 since they all speak this same wire format.
- `providers/llm/anthropic.ts` — Anthropic Messages API against `ANTHROPIC_API_BASE`
  (`/v1/messages`), model `ANTHROPIC_MODEL`.
- Both take `Authorization: Bearer $LLM_API_KEY` (not native OpenAI/Anthropic key headers) since
  these are custom-proxied — confirmed by your env var choices.

`stage_runs.stage = 'llm_summarize'` runs on `meeting.primary_transcript_artifact_id`'s content
(canonical `Transcript`), calling `summarize()` then `tag()`; writes
`summaries/llm-<provider>.md` as an `Artifact` (`kind: 'summary'`), updates
`meeting.primary_summary_artifact_id` and `meeting.tags`.

Settings (`settings.json`): `llmProvider: 'openai' | 'anthropic'`, `llmPrompt` override (default
prompt shipped in code).

**Exit gate**: run against a fixture transcript with each adapter (hits the real configured proxy,
per your env), summary+tags artifacts written with correct provenance; provider-swap test (switch
`llmProvider` setting, confirm both paths produce valid output without code changes);
`primarySummaryArtifactId` set per preference order.

---

## 13. Cross-milestone test strategy

- Every milestone's exit gate from `MILESTONES.md` becomes a `bun test` suite committed alongside
  the code that implements it — no milestone is considered done without its gate passing green.
- Live-account tests (M1a against real Plaud, M2 against real Speechmatics, M4 against the real LLM
  proxy) run against the actual configured credentials in `.env` / `~/.plaud/tokens.json` — no
  mocking of the external call itself, since `.env` access was explicitly granted for exactly this.
- Deterministic unit tests (dedupe, retry/resume, backfill matching, fixture-diff exports) use an
  in-memory `bun:sqlite` handle (`:memory:`, injected the same way `setDbForTests` does in applaud —
  pattern only) and fixture files under `packages/server/test/fixtures/`.

---

## 14. Explicit non-scope reminders

No multi-user auth beyond the two bearer tokens above, no LAN/Tailscale
exposure work, no Docker/CI publishing beyond what M0 scaffolds, no editing/fixing transcripts in
the UI (Artifact Immutability), no SQLite backups. If implementation surfaces a need for any of
these, stop and flag rather than building it.
