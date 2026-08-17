import type { TranscriptWord } from "@olive/shared";
import { logger } from "../../logger.ts";
import { LlamaServerManager } from "./llama-server.ts";
import type { LocalAsrConfig } from "./types.ts";

export interface LocalAsrEngineInterface {
  transcribeSegment(
    samples: Float32Array,
    sampleRate: number,
    options?: { language?: string; startMs?: number; strict?: boolean; modelId?: string }
  ): Promise<{ text: string; words?: TranscriptWord[] }>;
}

/**
 * HuggingFace Transformers.js & Llama.cpp based local ASR engine running on CPU or Vulkan.
 * Uses Qwen3-ASR (via llama-server) or Cohere Transcribe ONNX.
 */
export class TransformersAsrEngine implements LocalAsrEngineInterface {
  private readonly config: LocalAsrConfig;
  private readonly pipelineCache = new Map<string, any>();
  private initPromise: Promise<any> | null = null;

  constructor(config: LocalAsrConfig = {}) {
    this.config = {
      modelId: config.modelId ?? "onnx-community/cohere-transcribe-03-2026-ONNX",
      dtype: config.dtype ?? "q4",
      device: config.device ?? "cpu",
      language: config.language ?? "en"
    };
  }

  private isQwenModel(modelId: string): boolean {
    return Boolean(modelId.toLowerCase().includes("qwen"));
  }

  async getEngineForModel(modelId: string): Promise<any> {
    const cached = this.pipelineCache.get(modelId);
    if (cached) return cached;

    if (this.initPromise) {
      await this.initPromise;
      return this.getEngineForModel(modelId);
    }

    let resolveInit: (val: any) => void;
    this.initPromise = new Promise((res) => {
      resolveInit = res;
    });

    try {
      const hf = await import("@huggingface/transformers");
      if (process.env.TRANSFORMERS_CACHE || process.env.HF_HOME) {
        hf.env.cacheDir = process.env.TRANSFORMERS_CACHE || process.env.HF_HOME || null;
      }

      logger.info(`Loading ASR pipeline model on CPU`, {
        modelId,
        device: "cpu",
        dtype: this.config.dtype
      });
      const pipelineInstance = await hf.pipeline(
        "automatic-speech-recognition",
        modelId,
        {
          dtype: this.config.dtype,
          device: "cpu"
        }
      );

      this.pipelineCache.set(modelId, pipelineInstance);
      return pipelineInstance;
    } finally {
      this.initPromise = null;
      resolveInit!(true);
    }
  }

  async transcribeSegment(
    samples: Float32Array,
    sampleRate = 16000,
    options: { language?: string; startMs?: number; strict?: boolean; modelId?: string } = {}
  ): Promise<{ text: string; words?: TranscriptWord[] }> {
    if (samples.length === 0) {
      return { text: "" };
    }

    const modelId = options.modelId || this.config.modelId || "onnx-community/cohere-transcribe-03-2026-ONNX";

    if (modelId === "mock" || modelId === "mock-asr") {
      const baseStartMs = options.startMs ?? 0;
      const durationMs = Math.round((samples.length / sampleRate) * 1000);
      return {
        text: "Transcribed speech",
        words: [
          { word: "Transcribed", startMs: baseStartMs, endMs: baseStartMs + Math.floor(durationMs / 2) },
          { word: "speech", startMs: baseStartMs + Math.floor(durationMs / 2), endMs: baseStartMs + durationMs }
        ]
      };
    }

    // Dispatch Qwen models to supervised llama-server
    if (this.isQwenModel(modelId)) {
      try {
        return await LlamaServerManager.getInstance().transcribeSegment(samples, sampleRate, options);
      } catch (err) {
        if (options.strict) throw err;
        logger.warn("Qwen transcription encountered fallback", { error: String(err) });
        return {
          text: `[Audio segment (${Math.round((samples.length / sampleRate) * 1000)}ms)]`
        };
      }
    }

    try {
      const transcriber = await this.getEngineForModel(modelId);
      const baseStartMs = options.startMs ?? 0;

      const output = await transcriber(samples, {
        language: options.language || this.config.language || "en",
        max_new_tokens: 512,
        return_timestamps: "word"
      });

      const text = (output?.text || "").trim();
      let words: TranscriptWord[] | undefined;

      if (Array.isArray(output?.chunks)) {
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
      logger.warn("Segment transcription encountered fallback", { error: String(err) });
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
