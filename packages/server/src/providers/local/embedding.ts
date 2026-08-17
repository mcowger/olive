import type { VoiceprintVector } from "./types.ts";
import { ensureSherpaModels, getSherpaOnnx } from "./sherpa-runtime.ts";

/**
 * Computes the Euclidean norm (L2 norm) of a vector.
 */
export function l2Norm(vec: number[] | Float32Array): number {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    sum += vec[i] * vec[i];
  }
  return Math.sqrt(sum);
}

/**
 * Normalizes a vector to unit length (L2 norm = 1.0).
 */
export function normalizeVector(vec: number[] | Float32Array): VoiceprintVector {
  const norm = l2Norm(vec);
  if (norm === 0 || !Number.isFinite(norm)) {
    return new Array(vec.length).fill(0);
  }
  const result = new Array<number>(vec.length);
  for (let i = 0; i < vec.length; i++) {
    result[i] = vec[i] / norm;
  }
  return result;
}

/**
 * Computes the cosine similarity between two normalized or unnormalized vectors.
 * Returns a value between -1.0 and 1.0.
 */
export function cosineSimilarity(
  a: number[] | Float32Array | null | undefined,
  b: number[] | Float32Array | null | undefined
): number {
  if (!a || !b || a.length === 0 || b.length === 0) {
    return 0;
  }

  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0 || !Number.isFinite(denom)) {
    return 0;
  }

  return Math.max(-1.0, Math.min(1.0, dot / denom));
}

/**
 * Scores a query vector against an array of trusted speaker vectors.
 * Returns the maximum cosine similarity (or 0 if no vectors).
 */
export function scoreAgainstTrustedVectors(
  query: number[] | Float32Array | null | undefined,
  trustedVectors: VoiceprintVector[]
): number {
  if (!query || !trustedVectors || trustedVectors.length === 0) {
    return 0;
  }

  let maxSim = -1.0;
  for (const vec of trustedVectors) {
    const sim = cosineSimilarity(query, vec);
    if (sim > maxSim) {
      maxSim = sim;
    }
  }

  return Math.max(-1.0, maxSim);
}

/**
 * Updates an existing speaker voiceprint centroid with a new embedding sample
 * using an Exponential Moving Average (EMA) and L2 normalization.
 * Note: Automatic inference must not mutate enrolled profiles; this is kept for utility only.
 */
export function updateVoiceprintCentroid(
  existingCentroid: VoiceprintVector,
  newSample: VoiceprintVector,
  alpha = 0.85
): VoiceprintVector {
  if (!existingCentroid || existingCentroid.length === 0) {
    return normalizeVector(newSample);
  }
  if (!newSample || newSample.length === 0) {
    return existingCentroid;
  }

  const length = Math.min(existingCentroid.length, newSample.length);
  const updated = new Array<number>(length);

  for (let i = 0; i < length; i++) {
    updated[i] = alpha * existingCentroid[i] + (1 - alpha) * newSample[i];
  }

  return normalizeVector(updated);
}

/**
 * Computes the average centroid from multiple voiceprint vectors and normalizes it.
 */
export function mergeVoiceprintVectors(vectors: VoiceprintVector[]): VoiceprintVector {
  if (vectors.length === 0) {
    return [];
  }
  if (vectors.length === 1) {
    return normalizeVector(vectors[0]);
  }

  const dim = vectors[0].length;
  const sum = new Array<number>(dim).fill(0);

  for (const v of vectors) {
    const len = Math.min(dim, v.length);
    for (let i = 0; i < len; i++) {
      sum[i] += v[i];
    }
  }

  return normalizeVector(sum);
}

/**
 * Computes a weighted centroid from multiple voiceprint vectors (e.g. weighted by segment duration)
 * and normalizes the resulting vector to unit length.
 */
export function mergeWeightedVoiceprintVectors(
  entries: Array<{ vector: VoiceprintVector; weight: number }>
): VoiceprintVector {
  const valid = entries.filter((e) => e.vector && e.vector.length > 0 && e.weight > 0);
  if (valid.length === 0) {
    return [];
  }
  if (valid.length === 1) {
    return normalizeVector(valid[0].vector);
  }

  const dim = valid[0].vector.length;
  const sum = new Array<number>(dim).fill(0);

  for (const { vector, weight } of valid) {
    const len = Math.min(dim, vector.length);
    for (let i = 0; i < len; i++) {
      sum[i] += vector[i] * weight;
    }
  }

  return normalizeVector(sum);
}

/**
 * Speaker embedding extraction engine interface.
 * Computes fixed-dimensional voiceprint embeddings from 16kHz mono audio.
 */
export interface SpeakerEmbeddingExtractorInterface {
  readonly dim: number;
  extract(samples: Float32Array, sampleRate?: number): Promise<VoiceprintVector>;
}

/**
 * Deep learning-based neural speaker embedding extractor using Sherpa-ONNX
 * (e.g. 3D-Speaker ERes2Net, WeSpeaker, or NeMo TitaNet).
 */
export class SherpaSpeakerEmbeddingExtractor implements SpeakerEmbeddingExtractorInterface {
  private extractorInstance: any = null;
  private initPromise: Promise<void> | null = null;
  private modelPath: string | null = null;
  private _dim = 512;
  private readonly numThreads: number;

  constructor(options: { modelPath?: string; numThreads?: number } | number = {}) {
    if (typeof options === "number") {
      this.modelPath = null;
      this.numThreads = 2;
      this._dim = options;
    } else {
      this.modelPath = options.modelPath ?? null;
      this.numThreads = options.numThreads ?? 2;
    }
  }

  get dim(): number {
    return this._dim;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.extractorInstance) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const sherpa = await getSherpaOnnx();
      let model = this.modelPath;
      if (!model) {
        const paths = await ensureSherpaModels();
        model = paths.embeddingModelPath;
        this.modelPath = model;
      }

      this.extractorInstance = new sherpa.SpeakerEmbeddingExtractor({
        model,
        numThreads: this.numThreads,
        debug: false
      });

      this._dim = this.extractorInstance.dim ?? 512;
    })();

    await this.initPromise;
  }

  async extract(samples: Float32Array, sampleRate = 16000): Promise<VoiceprintVector> {
    if (samples.length === 0) {
      return new Array(this._dim).fill(0);
    }

    await this.ensureInitialized();

    try {
      const stream = this.extractorInstance.createStream();
      stream.acceptWaveform({ sampleRate, samples });
      stream.inputFinished();

      if (this.extractorInstance.isReady(stream)) {
        const rawEmb = this.extractorInstance.compute(stream);
        return normalizeVector(rawEmb);
      }

      return new Array(this._dim).fill(0);
    } catch {
      return new Array(this._dim).fill(0);
    }
  }
}

/**
 * Default alias for speaker embedding extractor.
 */
export { SherpaSpeakerEmbeddingExtractor as AcousticFeatureEmbeddingExtractor };
