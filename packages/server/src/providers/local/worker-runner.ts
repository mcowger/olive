import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { TranscriptionProgressUpdate } from "@olive/shared";
import { logger } from "../../logger.ts";
import { LocalTranscriptionPipeline, type TranscribeAudioOptions } from "./pipeline.ts";
import type { LocalTranscriptionPipelineOptions, LocalTranscriptionResult } from "./types.ts";

interface QueuedTask {
  taskId: string;
  options: TranscribeAudioOptions;
  resolve: (result: LocalTranscriptionResult) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
}

export class LocalTranscriptionWorkerRunner {
  private worker: Worker | null = null;
  private isSpawning = false;
  private readonly pipelineOptions?: LocalTranscriptionPipelineOptions;
  private currentTask: QueuedTask | null = null;
  private readonly queue: QueuedTask[] = [];
  private readonly workerScriptPath: string;

  constructor(pipelineOptions?: LocalTranscriptionPipelineOptions, workerScriptPath?: string) {
    this.pipelineOptions = pipelineOptions;
    this.workerScriptPath =
      workerScriptPath ||
      join(import.meta.dir, "worker.ts");
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }

    try {
      logger.info("Spawning background worker for local transcription", {
        workerScript: this.workerScriptPath
      });

      this.worker = new Worker(this.workerScriptPath);

      this.worker.on("message", (msg: any) => {
        if (!msg || !this.currentTask || msg.taskId !== this.currentTask.taskId) {
          return;
        }

        if (msg.type === "progress") {
          void this.currentTask.options.onProgress?.(msg.update);
        } else if (msg.type === "result") {
          const task = this.currentTask;
          this.currentTask = null;
          task.resolve(msg.result);
          this.processNext();
        } else if (msg.type === "cancelled") {
          const task = this.currentTask;
          this.currentTask = null;
          task.reject(new Error("Transcription cancelled by user"));
          this.processNext();
        } else if (msg.type === "error") {
          const task = this.currentTask;
          this.currentTask = null;
          task.reject(new Error(msg.error || "Local transcription worker error"));
          this.processNext();
        }
      });

      this.worker.on("error", (err: Error) => {
        logger.error("Local transcription background worker error", { error: err.message });
        if (this.currentTask) {
          const task = this.currentTask;
          this.currentTask = null;
          task.reject(new Error(`Background worker failed: ${err.message}`));
        }
        this.terminateWorker();
        this.processNext();
      });

      this.worker.on("exit", (code: number) => {
        logger.info("Local transcription background worker exited", { code });
        this.worker = null;
        if (this.currentTask) {
          const task = this.currentTask;
          this.currentTask = null;
          task.reject(new Error(`Background worker exited unexpectedly with code ${code}`));
          this.processNext();
        }
      });

      return this.worker;
    } catch (err) {
      logger.error("Failed to spawn local transcription worker thread", { error: String(err) });
      throw err;
    }
  }

  private terminateWorker(): void {
    if (this.worker) {
      try {
        void this.worker.terminate();
      } catch {}
      this.worker = null;
    }
  }

  private processNext(): void {
    if (this.currentTask || this.queue.length === 0) {
      return;
    }

    const nextTask = this.queue.shift()!;
    if (nextTask.signal?.aborted) {
      nextTask.reject(new Error("Transcription cancelled by user"));
      this.processNext();
      return;
    }

    this.currentTask = nextTask;

    try {
      const worker = this.ensureWorker();
      worker.postMessage({
        type: "transcribe",
        taskId: nextTask.taskId,
        options: {
          audioPath: nextTask.options.audioPath,
          audioBytes: nextTask.options.audioBytes,
          language: nextTask.options.language,
          enrolledSpeakers: nextTask.options.enrolledSpeakers,
          candidateSpeakers: nextTask.options.candidateSpeakers,
          expectedSpeakerCount: nextTask.options.expectedSpeakerCount,
          similarityThreshold: nextTask.options.similarityThreshold,
          clusteringThreshold: nextTask.options.clusteringThreshold,
          decisionMargin: nextTask.options.decisionMargin,
          modelId: nextTask.options.modelId
        },
        pipelineOptions: this.pipelineOptions
      });
    } catch (err) {
      this.currentTask = null;
      // Fallback: execute directly in process if worker cannot be spawned
      logger.warn("Falling back to in-process transcription execution", { error: String(err) });
      const fallbackPipeline = new LocalTranscriptionPipeline(this.pipelineOptions);
      fallbackPipeline
        .transcribe(nextTask.options)
        .then(nextTask.resolve, nextTask.reject)
        .finally(() => this.processNext());
    }
  }

  async transcribe(options: TranscribeAudioOptions): Promise<LocalTranscriptionResult> {
    if (options.signal?.aborted) {
      throw new Error("Transcription cancelled by user");
    }

    const taskId = randomUUID();

    return new Promise<LocalTranscriptionResult>((resolve, reject) => {
      const task: QueuedTask = {
        taskId,
        options,
        resolve,
        reject,
        signal: options.signal
      };

      if (options.signal) {
        options.signal.addEventListener("abort", () => {
          if (this.currentTask?.taskId === taskId) {
            try {
              this.worker?.postMessage({ type: "cancel", taskId });
            } catch {}
          } else {
            const idx = this.queue.findIndex((t) => t.taskId === taskId);
            if (idx >= 0) {
              this.queue.splice(idx, 1);
              reject(new Error("Transcription cancelled by user"));
            }
          }
        });
      }

      if (this.currentTask) {
        void options.onProgress?.({
          stage: "queued",
          percent: 0,
          message: `Queued for local transcription (position ${this.queue.length + 1})...`
        });
        this.queue.push(task);
      } else {
        this.queue.push(task);
        this.processNext();
      }
    });
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get isBusy(): boolean {
    return this.currentTask !== null;
  }

  stop(): void {
    this.terminateWorker();
    for (const task of this.queue) {
      task.reject(new Error("Transcription runner stopped"));
    }
    this.queue.length = 0;
    if (this.currentTask) {
      this.currentTask.reject(new Error("Transcription runner stopped"));
      this.currentTask = null;
    }
  }
}
