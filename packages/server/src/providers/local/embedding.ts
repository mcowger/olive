import type { VoiceprintVector } from "./types.ts";

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
 * Updates an existing speaker voiceprint centroid with a new embedding sample
 * using an Exponential Moving Average (EMA) and L2 normalization:
 *
 * centroid_new = normalize( alpha * centroid_old + (1 - alpha) * new_sample )
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
 * Speaker embedding extraction engine.
 * Computes fixed-dimensional voiceprint embeddings from 16kHz mono audio.
 */
export interface SpeakerEmbeddingExtractorInterface {
  readonly dim: number;
  extract(samples: Float32Array, sampleRate?: number): Promise<VoiceprintVector>;
}

/**
 * Standard acoustic filterbank & cepstral voiceprint extractor with
 * Cepstral Mean Normalization (CMN).
 * Computes 32 Mel-frequency filterbank energies, variance, and DCT cepstral
 * coefficients across speech frames to generate a normalized 192-dimensional voiceprint.
 */
export class AcousticFeatureEmbeddingExtractor implements SpeakerEmbeddingExtractorInterface {
  readonly dim: number;

  constructor(dim = 192) {
    this.dim = dim;
  }

  async extract(samples: Float32Array, sampleRate = 16000): Promise<VoiceprintVector> {
    if (samples.length === 0) {
      return new Array(this.dim).fill(0);
    }

    const frameSize = Math.floor(sampleRate * 0.025); // 25ms frame
    const frameHop = Math.floor(sampleRate * 0.010);  // 10ms hop
    const numFrames = Math.floor((samples.length - frameSize) / frameHop);

    if (numFrames <= 0) {
      return this.fallbackVector(samples);
    }

    const numFilters = 32;
    const filterEnergies: number[][] = Array.from({ length: numFilters }, () => []);

    // 32 Mel filter center frequencies from 100Hz to 7500Hz
    const minFreq = 100;
    const maxFreq = Math.min(sampleRate / 2, 7500);
    const minMel = 2595 * Math.log10(1 + minFreq / 700);
    const maxMel = 2595 * Math.log10(1 + maxFreq / 700);
    const melStep = (maxMel - minMel) / (numFilters + 1);

    const centerFreqs = new Float32Array(numFilters);
    for (let i = 0; i < numFilters; i++) {
      const mel = minMel + (i + 1) * melStep;
      centerFreqs[i] = 700 * (Math.pow(10, mel / 2595) - 1);
    }

    // Precomputed trigonometric tables
    const cosTable = Array.from({ length: numFilters }, (_, k) => {
      const w = (2 * Math.PI * centerFreqs[k]) / sampleRate;
      return new Float32Array(frameSize).map((_, i) => Math.cos(w * i));
    });
    const sinTable = Array.from({ length: numFilters }, (_, k) => {
      const w = (2 * Math.PI * centerFreqs[k]) / sampleRate;
      return new Float32Array(frameSize).map((_, i) => Math.sin(w * i));
    });

    // Hann window
    const window = new Float32Array(frameSize);
    for (let i = 0; i < frameSize; i++) {
      window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (frameSize - 1)));
    }

    for (let f = 0; f < numFrames; f++) {
      const start = f * frameHop;
      for (let k = 0; k < numFilters; k++) {
        let real = 0;
        let imag = 0;
        const cosT = cosTable[k];
        const sinT = sinTable[k];
        for (let i = 0; i < frameSize; i++) {
          const val = samples[start + i] * window[i];
          real += val * cosT[i];
          imag += val * sinT[i];
        }
        const power = real * real + imag * imag;
        filterEnergies[k].push(Math.log(1e-6 + power));
      }
    }

    // Filter means
    const filterMeans = new Float32Array(numFilters);
    let globalMean = 0;
    for (let k = 0; k < numFilters; k++) {
      let mean = 0;
      for (const v of filterEnergies[k]) mean += v;
      mean /= filterEnergies[k].length;
      filterMeans[k] = mean;
      globalMean += mean;
    }
    globalMean /= numFilters;

    // Cepstral Mean Normalization (CMN)
    const normalizedMeans = new Float32Array(numFilters);
    for (let k = 0; k < numFilters; k++) {
      normalizedMeans[k] = filterMeans[k] - globalMean;
    }

    const embedding = new Array<number>(this.dim).fill(0);
    for (let k = 0; k < numFilters; k++) {
      embedding[k] = normalizedMeans[k];

      let variance = 0;
      for (const v of filterEnergies[k]) {
        variance += (v - filterMeans[k]) * (v - filterMeans[k]);
      }
      embedding[k + numFilters] = Math.sqrt(variance / filterEnergies[k].length);
    }

    // Discrete Cosine Transform (DCT) coefficients (n = 1..32)
    for (let n = 1; n <= numFilters; n++) {
      let cepstrum = 0;
      for (let k = 0; k < numFilters; k++) {
        cepstrum += normalizedMeans[k] * Math.cos((Math.PI * n * (k + 0.5)) / numFilters);
      }
      embedding[n - 1 + numFilters * 2] = cepstrum;
    }

    return normalizeVector(embedding);
  }

  private fallbackVector(samples: Float32Array): VoiceprintVector {
    const vec = new Array<number>(this.dim).fill(0);
    for (let i = 0; i < samples.length; i++) {
      vec[i % this.dim] += samples[i];
    }
    return normalizeVector(vec);
  }
}
