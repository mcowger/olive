# Diarization Assessment & Improvement Plan

## Current State & Issues
The current local transcription pipeline uses a two-stage approach for diarization:
1. **Blind Diarization:** Uses energy-based Voice Activity Detection (VAD) to split audio, then a greedy clustering algorithm groups segments based on cosine similarity of their embeddings.
2. **Profile Tagging:** The pipeline compares the first segment of an anonymous cluster against known speaker profiles and permanently tags the cluster based on that first match.

### Root Causes of Misidentification
1. **MFCC Embedding Model:** The `AcousticFeatureEmbeddingExtractor` uses Mel-Frequency Cepstral Coefficients (MFCCs). MFCCs capture the acoustic environment (mic, room echo, noise) as much as the voice. Similar environments lead to high cosine similarity even across different voices.
2. **"First-Segment" Tagging Trap:** A cluster is tagged based on its *very first* segment. If this segment is short or noisy and spuriously matches a profile, the whole cluster is locked to that wrong speaker.
3. **Profile Drift (Runaway EMA):** When a match is found, the system updates the enrolled profile's centroid. Spurious matches cause the stored profiles to be actively overwritten with the wrong voice, creating a feedback loop of misidentification.
4. **Naive VAD:** The energy-based VAD captures non-speech noises (breathing, keyboard clicks), generating garbage embeddings that confuse the clustering.

## Options for Improvement (High to Low Priority)

### 1. Replace MFCCs with a Neural Speaker Embedding Model (Highest Impact)
Swap `AcousticFeatureEmbeddingExtractor` for a deep learning-based embedding model. Run a lightweight ONNX model for speaker verification (e.g., `ECAPA-TDNN` or `x-vectors` via SpeechBrain). These models are trained explicitly to isolate the biometric voiceprint and ignore the acoustic environment.

### 2. Change the Pipeline Tagging Logic (High Impact, Low Effort)
Instead of tagging based on the first segment:
- Run the blind clustering first.
- Compute the average embedding (centroid) for *all* audio assigned to a cluster.
- Compare that robust, averaged centroid to the enrolled profiles.
This prevents a single noisy segment from misidentifying an entire conversational turn.

### 3. Disable or Gate Dynamic Centroid Updates (High Impact, Low Effort)
Prevent "profile drift" by:
- Disabling `updateVoiceprintCentroid` entirely during inference so stored profiles remain pure.
- OR only updating the centroid if the cosine similarity is *extremely* high (e.g., `> 0.95`).

### 4. Implement a Neural VAD
Replace the energy-based VAD with a lightweight neural VAD (like Silero VAD via ONNX) to ensure the embedding extractor only processes actual human speech, drastically improving cluster quality.
