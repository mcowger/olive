# Olive M0 API

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
