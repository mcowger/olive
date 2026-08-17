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
 * Uses IBM Granite Speech, Qwen3-ASR (via llama-server), or Cohere Transcribe ONNX.
 */
export class TransformersAsrEngine implements LocalAsrEngineInterface {
  private readonly config: LocalAsrConfig;
  private readonly graniteCache = new Map<string, { processor: any; model: any }>();
  private readonly pipelineCache = new Map<string, any>();
  private initPromise: Promise<any> | null = null;

  constructor(config: LocalAsrConfig = {}) {
    this.config = {
      modelId: config.modelId ?? "onnx-community/granite-4.0-1b-speech-ONNX",
      dtype: config.dtype ?? "q4",
      device: config.device ?? "cpu",
      language: config.language ?? "en"
    };
  }

  private isGraniteModel(modelId: string): boolean {
    return Boolean(modelId.toLowerCase().includes("granite"));
  }

  private isQwenModel(modelId: string): boolean {
    return Boolean(modelId.toLowerCase().includes("qwen"));
  }

  async getEngineForModel(modelId: string): Promise<any> {
    if (this.isGraniteModel(modelId)) {
      const cached = this.graniteCache.get(modelId);
      if (cached) return { isGranite: true, ...cached };
    } else {
      const cached = this.pipelineCache.get(modelId);
      if (cached) return { isGranite: false, pipeline: cached };
    }

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

      if (this.isGraniteModel(modelId)) {
        const processorClass = (hf as any).GraniteSpeechProcessor || (hf as any).AutoProcessor;
        const modelClass = (hf as any).GraniteSpeechForConditionalGeneration || (hf as any).AutoModelForSpeechSeq2Seq;

        const processor = await processorClass.from_pretrained(modelId);
        logger.info(`Loading Granite Speech ASR model on CPU`, {
          modelId,
          device: "cpu",
          dtype: this.config.dtype
        });
        const model = await modelClass.from_pretrained(modelId, {
          dtype: {
            embed_tokens: this.config.dtype ?? "q4",
            audio_encoder: this.config.dtype ?? "q4",
            decoder_model_merged: this.config.dtype ?? "q4"
          },
          device: "cpu"
        });

        const entry = { processor, model };
        this.graniteCache.set(modelId, entry);
        return { isGranite: true, ...entry };
      } else {
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
        return { isGranite: false, pipeline: pipelineInstance };
      }
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

    const modelId = options.modelId || this.config.modelId || "onnx-community/granite-4.0-1b-speech-ONNX";

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
      const engine = await this.getEngineForModel(modelId);
      const baseStartMs = options.startMs ?? 0;

      if (engine.isGranite) {
        const { processor, model } = engine as { processor: any; model: any };

        const messages = [
          {
            role: "user",
            content: "<|audio|>transcribe the speech into a written format?"
          }
        ];
        const textPrompt = processor.apply_chat_template(messages, {
          add_generation_prompt: false,
          tokenize: false
        });

        const inputs = await processor(textPrompt, samples);
        const generatedIds = await model.generate({
          ...inputs,
          max_new_tokens: 512
        });

        const inputLen = inputs.input_ids.dims?.at(-1) ?? 0;
        const generatedTexts = processor.batch_decode(
          generatedIds.slice(null, [inputLen, null]),
          { skip_special_tokens: true }
        );

        const text = (generatedTexts[0] || "").trim();
        const durationMs = Math.round((samples.length / sampleRate) * 1000);
        const wordList = text.split(/\s+/).filter(Boolean);
        const wordDuration = Math.floor(durationMs / Math.max(1, wordList.length));

        const words: TranscriptWord[] = wordList.map((w: string, idx: number) => ({
          word: w,
          startMs: baseStartMs + idx * wordDuration,
          endMs: baseStartMs + (idx + 1) * wordDuration
        }));

        return { text, words };
      }

      const transcriber = (engine as { pipeline: any }).pipeline;
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
