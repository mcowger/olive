import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pipeline, env } from "@huggingface/transformers";

const defaultCacheDir = existsSync("/app")
  ? "/app/.cache/huggingface"
  : join(tmpdir(), "olive-models-cache");

const cacheDir = process.env.TRANSFORMERS_CACHE || process.env.HF_HOME || defaultCacheDir;
env.cacheDir = cacheDir || null;
mkdirSync(cacheDir, { recursive: true });

console.log(`[download-models] Pre-downloading model weights to: ${cacheDir}`);

// 1. Download Local ASR ONNX Model
const modelId = process.env.LOCAL_ASR_MODEL_ID || "onnx-community/cohere-transcribe-03-2026-ONNX";
console.log(`[download-models] Fetching ASR model: ${modelId} (q4)...`);
try {
  await pipeline("automatic-speech-recognition", modelId, {
    dtype: "q4",
    device: "cpu"
  });
  console.log(`[download-models] Successfully cached ASR model: ${modelId}`);
} catch (err) {
  console.warn(`[download-models] ASR model download warning: ${err instanceof Error ? err.message : String(err)}`);
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
