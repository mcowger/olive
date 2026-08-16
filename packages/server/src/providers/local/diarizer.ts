import type { LocalDiarizerConfig, LocalSpeakerSegment, VoiceprintVector } from "./types.ts";
import { cosineSimilarity, type SpeakerEmbeddingExtractorInterface } from "./embedding.ts";

export interface DiarizerInterface {
  diarize(samples: Float32Array, sampleRate: number): Promise<LocalSpeakerSegment[]>;
}

export class LocalSpeakerDiarizer implements DiarizerInterface {
  private readonly embeddingExtractor: SpeakerEmbeddingExtractorInterface;
  private readonly config: Required<LocalDiarizerConfig>;

  constructor(
    embeddingExtractor: SpeakerEmbeddingExtractorInterface,
    config: LocalDiarizerConfig = {}
  ) {
    this.embeddingExtractor = embeddingExtractor;
    this.config = {
      frameSizeMs: config.frameSizeMs ?? 30,
      frameShiftMs: config.frameShiftMs ?? 15,
      energyThreshold: config.energyThreshold ?? 0.005,
      minSpeechDurationMs: config.minSpeechDurationMs ?? 300,
      minSilenceDurationMs: config.minSilenceDurationMs ?? 300,
      clusteringThreshold: config.clusteringThreshold ?? 0.60
    };
  }

  async diarize(samples: Float32Array, sampleRate = 16000): Promise<LocalSpeakerSegment[]> {
    if (samples.length === 0) {
      return [];
    }

    const totalDurationMs = Math.round((samples.length / sampleRate) * 1000);

    // 1. Voice Activity Detection (VAD) to find speech intervals
    const rawSpeechIntervals = this.detectSpeechIntervals(samples, sampleRate);

    if (rawSpeechIntervals.length === 0) {
      // If VAD detected nothing but audio has length, fallback to single whole chunk
      const emb = await this.embeddingExtractor.extract(samples, sampleRate);
      return [
        {
          startMs: 0,
          endMs: totalDurationMs,
          speakerId: "Speaker 1",
          samples,
          embedding: emb
        }
      ];
    }

    // 2. Extract embeddings for each detected speech interval
    const candidateSegments: Array<{
      startMs: number;
      endMs: number;
      samples: Float32Array;
      embedding: VoiceprintVector;
      clusterId: number;
    }> = [];

    for (const interval of rawSpeechIntervals) {
      const startSample = Math.floor((interval.startMs / 1000) * sampleRate);
      const endSample = Math.min(samples.length, Math.floor((interval.endMs / 1000) * sampleRate));
      const segmentSamples = samples.subarray(startSample, endSample);

      if (segmentSamples.length < Math.floor(sampleRate * 0.2)) {
        continue; // Skip segments under 200ms
      }

      const embedding = await this.embeddingExtractor.extract(segmentSamples, sampleRate);
      candidateSegments.push({
        startMs: interval.startMs,
        endMs: interval.endMs,
        samples: segmentSamples,
        embedding,
        clusterId: -1
      });
    }

    if (candidateSegments.length === 0) {
      const emb = await this.embeddingExtractor.extract(samples, sampleRate);
      return [
        {
          startMs: 0,
          endMs: totalDurationMs,
          speakerId: "Speaker 1",
          samples,
          embedding: emb
        }
      ];
    }

    // 3. Cluster speech segments by embedding similarity within the recording
    let nextClusterId = 1;
    for (let i = 0; i < candidateSegments.length; i++) {
      if (candidateSegments[i].clusterId !== -1) continue;

      candidateSegments[i].clusterId = nextClusterId;

      for (let j = i + 1; j < candidateSegments.length; j++) {
        if (candidateSegments[j].clusterId !== -1) continue;

        const sim = cosineSimilarity(
          candidateSegments[i].embedding,
          candidateSegments[j].embedding
        );

        if (sim >= this.config.clusteringThreshold) {
          candidateSegments[j].clusterId = nextClusterId;
        }
      }

      nextClusterId++;
    }

    // 4. Merge adjacent segments from the SAME speaker if the silence gap is small (< 400ms)
    const mergedSegments: LocalSpeakerSegment[] = [];
    let current = candidateSegments[0];

    for (let i = 1; i < candidateSegments.length; i++) {
      const next = candidateSegments[i];
      const gapMs = next.startMs - current.endMs;

      if (next.clusterId === current.clusterId && gapMs <= 400) {
        // Extend current segment
        current.endMs = next.endMs;
        const startSample = Math.floor((current.startMs / 1000) * sampleRate);
        const endSample = Math.min(samples.length, Math.floor((current.endMs / 1000) * sampleRate));
        current.samples = samples.subarray(startSample, endSample);
      } else {
        mergedSegments.push({
          startMs: current.startMs,
          endMs: current.endMs,
          speakerId: `Speaker ${current.clusterId}`,
          samples: current.samples,
          embedding: current.embedding
        });
        current = next;
      }
    }

    mergedSegments.push({
      startMs: current.startMs,
      endMs: current.endMs,
      speakerId: `Speaker ${current.clusterId}`,
      samples: current.samples,
      embedding: current.embedding
    });

    return mergedSegments;
  }

  private detectSpeechIntervals(
    samples: Float32Array,
    sampleRate: number
  ): Array<{ startMs: number; endMs: number }> {
    const frameSize = Math.floor((this.config.frameSizeMs / 1000) * sampleRate);
    const frameShift = Math.floor((this.config.frameShiftMs / 1000) * sampleRate);
    const numFrames = Math.floor((samples.length - frameSize) / frameShift);

    if (numFrames <= 0) {
      return [{ startMs: 0, endMs: Math.round((samples.length / sampleRate) * 1000) }];
    }

    const frameEnergies = new Float32Array(numFrames);
    let avgEnergy = 0;

    for (let f = 0; f < numFrames; f++) {
      const start = f * frameShift;
      let energy = 0;
      for (let i = 0; i < frameSize; i++) {
        const s = samples[start + i];
        energy += s * s;
      }
      energy = energy / frameSize;
      frameEnergies[f] = energy;
      avgEnergy += energy;
    }
    avgEnergy /= numFrames;

    const threshold = Math.max(this.config.energyThreshold, avgEnergy * 0.4);

    const intervals: Array<{ startMs: number; endMs: number }> = [];
    let inSpeech = false;
    let speechStartMs = 0;
    let silenceStartMs = 0;

    for (let f = 0; f < numFrames; f++) {
      const currentMs = Math.round(((f * frameShift) / sampleRate) * 1000);
      const isSpeechFrame = frameEnergies[f] >= threshold;

      if (!inSpeech && isSpeechFrame) {
        inSpeech = true;
        speechStartMs = currentMs;
        silenceStartMs = 0;
      } else if (inSpeech && !isSpeechFrame) {
        if (silenceStartMs === 0) {
          silenceStartMs = currentMs;
        } else if (currentMs - silenceStartMs >= this.config.minSilenceDurationMs) {
          const duration = silenceStartMs - speechStartMs;
          if (duration >= this.config.minSpeechDurationMs) {
            intervals.push({ startMs: speechStartMs, endMs: silenceStartMs });
          }
          inSpeech = false;
          silenceStartMs = 0;
        }
      } else if (inSpeech && isSpeechFrame) {
        silenceStartMs = 0;
      }
    }

    if (inSpeech) {
      const endMs = Math.round((samples.length / sampleRate) * 1000);
      if (endMs - speechStartMs >= this.config.minSpeechDurationMs) {
        intervals.push({ startMs: speechStartMs, endMs });
      }
    }

    return intervals;
  }
}
