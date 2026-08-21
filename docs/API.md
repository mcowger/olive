# Olive API

## `POST /api/ingest`

Ingests arbitrary audio recordings into Olive from web uploads or iOS Shortcuts.

* **Authentication:** `Authorization: Bearer <OLIVE_INGEST_TOKEN>` (required if `OLIVE_INGEST_TOKEN` is set in environment).
* **Content-Type:** `multipart/form-data`
* **Form Fields:**
  * `file`: Audio file blob (required). Supported formats: `.m4a`, `.mp3`, `.wav`, `.aac`, `.ogg`, `.flac`, `.webm`.
  * `title`: Optional custom meeting title string.
  * `source`: Optional source (`'upload'` | `'ios-shortcut'`, default inferred from User-Agent / parameter).
  * `autoTranscribe`: Optional boolean (`true` / `false`).
  * `provider`: Optional transcription provider (`'speechmatics'` | `'local'`).

Response:
```json
{
  "meetingId": "uuid",
  "recordingId": "uuid",
  "deduped": false,
  "meeting": { ... },
  "audioPath": "audio/uuid.m4a"
}
```

*Note on Deduplication:* Computes SHA-256 hash of the uploaded audio payload. If the exact same recording was previously uploaded, responds with HTTP 200 `{ "deduped": true }` and returns the existing meeting without re-allocating disk storage.

## `GET /api/meetings/:id/audio`

Streams the audio recording for in-browser playback. Supports HTTP `Range` requests for seekable playback.

---

## iOS Shortcut Setup (Voice Memos to Olive)

You can easily send Apple Voice Memos directly into Olive via an iOS Share-Sheet Shortcut:

1. Open the **Shortcuts** app on iOS.
2. Create a new Shortcut with:
   * **Receive:** Audio / Files from Share Sheet.
   * **Action 1:** `Get Contents of URL`
     * **URL:** `https://<your-olive-host>/api/ingest`
     * **Method:** `POST`
     * **Headers:** `Authorization: Bearer <your-OLIVE_INGEST_TOKEN>`
     * **Request Body:** `Form`
       * `file`: `Shortcut Input` (Type: File)
       * `source`: `ios-shortcut`
       * `autoTranscribe`: `true`
   * **Action 2:** `Show Notification` with upload status.
3. In Apple Voice Memos, tap **Share** $\rightarrow$ select your Olive shortcut.

---

## `GET /api/health`

Returns HTTP 200 with:

```json
{"status":"ok"}
```

## `GET /api/meetings?limit&offset&search`

Returns HTTP 200 with a stable envelope. `meetings` is always an array, including when the
database is empty. `limit` defaults to `50` and is capped at `100`; `offset` defaults to `0`.

```json
{
  "meetings": [
    {
      "id": "uuid",
      "title": "Design review",
      "startTime": 1720000000000,
      "endTime": 1720003600000,
      "source": "upload",
      "status": "ready",
      "tags": ["project"],
      "primaryTranscriptArtifactId": null,
      "primarySummaryArtifactId": null,
      "lastError": null,
      "createdAt": 1720000000000,
      "updatedAt": 1720000000000
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 1
  }
}
```

## `/mcp`

Provides Olive's read-only Model Context Protocol endpoint on the same port as the HTTP API. It supports `list_meetings`, `get_meeting`, `search_transcripts`, `get_action_items`, `list_speakers`, and `get_speaker_profile`.

Authentication uses `Authorization: Bearer <OLIVE_MCP_TOKEN>`. If `OLIVE_MCP_TOKEN` is unset, `OLIVE_INGEST_TOKEN` is used as a fallback. When Olive binds to loopback, the endpoint may be used without a token; non-loopback binds require one.

## `GET /api/meetings/:id`

Returns HTTP 200 with the full meeting aggregate:

```json
{
  "meeting": { "id": "uuid", "title": "Design review", ... },
  "recordings": [ ... ],
  "artifacts": [ ... ],
  "speakers": [ ... ],
  "stageRuns": [ ... ],
  "transcriptContent": "...",
  "summaryContent": "..."
}
```

## `POST /api/meetings/:id/transcribe`

Triggers Speechmatics transcription for a meeting's recording.

Optional JSON body:
```json
{
  "language": "en",
  "poll": false,
  "force": false
}
```

Returns:
```json
{
  "stageRunId": "uuid",
  "jobId": "speechmatics-job-id",
  "status": "running"
}
```

## `POST /api/webhooks/speechmatics`

Webhook destination for Speechmatics job completion notifications. Receives transcript payload, normalizes to canonical format, stores `speechmatics.json` / `speechmatics.txt` artifacts, links speakers, and sets primary transcript.

## `GET /api/speakers`

Returns a list of all enrolled/discovered speakers with meeting participation counts.

```json
{
  "speakers": [
    {
      "id": "uuid",
      "name": "Matt",
      "providerIds": { "speechmatics": ["id1", "id2"] },
      "enrolledAt": 1720000000000,
      "enrollmentClipPaths": ["speakers/uuid/clip_1720000000000.wav"],
      "meetingCount": 4,
      "createdAt": 1720000000000
    }
  ]
}
```

## `POST /api/speakers/enroll`

Accepts `multipart/form-data` with:
* `name`: Speaker name (required)
* `file`: 5–30s solo audio clip (required)
* `speakerId`: Optional existing speaker ID to add additional audio clip

Submits audio to Speechmatics with `get_speakers: true`, extracts voiceprint identifiers, saves the clip to disk, and persists the speaker with their Speechmatics identifiers.

## `GET /api/speakers/:id`

Returns speaker profile, enrolled audio clips, and list of associated meetings.

## `POST /api/meetings/:id/speakers/link`

Links a speaker to a meeting. Optionally transfers voiceprint identifiers from a generic label (e.g. `S1`) in the meeting's transcript to the speaker's profile.

JSON body:
```json
{
  "speakerId": "uuid",
  "speechmaticsLabel": "S1"
}
```

---

## `GET /api/templates`

Returns a list of all summary prompt templates (built-in and custom), sorted with default first.

```json
{
  "templates": [
    {
      "id": "00000000-0000-0000-0000-000000000001",
      "name": "Executive Summary",
      "description": "Structured meeting overview...",
      "systemPrompt": "You are an expert executive assistant...",
      "userPrompt": "# Meeting Summary: {{title}}\n...",
      "isDefault": true,
      "isBuiltin": true,
      "createdAt": 1720000000000,
      "updatedAt": 1720000000000
    }
  ]
}
```

## `GET /api/templates/:id`

Returns a single summary prompt template by its UUID.

## `POST /api/templates`

Creates a custom summary prompt template (`isBuiltin: false`).

JSON body:
```json
{
  "name": "Sprint Retrospective",
  "description": "Highlights wins, blockers, and next sprint commitments",
  "systemPrompt": "You are an agile coach summarizing team retrospective.",
  "userPrompt": "# Retro: {{title}}\n**Date:** {{date}}\n\n## Summary\n{{transcript}}",
  "isDefault": false
}
```

## `PATCH /api/templates/:id` or `PUT /api/templates/:id`

Updates fields on a template. Built-in status cannot be altered.

## `POST /api/templates/:id/default`

Designates the specified template as the default summary template and removes default status from all others.

## `DELETE /api/templates/:id`

Deletes a custom template. Built-in templates cannot be deleted (returns HTTP 400).

---

## `GET /api/llm/providers`

Returns the list of supported LLM providers, whether each is configured with an API key, custom base URL status, and available model counts.

## `GET /api/llm/models?provider=&search=&limit=`

Lists models from the unified `pi-ai` model catalog. Supports filtering by provider, fuzzy search by model name/ID, and result limits.

## `POST /api/llm/refresh-catalog`

Fetches and refreshes the web model catalog from online registries (`models.dev`) and dynamic providers.

## `GET /api/llm/config`

Returns current LLM settings, including the active default provider, default model, configured provider endpoints, and custom model definitions (with API keys securely masked).

## `POST /api/llm/config`

Updates LLM settings:
```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-3-7-sonnet-20250219",
  "providers": {
    "openai": {
      "baseUrl": "http://localhost:11434/v1"
    }
  }
}
```

## `POST /api/llm/generate`

Executes a prompt generation using `pi-ai`:
```json
{
  "provider": "google",
  "model": "gemini-2.5-flash",
  "systemPrompt": "You are a concise executive assistant.",
  "prompt": "Summarize the key points: ...",
  "temperature": 0.3
}
```

## `POST /api/llm/test`

Tests connectivity to an LLM provider and model by executing a quick ping prompt.
```json
{
  "provider": "google",
  "model": "gemini-2.5-flash"
}
```

---

## Backup & Restore API

### `POST /api/backup`

Creates a complete, self-contained backup archive (`.tar.gz`) containing:
- Consistent SQLite database snapshot (`VACUUM INTO` + WAL checkpoint)
- User settings (`settings.json`) and model cache (`models.json`)
- All meeting folders with **all audio recordings**, transcripts, and summaries
- Metadata manifest (`manifest.json`)

Optional JSON payload:
```json
{
  "filename": "my-custom-backup-name.tar.gz"
}
```

Response (HTTP 201):
```json
{
  "ok": true,
  "backup": {
    "filename": "olive-backup-20260817-003015.tar.gz",
    "path": "/app/data/config/backups/olive-backup-20260817-003015.tar.gz",
    "sizeBytes": 5839201,
    "createdAt": "2026-08-17T00:30:15.000Z",
    "manifest": {
      "version": "1.0.0",
      "createdAt": "2026-08-17T00:30:15.000Z",
      "oliveVersion": "0.1.0",
      "app": "olive",
      "stats": {
        "meetingCount": 14,
        "recordingCount": 14,
        "audioFilesCount": 14,
        "totalAudioSizeBytes": 154829102,
        "summaryCount": 28,
        "speakerCount": 6,
        "templateCount": 4
      }
    }
  }
}
```

### `GET /api/backup/list`

Lists all stored backup archives on the server with metadata and manifest statistics.

### `GET /api/backup/download/:filename`

Streams the specified backup `.tar.gz` archive as an attachment download.

### `GET /api/backup/export`

Creates a fresh backup archive and immediately streams it as a browser download attachment (`Content-Disposition: attachment; filename="olive-backup-..."`).

### `DELETE /api/backup/:filename`

Deletes a stored backup archive from the server.

### `POST /api/backup/restore`

Restores the database, settings, and all audio files from a backup archive. Supports:
1. **Multipart File Upload:** `multipart/form-data` with `file: <backup.tar.gz>`
2. **Server-Stored File:** `application/json` with `{ "filename": "olive-backup-..." }`

Response (HTTP 200):
```json
{
  "ok": true,
  "result": {
    "success": true,
    "restoredAt": "2026-08-17T00:35:00.000Z",
    "manifest": { ... },
    "stats": {
      "meetings": 14,
      "recordings": 14,
      "audioFiles": 14,
      "summaries": 28,
      "speakers": 6,
      "templates": 4
    }
  }
}
```

---

## Logs API

### `GET /api/logs?level=&category=&meetingId=&search=&limit=&offset=`

Queries structured system and job logs with severity level filtering, category filtering, meeting scoping, text search, and pagination.

* **Parameters:**
  * `level`: Minimum severity level (`"debug"` | `"info"` | `"warn"` | `"error"`, defaults to `"debug"`). Filters for all logs at or above this severity.
  * `category`: Optional category filter (e.g. `"ingest"`, `"transcription"`, `"diarization"`, `"summary"`, `"speakers"`, `"plaud"`, `"backup"`, `"llm"`).
  * `meetingId`: Optional meeting UUID to scope logs to a specific meeting.
  * `search`: Fuzzy search substring against log message and JSON details.
  * `limit`: Page limit (default `100`, max `500`).
  * `offset`: Page offset (default `0`).

Response (HTTP 200):
```json
{
  "ok": true,
  "logs": [
    {
      "id": "uuid",
      "level": "info",
      "category": "transcription",
      "message": "Transcription completed successfully",
      "meetingId": "uuid",
      "meetingTitle": "Architecture Sync",
      "details": {
        "segmentCount": 24,
        "durationMs": 312000
      },
      "createdAt": 1786933000000
    }
  ],
  "pagination": {
    "total": 150,
    "limit": 100,
    "offset": 0
  },
  "categories": ["backup", "diarization", "ingest", "llm", "plaud", "speakers", "summary", "system", "transcription"]
}
```

### `DELETE /api/logs?olderThanMs=`

Clears stored logs from SQLite database, with optional `olderThanMs` timestamp cutoff.

---

## Command Line Utilities

### Create Backup
```bash
bun run scripts/backup.ts [optional-output-path.tar.gz]
```

### Restore Backup
```bash
bun run scripts/restore.ts <path-to-backup.tar.gz>
```
