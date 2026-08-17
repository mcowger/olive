import { parentPort } from "node:worker_threads";
import { LocalTranscriptionPipeline, type TranscribeAudioOptions } from "./pipeline.ts";
import type { LocalTranscriptionPipelineOptions } from "./types.ts";
import type { TranscriptionProgressUpdate } from "@olive/shared";

if (!parentPort) {
  throw new Error("Local transcription worker must be spawned as a Worker thread");
}

let activePipeline: LocalTranscriptionPipeline | null = null;
let activeAbortController: AbortController | null = null;
let currentTaskId: string | null = null;

parentPort.on("message", async (msg: any) => {
  if (!parentPort || !msg) return;

  if (msg.type === "cancel") {
    if (currentTaskId === msg.taskId && activeAbortController) {
      activeAbortController.abort();
    }
    return;
  }

  if (msg.type === "transcribe") {
    const { taskId, options, pipelineOptions } = msg as {
      taskId: string;
      options: TranscribeAudioOptions;
      pipelineOptions?: LocalTranscriptionPipelineOptions;
    };

    currentTaskId = taskId;
    activeAbortController = new AbortController();

    try {
      if (!activePipeline) {
        activePipeline = new LocalTranscriptionPipeline(pipelineOptions);
      }

      const result = await activePipeline.transcribe({
        ...options,
        signal: activeAbortController.signal,
        onProgress: (update: TranscriptionProgressUpdate) => {
          parentPort?.postMessage({
            type: "progress",
            taskId,
            update
          });
        }
      });

      parentPort.postMessage({
        type: "result",
        taskId,
        result
      });
    } catch (err) {
      const isCancelled =
        (err instanceof Error && err.message.toLowerCase().includes("cancel")) ||
        activeAbortController?.signal.aborted;

      parentPort.postMessage({
        type: isCancelled ? "cancelled" : "error",
        taskId,
        error: err instanceof Error ? err.message : String(err)
      });
    } finally {
      if (currentTaskId === taskId) {
        currentTaskId = null;
        activeAbortController = null;
      }
    }
  }
});
