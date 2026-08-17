import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { dlopen, FFIType } from "bun:ffi";
import { resolvePaths } from "../../paths.ts";

let nativeLibsLoaded = false;
let sherpaModule: any = null;

/**
 * Ensures native shared libraries for sherpa-onnx-node are loaded into the process runtime.
 */
export function loadSherpaNativeLibs(): void {
  if (nativeLibsLoaded) return;

  if (process.platform === "linux" || process.platform === "darwin") {
    const possibleDirs = [
      resolve(__dirname, "../../../../../node_modules/.bun/sherpa-onnx-linux-x64@1.13.5/node_modules/sherpa-onnx-linux-x64"),
      resolve(__dirname, "../../../../node_modules/.bun/sherpa-onnx-linux-x64@1.13.5/node_modules/sherpa-onnx-linux-x64"),
      resolve(__dirname, "../../../node_modules/.bun/sherpa-onnx-linux-x64@1.13.5/node_modules/sherpa-onnx-linux-x64"),
      resolve(process.cwd(), "node_modules/.bun/sherpa-onnx-linux-x64@1.13.5/node_modules/sherpa-onnx-linux-x64"),
      resolve(process.cwd(), "packages/server/node_modules/sherpa-onnx-linux-x64"),
      resolve(process.cwd(), "node_modules/sherpa-onnx-linux-x64"),
      "/app/node_modules/.bun/sherpa-onnx-linux-x64@1.13.5/node_modules/sherpa-onnx-linux-x64",
      "/app/node_modules/sherpa-onnx-linux-x64"
    ];

    for (const dir of possibleDirs) {
      const onnxPath = join(dir, "libonnxruntime.so");
      const sherpaPath = join(dir, "libsherpa-onnx-c-api.so");
      if (existsSync(onnxPath) && existsSync(sherpaPath)) {
        try {
          dlopen(onnxPath, { OrtGetApiBase: { args: [], returns: FFIType.ptr } });
          dlopen(sherpaPath, { SherpaOnnxGetOnnxruntimeVersionStr: { args: [], returns: FFIType.cstring } });
        } catch {
          // Ignore if dlopen fails or already loaded
        }
        break;
      }
    }
  }

  nativeLibsLoaded = true;
}

/**
 * Loads the sherpa-onnx-node module safely.
 */
export async function getSherpaOnnx(): Promise<any> {
  if (sherpaModule) return sherpaModule;
  loadSherpaNativeLibs();
  try {
    // @ts-ignore
    const mod = await import("sherpa-onnx-node");
    sherpaModule = mod.default || mod;
    return sherpaModule;
  } catch (err) {
    throw new Error(`Failed to load sherpa-onnx-node: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const SHERPA_MODELS = {
  embedding: {
    filename: "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
  },
  segmentation: {
    dirname: "sherpa-onnx-pyannote-segmentation-3-0",
    modelFilename: "model.onnx",
    tarFilename: "sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
  }
};

export interface SherpaModelPaths {
  modelsDir: string;
  embeddingModelPath: string;
  segmentationModelPath: string;
}

/**
 * Resolves paths for Sherpa models and downloads them automatically if missing.
 */
export async function ensureSherpaModels(customModelsDir?: string): Promise<SherpaModelPaths> {
  const paths = resolvePaths();
  const baseModelsDir = customModelsDir || process.env.OLIVE_MODELS_DIR || paths.modelsDir || join(tmpdir(), "olive-models");
  const sherpaDir = join(baseModelsDir, "sherpa");
  mkdirSync(sherpaDir, { recursive: true });

  const embeddingPath = join(sherpaDir, SHERPA_MODELS.embedding.filename);
  const segmentationDir = join(sherpaDir, SHERPA_MODELS.segmentation.dirname);
  const segmentationModelPath = join(segmentationDir, SHERPA_MODELS.segmentation.modelFilename);

  // 1. Download speaker embedding model if missing
  if (!existsSync(embeddingPath)) {
    const tempPath = `${embeddingPath}.tmp`;
    const res = await fetch(SHERPA_MODELS.embedding.url);
    if (!res.ok) {
      throw new Error(`Failed to download speaker embedding model: HTTP ${res.status} ${res.statusText}`);
    }
    const buf = await res.arrayBuffer();
    await Bun.write(tempPath, buf);
    const fs = await import("node:fs/promises");
    await fs.rename(tempPath, embeddingPath);
  }

  // 2. Download and extract segmentation model if missing
  if (!existsSync(segmentationModelPath)) {
    mkdirSync(segmentationDir, { recursive: true });
    const tarPath = join(sherpaDir, SHERPA_MODELS.segmentation.tarFilename);
    const res = await fetch(SHERPA_MODELS.segmentation.url);
    if (!res.ok) {
      throw new Error(`Failed to download speaker segmentation model: HTTP ${res.status} ${res.statusText}`);
    }
    const buf = await res.arrayBuffer();
    await Bun.write(tarPath, buf);

    // Extract tar.bz2
    const tarRes = spawnSync("tar", ["-xjf", tarPath, "-C", sherpaDir]);
    if (tarRes.status !== 0) {
      throw new Error(`Failed to extract segmentation model tar archive: ${tarRes.stderr?.toString()}`);
    }
  }

  return {
    modelsDir: sherpaDir,
    embeddingModelPath: embeddingPath,
    segmentationModelPath
  };
}
