import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cpus } from "node:os";
import type { TranscriptWord } from "@olive/shared";
import { logger } from "../../logger.ts";
import { encodeWav } from "./wav.ts";

export interface LlamaServerOptions {
  binPath?: string;
  modelRepo?: string;
  port?: number;
  host?: string;
  gpuLayers?: number;
  threads?: number;
  contextSize?: number;
}

export class LlamaServerManager {
  private static instance: LlamaServerManager | null = null;
  private process: ChildProcess | null = null;
  private isStarting = false;
  private startPromise: Promise<boolean> | null = null;
  private readonly port: number;
  private readonly host: string;
  private readonly modelRepo: string;
  private readonly gpuLayers: number;
  private readonly threads: number;
  private readonly contextSize: number;

  constructor(options: LlamaServerOptions = {}) {
    this.port = options.port ?? Number(process.env.LLAMA_SERVER_PORT || 18090);
    this.host = options.host ?? "127.0.0.1";
    this.modelRepo = options.modelRepo ?? process.env.LLAMA_MODEL_REPO ?? "ggml-org/Qwen3-ASR-1.7B-GGUF";
    this.gpuLayers = options.gpuLayers ?? (existsSync("/dev/dri") ? 99 : 0);
    const numCores = cpus()?.length ?? 4;
    const defaultThreads = Math.max(1, Math.min(8, numCores > 2 ? numCores - 2 : numCores));
    this.threads = options.threads ?? (process.env.LLAMA_THREADS ? Number(process.env.LLAMA_THREADS) : defaultThreads);
    this.contextSize = options.contextSize ?? 4096;

    // Register cleanup on process exit
    const cleanup = () => this.stop();
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }

  static getInstance(): LlamaServerManager {
    if (!LlamaServerManager.instance) {
      LlamaServerManager.instance = new LlamaServerManager();
    }
    return LlamaServerManager.instance;
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  private findLlamaServerBin(): string | null {
    if (process.env.LLAMA_SERVER_BIN && existsSync(process.env.LLAMA_SERVER_BIN)) {
      return process.env.LLAMA_SERVER_BIN;
    }

    const candidatePaths = [
      "/usr/local/llama/llama-server",
      "/usr/local/bin/llama-server",
      "/tmp/opencode/llama-vulkan/llama-b10453/llama-server",
      "/tmp/opencode/llama/llama-b10453/llama-server"
    ];

    for (const p of candidatePaths) {
      if (existsSync(p)) {
        return p;
      }
    }

    return null;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return false;
      const data = (await res.json().catch(() => ({}))) as { status?: string };
      return data.status === "ok" || data.status === "loading model";
    } catch {
      return false;
    }
  }

  async ensureRunning(): Promise<boolean> {
    if (await this.isHealthy()) {
      return true;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.start();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async start(): Promise<boolean> {
    const bin = this.findLlamaServerBin();
    if (!bin) {
      logger.warn("llama-server binary not found on system. Qwen3-ASR GGUF execution unavailable.");
      return false;
    }

    logger.info("Starting llama-server for Qwen3-ASR...", {
      bin,
      modelRepo: this.modelRepo,
      port: this.port,
      gpuLayers: this.gpuLayers
    });

    const args = [
      "-hf", this.modelRepo,
      "--port", String(this.port),
      "--host", this.host,
      "-c", String(this.contextSize),
      "-t", String(this.threads)
    ];

    if (this.gpuLayers > 0) {
      args.push("-ngl", String(this.gpuLayers));
    }

    try {
      this.process = spawn(bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          LD_LIBRARY_PATH: `${join(bin, "..")}:${process.env.LD_LIBRARY_PATH || ""}`
        }
      });
      this.process.unref();

      this.process.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) logger.debug(`[llama-server] ${text}`);
      });

      this.process.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) logger.debug(`[llama-server:err] ${text}`);
      });

      this.process.on("error", (err) => {
        logger.error("llama-server process error", { error: err.message });
      });

      this.process.on("exit", (code, signal) => {
        logger.info("llama-server process exited", { code, signal });
        this.process = null;
      });

      // Poll until server is ready (max 60 seconds for model download/load)
      const startTime = Date.now();
      while (Date.now() - startTime < 60000) {
        if (await this.isHealthy()) {
          logger.info("llama-server initialized and ready!");
          return true;
        }
        await new Promise((res) => setTimeout(res, 500));
      }

      logger.warn("llama-server startup timed out after 60s");
      return false;
    } catch (err) {
      logger.error("Failed to spawn llama-server", { error: String(err) });
      return false;
    }
  }

  stop(): void {
    if (this.process) {
      try {
        this.process.kill("SIGTERM");
      } catch {}
      this.process = null;
    }
  }

  async transcribeSegment(
    samples: Float32Array,
    sampleRate = 16000,
    options: { language?: string; startMs?: number } = {}
  ): Promise<{ text: string; words?: TranscriptWord[] }> {
    if (samples.length === 0) {
      return { text: "" };
    }

    const ready = await this.ensureRunning();
    if (!ready) {
      throw new Error("llama-server is not running and could not be started");
    }

    const wavBytes = encodeWav(samples, sampleRate);
    const b64 = Buffer.from(wavBytes).toString("base64");
    const baseStartMs = options.startMs ?? 0;
    const durationMs = Math.round((samples.length / sampleRate) * 1000);

    const language = options.language || "en";
    const isEnglish = language.toLowerCase().startsWith("en");

    const systemPrompt = isEnglish
      ? "You are an accurate English speech-to-text transcriber. Transcribe the speech verbatim in English only. Do not output non-English characters."
      : `You are an accurate speech-to-text transcriber. Transcribe the speech verbatim in ${language}.`;

    const userPrompt = isEnglish
      ? "Language: English. Transcribe speech in English:"
      : `Language: ${language}. Transcribe speech:`;

    const assistantPrefill = isEnglish
      ? "language English<asr_text>"
      : `language ${language}<asr_text>`;

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.modelRepo,
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: [
              { type: "text", text: userPrompt },
              { type: "input_audio", input_audio: { data: b64, format: "wav" } }
            ]
          },
          {
            role: "assistant",
            content: assistantPrefill
          }
        ],
        temperature: 0.0,
        max_tokens: 512
      })
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`llama-server returned HTTP ${res.status}: ${errText}`);
    }

    const json = (await res.json()) as any;
    let rawContent: string = json?.choices?.[0]?.message?.content || "";

    // Strip Qwen prefix like "language English<asr_text>" or "<asr_text>"
    rawContent = rawContent.replace(/^language\s+[a-zA-Z-]+\s*/i, "");
    rawContent = rawContent.replace(/<asr_text>/gi, "");
    rawContent = rawContent.replace(/<\/asr_text>/gi, "");

    if (isEnglish) {
      // Strip any residual non-Latin script characters (e.g. Devanagari, CJK, Arabic, Cyrillic) produced during hesitations or multilingual leaks
      rawContent = rawContent.replace(/[^\u0000-\u007F\u00C0-\u024F\u2000-\u206F\u2E00-\u2E7F]+/g, " ");
    }

    const cleanText = rawContent
      .replace(/\s+/g, " ")
      .replace(/\s+([.,!?;:])/g, "$1")
      .trim();

    const wordList = cleanText.split(/\s+/).filter(Boolean);
    const wordDuration = Math.floor(durationMs / Math.max(1, wordList.length));

    const words: TranscriptWord[] = wordList.map((w: string, idx: number) => ({
      word: w,
      startMs: baseStartMs + idx * wordDuration,
      endMs: baseStartMs + (idx + 1) * wordDuration
    }));

    return { text: cleanText, words };
  }
}
