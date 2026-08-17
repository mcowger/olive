import { cpus } from "node:os";
import type { LocalDiarizerConfig, LocalSpeakerSegment, VoiceprintVector } from "./types.ts";
import { type SpeakerEmbeddingExtractorInterface, normalizeVector } from "./embedding.ts";
import { ensureSherpaModels, getSherpaOnnx } from "./sherpa-runtime.ts";

function getDefaultDiarizerThreads(): number {
  if (process.env.OLIVE_DIARIZATION_THREADS) {
    const parsed = Number(process.env.OLIVE_DIARIZATION_THREADS);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  const numCores = cpus()?.length ?? 4;
  return Math.max(2, Math.min(8, Math.floor(numCores / 2)));
}

export interface DiarizerInterface {
  diarize(
    samples: Float32Array,
    sampleRate?: number,
    clusteringThresholdOverride?: number,
    expectedSpeakerCount?: number
  ): Promise<LocalSpeakerSegment[]>;
}

export interface SherpaDiarizerConfig extends LocalDiarizerConfig {
  segmentationModelPath?: string;
  embeddingModelPath?: string;
  numThreads?: number;
  minDurationOn?: number;
  minDurationOff?: number;
}

/**
 * Neural speaker diarizer powered by Sherpa-ONNX (Pyannote segmentation + ERes2Net embeddings + FastClustering).
 */
export class SherpaSpeakerDiarizer implements DiarizerInterface {
  private readonly embeddingExtractor: SpeakerEmbeddingExtractorInterface;
  private readonly config: SherpaDiarizerConfig;
  private sherpaDiarizerInstance: any = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    embeddingExtractor: SpeakerEmbeddingExtractorInterface,
    config: SherpaDiarizerConfig = {}
  ) {
    this.embeddingExtractor = embeddingExtractor;
    this.config = {
      clusteringThreshold: config.clusteringThreshold ?? 0.5,
      numThreads: config.numThreads ?? getDefaultDiarizerThreads(),
      minDurationOn: config.minDurationOn ?? 0.3,
      minDurationOff: config.minDurationOff ?? 0.5,
      ...config
    };
  }

  private async ensureInitialized(numClusters?: number, thresholdOverride?: number): Promise<any> {
    const sherpa = await getSherpaOnnx();
    let segPath = this.config.segmentationModelPath;
    let embPath = this.config.embeddingModelPath;

    if (!segPath || !embPath) {
      const paths = await ensureSherpaModels();
      segPath = segPath || paths.segmentationModelPath;
      embPath = embPath || paths.embeddingModelPath;
    }

    const numC = numClusters && numClusters > 0 ? numClusters : -1;
    const thresh = thresholdOverride ?? this.config.clusteringThreshold ?? 0.5;

    const diarizerConfig: any = {
      segmentation: {
        pyannote: {
          model: segPath
        },
        numThreads: this.config.numThreads,
        debug: false
      },
      embedding: {
        model: embPath,
        numThreads: this.config.numThreads,
        debug: false
      },
      clustering: {
        numClusters: numC,
        threshold: thresh
      },
      minDurationOn: this.config.minDurationOn,
      minDurationOff: this.config.minDurationOff
    };

    return new sherpa.OfflineSpeakerDiarization(diarizerConfig);
  }

  async diarize(
    samples: Float32Array,
    sampleRate = 16000,
    clusteringThresholdOverride?: number,
    expectedSpeakerCount?: number
  ): Promise<LocalSpeakerSegment[]> {
    if (samples.length === 0) {
      return [];
    }

    const totalDurationMs = Math.round((samples.length / sampleRate) * 1000);

    // 1. Run neural speaker diarization
    let rawSegments: Array<{ start: number; end: number; speaker: number }> = [];
    try {
      const diarizerInstance = await this.ensureInitialized(
        expectedSpeakerCount,
        clusteringThresholdOverride
      );
      rawSegments = diarizerInstance.process(samples) || [];
    } catch {
      rawSegments = [];
    }

    // 2. If no segments found, fallback to single whole chunk
    if (rawSegments.length === 0) {
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

    // 3. Extract embeddings for each detected speech interval and build candidate segments
    const candidateSegments: LocalSpeakerSegment[] = [];

    for (const raw of rawSegments) {
      const startMs = Math.round(raw.start * 1000);
      const endMs = Math.round(raw.end * 1000);
      const startSample = Math.max(0, Math.floor(raw.start * sampleRate));
      const endSample = Math.min(samples.length, Math.ceil(raw.end * sampleRate));

      if (endSample <= startSample) continue;

      const segmentSamples = samples.subarray(startSample, endSample);
      const embedding = await this.embeddingExtractor.extract(segmentSamples, sampleRate);

      candidateSegments.push({
        startMs,
        endMs,
        speakerId: `Speaker ${raw.speaker + 1}`,
        samples: segmentSamples,
        embedding
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

    // 4. Sort segments chronologically
    candidateSegments.sort((a, b) => a.startMs - b.startMs);

    // 5. Merge adjacent segments from the SAME speaker if the gap is small (<= 1500ms)
    const mergedSegments: LocalSpeakerSegment[] = [];
    let current = candidateSegments[0];

    for (let i = 1; i < candidateSegments.length; i++) {
      const next = candidateSegments[i];
      const gapMs = next.startMs - current.endMs;

      if (next.speakerId === current.speakerId && gapMs <= 1500 && gapMs >= 0) {
        // Extend current segment
        current.endMs = Math.max(current.endMs, next.endMs);
        const startSample = Math.floor((current.startMs / 1000) * sampleRate);
        const endSample = Math.min(samples.length, Math.floor((current.endMs / 1000) * sampleRate));
        current.samples = samples.subarray(startSample, endSample);
      } else {
        mergedSegments.push(current);
        current = next;
      }
    }

    mergedSegments.push(current);
    return mergedSegments;
  }
}

/**
 * Backward compatibility alias for local diarizer.
 */
export { SherpaSpeakerDiarizer as LocalSpeakerDiarizer };
