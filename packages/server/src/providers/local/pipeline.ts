import type { EnrolledSpeaker, Transcript, TranscriptSegment } from "@olive/shared";
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

export interface TranscribeAudioOptions {
  audioPath?: string;
  audioBytes?: Uint8Array;
  language?: string;
  enrolledSpeakers?: EnrolledSpeaker[];
  similarityThreshold?: number;
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
    // 1. Decode audio (WAV, MP3, M4A, etc.) to 16kHz mono Float32Array
    const targetSampleRate = 16000;
    const decoded = await loadAudioSamples(options, targetSampleRate);
    const samples = decoded.samples;
    const durationMs = decoded.durationMs;

    // 2. Perform Speaker Diarization
    const speakerSegments = await this.diarizer.diarize(samples, targetSampleRate);

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
    for (const seg of speakerSegments) {
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

      // 5. Transcribe the audio segment
      const asrResult = await this.asrEngine.transcribeSegment(
        seg.samples,
        targetSampleRate,
        {
          language: options.language,
          startMs: seg.startMs
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

/**
 * Merges consecutive segments from the same speaker if the silence gap between them is reasonable (< 3000ms).
 */
export function coalesceSpeakerSegments(segments: TranscriptSegment[], maxGapMs = 3000): TranscriptSegment[] {
  if (segments.length <= 1) {
    return segments;
  }

  const merged: TranscriptSegment[] = [];
  let current: TranscriptSegment = {
    ...segments[0],
    words: segments[0].words ? [...segments[0].words] : []
  };

  for (let i = 1; i < segments.length; i++) {
    const next = segments[i];
    const sameSpeaker = current.speaker.trim().toLowerCase() === next.speaker.trim().toLowerCase();
    const gapMs = next.startMs - current.endMs;

    if (sameSpeaker && (gapMs <= maxGapMs || !current.text.trim())) {
      const glue = current.text.trim() && next.text.trim() ? " " : "";
      current.text = `${current.text.trim()}${glue}${next.text.trim()}`.trim();
      current.endMs = Math.max(current.endMs, next.endMs);
      if (next.words && next.words.length > 0) {
        current.words = [...(current.words || []), ...next.words];
      }
    } else {
      if (current.text.trim()) {
        merged.push(current);
      }
      current = {
        ...next,
        words: next.words ? [...next.words] : []
      };
    }
  }

  if (current.text.trim()) {
    merged.push(current);
  }

  return merged;
}
