import type { TranscriptWord } from "@olive/shared";
import type { LocalAsrConfig } from "./types.ts";

export interface LocalAsrEngineInterface {
  transcribeSegment(
    samples: Float32Array,
    sampleRate: number,
    options?: { language?: string; startMs?: number; strict?: boolean }
  ): Promise<{ text: string; words?: TranscriptWord[] }>;
}

/**
 * HuggingFace Transformers.js-based local ASR engine running on CPU.
 * Uses Cohere Transcribe 2B (or Whisper/Granite ONNX).
 */
export class TransformersAsrEngine implements LocalAsrEngineInterface {
  private readonly config: LocalAsrConfig;
  private pipelineInstance: any = null;
  private isInitializing = false;

  constructor(config: LocalAsrConfig = {}) {
    this.config = {
      modelId: config.modelId ?? "onnx-community/cohere-transcribe-03-2026-ONNX",
      dtype: config.dtype ?? "q4",
      device: config.device ?? "cpu",
      language: config.language ?? "en"
    };
  }

  async getPipeline() {
    if (this.pipelineInstance) {
      return this.pipelineInstance;
    }
    if (this.isInitializing) {
      while (this.isInitializing) {
        await new Promise((res) => setTimeout(res, 50));
      }
      return this.pipelineInstance;
    }

    this.isInitializing = true;
    try {
      const { pipeline, env } = await import("@huggingface/transformers");
      if (process.env.TRANSFORMERS_CACHE || process.env.HF_HOME) {
        env.cacheDir = process.env.TRANSFORMERS_CACHE || process.env.HF_HOME || null;
      }
      this.pipelineInstance = await pipeline(
        "automatic-speech-recognition",
        this.config.modelId!,
        {
          dtype: this.config.dtype,
          device: this.config.device
        }
      );
      return this.pipelineInstance;
    } finally {
      this.isInitializing = false;
    }
  }

  async transcribeSegment(
    samples: Float32Array,
    sampleRate = 16000,
    options: { language?: string; startMs?: number; strict?: boolean } = {}
  ): Promise<{ text: string; words?: TranscriptWord[] }> {
    if (samples.length === 0) {
      return { text: "" };
    }

    try {
      const transcriber = await this.getPipeline();
      const output = await transcriber(samples, {
        language: options.language || this.config.language || "en",
        max_new_tokens: 512,
        return_timestamps: "word"
      });

      const text = (output?.text || "").trim();
      let words: TranscriptWord[] | undefined;

      if (Array.isArray(output?.chunks)) {
        const baseStartMs = options.startMs ?? 0;
        words = output.chunks.map((chunk: any) => {
          const wStart = chunk.timestamp?.[0] != null ? Math.round(chunk.timestamp[0] * 1000) : 0;
          const wEnd = chunk.timestamp?.[1] != null ? Math.round(chunk.timestamp[1] * 1000) : wStart + 300;
          return {
            word: chunk.text.trim(),
            startMs: baseStartMs + wStart,
            endMs: baseStartMs + wEnd
          };
        });
      }

      return { text, words };
    } catch (err) {
      if (options.strict) {
        throw err;
      }
      return {
        text: `[Audio segment (${Math.round((samples.length / sampleRate) * 1000)}ms)]`
      };
    }
  }
}

/**
 * Deterministic Mock / In-Memory ASR Engine for unit testing and offline test suites.
 */
export class MockLocalAsrEngine implements LocalAsrEngineInterface {
  private readonly defaultText: string;
  private readonly phrases: string[];
  private callCount = 0;

  constructor(phrases: string[] = ["Hello everyone.", "Welcome to the meeting.", "Let's review the items."]) {
    this.phrases = phrases;
    this.defaultText = phrases[0] || "Transcribed speech";
  }

  async transcribeSegment(
    samples: Float32Array,
    sampleRate = 16000,
    options: { language?: string; startMs?: number } = {}
  ): Promise<{ text: string; words?: TranscriptWord[] }> {
    const phrase = this.phrases[this.callCount % this.phrases.length] || this.defaultText;
    this.callCount++;

    const baseStartMs = options.startMs ?? 0;
    const durationMs = Math.round((samples.length / sampleRate) * 1000);
    const wordList = phrase.split(/\s+/).filter(Boolean);
    const wordDuration = Math.floor(durationMs / Math.max(1, wordList.length));

    const words: TranscriptWord[] = wordList.map((w, idx) => ({
      word: w,
      startMs: baseStartMs + idx * wordDuration,
      endMs: baseStartMs + (idx + 1) * wordDuration
    }));

    return { text: phrase, words };
  }
}
