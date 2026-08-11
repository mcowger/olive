# Applaud-NG — High-Level Plan

A self-hosted audio pipeline: recordings in → transcript + speaker ID + summary + tags → Obsidian notes out.
Built as a **new repo**, using `mcowger/applaud` as scaffold/reference (not developed in-place).

Status: planning locked, nothing built yet.

## Reference bases

| Base | Role | Location |
|---|---|---|
| `mcowger/applaud` (fork of `rsteckler/applaud`, v0.5.11) | **Primary scaffold** — UI, service shell, infra | local: `~/workspace/applaud` · origin: `https://github.com/mcowger/applaud.git` |
| `landoncrabtree/applaud` | Reference only — same name, unrelated project | `https://github.com/landoncrabtree/applaud` (stale since Feb 2025, plain JS, known bugs — do NOT adopt as code; **author's permission granted**, license concern moot) |

## Locked decisions

1. **No paid tier, no n8n.** Everything self-hosted; Obsidian is the primary destination.
2. **Plaud ingestion via the official documented API** (docs.plaud.ai), replacing the fork's cookie/session scraping.
3. **Speechmatics** (batch) handles ALL raw-audio transcription: STT + within-file diarization + **cross-recording speaker identification** (voiceprint enrollment — confirmed supported in batch + realtime). ~$0.0067/min. Privacy is not a concern; delete audio from their 7-day retention after ingest as hygiene.
4. **Summaries + auto-tagging via a pluggable LLM** (Anthropic/OpenAI/Ollama to start) — Speechmatics' own summaries not relied upon.
5. **Apple Voice Memos constraint:** assume access is ONLY via iOS device/iCloud. Voice Memos lives in a private CloudKit container — no iCloud Drive path, no web UI, no macOS filesystem assumption. **iOS Share-Sheet Shortcut + upload endpoint is the sole ingress.** (macOS group-container watcher documented below as dormant option.)
6. **Plaud official API verified usable by individuals** — proven by multiple working OSS implementations, including our own `@mcowger/plaud-client` (OAuth 2.0 + PKCE against `platform.plaud.ai/developer/api`). No feasibility spike required.
7. **LLM, STT, and Diarization are capability interfaces, not vendors.** Speechmatics is the first STT/diarization implementation, not a coupling. Each stage talks to a defined interface; providers advertise capabilities and are swappable via config. Future candidates: ElevenLabs Scribe, Deepgram, AssemblyAI, local whisper.cpp/mlx-whisper (+pyannote if diarization needed locally), Groq; LLM candidates already include Anthropic/OpenAI/Ollama.
8. **The aggregate root is a `Meeting`, not a recording.** A Meeting owns multiple typed **artifacts** — audio recording(s), transcript(s) (each tied to a recording), summaries — plus links to **known speakers** (name + provider voiceprint IDs/embedding vectors). Every artifact carries **provenance** (provider, format, timestamps), and all available artifacts are ingested and retained: Plaud's server-side transcript and summary are first-class artifacts alongside any we generate. Meeting-level exports (Obsidian, webhook, future notes tools) are pure functions of the Meeting aggregate.

## Research findings (why these decisions)

### Plaud official API
- Documented REST API at `https://platform.plaud.ai/developer/api`, OAuth-based; official `@plaud-ai/cli` (`npm i -g @plaud-ai/cli`) with auto-managed tokens at `~/.plaud/tokens.json`; env overrides (`PLAUD_CLIENT_ID`, `PLAUD_CLIENT_SECRET`, …) imply custom OAuth clients are supportable.
- Data surface: `list_files` (filters, pagination), `get_file` → `presigned_url` (24h audio), `source_list` (transcript segments w/ timestamps + speaker labels), `note_list` (AI summaries, markdown).
- **Feasibility confirmed** — OAuth 2.0 + PKCE works for individuals via the same client flow the official CLI uses. Our own `@mcowger/plaud-client` (published on npm) already implements: PKCE login (loopback :8199 + headless paste-code flow), token persistence at `~/.plaud/tokens.json` (0600), proactive 48h auto-refresh, paginated listing with date filters, `getFile` (presigned audio + transcript segments + AI notes), error taxonomy with backoff, and **formatters (Markdown/SRT/text with speaker labels + timestamps, full note-doc generation)**. This is the Plaud layer for the new project.
- Requires Plaud Cloud Sync (PCS) enabled on the account. Official `plaud` CLI remains a debugging tool, not an integration path.

### Speechmatics
- **Speaker Identification** (docs.speechmatics.com/speech-to-text/features/speaker-identification): enroll 5–30s solo clips → string voice identifiers; pass `speaker_diarization_config.speakers = [{label, speaker_identifiers}]` on every job → transcripts come back named persistently across recordings. Also improves diarization accuracy. Batch + realtime.
- Constraints: max 50 identifiers/job; unknown speakers fall back to generic `S1/S2` per recording (enrollment-driven naming only); identifiers scoped per customer/project (fine for single user); 1GB max in-body upload (fetch-URL beyond); files retained 7 days unless deleted via API; completion via webhook Notifications (prefer over polling).
- Also has: custom vocabulary, channel diarization, summaries (unused).

### Apple Voice Memos
- iOS Shortcuts `Get Contents of URL` does multipart file POSTs with Bearer headers — proven pattern.
- iOS quirk: m4a uploads tagged `audio/x-m4a` (accept it); form file field must be type File with exact key name server expects.
- No "new voice memo" automation trigger exists on iOS → share-sheet is max automation, one tap.
- Voice Memos supports Edit → multi-select → Share → one shortcut handles single memos AND library backfill.
- Dormant option (if a Mac enters the loop later): `~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings/` + `CloudRecordings.db` (table `ZCLOUDRECORDING`: `ZUNIQUEID`, `ZENCRYPTEDTITLE`, `ZDATE`+978307200, `ZPATH`, `ZEVICTIONDATE`; needs Full Disk Access; handle ~3KB iCloud placeholder stubs; read DB read-only/copy-to-temp). Newer memos embed Apple's own transcript in a `tsrp` atom — free fallback, no speakers. Not part of the plan per Decision 5.

### Ecosystem prior art (surveyed 2026-08)

| Repo | Plaud access | What it is | What to take |
|---|---|---|---|
| **`mcowger/plaud-client`** (own) | Official API, OAuth PKCE | TS SDK + CLI, published npm | **The Plaud client for this project — depend on it or vendor it** |
| `sergivalverde/plaud-toolkit` (MIT) | Undocumented API, email+password (~300-day tokens, auto-refresh) | Monorepo: core lib, CLI, MCP server, Obsidian plugin "Plaud Pin Sync" | Obsidian note conventions: frontmatter + transcript + timestamps; folder split `Plaud/Notes` + `Plaud/Audio`; transport-pluggable core (Node fetch / Obsidian requestUrl) |
| `leonardsellem/plaud-sync-for-obsidian` (MIT) | `tokenstr` JWT from browser | Obsidian plugin, incremental sync | **Stable `file_id` in frontmatter → idempotent upserts**; sync checkpoint (`lastSyncAtMs`); error taxonomy (auth vs rate-limit vs 5xx); single-flight sync guard |
| `G9KBytes-Labs/Plaud-Claude-Obsidian` (license unverified) | n/a — Plaud mobile app syncs audio to iCloud Drive inbox | Python pipeline: iCloud watcher (brctl materialize) → Docker Whisper + Silero VAD → Claude → **Obsidian Local REST API** → weekly digest email | Alternative Obsidian write-path (Local REST API — no fs access needed, but Obsidian must be running); VAD silence-strip pre-STT; ~$0.01–0.02/note LLM cost datapoint |
| `loriss84/open-plaud` (MIT) | plaud-toolkit core (email+password) | TS poller + n8n → ElevenLabs Scribe STT + OpenRouter map-reduce summary → Notion | Decoupled stage flags (download vs notify, crash-safe, retryable); audio chunking for long files; map-reduce summarization pattern. Its own roadmap wished for voiceprint speaker ID — Speechmatics gives us this turnkey |
| `RobbieInOz/plaud-sdk` | n/a | = Plaud's **official device SDK hub** (BLE/WiFi pairing, appKey, physical device required) | **Not applicable** — mobile-app/device integration only |
| `lmmx/plaudit` (Rust) | Official API, OAuth PKCE | Reference impl credited by plaud-client | Read if OAuth edge cases bite |

## Target architecture

```
SOURCES (create Meetings + artifacts)      PROCESSING (attach artifacts)     DESTINATIONS (consume Meetings)

Plaud (official API, OAuth)  ── audio + Plaud transcript + Plaud summary ─┐
iOS Shortcut → POST /api/ingest ── audio artifact                        ─┤
web UI upload              ── audio artifact                             ─┘
                                   │
                                   ▼
                       MEETING row + artifact store
                       (sha256 dedupe per artifact; provenance on every artifact)
                                   │
              ┌──── optional/conditional stages —───┐──────────┐
              ▼                                      ▼          ▼
     Speechmatics job                     LLM (summary + tags)   speaker linking
     (diarized transcript artifact        (summary artifacts)     (meeting ↔ speaker registry,
      w/ enrolled names; needed when       from chosen primary    voiceprint enrollment)
      enrolled speakers exist /          transcript)
      configured / no Plaud transcript)
                                   │
                                   ▼
                Obsidian note (file_id = meeting id; frontmatter: date,
                 duration, source(s), speakers, tags; summary; transcript; audio link)
                + webhook (existing, keep as bonus)
```

- **Uniform model:** one `sources → ingest → stages → destinations` pipeline; every meeting gets an on-disk folder (fork-derived layout, now per-meeting): `<meetings>/<YYYY-MM-DD_title__meetingId8>/` containing `audio/`, `transcripts/<provider>.{json,txt}`, `summaries/<provider>.md`. Blob bytes live on disk; metadata + relationships live in SQLite.
- Plaud audio optionally *re-run through Speechmatics* for automatic voiceprint-based naming — only when Plaud labels came back generic (`Speaker N`); Plaud speakers identified in the Plaud app already carry real names through the API. Trigger: `retranscribePlaudWhenUnnamed` config, OR no Plaud transcript artifact exists. Plaud's own transcript/summary artifacts are always retained regardless.
- **Speaker registry:** SQLite table (name, provider voiceprint identifiers — e.g. Speechmatics `speaker_identifiers[]`, enrolled_at); attached to every Speechmatics job; backfill step renames speakers in past transcripts on enrollment.
- Auth: server binds beyond loopback; **new Bearer-token middleware** on all `/api/*` when not loopback-bound (the fork has an unused `lanToken` config field — implement the enforcement it implies). Same-LAN out of the box; off-LAN via Tailscale.
- **Obsidian write-path:** default = direct vault file write (server needs fs visibility into the vault — same host or sync mount) with **stable `file_id` frontmatter → idempotent upserts** and folder split `Notes/` + `Audio/`, filename pattern `{date}-{title}` (conventions per ecosystem survey). Alternative = Obsidian Local REST API plugin when the server can't touch the vault filesystem; requires Obsidian running.

### Provider interfaces (Decision 7)

Every AI stage is config-swappable behind a small interface; all providers normalize to one canonical internal transcript shape.

```ts
// Canonical internal transcript — everything normalizes to this
type Transcript = { segments: { start: ms; end: ms; speaker: string; text: string }[] };

interface TranscriptionProvider {          // STT (incl. within-file diarization)
  readonly caps: { diarization: boolean; speakerId: boolean; customVocab: boolean };
  transcribe(job: { audioPath: string; vocab?: string[]; speakers?: EnrolledSpeaker[] }): Promise<Transcript>;
}

interface SpeakerIdentityProvider {        // cross-recording voiceprint ID
  enroll(label: string, clipPaths: string[]): Promise<SpeakerId>;  // 5–30s solo clips
  list(): Promise<EnrolledSpeaker[]>;
}

interface LLMProvider {                    // summary + tags from final transcript
  complete(prompt: string, opts: { maxTokens?: number }): Promise<string>;  // summary
  tag(transcript: Transcript, existingTags: string[]): Promise<string[]>;   // auto-tag
}
```

- Providers **advertise capability flags**; features degrade gracefully (e.g. a no-`speakerId` provider leaves generic `S1/S2` labels; the speaker registry is simply Speechmatics' implementation of `SpeakerIdentityProvider` — local whisper + pyannote would be a second, privacy-first implementation).
- LLM stays transcript-in/markdown(s)+tags-out so prompts/pipelines survive provider swaps.
- OpenAI-compatible endpoints (OpenRouter, Ollama, LM Studio) ride one LLM adapter.

### Domain model (Decision 8)

```ts
Meeting        { id, title, startTime, endTime, source, status, tags: string[],
                 primaryTranscriptArtifactId?, primarySummaryArtifactId? }
Recording      { id, meetingId, path, mime, durationMs, sha256 }          // audio artifact(s); N per meeting
Artifact       { id, meetingId, recordingId?, kind: 'transcript'|'summary',
                 provider: 'plaud'|'speechmatics'|'apple-tsrp'|'llm:*', format: 'md'|'txt'|'json',
                 path, createdAt }                                          // provenance on every row
Speaker        { id, name, providerIds: { speechmatics?: string[] }, enrolledAt }   // voiceprint vectors/IDs
MeetingSpeaker { meetingId, speakerId, evidenceArtifactId }               // who was in which meeting
Export         = f(Meeting + Artifacts + Speakers + Tags)  → Obsidian note / webhook payload
```

- **Multiple recordings per meeting** is supported in the schema (multi-device capture, manual merge) but MVP creation is 1 recording → 1 meeting; merging is an explicit later op.
- **`primaryTranscriptArtifactId` / `primarySummaryArtifactId`** pointers decide what the LLM stage and exports consume; preference is configurable (default: speechmatics-with-named-speakers transcript > plaud transcript; llm summary > plaud summary). All alternates stay retained as artifacts.
- **Speechmatics speaker identifiers are stored on `Speaker.providerIds`** (provider-namespaced), so swapping/adding a `SpeakerIdentityProvider` doesn't corrupt existing identities.
- **Named Plaud speaker labels flow straight into `MeetingSpeaker` links** (match-or-create `Speaker` by label name at ingest). Voiceprint enrollment is only needed to *discover* names for sources with generic labels: raw uploads, Voice Memos, and unnamed Plaud recordings.

## Reuse census — what travels to the new repo

**Transplant (≈60%):** `web/` React UI wholesale (recordings browser, waveform player, transcript viewer, settings) · service shell (`index.ts`, `config.ts`, `paths.ts`, `logger.ts`, `db.ts`) · `sync/layout.ts` verbatim · `webhook/*` · shared types + `summarySanitize.ts` · Vitest harness, CI, Dockerfile, release scripts.

**Rewrite/replace (≈40%):** `server/src/auth/*` (cookie scraping → OAuth via `plaud-client`) · `server/src/plaud/*` (undocumented API → official API) · poller/state semantics (Plaud-specific schema → **Meeting/Artifact/Speaker schema** + stage tracking).

**Lasting tricks worth remembering (not carrying):** copy-locked-SQLite-to-temp pattern; webhook `(id, event)` idempotency + backoff.

## Build order (chosen)

| # | Item | Size | Notes |
|---|------|------|-------|
| 1 | **Plaud official-API layer** | S | Adopt/depend on `@mcowger/plaud-client` (OAuth PKCE ✓, refresh ✓, formatters ✓ — see Ecosystem). Poller creates **Meetings** and ingests all available artifacts: audio + Plaud transcript + Plaud summary (never discard). Verify PCS enabled on account during first login test. |
| 2 | **`/api/ingest` + token middleware + iOS Shortcut recipe** | S–M | Multipart, m4a/aac/mp3/wav/ogg, sha256 dedupe, Bearer auth, bind-config enforcement. Shortcut: share-sheet → loop → Form POST. Until step 3 exists, uploads just land on disk. |
| 3 | **Speechmatics pipeline** | M | First `TranscriptionProvider` + `SpeakerIdentityProvider` implementations behind the Decision-7 interfaces. Batch jobs + Notifications webhook completion (not polling); speaker registry attached; 7-day-retention delete-after-ingest; transcription for all raw-audio sources. Long-audio: chunking or fetch-URL >1GB (open-plaud's chunk pattern). Stage flags decoupled per open-plaud (`state`-tracked, retryable per stage). |
| 4 | **Speaker registry UI + enrollment/backfill** | S–M | Enroll from 5–30s clip; rename-in-history on enrollment; unknown-speaker surfacing in UI. |
| 5 | **LLM summary/tag stage** | S | First `LLMProvider` implementations (one OpenAI-compatible adapter covers OpenRouter/Ollama/LM Studio; Anthropic separate). Provider/model/prompt in settings; runs on final canonical transcript; emits summary md + tags[]. |
| 6 | **Obsidian destination** | S | Export = pure function of Meeting aggregate: one note per meeting, YAML frontmatter (date/duration/source/speakers/tags/**file_id = meeting id**) + primary summary + primary transcript + audio link; idempotent upsert keyed on `file_id`. Fork groundwork reusable: filename sanitizer already Obsidian-safe. |

## Non-goals

- No n8n/Zapier-styled workflow engine (webhooks suffice).
- No reMarkable/Boox, no Google Drive/Notion destinations (paid-tier features; out of scope).
- No macOS Voice Memos filesystem watcher (per constraint; seam kept for later).
- No local Whisper/pyannote pipeline (Speechmatics replaces it; landoncrabtree recipe kept as privacy fallback only).
