# Olive API

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
