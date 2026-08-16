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
