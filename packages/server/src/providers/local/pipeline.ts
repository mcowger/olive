import {
  coalesceSpeakerSegments,
  type EnrolledSpeaker,
  type Transcript,
  type TranscriptSegment,
  type TranscriptionProgressUpdate
} from "@olive/shared";
import { decodeWav, loadAudioSamples, resample } from "./wav.ts";
import {
  AcousticFeatureEmbeddingExtractor,
  cosineSimilarity,
  normalizeVector,
  updateVoiceprintCentroid,
  type SpeakerEmbeddingExtractorInterface
} from "./embedding.ts";
import { LocalSpeakerDiarizer, type DiarizerInterface } from "./diarizer.ts";
import { TransformersAsrEngine, type LocalAsrEngineInterface } from "./asr.ts";
import type {
  DiscoveredSpeakerVoiceprint,
  LocalTranscriptionPipelineOptions,
  LocalTranscriptionResult,
  VoiceprintVector
} from "./types.ts";

export type TranscriptionProgressCallback = (update: TranscriptionProgressUpdate) => void | Promise<void>;

export interface TranscribeAudioOptions {
  audioPath?: string;
  audioBytes?: Uint8Array;
  language?: string;
  enrolledSpeakers?: EnrolledSpeaker[];
  similarityThreshold?: number;
  clusteringThreshold?: number;
  modelId?: string;
  signal?: AbortSignal;
  onProgress?: TranscriptionProgressCallback;
}

export class LocalTranscriptionPipeline {
  private readonly diarizer: DiarizerInterface;
  private readonly embeddingExtractor: SpeakerEmbeddingExtractorInterface;
  private readonly asrEngine: LocalAsrEngineInterface;
  private readonly similarityThreshold: number;
  private readonly centroidUpdateRate: number;

  constructor(
    options: LocalTranscriptionPipelineOptions = {},
    customDiarizer?: DiarizerInterface,
    customExtractor?: SpeakerEmbeddingExtractorInterface,
    customAsrEngine?: LocalAsrEngineInterface
  ) {
    this.embeddingExtractor =
      customExtractor ??
      new AcousticFeatureEmbeddingExtractor(options.voiceprintConfig?.embeddingDim ?? 192);

    this.diarizer =
      customDiarizer ??
      new LocalSpeakerDiarizer(this.embeddingExtractor, options.diarizerConfig);

    this.asrEngine =
      customAsrEngine ??
      new TransformersAsrEngine(options.asrConfig);

    this.similarityThreshold = options.voiceprintConfig?.similarityThreshold ?? 0.85;
    this.centroidUpdateRate = options.voiceprintConfig?.centroidUpdateRate ?? 0.85;
  }

  /**
   * Main entry point to transcribe an audio file or raw buffer with
   * speaker diarization and cross-recording speaker identification.
   */
  async transcribe(options: TranscribeAudioOptions): Promise<LocalTranscriptionResult> {
    if (options.signal?.aborted) {
      throw new Error("Transcription cancelled by user");
    }

    await options.onProgress?.({
      stage: "decoding",
      percent: 5,
      message: "Enhancing speech audio & decoding 16kHz samples..."
    });

    // 1. Decode audio (WAV, MP3, M4A, etc.) to 16kHz mono Float32Array
    const targetSampleRate = 16000;
    const decoded = await loadAudioSamples(options, targetSampleRate);
    const samples = decoded.samples;
    const durationMs = decoded.durationMs;

    if (options.signal?.aborted) {
      throw new Error("Transcription cancelled by user");
    }

    await options.onProgress?.({
      stage: "diarizing",
      percent: 15,
      totalMs: durationMs,
      message: "Detecting speech activity & clustering speaker turns..."
    });

    // 2. Perform Speaker Diarization
    const speakerSegments = await this.diarizer.diarize(
      samples,
      targetSampleRate,
      options.clusteringThreshold
    );

    if (options.signal?.aborted) {
      throw new Error("Transcription cancelled by user");
    }

    const totalSegments = speakerSegments.length;
    await options.onProgress?.({
      stage: "diarizing",
      percent: 25,
      total: totalSegments,
      totalMs: durationMs,
      message: `Identified ${totalSegments} speech segments. Matching enrolled profiles...`
    });

    // 3. Prepare enrolled speaker voiceprints for cross-recording matching
    const enrolledProfiles = new Map<string, { id: string; name: string; centroid: VoiceprintVector }>();
    for (const spk of options.enrolledSpeakers ?? []) {
      const localIds = spk.providerIds.local;
      if (localIds && Array.isArray(localIds) && localIds.length > 0) {
        try {
          // Parse stored embedding vector
          const parsed = typeof localIds[0] === "string" ? JSON.parse(localIds[0]) : localIds;
          if (Array.isArray(parsed) && parsed.length > 0) {
            enrolledProfiles.set(spk.name.trim().toLowerCase(), {
              id: spk.id,
              name: spk.name,
              centroid: normalizeVector(parsed)
            });
          }
        } catch {
          // ignore unparseable voiceprints
        }
      }
    }

    const threshold = options.similarityThreshold ?? this.similarityThreshold;
    const discoveredMap = new Map<string, DiscoveredSpeakerVoiceprint>();
    const finalSegments: TranscriptSegment[] = [];

    // Map local diarizer clusters (e.g. "Speaker 1") to recognized or discovered speaker names
    const clusterToResolvedName = new Map<string, string>();

    // 4. Match speaker segments across recordings & update voiceprint centroids
    for (let i = 0; i < speakerSegments.length; i++) {
      if (options.signal?.aborted) {
        throw new Error("Transcription cancelled by user");
      }

      const seg = speakerSegments[i];
      const currentNumber = i + 1;
      const progressPercent = Math.min(95, Math.round(25 + ((i + 0.5) / Math.max(1, totalSegments)) * 70));

      const segEmbedding = seg.embedding ?? (await this.embeddingExtractor.extract(seg.samples, targetSampleRate));

      let resolvedSpeakerName = clusterToResolvedName.get(seg.speakerId);

      if (!resolvedSpeakerName) {
        // Search against all enrolled speaker profiles
        let bestMatch: { name: string; id: string; similarity: number } | null = null;

        for (const [key, profile] of enrolledProfiles) {
          const sim = cosineSimilarity(segEmbedding, profile.centroid);
          if (sim >= threshold && (!bestMatch || sim > bestMatch.similarity)) {
            bestMatch = { name: profile.name, id: profile.id, similarity: sim };
          }
        }

        if (bestMatch) {
          resolvedSpeakerName = bestMatch.name;
          clusterToResolvedName.set(seg.speakerId, resolvedSpeakerName);

          // Update the enrolled profile centroid with this new utterance
          const profile = enrolledProfiles.get(bestMatch.name.trim().toLowerCase())!;
          profile.centroid = updateVoiceprintCentroid(
            profile.centroid,
            segEmbedding,
            this.centroidUpdateRate
          );

          discoveredMap.set(resolvedSpeakerName, {
            speakerId: bestMatch.id,
            name: resolvedSpeakerName,
            voiceprint: profile.centroid,
            isEnrolled: true,
            similarityScore: bestMatch.similarity
          });
        } else {
          // Unenrolled / New Speaker
          resolvedSpeakerName = seg.speakerId;
          clusterToResolvedName.set(seg.speakerId, resolvedSpeakerName);

          const existingDiscovered = discoveredMap.get(resolvedSpeakerName);
          const updatedVoiceprint = existingDiscovered
            ? updateVoiceprintCentroid(existingDiscovered.voiceprint, segEmbedding, this.centroidUpdateRate)
            : segEmbedding;

          discoveredMap.set(resolvedSpeakerName, {
            speakerId: resolvedSpeakerName,
            name: resolvedSpeakerName,
            voiceprint: updatedVoiceprint,
            isEnrolled: false
          });
        }
      }

      await options.onProgress?.({
        stage: "transcribing",
        percent: progressPercent,
        current: currentNumber,
        total: totalSegments,
        currentMs: seg.startMs,
        totalMs: durationMs,
        speaker: resolvedSpeakerName || seg.speakerId,
        message: `Transcribing segment ${currentNumber} of ${totalSegments} (${progressPercent}%)`
      });

      // 5. Transcribe the audio segment
      const asrResult = await this.asrEngine.transcribeSegment(
        seg.samples,
        targetSampleRate,
        {
          language: options.language,
          startMs: seg.startMs,
          modelId: options.modelId
        }
      );

      finalSegments.push({
        startMs: seg.startMs,
        endMs: seg.endMs,
        speaker: resolvedSpeakerName,
        text: asrResult.text,
        words: asrResult.words
      });
    }

    await options.onProgress?.({
      stage: "finalizing",
      percent: 98,
      totalMs: durationMs,
      message: "Coalescing turns & formatting transcript artifacts..."
    });

    // 6. Coalesce consecutive segments from the same speaker into natural conversational turns
    const coalescedSegments = coalesceSpeakerSegments(finalSegments);

    const transcript: Transcript = {
      segments: coalescedSegments,
      language: options.language || "en",
      durationMs
    };

    return {
      transcript,
      discoveredSpeakers: Array.from(discoveredMap.values())
    };
  }
}

export { coalesceSpeakerSegments };
