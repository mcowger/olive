import type { EnrolledSpeaker, Transcript, TranscriptSegment } from "@olive/shared";

export type VoiceprintVector = number[];

export interface LocalEnrolledSpeaker extends EnrolledSpeaker {
  voiceprint?: VoiceprintVector;
}

export interface LocalDiarizerConfig {
  frameSizeMs?: number;
  frameShiftMs?: number;
  energyThreshold?: number;
  minSpeechDurationMs?: number;
  minSilenceDurationMs?: number;
  clusteringThreshold?: number;
  numThreads?: number;
}

export interface LocalAsrConfig {
  modelId?: string;
  dtype?: "q4" | "int8" | "fp32";
  device?: "cpu" | "webgpu";
  language?: string;
}

export interface LocalVoiceprintConfig {
  embeddingDim?: number;
  numThreads?: number;
  similarityThreshold?: number; // Minimum cosine similarity to match (default 0.65)
  centroidUpdateRate?: number;   // alpha weight for exponential moving average centroid (default 0.85)
}

export interface LocalSpeakerSegment {
  startMs: number;
  endMs: number;
  speakerId: string;
  samples: Float32Array;
  embedding?: VoiceprintVector;
}

export interface DiscoveredSpeakerVoiceprint {
  speakerId: string;
  name: string;
  voiceprint: VoiceprintVector;
  isEnrolled: boolean;
  similarityScore?: number;
}

export interface LocalTranscriptionPipelineOptions {
  asrConfig?: LocalAsrConfig;
  diarizerConfig?: LocalDiarizerConfig;
  voiceprintConfig?: LocalVoiceprintConfig;
}

export interface LocalTranscriptionResult {
  transcript: Transcript;
  discoveredSpeakers: DiscoveredSpeakerVoiceprint[];
}
