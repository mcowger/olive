import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  pipeline,
  env,
  AutoProcessor,
  AutoTokenizer,
  GraniteSpeechForConditionalGeneration
} from "@huggingface/transformers";

const defaultCacheDir = existsSync("/app")
  ? "/app/.cache/huggingface"
  : join(tmpdir(), "olive-models-cache");

const cacheDir = process.env.TRANSFORMERS_CACHE || process.env.HF_HOME || defaultCacheDir;
env.cacheDir = cacheDir || null;
mkdirSync(cacheDir, { recursive: true });

console.log(`[download-models] Pre-downloading model weights to: ${cacheDir}`);

// 1. Download IBM Granite Speech ONNX Model
const graniteModelId = "onnx-community/granite-4.0-1b-speech-ONNX";
console.log(`[download-models] Fetching IBM Granite Speech model: ${graniteModelId} (q4)...`);
try {
  await AutoProcessor.from_pretrained(graniteModelId);
  await GraniteSpeechForConditionalGeneration.from_pretrained(graniteModelId, {
    dtype: {
      embed_tokens: "q4",
      audio_encoder: "q4",
      decoder_model_merged: "q4"
    },
    device: "cpu"
  });
  console.log(`[download-models] Successfully cached IBM Granite Speech model: ${graniteModelId}`);
} catch (err) {
  console.warn(`[download-models] IBM Granite Speech download warning: ${err instanceof Error ? err.message : String(err)}`);
}

// 2. Download Cohere Transcribe ONNX Model
const cohereModelId = "onnx-community/cohere-transcribe-03-2026-ONNX";
console.log(`[download-models] Fetching Cohere Transcribe model: ${cohereModelId} (q4)...`);
try {
  await pipeline("automatic-speech-recognition", cohereModelId, {
    dtype: "q4",
    device: "cpu"
  });
  console.log(`[download-models] Successfully cached Cohere Transcribe model: ${cohereModelId}`);
} catch (err) {
  console.warn(`[download-models] Cohere Transcribe download warning: ${err instanceof Error ? err.message : String(err)}`);
}

// 3. Download Qwen3-ASR 1.7B GGUF Model & Multimodal Projector
const qwenGgufRepo = "ggml-org/Qwen3-ASR-1.7B-GGUF";
console.log(`[download-models] Fetching Qwen3-ASR GGUF files: ${qwenGgufRepo}...`);
try {
  const hubDir = join(cacheDir, "hub", "models--ggml-org--Qwen3-ASR-1.7B-GGUF", "snapshots", "default");
  mkdirSync(hubDir, { recursive: true });
  for (const filename of ["Qwen3-ASR-1.7B-Q8_0.gguf", "mmproj-Qwen3-ASR-1.7B-Q8_0.gguf"]) {
    const dest = join(hubDir, filename);
    if (!existsSync(dest)) {
      console.log(`[download-models] Downloading ${filename}...`);
      const res = await fetch(`https://huggingface.co/${qwenGgufRepo}/resolve/main/${filename}`);
      if (res.ok) {
        await Bun.write(dest, res);
        console.log(`[download-models] Successfully cached ${filename}`);
      }
    }
  }
} catch (err) {
  console.warn(`[download-models] Qwen3-ASR GGUF download warning: ${err instanceof Error ? err.message : String(err)}`);
}

// 2. Fetch and cache web model catalog for offline availability
const defaultConfigDir = existsSync("/app") ? "/app/data/config" : join(tmpdir(), "olive-config");
const configDir = process.env.OLIVE_CONFIG_DIR || defaultConfigDir;
mkdirSync(configDir, { recursive: true });
const webCatalogPath = join(configDir, "models-web-cache.json");

console.log(`[download-models] Fetching live web LLM catalog from models.dev...`);
try {
  const res = await fetch("https://models.dev/api.json", {
    headers: { "User-Agent": "Olive-Docker-Build/1.0" }
  });
  if (res.ok) {
    const data = (await res.json()) as Record<string, any>;
    const items = [];
    for (const [providerId, providerData] of Object.entries(data)) {
      if (!providerData?.models) continue;
      for (const [mId, mDef] of Object.entries(providerData.models as Record<string, any>)) {
        items.push({
          id: mId,
          name: mDef.name || mId,
          provider: providerId,
          api: mDef.api || (providerId === "anthropic" ? "anthropic-messages" : "openai-completions"),
          baseUrl: mDef.baseUrl || providerData.baseUrl,
          contextWindow: mDef.contextWindow || mDef.limit?.context,
          maxTokens: mDef.maxTokens || mDef.limit?.output,
          reasoning: Boolean(mDef.reasoning || mDef.thinking),
          cost: mDef.cost,
          source: "web"
        });
      }
    }
    writeFileSync(webCatalogPath, JSON.stringify(items, null, 2), "utf-8");
    console.log(`[download-models] Cached ${items.length} web models to ${webCatalogPath}`);
  }
} catch (err) {
  console.warn(`[download-models] Web catalog cache note: ${err instanceof Error ? err.message : String(err)}`);
}

console.log("[download-models] Model pre-download phase completed!");
