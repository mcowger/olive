# Olive — Milestones

Sequential breakdown of `HIGHLEVEL.md`'s Build order (§ "Build order (chosen)") into milestones
with an explicit, testable exit gate at each boundary. Each milestone assumes all prior milestones
are done and green; nothing here starts until the previous exit gate passes.

The original build-order table skips the foundation (repo scaffold + domain schema) and merges two
independent ingestion sources into back-to-back items — split out below (M0, M1a/M1b) so each has
its own gate.

| # | Milestone | Maps to Build order # | Size |
|---|---|---|---|
| M0 | Scaffold + domain schema | (implicit, precedes #1) | S |
| M1a | Plaud ingestion | #1 | S |
| M1b | Manual/iOS ingestion | #2 | S–M |
| M2 | Speechmatics transcription + speaker ID | #3 | M |
| M3 | Speaker registry UI + enrollment/backfill | #4 | S–M |
| M4 | LLM summary/tag stage | #5 | S |

---

## M0 — Scaffold + domain schema

**Goal:** New repo exists, built from the `mcowger/applaud` scaffold, with the Decision-8 domain
model (`Meeting`, `Recording`, `Artifact`, `Speaker`, `MeetingSpeaker`) as real SQLite tables, and
nothing else — no providers, no ingestion, empty UI shell.

**Depends on:** nothing.

**Deliverables:**
- Repo created; transplanted service shell (`index.ts`, `config.ts`, `paths.ts`, `logger.ts`,
  `db.ts`), `web/` UI shell, Vitest harness, CI, Dockerfile.
- Migrations for `Meeting`/`Recording`/`Artifact`/`Speaker`/`MeetingSpeaker` per Decision-8 schema.
- Per-meeting disk layout helper (`<meetings>/<YYYY-MM-DD_title__meetingId8>/{audio,transcripts,summaries}/`).

**Exit gate (testable):**
- `npm test` / CI green with migration unit tests (schema applies cleanly, round-trips a fixture row per table).
- Service boots; `GET /health` (or equivalent) returns 200.
- Web UI loads and renders an empty recordings/meetings list with zero data.
- Manually inserting a fixture `Meeting` + `Artifact` row makes it appear in the UI list (proves DB→UI wiring without any provider).

---

## M1a — Plaud ingestion

**Goal:** Plaud is the first working source. Poller creates `Meeting` rows and ingests all
available Plaud artifacts (audio, Plaud transcript, Plaud summary) with provenance.

**Depends on:** M0.

**Deliverables:**
- `@mcowger/plaud-client` integrated (OAuth PKCE login, token persistence/refresh).
- Poller: lists Plaud files, creates one `Meeting` per Plaud recording, writes audio + transcript +
  summary artifacts to disk and DB with provider=`plaud` provenance.
- Wait-for-PCS-then-fallback-to-audio-only logic (timeout path).

**Exit gate (testable):**
- Integration test against a real (or recorded/mocked) Plaud account: run poller once → assert
  `Meeting` + expected `Artifact` rows exist with correct `provider`/`kind`/`format`, and files on
  disk match what's referenced in DB.
- Idempotency test: run poller twice on the same account state → no duplicate `Meeting`/`Artifact` rows.
- Fallback test: simulate a Plaud recording with no PCS/transcript ready within timeout → asserts
  audio-only `Meeting` is created (no transcript/summary artifact), and a later re-poll fills them in.
- Manual: log in via OAuth for the first time, confirm token file written with `0600` perms.

---

## M1b — Manual/iOS ingestion

**Goal:** Second, independent source: authenticated multipart upload endpoint plus the iOS Shortcut
that drives it. Does not depend on Plaud or Speechmatics — uploads just land as audio-only Meetings.

**Depends on:** M0. (Independent of M1a; can be built in parallel, but ordered after per the original table.)

**Deliverables:**
- `POST /api/ingest`: Bearer token auth, multipart upload, accepts m4a/aac/mp3/wav/ogg, sha256 dedupe,
  creates `Meeting` + `Recording` with provider=`upload`/`ios-shortcut` provenance.
- iOS Shortcut recipe (share-sheet → loop → form POST).

**Exit gate (testable):**
- `curl` multipart upload test creates a `Meeting` + `Recording` row and writes the file to the
  correct per-meeting disk path.
- Dedupe test: uploading the same bytes twice does not create a second `Recording`.
- Auth test: missing/invalid Bearer token → 401/403, no DB row created.
- Manual: run the Shortcut from an iOS device against a dev server, confirm a memo appears in the UI.

---

## M2 — Speechmatics transcription + speaker ID

**Goal:** First real `TranscriptionProvider` + `SpeakerIdentityProvider` implementations. Any
audio-bearing Meeting from M1a/M1b (or Plaud audio needing re-transcription) can be run through
Speechmatics to get a diarized, speaker-identified transcript artifact.

**Depends on:** M1a, M1b (need audio-bearing Meetings to operate on).

**Deliverables:**
- Batch job submission + Notifications-webhook completion handling (not polling).
- Speaker registry table wired to Speechmatics `speaker_identifiers[]`.
- `retranscribePlaudWhenUnnamed` trigger logic.
- Long-audio chunking / fetch-URL path for files >1GB.
- Per-stage state tracking, retryable independent of other stages.
- Post-ingest deletion of audio from Speechmatics' 7-day retention.

**Exit gate (testable):**
- Submit a fixture recording → webhook received → transcript `Artifact` (provider=`speechmatics`)
  appears in DB/disk in the canonical `Transcript` shape.
- Speaker ID round-trip test: enroll a known-voice clip, submit a recording containing that voice,
  assert the resulting transcript's speaker labels resolve to the enrolled name (not generic `S1/S2`).
- Retry test: kill the process mid-job, restart, assert the stage resumes/retries without duplicating
  the artifact or re-submitting a completed job.
- Retention test: confirm a delete-after-ingest call is made (mocked) once the artifact is persisted.

---

## M3 — Speaker registry UI + enrollment/backfill

**Goal:** Humans can enroll speakers from the UI and see history retroactively renamed.

**Depends on:** M2.

**Deliverables:**
- UI: list known speakers, enroll from a 5–30s clip, surface unknown/unlabeled speakers.
- Backfill job: on enrollment, rename matching speaker labels in previously ingested transcripts.

**Exit gate (testable):**
- Enrolling a speaker via the UI creates the `Speaker` row with `providerIds` populated.
- Backfill test: seed a fixture transcript with a generic `S1` label matching a newly enrolled voice,
  trigger enrollment, assert the stored transcript/`MeetingSpeaker` link is updated to the real name.
- UI shows meetings with unresolved/generic speakers in an "unknown speaker" state before enrollment.

---

## M4 — LLM summary/tag stage

**Goal:** First `LLMProvider` implementations produce summary + tag artifacts from the canonical
primary transcript, provider-swappable via config.

**Depends on:** M2 (needs a canonical transcript to summarize) — does not depend on M3.

**Deliverables:**
- OpenAI-compatible adapter (covers OpenRouter/Ollama/LM Studio) + Anthropic adapter.
- Settings for provider/model/prompt selection.
- Stage emits summary `Artifact` (md) + tags[] on the Meeting.

**Exit gate (testable):**
- Run the stage against a fixture transcript with a mocked provider → summary `Artifact` and tags
  are written with correct provenance (`provider: llm:*`).
- Provider-swap test: switch config between two adapters (e.g. mock OpenAI-compatible vs Anthropic)
  and confirm both produce a valid summary artifact without code changes.
- `primarySummaryArtifactId` on `Meeting` is set/updated per the documented preference order.

---

## Deferred / non-goals (unchanged from HIGHLEVEL.md)

No milestone covers: n8n-style workflow engine,
reMarkable/Boox/Google Drive/Notion destinations, macOS Voice Memos filesystem watcher, local
Whisper/pyannote pipeline. These remain out of scope per `HIGHLEVEL.md` § Non-goals.
