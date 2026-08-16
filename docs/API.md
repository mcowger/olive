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
