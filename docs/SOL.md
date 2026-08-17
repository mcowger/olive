# Local Diarization Assessment and Improvement Plan

## Summary

Olive's local diarization currently uses custom acoustic features rather than a trained speaker model. The larger issue is that automatic speaker assignments are written back into enrolled profiles. Re-running a meeting can therefore reinforce an incorrect assignment.

The number of stored clips is not a reliable measure of enrollment quality. Each speaker ultimately has one local centroid, and the live clip collection includes duplicates, very short excerpts, and long multi-speaker meeting sections.

The two highest-priority improvements are:

1. Stop automatic results from modifying enrolled speaker profiles, then rebuild those profiles from clean, user-confirmed excerpts.
2. Replace the custom segmentation, embedding, and clustering stack with neural diarization, preferably through the existing `sherpa-onnx-node` dependency.

## Current Local Technique

The current local flow is:

1. FFmpeg converts the recording to 16 kHz mono and applies a speech-enhancement filter.
2. Energy-based speech detection finds intervals using 30 ms frames and a 400 ms silence rule.
3. A custom 192-dimensional vector is calculated from filterbank means, variances, and DCT coefficients.
4. An order-dependent threshold algorithm groups intervals into recording-level clusters.
5. The first segment encountered for a cluster determines its enrolled speaker name.
6. The matched segment updates the enrolled centroid using an exponential moving average.
7. The resulting centroid is persisted as the speaker's sole local vector.

Relevant implementation locations:

- Audio conversion and enhancement: `packages/server/src/providers/local/wav.ts`
- Custom embedding: `packages/server/src/providers/local/embedding.ts:121-234`
- Energy speech detection: `packages/server/src/providers/local/diarizer.ts:157-224`
- Recording-level clustering: `packages/server/src/providers/local/diarizer.ts:97-118`
- Cluster naming and centroid updates: `packages/server/src/providers/local/pipeline.ts:145-208`
- Automatic profile persistence: `packages/server/src/transcription/service.ts:975-1003`
- Enrollment centroid updates: `packages/server/src/speakers/service.ts:1637-1650`

Despite a comment in `packages/server/src/transcription/service.ts:241-244`, the local pipeline does not currently use Pyannote.

## Live Findings

The running `olive` container was queried read-only. No live files or database rows were changed.

### Meeting `2ae37ba4-cfd9-4d2d-b6bb-ec5a9d6ea8d2`

The meeting contains Matt and Harrison, but its current local transcript assigns approximately:

- Hassen: 845 seconds
- Yogitha: 29 seconds
- Matt Cowger: 34 seconds
- Harrison: 0 seconds

The local stage has 19 attempts. A read-only rerun of only the diarization and scoring steps produced three clusters:

- A 678-second cluster resolved to Hassen from its first 795 ms segment.
- A 27-second cluster resolved to Yogitha from its first 1.94-second segment.
- A 27-second cluster resolved to Matt from its first 945 ms segment.

The meeting-wide names are therefore being selected from very short initial excerpts rather than from a centroid representing the full cluster.

### Enrolled profiles are not separable

Among the seven speakers with local vectors, 20 of the 21 distinct speaker pairs have cosine similarity above the configured `0.85` matching threshold.

Examples include:

- Matt Cowger and Harrison: `0.9876`
- Alexis and Lawrence: `0.9989`
- Harrison and Lawrence: `0.9854`

The threshold cannot provide useful unknown-speaker rejection when enrolled profiles are already this similar. Raising the threshold alone will not address the underlying representation and profile-quality problems.

### Clip counts overstate useful enrollment evidence

Each enrolled speaker has one local vector regardless of the number of stored clips. The live data also contains:

- An exact byte-identical 845-second clip enrolled under both Matt and Harrison.
- Exact duplicate clips within Matt, Hassen, and Yogitha's collections.
- Harrison clips lasting approximately 845 and 921 seconds.
- Matt clips lasting approximately 845 and 1,286 seconds.
- Hassen clips lasting approximately 228 and 1,397 seconds.
- Multiple excerpts shorter than one second.

These are not suitable independent solo-speaker examples. Long clips assembled from transcript ranges can include silence, missed turns, and multiple voices. Duplicate clips increase the displayed count without adding evidence.

### Repeated runs reinforce prior assignments

Automatic matches update centroids with an EMA weight of `0.85`, and the updated vector is persisted after each run.

If the same assignment occurs over 19 runs, the original vector's pre-normalization contribution falls to approximately:

```text
0.85^19 = 4.6%
```

The current live scores are consistent with this feedback loop:

- Dominant cluster to Hassen: `0.9994`
- Second cluster to Yogitha: `0.9987`

User-confirmed enrollment and automatic observations need separate storage and trust levels.

## Prioritized Improvements

### P0: Freeze and rebuild speaker enrollment

Automatic diarization results should never directly modify trusted speaker profiles.

Recommended enrollment rules:

- Only user-confirmed excerpts can become trusted enrollment examples.
- Keep several independent vectors per speaker rather than one mutable EMA centroid.
- Prefer clean solo excerpts of roughly 3-15 seconds.
- Reject excerpts that are too short, excessively long, low-energy, or likely to contain more than one voice.
- Detect and ignore duplicate audio.
- Keep automatic meeting observations separate and disposable.
- Rebuild existing local profiles after removing duplicate and mixed-speaker clips.

This profile reset should accompany the model replacement. Rebuilding with the current custom embedding alone would still leave speakers poorly separated.

### P0: Adopt Sherpa-ONNX neural diarization

`sherpa-onnx-node` is already declared in `packages/server/package.json` and installed in the running image. Its runtime exposes:

- `OfflineSpeakerDiarization`
- `SpeakerEmbeddingExtractor`
- `SpeakerEmbeddingManager`

Olive currently has no source references to these APIs, and the live models directory is empty.

The recommended stack is:

- Pyannote-compatible neural segmentation for speaker activity and overlap.
- A trained neural speaker embedding model such as 3D-Speaker ERes2Net or NeMo TitaNet.
- Sherpa's recording-level clustering.
- A configured expected speaker count when it is known.

This fits Olive's Bun/TypeScript process without requiring a separate Python service.

Official Sherpa JavaScript example:

https://k2-fsa.github.io/sherpa/onnx/javascript-api/examples/speaker_diarization.html

### P1: Use stronger known-speaker assignment

After obtaining reliable recording-level clusters:

- Calculate an embedding centroid from several high-quality segments in each cluster.
- Compare the cluster against multiple trusted examples per enrolled speaker.
- Require both a minimum score and a meaningful margin over the second-best candidate.
- Return `Unknown` when the decision is ambiguous.
- Resolve all meeting clusters together using global assignment rather than independently.
- Support a meeting-specific candidate roster.
- Support an expected speaker count, such as two for a known one-on-one meeting.

For a known Matt/Harrison meeting, the system should not consider every enrolled person equally unless the audio strongly indicates an additional participant.

### P1: Improve turn and overlap handling

The current energy detector generally needs at least 400 ms of silence to split speech. Real conversations often switch speakers faster than this or contain simultaneous speech.

A neural segmentation model should provide frame-level speaker activity. Speaker labels can then be reconciled with real word timestamps instead of assigning one name to a large ASR segment.

The Granite ASR path currently creates evenly distributed synthetic word timestamps in `packages/server/src/providers/local/asr.ts:166-175`. Accurate word-to-speaker reconciliation will require actual word alignment or an ASR model that returns reliable word timestamps.

### P2: Add evaluation and diagnostics

Current diarization tests use synthetic sine tones separated by silence in `packages/server/test/local-transcription.test.ts:28-64`. These tests mainly validate pitch separation, which closely matches the custom spectral representation.

A useful evaluation set should contain user-confirmed real audio and separately measure:

- Speech interval accuracy
- Speaker turn boundaries
- Speaker-count accuracy
- Cluster consistency within a meeting
- Known-speaker naming accuracy
- Unknown-speaker decisions
- Simultaneous speech handling

Useful runtime diagnostics should include:

- Per-cluster duration and segment count
- Top speaker scores and score margins
- Enrollment example duration and quality
- Duplicate-example detection
- Whether a label came from trusted enrollment or an automatic observation

## Alternative Tools

### Pyannote Community-1

Pyannote Community-1 is a strong local pipeline with improved speaker assignment and counting compared with the older 3.1 pipeline. It requires a Python/PyTorch worker and a gated CC-BY-4.0 model download.

https://huggingface.co/pyannote/speaker-diarization-community-1

### NVIDIA NeMo Sortformer

NeMo Sortformer provides end-to-end speaker timing and support for simultaneous speakers. It is most appropriate if Olive gains a GPU-backed Python worker and can accept the additional operational complexity.

https://docs.nvidia.com/nemo-framework/user-guide/latest/nemotoolkit/asr/speaker_diarization/models.html

### WeSpeaker neural embeddings

Replacing only the custom speaker vectors with a WeSpeaker ResNet34-LM ONNX model would be a smaller improvement. It would substantially improve cross-recording speaker representation, but it would not independently correct speech segmentation, cluster counting, or simultaneous-speaker handling.

https://github.com/wenet-e2e/wespeaker/blob/master/docs/pretrained.md

## Recommended Sequence

1. Disable automatic updates to trusted speaker vectors.
2. Remove duplicate and unsuitable enrollment examples, then rebuild profiles.
3. Integrate Sherpa-ONNX diarization and a trained speaker embedding model.
4. Store multiple trusted examples per speaker with quality metadata.
5. Add score margins, `Unknown`, global assignment, candidate rosters, and expected speaker counts.
6. Add a real-audio evaluation set before tuning thresholds.

Adding more clips or tuning the current `0.85` thresholds will not materially improve the existing pipeline while the representation, enrollment data, and automatic update loop remain unchanged.
