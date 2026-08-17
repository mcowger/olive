# Diarization Fixes — Consolidated and Ranked Plan

Collated and deduplicated from three independent assessments of the local diarization stack:

- `docs/GEMINI.md` (Gemini)
- `docs/OPUS.md` (Opus)
- `docs/SOL.md` (Sol)

All three diagnose the same reference failure — meeting `2ae37ba4-cfd9-4d2d-b6bb-ec5a9d6ea8d2`, a
16.8-minute Matt/Harrison 1:1 attributed ~93% to Hassen (not present) and 0% to Harrison — and
converge on the same three root mechanisms:

1. The hand-rolled acoustic embedding carries no speaker-discriminative signal.
2. Speaker identity is locked to a cluster from its first (often sub-second) segment.
3. Inference-time centroid updates (EMA) corrupt enrolled profiles in a self-reinforcing loop.

Items below are ranked by value: measured or reasoned impact on attribution accuracy, divided by
implementation effort, weighted by cross-source consensus. Code references are as cited by the
source assessments (`packages/server/src/providers/local/` unless otherwise noted).

---

## Ranked recommendations

### 1. Replace the custom embedding with a trained neural speaker model
**Consensus: 3/3 — ranked first or co-first by every source.**

The current `AcousticFeatureEmbeddingExtractor` (`embedding.ts`) is hand-rolled DSP, not a trained
model. Opus measured it against all 26 live enrollment clips: within-speaker cosine similarity is
*lower* than between-speaker (separation −0.008), best achievable accuracy at any threshold is
78.4% against a 77.8% random baseline, and 20 of 21 enrolled speaker pairs already sit above the
0.85 match threshold. There is no signal to threshold. Gemini's root-cause analysis: MFCCs capture
mic/room/noise as much as voice. Opus adds concrete defects — 97 of 192 dimensions hardcoded zero,
a single-bin Goertzel probe masquerading as a mel filterbank, time-averaged statistics that describe
channel and phonetic content, and global-mean CMN that strips the remaining speaker offset.

**Fix:** swap in a trained ONNX speaker-verification model (ECAPA-TDNN via WeSpeaker or 3D-Speaker,
ERes2Net, or NeMo TitaNet; ~256-d, ~28 MB, CPU-fast) through the `SpeakerEmbeddingExtractor` that
`sherpa-onnx-node` already ships. That package is declared in `packages/server/package.json` and
installed in the running image but never imported. The existing
`SpeakerEmbeddingExtractorInterface` (`embedding.ts:116`) is the right seam — this is a drop-in
replacement behind an existing boundary. Expected result (Opus): separation from −0.008 to roughly
+0.35–0.5; EER from ~50% to ~2–5%. Nothing else matters until this lands.

**Effort:** medium (model download + adapter behind the existing interface).

### 2. Stop enrolled profiles from being mutated during inference
**Consensus: 3/3 — Sol sequences this first overall; Gemini and Opus embed it in their top four.**

`updateVoiceprintCentroid` updates and persists a speaker's enrolled centroid every time an
automatic match occurs (`pipeline.ts:179`, `transcription/service.ts:975-1003`,
`speakers/service.ts:1637-1650`). A wrong match therefore drags the trusted profile toward the wrong
voice, and the next run starts from the corrupted state. At EMA α=0.85, 19 runs of the same
assignment reduce the original profile's contribution to ~4.6% (Sol); the live data shows exactly
this, with self-reinforced matches scoring 0.9994. It is also order-dependent — clip #1 retains
~23% weight after 9 updates while clip #9 contributes 15% (Opus).

**Fix:** disable automatic centroid updates entirely during inference, or gate them behind both an
extreme similarity (Gemini suggests >0.95) and user confirmation. Automatic meeting observations
must never modify trusted enrollment data (see also #6). This is a small diff that stops ongoing
corruption of the system's only persistent state while the real fixes are built.

**Effort:** trivial. Land same-day, in parallel with #1.

### 3. Assign speaker identity per cluster from aggregated evidence, not the first segment
**Consensus: 3/3.**

`pipeline.ts:160` caches `clusterToResolvedName` on the **first** segment of each cluster and never
revisits the decision. In the reference meeting, a 795 ms fragment locked a 678-second cluster to
Hassen; a 0.7 s fragment locked cluster 2 to Yogitha. On real segments the winning margins were
0.0003–0.01 — floating-point noise (Opus).

**Fix:** run blind clustering first, then compute a duration-weighted centroid (all three sources
agree) or a length-weighted vote (Opus) across all segments in the cluster, and match that robust
aggregate against enrolled profiles. A single noisy fragment can no longer misidentify an entire
conversational turn.

**Effort:** small. Land immediately alongside #2.

### 4. Clean, validate, and rebuild speaker enrollment from scratch
**Consensus: 2/3 (Opus, Sol). Not addressed by Gemini.**

The live enrollment data is contaminated and unreusable:

- Byte-identical audio clips are enrolled under both Matt and Harrison — repeated "training" on the
  reference meeting fed the same audio to both profiles, forcing them together.
- 6 of 26 clips are exact duplicates; displayed clip counts (Yogitha 2, Hassen 3, Lawrence per
  duplicates) overstate distinct evidence — real counts are 1, 2, and 2.
- Durations range from 0.4 s (degenerate embedding) to 1,286 s (near-certainly multi-speaker).

**Fix** (merged rules from both sources): deduplicate by content hash; reject clips under ~3 s and
over ~30 s (Sol prefers a 3–15 s ideal window); verify long clips are single-speaker before
enrolling; block the same audio slice from being enrolled to two speakers; then rebuild every
profile from clean, user-confirmed excerpts. The current centroids are unrecoverable (Opus). The
rebuild must happen **on the new embedding from #1** — rebuilding with the current representation
leaves speakers inseparable regardless of data quality (Sol).

**Effort:** small-to-medium; mostly tooling plus one guided re-enrollment pass. Blocked by #1.

### 5. Replace energy VAD and greedy clustering with neural segmentation and clustering
**Consensus: 3/3 — Gemini #4, Opus #2, part of Sol's Sherpa P0.**

The energy-threshold VAD (`diarizer.ts:185`, `avgEnergy * 0.4`, 400 ms silence rule) produces
0.3–0.8 s fragments, ingests non-speech (breaths, keyboard clicks) that poison embeddings (Gemini),
and found 4 clusters in a 2-person meeting (Opus). The greedy single-pass first-match clustering
(`diarizer.ts:97-118`) compounds the fragments' errors.

**Fix:** adopt sherpa-onnx's `OfflineSpeakerDiarization` — Silero VAD plus a pyannote-family neural
segmentation model for frame-level speaker activity and overlap, with agglomerative or spectral
clustering, supplying a known/expected speaker count when participants are known. This rides the
same sherpa integration wave as #1 but is a separable, larger pipeline change. Sol notes the
official JS example: <https://k2-fsa.github.io/sherpa/onnx/javascript-api/examples/speaker_diarization.html>.

**Effort:** medium-large.

### 6. Store multiple trusted vectors per speaker; separate trusted enrollment from automatic observations
**Consensus: 2/3 (Opus #4, Sol P0/P1).**

Collapsing all evidence into one mutable EMA centroid is why "more training makes results worse"
(Opus): heavily-averaged profiles (Matt 12 clips, Harrison 9) drift to the global mean and win
nothing decisively, while sparse profiles retain idiosyncratic off-center vectors that spike on
noisy segments. The system punishes training.

**Fix:** keep N independent trusted vectors per speaker; score a segment or cluster as the max or
top-k mean against them (no order dependence, additional clips monotonically helpful); add score
normalization (AS-Norm / z-norm against a cohort) so absolute similarities are comparable across
speakers (Opus). Store automatic meeting observations separately as disposable evidence with its
own trust level — only user-confirmed excerpts enter the trusted set (Sol).

**Effort:** medium (schema + scoring change). Depends on #1, pairs with #4.

### 7. Constrain the candidate set, require a decision margin, and emit "Unknown" on ambiguity
**Consensus: 2/3 (Opus #5, Sol P1).**

The reference meeting is literally titled `Matt_Harrison_1_1`. Restricting matching to known
meeting participants would alone have prevented the Hassen/Yogitha result (Opus).

**Fix:** support a meeting-specific candidate roster and an expected speaker count; require both a
minimum score and a meaningful top-1 vs top-2 margin (~0.05 per Opus) or return `Unknown`; resolve
all of a meeting's clusters together via global assignment rather than independent argmaxes (Sol).

**Effort:** small-medium. Depends on #1/#5 producing separable scores and real clusters.

### 8. Use unenhanced audio for speaker embeddings
**Consensus: 1/3 (Opus #7 only).**

Every file passes through `wav.ts:180` before embedding: `highpass=f=80, afftdn=nr=10`,
a −3 dB notch at 350 Hz, +5 dB at 3200 Hz, and `speechnorm`. That chain notches the formant
regions carrying vocal-tract identity and flattens dynamics — it is tuned for ASR intelligibility
and is actively hostile to speaker identification.

**Fix:** keep the enhancement chain for the ASR path only; extract voiceprints from clean,
unprocessed audio at both enrollment and inference.

**Effort:** small-medium (a second, tap-off audio path). Single-source, but cheap and mechanistically
sound; ranked here on consensus and dependency, not lack of merit.

### 9. Add a real evaluation harness and runtime diagnostics
**Consensus: 2/3 (Opus #8, Sol P2).**

Opus's within/between-separation and best-threshold-accuracy metrics are ~40 lines of code and
would have caught this failure before it shipped — gate embedding changes on separation > 0.25.
Sol adds that the current tests use synthetic sine tones separated by silence
(`packages/server/test/local-transcription.test.ts:28-64`), which mainly validate pitch separation
— a near-circular match to the hand-rolled spectral features. Build a real-audio set from
user-confirmed excerpts and measure interval accuracy, turn boundaries, speaker-count accuracy,
cluster consistency, naming accuracy, Unknown correctness, and overlap handling. Add runtime
diagnostics: per-cluster duration and segment count, top scores and margins, label provenance
(trusted enrollment vs automatic observation).

**Effort:** small for the core separation metric; medium for the full harness. Ranked by value, not
by when to start — the 40-line separation check should be stood up immediately as the acceptance
gate for #1, then expanded.

### 10. Reconcile speaker labels with real word timestamps; handle overlap
**Consensus: 1/3 (Sol P1 only).**

Energy VAD requires ~400 ms of silence to split, but real conversations turn faster and contain
simultaneous speech. Frame-level neural segmentation (from #5) enables mapping speaker labels onto
word-level timestamps instead of assigning one name to a large ASR segment — but the Granite ASR
path currently fabricates evenly distributed synthetic word timestamps (`asr.ts:166-175`), so
accurate reconciliation also requires real word alignment or an ASR that returns genuine word
timestamps.

**Effort:** medium-large; dependent on #5. Last in value because everything upstream must land first.

---

## What the sources agree will NOT help

Guardrails before tuning anything in the current pipeline:

- **Adjusting the 0.85 match threshold** — with 20 of 21 enrolled pairs already above it and
  negative within/between separation, no threshold can work; there is no signal to threshold
  (Opus, Sol).
- **Adding more enrollment clips under the current regime** — clip counts overstate evidence, and
  the single EMA centroid makes additional training actively harmful (Opus, Sol).
- **Rebuilding profiles without replacing the embedding** — clean data on a representation with no
  speaker separation still yields inseparable profiles (Sol).

## Merged sequencing

Blending all three sources' sequences (Sol: freeze → clean → sherpa; Opus: 1–3 fix the symptom,
4 fixes "training makes it worse," 6 is required regardless; Gemini: embedding → tagging → EMA →
VAD):

1. **Now (hours):** #2 freeze profile mutation and #3 cluster-aggregate assignment — small diffs
   that stop ongoing corruption and the worst misattribution mechanism. Stand up the #9 core
   separation metric as the acceptance gate.
2. **Core fix (days):** #1 neural embedding, immediately followed by #4 clean re-enrollment on the
   new representation (profiles must be rebuilt; they are poisoned and tied to the old embedding).
3. **Pipeline quality:** #5 neural segmentation + clustering (same sherpa integration as #1, can be
   staged once embeddings prove out), then #6 multi-vector trusted profiles.
4. **Decision quality:** #7 rosters, margins, `Unknown`, global assignment.
5. **Follow-through:** #8 dual audio path, full #9 evaluation suite, then #10 word-level
   reconciliation and overlap.

## Alternatives considered (implementation options for #1/#5)

Per Sol's survey, if the sherpa-onnx path proves insufficient:

- **Pyannote Community-1** — strong local diarization with improved assignment and counting, but
  requires a Python/PyTorch worker and a gated CC-BY-4.0 model download.
- **NVIDIA NeMo Sortformer** — end-to-end speaker timing with simultaneous-speaker support;
  appropriate only with a GPU-backed Python worker and higher operational complexity.
- **WeSpeaker embedding-only swap** — substantially improves the representation but does not fix
  segmentation, cluster counting, or overlap; a strictly partial fix.

## Unique contributions by source

Deduplication removed near-total overlap on items 1–3 and 5. Remaining single-source contributions,
presolved into the list above: Opus alone identified the ASR-tuned preprocessing as hostile to
speaker identity (#8) and provided all live measurements; Sol alone identified the fabricated ASR
word timestamps blocking label reconciliation (#10) and the trusted-vs-automatic evidence split
(#6); Gemini's four-mechanism framing of the root causes aligned with, but did not detect, the
enrollment data contamination that Opus and Sol both surface as a mandatory fix (#4).
