# Local Diarization: Assessment and Improvement Plan

Assessment of the local diarization/speaker-ID stack, measured against live data in the
`olive` container (`/app/data/config/olive.sqlite`, 12 speakers, 26 enrollment clips).

Reference failure: meeting `2ae37ba4-cfd9-4d2d-b6bb-ec5a9d6ea8d2`, a 16.8 min 1:1 between
Matt Cowger and Harrison. Harrison has 9 stored clips, Matt 12. Result:

| Speaker | Segments | Duration | Share |
|---|---|---|---|
| Hassen (3 clips, not present) | 37 | 14.1 min | **93.0%** |
| Matt Cowger (present) | 17 | 0.6 min | 3.7% |
| Yogitha (2 clips, not present) | 22 | 0.5 min | 3.2% |
| **Harrison (present)** | **0** | **0 min** | **0%** |

---

## Findings

### 1. The embedding carries no speaker information

`packages/server/src/providers/local/embedding.ts:127` — `AcousticFeatureEmbeddingExtractor`
is hand-rolled DSP, not a trained speaker model. Measured over all 26 enrollment clips:

```
WITHIN-speaker  mean cosine = 0.9570
BETWEEN-speaker mean cosine = 0.9654
SEPARATION                  = -0.0084   <-- NEGATIVE

Best accuracy at ANY threshold: 78.4%   (random baseline 77.8%)
```

Clips from *different* speakers are more similar than clips from the *same* speaker. No
threshold can work because there is no signal to threshold.

Pairwise cosine similarity of the enrolled centroids (match threshold is `0.85`):

```
              Matt  Yogitha Hassen Lawrence Joey  Alexis Harrison
Matt Cowger   1.000  0.875  0.894   0.983  0.975  0.977   0.988
Yogitha       0.875  1.000  0.821   0.891  0.893  0.888   0.917
Hassen        0.894  0.821  1.000   0.922  0.909  0.920   0.925
Lawrence      0.983  0.891  0.922   1.000  0.993  0.999   0.985
Joey Hain     0.975  0.893  0.909   0.993  1.000  0.992   0.978
Alexis        0.977  0.888  0.920   0.999  0.992  1.000   0.980
Harrison      0.988  0.917  0.925   0.985  0.978  0.980   1.000

20 of 21 speaker pairs exceed the 0.85 identity threshold.
```

Lawrence≈Alexis at 0.999. Matt≈Harrison at 0.988.

Root causes:

- 97 of 192 dimensions are hardcoded zeros — effectively a 95-d vector.
- The "mel filterbank" (`embedding.ts:181-193`) is a single-bin Goertzel probe per center
  frequency, not a triangular filter. Narrowband and noisy.
- Features are time-averaged means, variances, and a DCT of the means. This describes
  channel, room, and phonetic content — which is why two people recorded on the same
  device look identical.
- CMN (`embedding.ts:208-212`) subtracts the global mean, removing much of the remaining
  speaker-level offset.

### 2. A single sub-second fragment locks an entire cluster

`packages/server/src/providers/local/pipeline.ts:160` caches `clusterToResolvedName` on the
**first** segment of each cluster and never revisits the decision. Replaying the meeting:

```
seg start  dur  cluster    Matt  Yogitha Hassen Lawrence Joey  Alexis Harrison  => WINNER
  0    0s  0.8s   c1      0.814   0.791  0.982   0.861  0.847  0.860   0.863    => Hassen   [gap 0.1188]
  1    3s  0.7s   c2      0.807   0.990  0.781   0.834  0.836  0.832   0.865    => Yogitha  [gap 0.1243]
  5   10s  1.4s   c1      0.977   0.865  0.925   0.980  0.974  0.974   0.978    => Lawrence [gap 0.0028]
 11   38s  1.8s   c1      0.989   0.870  0.921   0.987  0.980  0.981   0.989    => Matt     [gap 0.0006]
 17   60s  5.4s   c4      0.989   0.889  0.909   0.981  0.970  0.975   0.989    => Harrison [gap 0.0003]
 24   90s  1.3s   c2      0.936   0.969  0.869   0.941  0.936  0.937   0.969    => Harrison [gap 0.0004]
```

A 0.8s fragment at t=0 locks cluster 1 to Hassen. A 0.7s fragment at t=3s locks cluster 2 to
Yogitha. Every subsequent segment in those clusters is ignored. Winning margins on real
segments are 0.0003–0.01 — floating-point noise.

### 3. More training makes results worse

`mergeVoiceprintVectors` and the EMA in `updateVoiceprintCentroid` pull each centroid toward
the mean of the embedding space. Because that space has no speaker separation, the mean is
where everyone already sits.

- Matt (12 clips) and Harrison (9 clips) end up with heavily-averaged centroids parked at the
  global mean. They score ~0.96 on everything and win nothing decisively.
- Yogitha (2 clips) and Hassen (3 clips) retain idiosyncratic, off-center vectors that spike
  hard (gaps of 0.12) on short or noisy segments.

Fewer clips produce a sharper vector that wins the argmax. The system punishes training.

Compounding issues:

- The EMA is order-dependent, not a mean. At `alpha=0.85`, clip #1 still holds ~23% of the
  weight after 9 updates while clip #9 contributes 15%.
- `pipeline.ts:179` mutates centroids *during inference*, so one wrong match immediately drags
  the profile toward the wrong voice for the rest of the run.

### 4. Enrollment data is contaminated

Byte-identical audio enrolled to two different people, both from the failing meeting:

```
9eac0033d5a4  Matt Cowger:clip_meeting_2ae37ba4..._1786946370964.wav
              Harrison:clip_meeting_2ae37ba4..._1786945733792.wav
efaff0d80577  Matt Cowger:clip_meeting_2ae37ba4..._1786947227115.wav
              Harrison:clip_meeting_2ae37ba4..._1786947216598.wav
```

Repeated "training" on this meeting fed the same audio to both profiles, forcing them together.

Additionally, 6 of 26 clips are duplicates — Yogitha's "2 clips" are one file stored twice, as
are Hassen's and Lawrence's. Real distinct counts are 1, 2, and 2.

Clip durations are unusable at both extremes:

```
Matt Cowger  n=12  [157.3, 3.9, 95.1, 95.1, 1286.0, 29.2, 845.0, 60.8, 1.9, 4.6, 0.4, 0.7]
Harrison     n= 9  [845.0, 920.9, 4.6, 0.8, 2.0, 4.2, 40.1, 30.0, 74.8]
```

Sub-second clips yield degenerate embeddings; multi-minute clips almost certainly contain
both speakers.

### 5. `sherpa-onnx-node` is installed and never imported

`packages/server/package.json:25` declares it. There are zero imports anywhere in `packages/`.
It ships exactly what is needed, already on disk:

```
non-streaming-speaker-diarization.js   segmentation + embedding + clustering
speaker-identification.js              SpeakerEmbeddingExtractor, SpeakerEmbeddingManager
vad.js                                 Silero VAD
```

### 6. Preprocessing erases speaker identity

`packages/server/src/providers/local/wav.ts:180` applies to every file before embedding:

```
highpass=f=80, afftdn=nr=10, equalizer=f=350:g=-3, equalizer=f=3200:g=+5, speechnorm
```

The EQ notches 350 Hz and boosts 3200 Hz — precisely the formant regions carrying vocal-tract
identity — and `speechnorm` flattens dynamics. This chain is tuned for ASR intelligibility and
is actively hostile to speaker identification.

---

## Recommendations, ranked

### 1. Replace the embedding with a trained speaker model

Highest impact by a wide margin. Nothing else matters until this lands.

Use the already-installed sherpa-onnx `SpeakerEmbeddingExtractor` with a WeSpeaker or
3D-Speaker ECAPA-TDNN ONNX model (~256-d, ~28 MB, CPU-fast). Keep the
`SpeakerEmbeddingExtractorInterface` boundary in `embedding.ts:116` — it is already the right
seam, so this is a drop-in replacement behind the existing interface.

Expected: separation moves from **−0.008** to roughly **+0.35–0.5**; EER from ~50% to ~2–5%.

### 2. Replace VAD and clustering with sherpa's diarization module

Energy-threshold VAD (`diarizer.ts:185`, `avgEnergy * 0.4`) produces 0.3–0.8s fragments and
found 4 clusters for a 2-person meeting. Replace with Silero VAD plus the pyannote segmentation
model. Replace the greedy single-pass first-match clustering (`diarizer.ts:99-118`) with
agglomerative or spectral clustering, supplying a known speaker count when participants are known.

### 3. Remove the first-segment cluster lock

Decide identity per *cluster* by aggregating evidence across all of its segments — a
length-weighted mean similarity or a vote — rather than from whichever fragment happened to
appear first. Fix at `pipeline.ts:160`.

### 4. Store per-clip embeddings instead of one EMA centroid

Keep all N vectors per speaker. Score a segment as the max or top-k mean against them. This
removes order-dependence and makes additional training monotonically helpful. Add score
normalization (AS-Norm / z-norm against a cohort) so absolute similarities become comparable
across speakers. Stop mutating profiles during inference (`pipeline.ts:179`).

### 5. Constrain the candidate set and require a margin

The failing meeting is titled `Matt_Harrison_1_1`. Restricting matching to known meeting
participants would alone have prevented the Hassen/Yogitha result. Additionally, if top-1 and
top-2 are within ~0.05, emit `Unknown` rather than guessing.

### 6. Clean and validate enrollment, then re-enroll

- Deduplicate clips by content hash.
- Reject clips under ~3s and over ~30s.
- Re-diarize long clips to confirm they are single-speaker.
- Prevent the same audio slice from being enrolled to two speakers.

Current centroids are unrecoverable and must be rebuilt from scratch after cleanup.

### 7. Use unenhanced audio for embeddings

Keep the enhanced path (`wav.ts:180`) for ASR only. Extract voiceprints from clean, unprocessed
audio at both enrollment and inference.

### 8. Add a regression harness

The within/between separation and best-achievable-accuracy metrics above are roughly 40 lines
of code and would have caught this immediately. Gate changes on separation > 0.25.

---

## Sequencing

- Items **1–3** address the reported symptom.
- Item **4** fixes "training makes it worse."
- Item **6** is required regardless, since the stored profiles are already poisoned.
