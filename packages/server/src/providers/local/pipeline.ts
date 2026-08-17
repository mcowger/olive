import {
  coalesceSpeakerSegments,
  type EnrolledSpeaker,
  type Transcript,
  type TranscriptSegment,
  type TranscriptionProgressUpdate
} from "@olive/shared";
import { decodeWav, loadAudioSamples, resample } from "./wav.ts";
import {
  cosineSimilarity,
  mergeWeightedVoiceprintVectors,
  normalizeVector,
  scoreAgainstTrustedVectors,
  SherpaSpeakerEmbeddingExtractor,
  type SpeakerEmbeddingExtractorInterface
} from "./embedding.ts";
import { SherpaSpeakerDiarizer, type DiarizerInterface } from "./diarizer.ts";
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
  candidateSpeakers?: string[];
  expectedSpeakerCount?: number;
  similarityThreshold?: number;
  clusteringThreshold?: number;
  decisionMargin?: number;
  modelId?: string;
  signal?: AbortSignal;
  onProgress?: TranscriptionProgressCallback;
}

export class LocalTranscriptionPipeline {
  private readonly diarizer: DiarizerInterface;
  private readonly embeddingExtractor: SpeakerEmbeddingExtractorInterface;
  private readonly asrEngine: LocalAsrEngineInterface;
  private readonly similarityThreshold: number;
  private readonly decisionMargin: number;

  constructor(
    options: LocalTranscriptionPipelineOptions = {},
    customDiarizer?: DiarizerInterface,
    customExtractor?: SpeakerEmbeddingExtractorInterface,
    customAsrEngine?: LocalAsrEngineInterface
  ) {
    this.embeddingExtractor =
      customExtractor ??
      new SherpaSpeakerEmbeddingExtractor({
        numThreads: options.diarizerConfig?.numThreads
      });

    this.diarizer =
      customDiarizer ??
      new SherpaSpeakerDiarizer(this.embeddingExtractor, options.diarizerConfig);

    this.asrEngine =
      customAsrEngine ??
      new TransformersAsrEngine(options.asrConfig);

    // Default matching threshold for neural embeddings (e.g. ERes2Net / CAM++)
    this.similarityThreshold = options.voiceprintConfig?.similarityThreshold ?? 0.60;
    this.decisionMargin = 0.05;
  }

  /**
   * Main entry point to transcribe an audio file or raw buffer with
   * neural speaker diarization and cross-recording speaker identification.
   */
  async transcribe(options: TranscribeAudioOptions): Promise<LocalTranscriptionResult> {
    if (options.signal?.aborted) {
      throw new Error("Transcription cancelled by user");
    }

    await options.onProgress?.({
      stage: "decoding",
      percent: 5,
      message: "Decoding 16kHz audio samples..."
    });

    // 1. Decode audio (clean 16kHz mono Float32Array for diarization & embeddings)
    const targetSampleRate = 16000;
    const decoded = await loadAudioSamples(
      {
        audioPath: options.audioPath,
        audioBytes: options.audioBytes,
        enhance: false
      },
      targetSampleRate
    );
    const samples = decoded.samples;
    const durationMs = decoded.durationMs;

    if (options.signal?.aborted) {
      throw new Error("Transcription cancelled by user");
    }

    await options.onProgress?.({
      stage: "diarizing",
      percent: 15,
      totalMs: durationMs,
      message: "Neural speaker diarization & turn segmentation..."
    });

    // 2. Perform Speaker Diarization
    const speakerSegments = await this.diarizer.diarize(
      samples,
      targetSampleRate,
      options.clusteringThreshold,
      options.expectedSpeakerCount
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
      message: `Identified ${totalSegments} speech segments across clusters. Matching enrolled profiles...`
    });

    // 3. Prepare enrolled speaker profiles with multiple trusted vectors
    interface PreparedProfile {
      id: string;
      name: string;
      trustedVectors: VoiceprintVector[];
    }

    const allProfiles: PreparedProfile[] = [];
    const normalizedCandidateSet = options.candidateSpeakers && options.candidateSpeakers.length > 0
      ? new Set(options.candidateSpeakers.map((c) => c.trim().toLowerCase()))
      : null;

    for (const spk of options.enrolledSpeakers ?? []) {
      const localIds = spk.providerIds.local;
      const trustedVectors: VoiceprintVector[] = [];

      if (localIds && Array.isArray(localIds)) {
        for (const item of localIds) {
          try {
            const parsed = typeof item === "string" ? JSON.parse(item) : item;
            if (Array.isArray(parsed) && parsed.length > 0) {
              // Handle single vector or array of vectors
              if (Array.isArray(parsed[0])) {
                for (const sub of parsed) {
                  if (Array.isArray(sub) && sub.length > 0) {
                    trustedVectors.push(normalizeVector(sub));
                  }
                }
              } else {
                trustedVectors.push(normalizeVector(parsed));
              }
            }
          } catch {
            // ignore unparseable
          }
        }
      }

      if (trustedVectors.length > 0) {
        allProfiles.push({
          id: spk.id,
          name: spk.name,
          trustedVectors
        });
      }
    }

    // Filter candidate profiles if candidate roster provided
    const candidateProfiles = normalizedCandidateSet
      ? allProfiles.filter(
          (p) =>
            normalizedCandidateSet.has(p.id.toLowerCase()) ||
            normalizedCandidateSet.has(p.name.trim().toLowerCase())
        )
      : allProfiles;

    // 4. Group segments by cluster & compute duration-weighted centroid per cluster
    const clusterMap = new Map<string, typeof speakerSegments>();
    for (const seg of speakerSegments) {
      const clusterId = seg.speakerId || "Speaker 1";
      const list = clusterMap.get(clusterId) ?? [];
      list.push(seg);
      clusterMap.set(clusterId, list);
    }

    const clusterCentroids = new Map<string, VoiceprintVector>();
    for (const [clusterId, segs] of clusterMap.entries()) {
      const centroid = mergeWeightedVoiceprintVectors(
        segs.map((s) => ({
          vector: s.embedding ?? new Array(512).fill(0),
          weight: Math.max(1, s.endMs - s.startMs)
        }))
      );
      clusterCentroids.set(clusterId, centroid);
    }

    // 5. Global Cluster-to-Speaker Assignment with decision margin & threshold
    const effectiveThreshold = options.similarityThreshold ?? this.similarityThreshold;
    const effectiveMargin = options.decisionMargin ?? this.decisionMargin;

    const clusterToResolvedName = new Map<string, string>();
    const discoveredMap = new Map<string, DiscoveredSpeakerVoiceprint>();

    interface ClusterScoreEntry {
      clusterId: string;
      profile: PreparedProfile;
      score: number;
      secondScore: number;
    }

    const candidateMatches: ClusterScoreEntry[] = [];

    for (const [clusterId, centroid] of clusterCentroids.entries()) {
      const speakerScores: Array<{ profile: PreparedProfile; score: number }> = [];

      for (const profile of candidateProfiles) {
        const score = scoreAgainstTrustedVectors(centroid, profile.trustedVectors);
        speakerScores.push({ profile, score });
      }

      // Sort descending by score
      speakerScores.sort((a, b) => b.score - a.score);

      if (speakerScores.length > 0) {
        const top1 = speakerScores[0];
        const top2 = speakerScores.length > 1 ? speakerScores[1] : null;
        const secondScore = top2 ? top2.score : -1.0;

        // Check if top-1 meets threshold and decision margin
        const meetsThreshold = top1.score >= effectiveThreshold;
        const meetsMargin = top2 ? top1.score - top2.score >= effectiveMargin : true;

        if (meetsThreshold && meetsMargin) {
          candidateMatches.push({
            clusterId,
            profile: top1.profile,
            score: top1.score,
            secondScore
          });
        }
      }
    }

    // Global greedy assignment: assign highest scoring (cluster, speaker) pairs first, ensuring 1-to-1 uniqueness
    candidateMatches.sort((a, b) => b.score - a.score);

    const assignedClusters = new Set<string>();
    const assignedSpeakerIds = new Set<string>();

    for (const match of candidateMatches) {
      if (!assignedClusters.has(match.clusterId) && !assignedSpeakerIds.has(match.profile.id)) {
        assignedClusters.add(match.clusterId);
        assignedSpeakerIds.add(match.profile.id);

        clusterToResolvedName.set(match.clusterId, match.profile.name);

        discoveredMap.set(match.profile.name, {
          speakerId: match.profile.id,
          name: match.profile.name,
          voiceprint: clusterCentroids.get(match.clusterId) ?? match.profile.trustedVectors[0],
          isEnrolled: true,
          similarityScore: match.score
        });
      }
    }

    // Unassigned clusters stay as their cluster label or "Unknown"
    for (const [clusterId, centroid] of clusterCentroids.entries()) {
      if (!clusterToResolvedName.has(clusterId)) {
        clusterToResolvedName.set(clusterId, clusterId);

        discoveredMap.set(clusterId, {
          speakerId: clusterId,
          name: clusterId,
          voiceprint: centroid,
          isEnrolled: false
        });
      }
    }

    // 6. Transcribe audio segments with ASR
    const finalSegments: TranscriptSegment[] = [];

    for (let i = 0; i < speakerSegments.length; i++) {
      if (options.signal?.aborted) {
        throw new Error("Transcription cancelled by user");
      }

      const seg = speakerSegments[i];
      const currentNumber = i + 1;
      const progressPercent = Math.min(95, Math.round(25 + ((i + 0.5) / Math.max(1, totalSegments)) * 70));
      const resolvedSpeakerName = clusterToResolvedName.get(seg.speakerId) || seg.speakerId;

      await options.onProgress?.({
        stage: "transcribing",
        percent: progressPercent,
        current: currentNumber,
        total: totalSegments,
        currentMs: seg.startMs,
        totalMs: durationMs,
        speaker: resolvedSpeakerName,
        message: `Transcribing segment ${currentNumber} of ${totalSegments} (${progressPercent}%)`
      });

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

    // 7. Coalesce consecutive segments from the same speaker into natural conversational turns
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
