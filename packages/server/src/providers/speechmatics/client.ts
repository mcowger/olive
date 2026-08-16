import { readFile } from "node:fs/promises";
import {
  BatchClient,
  type DeleteJobResponse,
  type JobDetails,
  type RetrieveTranscriptResponse,
  type SpeakersInputItem
} from "@speechmatics/batch-client";
import type {
  SpeechmaticsJobStatus,
  SpeechmaticsJsonV2,
  SpeechmaticsSpeakerConfig
} from "./types.ts";

export interface SpeechmaticsClientOptions {
  apiKey?: string;
  apiUrl?: string;
  appId?: string;
  batchClient?: BatchClient;
}

export interface SubmitJobOptions {
  audio?: Uint8Array | Blob | { path: string } | { url: string };
  filename?: string;
  mime?: string;
  language?: string;
  speakers?: SpeechmaticsSpeakerConfig[];
  getSpeakers?: boolean;
  additionalVocab?: Array<{ content: string; sounds_like?: string[] }>;
  webhookUrl?: string;
  webhookSecret?: string;
}

export interface SubmitJobResult {
  id: string;
  createdAt?: string;
}

export class SpeechmaticsClient {
  private readonly apiKey: string;
  private readonly apiUrl?: string;
  private readonly appId: string;
  private readonly client: BatchClient;

  constructor(options: SpeechmaticsClientOptions = {}) {
    this.apiKey = options.apiKey || process.env.SPEECHMATICS_API_KEY || "";
    this.apiUrl = options.apiUrl;
    this.appId = options.appId || "olive-meeting-pipeline";

    this.client =
      options.batchClient ??
      new BatchClient({
        apiKey: this.apiKey,
        apiUrl: this.apiUrl,
        appId: this.appId
      });
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey.trim());
  }

  get rawClient(): BatchClient {
    return this.client;
  }

  async submitJob(options: SubmitJobOptions): Promise<SubmitJobResult> {
    if (!this.apiKey && !this.client) {
      throw new Error("Speechmatics API key is not configured");
    }

    const language = options.language || "en";
    const speakerDiarizationConfig: {
      get_speakers?: boolean;
      speakers?: SpeakersInputItem[];
    } = {};

    if (options.speakers && options.speakers.length > 0) {
      speakerDiarizationConfig.speakers = options.speakers.slice(0, 50).map((s) => ({
        label: s.label,
        speaker_identifiers: new Set(s.speaker_identifiers)
      }));
    } else if (options.getSpeakers) {
      speakerDiarizationConfig.get_speakers = true;
    }

    const transcriptionConfig: any = {
      language,
      diarization: "speaker",
      ...(Object.keys(speakerDiarizationConfig).length > 0
        ? { speaker_diarization_config: speakerDiarizationConfig }
        : {})
    };

    if (options.additionalVocab && options.additionalVocab.length > 0) {
      transcriptionConfig.additional_vocab = options.additionalVocab;
    }

    const jobConfig: any = {
      transcription_config: transcriptionConfig
    };

    if (options.webhookUrl) {
      const authHeaders: string[] = [];
      if (options.webhookSecret) {
        authHeaders.push(`Authorization: Bearer ${options.webhookSecret}`);
      }
      jobConfig.notification_config = [
        {
          url: options.webhookUrl,
          contents: ["transcript"],
          auth_headers: authHeaders.length > 0 ? authHeaders : undefined
        }
      ];
    }

    let input: any;
    if (options.audio && "url" in options.audio) {
      input = { url: options.audio.url };
    } else if (options.audio) {
      let audioBlob: Blob;
      const filename = options.filename || "audio.m4a";
      const mime = options.mime || "audio/mp4";

      if ("path" in options.audio) {
        const bytes = await readFile(options.audio.path);
        audioBlob = new Blob([bytes.buffer as ArrayBuffer], { type: mime });
      } else if (options.audio instanceof Blob) {
        audioBlob = options.audio;
      } else {
        audioBlob = new Blob([options.audio.buffer as ArrayBuffer], { type: mime });
      }

      input = {
        data: audioBlob,
        fileName: filename
      };
    } else {
      throw new Error("No audio provided for transcription job");
    }

    const response = await this.client.createTranscriptionJob(input, jobConfig);
    return {
      id: response.id
    };
  }

  async getJob(jobId: string): Promise<SpeechmaticsJobStatus> {
    const res = await this.client.getJob(jobId);
    const job: JobDetails = res.job;
    return {
      id: job.id,
      status: job.status as SpeechmaticsJobStatus["status"],
      created_at: job.created_at,
      data_name: job.data_name,
      duration: job.duration,
      errors: job.errors?.map((e) => ({ code: "JOB_ERROR", message: e.message }))
    };
  }

  async getTranscript(
    jobId: string,
    format: "json-v2" | "txt" | "srt" = "json-v2"
  ): Promise<RetrieveTranscriptResponse | string> {
    if (format === "json-v2") {
      return (await this.client.getJobResult(jobId, "json-v2")) as RetrieveTranscriptResponse;
    }
    return (await this.client.getJobResult(jobId, format === "txt" ? "text" : "srt")) as string;
  }

  async deleteJob(jobId: string): Promise<DeleteJobResponse> {
    return await this.client.deleteJob(jobId);
  }
}
