import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, rename, unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Kysely } from "kysely";
import {
  coalesceSpeakerSegments,
  type Database,
  type Speaker,
  type SpeakerRow,
  type Transcript,
  type TranscriptSegment
} from "@olive/shared";
import { logger as defaultLogger, type Logger } from "../logger.ts";
import { SpeechmaticsClient } from "../providers/speechmatics/client.ts";
import type { SpeechmaticsJsonV2 } from "../providers/speechmatics/types.ts";
import { meetingPaths } from "../layout.ts";
import { transcriptToText } from "../providers/speechmatics/normalize.ts";
import {
  decodeWav,
  encodeWav,
  loadAudioSamples,
  normalizeVector,
  scoreAgainstTrustedVectors,
  SherpaSpeakerEmbeddingExtractor,
  type SpeakerEmbeddingExtractorInterface,
  type VoiceprintVector
} from "../providers/local/index.ts";

export const MAX_ENROLLMENT_CLIPS = 8;
export const MIN_CONFIRM_DURATION_SEC = 3.0;
export const MAX_CONFIRM_DURATION_SEC = 15.0;
export const MAX_ENROLL_DURATION_SEC = 30.0;
export const OUTLIER_MIN_SIMILARITY = 0.55;
export const REDUNDANT_MAX_SIMILARITY = 0.95;

export type VoiceprintEnrollmentStatus =
  | "enrolled"
  | "enrolled_evicted"
  | "redundant_skipped"
  | "outlier_rejected"
  | "duration_skipped"
  | "not_available";

export interface AdoptVoiceprintOptions {
  speakerRow: SpeakerRow;
  samples: Float32Array;
  sampleRate?: number;
  clipFilename: string;
  isAnchor?: boolean;
  meetingId?: string;
  segmentIndex?: number;
}

export interface AdoptVoiceprintResult {
  status: VoiceprintEnrollmentStatus;
  voiceprintEnrolled: boolean;
  statusReason?: string;
  similarity?: number;
  updatedSpeakerRow: SpeakerRow;
}

export interface SpeakerServiceOptions {
  db: Kysely<Database>;
  configDir: string;
  meetingsDir?: string;
  speechmaticsClient?: SpeechmaticsClient;
  logger?: Logger;
  now?: () => number;
}

export interface EnrollSpeakerOptions {
  name: string;
  audioBytes: Uint8Array;
  mime?: string;
  filename?: string;
  speakerId?: string;
  provider?: "speechmatics" | "local" | "both";
  language?: string;
  pollIntervalMs?: number;
  maxPollWaitMs?: number;
}

export interface ReassignMeetingSpeakerOptions {
  meetingId: string;
  fromLabel: string;
  toSpeakerName?: string;
  toSpeakerId?: string;
  adoptVoiceprint?: boolean;
  segmentIndex?: number;
  scope?: "single" | "all";
}

export interface ReassignMeetingSpeakerResult {
  speaker: Speaker;
  transcript: Transcript;
  updatedSegmentsCount: number;
  extractedVoiceprintsCount: number;
  voiceprintStatus?: VoiceprintEnrollmentStatus;
  statusReason?: string;
}

export interface ConfirmMeetingSegmentSpeakerOptions {
  meetingId: string;
  segmentIndex: number;
  speakerName?: string;
  speakerId?: string;
}

export interface ConfirmMeetingSegmentSpeakerResult {
  speaker: Speaker;
  transcript: Transcript;
  segmentIndex: number;
  voiceprintEnrolled: boolean;
  voiceprintStatus: VoiceprintEnrollmentStatus;
  statusReason?: string;
  similarity?: number;
}

export interface UnassignMeetingSegmentSpeakerOptions {
  meetingId: string;
  segmentIndex: number;
}

export interface UnassignMeetingSegmentSpeakerResult {
  transcript: Transcript;
  segmentIndex: number;
}

export interface SplitMeetingSegmentOptions {
  meetingId: string;
  segmentIndex: number;
  wordIndex?: number;
  splitMs?: number;
  newSpeakerName?: string;
  newSpeakerId?: string;
}

export interface SplitMeetingSegmentResult {
  transcript: Transcript;
  firstSegmentIndex: number;
  secondSegmentIndex: number;
}

export interface MergeMeetingSegmentsOptions {
  meetingId: string;
  segmentIndex: number;
}

export interface MergeMeetingSegmentsResult {
  transcript: Transcript;
  segmentIndex: number;
}

export interface BackfillVoiceprintsOptions {
  speakerId?: string;
  force?: boolean;
}

export interface BackfillVoiceprintsResult {
  processed: number;
  updated: number;
  speakers: Speaker[];
}

export interface RebuildSpeakerProfilesOptions {
  speakerId?: string;
  force?: boolean;
}

export interface RebuildSpeakerProfilesResult {
  processedSpeakers: number;
  updatedSpeakers: number;
  cleanedClipsCount: number;
  retainedClipsCount: number;
  speakers: Speaker[];
}

export interface SpeakerWithStats extends Speaker {
  meetingCount: number;
}

export interface SpeakerDetailResponse {
  speaker: Speaker;
  meetings: Array<{ id: string; title: string; startTime: number }>;
}

function parseJsonField<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function extractTranscriptSegments(parsedData: any): {
  segments: TranscriptSegment[];
  isArrayFormat: boolean;
  language?: string;
  durationMs?: number;
  speakers?: any[];
} {
  if (Array.isArray(parsedData?.segments)) {
    return {
      segments: parsedData.segments,
      isArrayFormat: false,
      language: parsedData.language,
      durationMs: parsedData.durationMs,
      speakers: parsedData.speakers
    };
  }

  if (Array.isArray(parsedData)) {
    const segments: TranscriptSegment[] = parsedData
      .filter((item: any) => (item.text && item.text.trim()) || (item.content && item.content.trim()))
      .map((item: any) => ({
        speaker: item.speaker || "Speaker",
        text: item.text || item.content || "",
        startMs: item.startMs ?? item.start_time ?? 0,
        endMs: item.endMs ?? item.end_time ?? 0,
        verified: Boolean(item.verified),
        words: item.words
      }));

    return {
      segments,
      isArrayFormat: true
    };
  }

  return {
    segments: [],
    isArrayFormat: false
  };
}

function toSpeaker(row: SpeakerRow): Speaker {
  return {
    id: row.id,
    name: row.name,
    providerIds: parseJsonField<Record<string, string[]>>(row.provider_ids, {}),
    enrolledAt: row.enrolled_at,
    enrollmentClipPaths: parseJsonField<string[]>(row.enrollment_clip_paths, []),
    createdAt: row.created_at
  };
}

export class SpeakerService {
  private readonly db: Kysely<Database>;
  private readonly configDir: string;
  private readonly meetingsDir?: string;
  private readonly client: SpeechmaticsClient;
  private readonly localEmbeddingExtractor: SpeakerEmbeddingExtractorInterface;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(options: SpeakerServiceOptions) {
    this.db = options.db;
    this.configDir = options.configDir;
    this.meetingsDir = options.meetingsDir;
    this.client = options.speechmaticsClient ?? new SpeechmaticsClient();
    this.localEmbeddingExtractor = new SherpaSpeakerEmbeddingExtractor();
    this.logger = options.logger ?? defaultLogger;
    this.now = options.now ?? Date.now;
  }

  /**
   * Adopts a speech sample into a speaker's trusted local voiceprint pool using
   * the Protected Anchor + Diversity Cap policy:
   * 1. Gating on duration ([3.0s, 15.0s] for confirmations, [3.0s, 30.0s] for anchor enrollment).
   * 2. Outlier rejection: cosine similarity < 0.55 rejected as noise/crosstalk.
   * 3. Redundancy check: cosine similarity > 0.95 skipped (already modeled).
   * 4. Cap & Anchor Protection: max 8 clips total. When full, evicts oldest non-anchor clip (index 1).
   */
  private async adoptVoiceprintSample(
    options: AdoptVoiceprintOptions
  ): Promise<AdoptVoiceprintResult> {
    const {
      speakerRow,
      samples,
      sampleRate = 16000,
      clipFilename,
      isAnchor = false,
      meetingId,
      segmentIndex
    } = options;
    const currentTime = this.now();
    const durationSec = samples.length / sampleRate;

    // 1. Duration check
    const minSec = MIN_CONFIRM_DURATION_SEC;
    const maxSec = isAnchor ? MAX_ENROLL_DURATION_SEC : MAX_CONFIRM_DURATION_SEC;
    if (durationSec < minSec || durationSec > maxSec) {
      return {
        status: "duration_skipped",
        voiceprintEnrolled: false,
        statusReason: `Duration (${durationSec.toFixed(1)}s) outside optimal window [${minSec.toFixed(1)}s - ${maxSec.toFixed(1)}s]`,
        updatedSpeakerRow: speakerRow
      };
    }

    // 2. Extract local neural embedding
    let newEmbedding: VoiceprintVector;
    try {
      newEmbedding = await this.localEmbeddingExtractor.extract(samples, sampleRate);
    } catch (err) {
      this.logger.warn("Could not extract local voiceprint embedding", {
        speakerId: speakerRow.id,
        meetingId,
        segmentIndex,
        error: err instanceof Error ? err.message : String(err)
      });
      return {
        status: "not_available",
        voiceprintEnrolled: false,
        statusReason: "Local embedding extraction failed",
        updatedSpeakerRow: speakerRow
      };
    }

    const providerIds = parseJsonField<Record<string, string[]>>(speakerRow.provider_ids, {});
    const clips = parseJsonField<string[]>(speakerRow.enrollment_clip_paths, []);
    const localVectorStrs = providerIds.local ?? [];

    const existingVectors: VoiceprintVector[] = localVectorStrs
      .map((str) => {
        try {
          return JSON.parse(str) as VoiceprintVector;
        } catch {
          return [];
        }
      })
      .filter((v) => Array.isArray(v) && v.length > 0);

    // 3. Similarity check if existing vectors exist and not an explicit anchor enrollment
    let similarity: number | undefined;
    if (!isAnchor && existingVectors.length > 0) {
      similarity = scoreAgainstTrustedVectors(newEmbedding, existingVectors);
      if (similarity < OUTLIER_MIN_SIMILARITY) {
        return {
          status: "outlier_rejected",
          voiceprintEnrolled: false,
          similarity,
          statusReason: `Similarity (${similarity.toFixed(3)}) is below outlier threshold (${OUTLIER_MIN_SIMILARITY})`,
          updatedSpeakerRow: speakerRow
        };
      }

      if (similarity > REDUNDANT_MAX_SIMILARITY) {
        return {
          status: "redundant_skipped",
          voiceprintEnrolled: false,
          similarity,
          statusReason: `Similarity (${similarity.toFixed(3)}) exceeds redundancy threshold (${REDUNDANT_MAX_SIMILARITY})`,
          updatedSpeakerRow: speakerRow
        };
      }
    }

    // 4. Save audio clip to disk
    const speakerFolder = join(this.configDir, "speakers", speakerRow.id);
    await mkdir(speakerFolder, { recursive: true });
    const clipRelativePath = join("speakers", speakerRow.id, clipFilename);
    const clipWavBytes = encodeWav(samples, sampleRate);
    await writeFile(join(this.configDir, clipRelativePath), clipWavBytes);

    let status: VoiceprintEnrollmentStatus = "enrolled";

    // 5. Enforce Cap (Protected Anchor + Diversity Cap)
    // If pool is at or above MAX_ENROLLMENT_CLIPS, evict oldest non-anchor clip (index 1)
    if (clips.length >= MAX_ENROLLMENT_CLIPS) {
      if (clips.length > 1) {
        const evictedRelPath = clips.splice(1, 1)[0];
        if (localVectorStrs.length > 1) {
          localVectorStrs.splice(1, 1);
        }
        try {
          const evictedFullPath = join(this.configDir, evictedRelPath);
          if (existsSync(evictedFullPath)) {
            await unlink(evictedFullPath);
          }
        } catch (err) {
          this.logger.warn("Could not remove evicted confirmation clip", {
            path: evictedRelPath,
            error: err instanceof Error ? err.message : String(err)
          });
        }
        status = "enrolled_evicted";
      }
    }

    if (!clips.includes(clipRelativePath)) {
      clips.push(clipRelativePath);
    }
    localVectorStrs.push(JSON.stringify(newEmbedding));
    providerIds.local = localVectorStrs;

    await this.db
      .updateTable("speakers")
      .set({
        provider_ids: JSON.stringify(providerIds),
        enrollment_clip_paths: JSON.stringify(clips),
        enrolled_at: speakerRow.enrolled_at ?? currentTime
      })
      .where("id", "=", speakerRow.id)
      .execute();

    const updatedRow = await this.db
      .selectFrom("speakers")
      .selectAll()
      .where("id", "=", speakerRow.id)
      .executeTakeFirstOrThrow();

    // Background Speechmatics enrollment if available and configured
    if (this.client?.isConfigured && (!providerIds.speechmatics || providerIds.speechmatics.length === 0)) {
      void this.enrollSpeechmaticsClipBackground(speakerRow.id, clipWavBytes, clipFilename);
    }

    return {
      status,
      voiceprintEnrolled: true,
      similarity,
      statusReason:
        status === "enrolled_evicted"
          ? "Enrolled new sample, evicted oldest non-anchor clip (cap reached)"
          : "Enrolled new voiceprint sample",
      updatedSpeakerRow: updatedRow
    };
  }

  private async enrollSpeechmaticsClipBackground(
    speakerId: string,
    clipWavBytes: Uint8Array,
    clipFilename: string
  ): Promise<void> {
    if (!this.client?.isConfigured) return;
    try {
      const enrollJob = await this.client.submitJob({
        audio: clipWavBytes,
        filename: clipFilename,
        mime: "audio/wav",
        language: "en",
        getSpeakers: true
      });

      const startWait = this.now();
      while (this.now() - startWait < 60_000) {
        const status = await this.client.getJob(enrollJob.id);
        if (status.status === "done") {
          const smEnrollJson = (await this.client.getTranscript(enrollJob.id, "json-v2")) as SpeechmaticsJsonV2;
          const extractedIds: string[] = [];
          for (const s of (smEnrollJson.speakers ?? []) as any[]) {
            const ids = Array.isArray(s.speaker_identifiers)
              ? s.speaker_identifiers
              : Array.from(s.speaker_identifiers ?? []);
            for (const id of ids as string[]) {
              if (id && !extractedIds.includes(id)) {
                extractedIds.push(id);
              }
            }
          }

          if (extractedIds.length > 0) {
            const speakerRow = await this.db
              .selectFrom("speakers")
              .selectAll()
              .where("id", "=", speakerId)
              .executeTakeFirst();
            if (speakerRow) {
              const providerIds = parseJsonField<Record<string, string[]>>(speakerRow.provider_ids, {});
              const currentSmIds = new Set(providerIds.speechmatics ?? []);
              for (const id of extractedIds) {
                currentSmIds.add(id);
              }
              providerIds.speechmatics = Array.from(currentSmIds);
              await this.db
                .updateTable("speakers")
                .set({ provider_ids: JSON.stringify(providerIds) })
                .where("id", "=", speakerId)
                .execute();
            }
          }
          try {
            await this.client.deleteJob(enrollJob.id);
          } catch {}
          break;
        }
        if (status.status === "rejected" || status.status === "deleted") break;
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (smErr) {
      this.logger.warn("Could not enroll audio slice with Speechmatics in background", {
        speakerId,
        error: smErr instanceof Error ? smErr.message : String(smErr)
      });
    }
  }

  async listSpeakers(): Promise<SpeakerWithStats[]> {
    const rows = await this.db
      .selectFrom("speakers")
      .selectAll()
      .orderBy("name", "asc")
      .execute();

    const counts = await this.db
      .selectFrom("meeting_speakers")
      .select(["speaker_id", ({ fn }) => fn.count<number>("meeting_id").as("count")])
      .groupBy("speaker_id")
      .execute();

    const countMap = new Map<string, number>();
    for (const c of counts) {
      countMap.set(c.speaker_id, Number(c.count));
    }

    return rows.map((row) => ({
      ...toSpeaker(row),
      meetingCount: countMap.get(row.id) ?? 0
    }));
  }

  async getSpeaker(id: string): Promise<SpeakerDetailResponse | null> {
    const row = await this.db
      .selectFrom("speakers")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    if (!row) {
      return null;
    }

    const meetingLinks = await this.db
      .selectFrom("meeting_speakers")
      .innerJoin("meetings", "meetings.id", "meeting_speakers.meeting_id")
      .select(["meetings.id", "meetings.title", "meetings.start_time"])
      .where("meeting_speakers.speaker_id", "=", id)
      .orderBy("meetings.start_time", "desc")
      .execute();

    return {
      speaker: toSpeaker(row),
      meetings: meetingLinks.map((m) => ({
        id: m.id,
        title: m.title,
        startTime: m.start_time
      }))
    };
  }

  /**
   * Backfills neural voiceprints across providers from saved enrollment clips.
   * Stores multiple independent trusted vectors per speaker in provider_ids.local.
   */
  async backfillVoiceprints(
    options: BackfillVoiceprintsOptions = {}
  ): Promise<BackfillVoiceprintsResult> {
    const currentTime = this.now();
    let query = this.db.selectFrom("speakers").selectAll();
    if (options.speakerId) {
      query = query.where("id", "=", options.speakerId);
    }

    const rows = await query.execute();
    const updatedSpeakers: Speaker[] = [];
    let updatedCount = 0;

    for (const row of rows) {
      const providerIds = parseJsonField<Record<string, string[]>>(row.provider_ids, {});
      const clips = parseJsonField<string[]>(row.enrollment_clip_paths, []);
      let changed = false;

      // 1. Cross-fill Local Voiceprints from saved audio clips if missing or forced
      if (clips.length > 0 && (!providerIds.local?.length || options.force)) {
        const clipVectors: VoiceprintVector[] = [];
        for (const relPath of clips) {
          const fullPath = join(this.configDir, relPath);
          if (existsSync(fullPath)) {
            try {
              const fileBytes = new Uint8Array(await readFile(fullPath));
              if (fileBytes.byteLength >= 12) {
                const decoded = await loadAudioSamples({ audioBytes: fileBytes, audioPath: fullPath, enhance: false }, 16000);
                const durSec = decoded.samples.length / 16000;
                if (durSec >= 2.0) {
                  const emb = await this.localEmbeddingExtractor.extract(decoded.samples, 16000);
                  clipVectors.push(emb);
                }
              }
            } catch (err) {
              this.logger.warn("Failed to extract local voiceprint from stored clip during backfill", {
                path: fullPath,
                error: err instanceof Error ? err.message : String(err)
              });
            }
          }
        }

        if (clipVectors.length > 0) {
          providerIds.local = clipVectors.map((v) => JSON.stringify(v));
          changed = true;
        }
      }

      // 2. Cross-fill Speechmatics voiceprint from saved audio clips if missing and client is configured
      if (
        clips.length > 0 &&
        (!providerIds.speechmatics?.length || options.force) &&
        (process.env.SPEECHMATICS_API_KEY || (this.client as any).jobs !== undefined)
      ) {
        const extractedSmIds: string[] = [];
        for (const relPath of clips) {
          const fullPath = join(this.configDir, relPath);
          if (existsSync(fullPath)) {
            try {
              const fileBytes = new Uint8Array(await readFile(fullPath));
              const submitResult = await this.client.submitJob({
                audio: fileBytes,
                filename: relPath.split("/").at(-1) || "clip.wav",
                mime: "audio/wav",
                language: "en",
                getSpeakers: true
              });

              const startTime = this.now();
              while (this.now() - startTime < 120_000) {
                const status = await this.client.getJob(submitResult.id);
                if (status.status === "done") {
                  const jsonV2 = (await this.client.getTranscript(submitResult.id, "json-v2")) as SpeechmaticsJsonV2;
                  for (const s of (jsonV2.speakers ?? []) as any[]) {
                    const ids = Array.isArray(s.speaker_identifiers)
                      ? s.speaker_identifiers
                      : Array.from(s.speaker_identifiers ?? []);
                    for (const id of ids as string[]) {
                      if (id && !extractedSmIds.includes(id)) {
                        extractedSmIds.push(id);
                      }
                    }
                  }
                  try {
                    await this.client.deleteJob(submitResult.id);
                  } catch {}
                  break;
                }
                if (status.status === "rejected" || status.status === "deleted") {
                  break;
                }
                await new Promise((res) => setTimeout(res, 2000));
              }
            } catch (err) {
              this.logger.warn("Failed to cross-fill Speechmatics voiceprint from clip", {
                path: fullPath,
                error: err instanceof Error ? err.message : String(err)
              });
            }
          }
        }

        if (extractedSmIds.length > 0) {
          providerIds.speechmatics = extractedSmIds;
          changed = true;
        }
      }

      if (changed) {
        await this.db
          .updateTable("speakers")
          .set({
            provider_ids: JSON.stringify(providerIds),
            enrolled_at: row.enrolled_at ?? currentTime
          })
          .where("id", "=", row.id)
          .execute();

        updatedCount++;
      }

      const updatedRow = await this.db
        .selectFrom("speakers")
        .selectAll()
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow();

      updatedSpeakers.push(toSpeaker(updatedRow));
    }

    return {
      processed: rows.length,
      updated: updatedCount,
      speakers: updatedSpeakers
    };
  }

  /**
   * Rebuilds all speaker profiles from scratch:
   * 1. Deduplicates audio clips by SHA-256 hash.
   * 2. Rejects clips < 3.0s or > 30.0s.
   * 3. Detects and removes cross-speaker contaminated clips (same audio enrolled to 2 speakers).
   * 4. Re-computes neural embeddings using the Sherpa-ONNX model.
   * 5. Stores independent trusted vectors per speaker.
   */
  async rebuildSpeakerProfiles(
    options: RebuildSpeakerProfilesOptions = {}
  ): Promise<RebuildSpeakerProfilesResult> {
    const currentTime = this.now();
    let query = this.db.selectFrom("speakers").selectAll();
    if (options.speakerId) {
      query = query.where("id", "=", options.speakerId);
    }

    const rows = await query.execute();

    // Map: sha256 -> Array of { speakerId, relPath, fullPath, durationSec, samples }
    interface ClipInfo {
      speakerId: string;
      relPath: string;
      fullPath: string;
      sha256: string;
      durationSec: number;
      samples: Float32Array;
    }

    const clipsByHash = new Map<string, ClipInfo[]>();
    const allClipsBySpeaker = new Map<string, ClipInfo[]>();

    for (const row of rows) {
      const clips = parseJsonField<string[]>(row.enrollment_clip_paths, []);
      const speakerClips: ClipInfo[] = [];

      for (const relPath of clips) {
        const fullPath = join(this.configDir, relPath);
        if (existsSync(fullPath)) {
          try {
            const fileBytes = new Uint8Array(await readFile(fullPath));
            if (fileBytes.byteLength >= 12) {
              const hash = createHash("sha256").update(fileBytes).digest("hex");
              const decoded = await loadAudioSamples({ audioBytes: fileBytes, audioPath: fullPath, enhance: false }, 16000);
              const durationSec = decoded.samples.length / 16000;

              const info: ClipInfo = {
                speakerId: row.id,
                relPath,
                fullPath,
                sha256: hash,
                durationSec,
                samples: decoded.samples
              };

              speakerClips.push(info);

              const hashList = clipsByHash.get(hash) ?? [];
              hashList.push(info);
              clipsByHash.set(hash, hashList);
            }
          } catch {}
        }
      }

      allClipsBySpeaker.set(row.id, speakerClips);
    }

    let cleanedClipsCount = 0;
    let retainedClipsCount = 0;
    let updatedSpeakersCount = 0;
    const updatedSpeakers: Speaker[] = [];

    for (const row of rows) {
      const speakerClips = allClipsBySpeaker.get(row.id) ?? [];
      const cleanClips: ClipInfo[] = [];
      const seenHashesInSpeaker = new Set<string>();

      for (const clip of speakerClips) {
        const sharingSpeakers = new Set((clipsByHash.get(clip.sha256) ?? []).map((c) => c.speakerId));

        // Validation rules:
        // A. Cross-speaker conflict: if enrolled under >= 2 distinct speakers, reject as contaminated
        const isCrossContaminated = sharingSpeakers.size > 1;

        // B. Duplicate within speaker: reject duplicate clips
        const isDuplicate = seenHashesInSpeaker.has(clip.sha256);

        // C. Duration constraint: reject < 3.0s or > 30.0s
        const isDurationInvalid = clip.durationSec < 2.5 || clip.durationSec > 35.0;

        if (isCrossContaminated || isDuplicate || isDurationInvalid) {
          cleanedClipsCount++;
          // Remove invalid file from disk
          try {
            if (existsSync(clip.fullPath)) {
              await unlink(clip.fullPath);
            }
          } catch {}
        } else {
          seenHashesInSpeaker.add(clip.sha256);
          cleanClips.push(clip);
          retainedClipsCount++;
        }
      }

      // Enforce cap: Protected Anchor + Diversity Cap (Max 8 clips)
      if (cleanClips.length > MAX_ENROLLMENT_CLIPS) {
        const anchor = cleanClips[0];
        const otherClips = cleanClips.slice(1);
        const keepCount = MAX_ENROLLMENT_CLIPS - 1;
        const keptOthers = otherClips.slice(-keepCount);
        const evictedOthers = otherClips.slice(0, -keepCount);

        for (const evicted of evictedOthers) {
          cleanedClipsCount++;
          retainedClipsCount--;
          try {
            if (existsSync(evicted.fullPath)) {
              await unlink(evicted.fullPath);
            }
          } catch {}
        }
        cleanClips.length = 0;
        cleanClips.push(anchor, ...keptOthers);
      }

      // Re-extract neural embeddings for all clean clips
      const trustedVectors: VoiceprintVector[] = [];
      for (const clip of cleanClips) {
        try {
          const emb = await this.localEmbeddingExtractor.extract(clip.samples, 16000);
          trustedVectors.push(emb);
        } catch (err) {
          this.logger.warn("Failed to extract neural embedding during rebuild", {
            path: clip.fullPath,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }

      const providerIds = parseJsonField<Record<string, string[]>>(row.provider_ids, {});
      providerIds.local = trustedVectors.map((v) => JSON.stringify(v));
      const cleanPaths = cleanClips.map((c) => c.relPath);

      await this.db
        .updateTable("speakers")
        .set({
          provider_ids: JSON.stringify(providerIds),
          enrollment_clip_paths: JSON.stringify(cleanPaths),
          enrolled_at: cleanPaths.length > 0 ? (row.enrolled_at ?? currentTime) : null
        })
        .where("id", "=", row.id)
        .execute();

      updatedSpeakersCount++;

      const updatedRow = await this.db
        .selectFrom("speakers")
        .selectAll()
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow();

      updatedSpeakers.push(toSpeaker(updatedRow));
    }

    return {
      processedSpeakers: rows.length,
      updatedSpeakers: updatedSpeakersCount,
      cleanedClipsCount,
      retainedClipsCount,
      speakers: updatedSpeakers
    };
  }

  async reassignMeetingSpeaker(
    options: ReassignMeetingSpeakerOptions
  ): Promise<ReassignMeetingSpeakerResult> {
    const { meetingId, fromLabel } = options;
    const adoptVoiceprint = options.adoptVoiceprint ?? true;
    const currentTime = this.now();

    const meeting = await this.db
      .selectFrom("meetings")
      .selectAll()
      .where("id", "=", meetingId)
      .executeTakeFirst();

    if (!meeting) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }

    if (!this.meetingsDir) {
      throw new Error("meetingsDir is required to reassign meeting transcript");
    }

    // 1. Resolve or create target speaker
    let targetSpeakerRow: SpeakerRow | undefined;
    if (options.toSpeakerId) {
      targetSpeakerRow = await this.db
        .selectFrom("speakers")
        .selectAll()
        .where("id", "=", options.toSpeakerId)
        .executeTakeFirst();
      if (!targetSpeakerRow) {
        throw new Error(`Target speaker not found: ${options.toSpeakerId}`);
      }
    } else if (options.toSpeakerName && options.toSpeakerName.trim()) {
      const trimmedName = options.toSpeakerName.trim();
      const all = await this.db.selectFrom("speakers").selectAll().execute();
      targetSpeakerRow = all.find((s) => s.name.trim().toLowerCase() === trimmedName.toLowerCase());

      if (!targetSpeakerRow) {
        const newId = randomUUID();
        await this.db
          .insertInto("speakers")
          .values({
            id: newId,
            name: trimmedName,
            provider_ids: "{}",
            enrolled_at: null,
            enrollment_clip_paths: "[]",
            created_at: currentTime
          })
          .execute();

        targetSpeakerRow = await this.db
          .selectFrom("speakers")
          .selectAll()
          .where("id", "=", newId)
          .executeTakeFirstOrThrow();
      }
    } else {
      throw new Error("Either toSpeakerId or toSpeakerName must be provided");
    }

    // 2. Read meeting transcript artifact
    let transcriptArtifact = meeting.primary_transcript_artifact_id
      ? await this.db
          .selectFrom("artifacts")
          .selectAll()
          .where("id", "=", meeting.primary_transcript_artifact_id)
          .executeTakeFirst()
      : undefined;

    if (!transcriptArtifact || transcriptArtifact.kind !== "transcript" || transcriptArtifact.format !== "json") {
      transcriptArtifact = await this.db
        .selectFrom("artifacts")
        .selectAll()
        .where("meeting_id", "=", meetingId)
        .where("kind", "=", "transcript")
        .where("format", "=", "json")
        .orderBy("created_at", "desc")
        .executeTakeFirst();
    }

    if (!transcriptArtifact) {
      throw new Error(`No JSON transcript artifact found for meeting ${meetingId}`);
    }

    const folder = meetingPaths(this.meetingsDir, meeting.start_time, meeting.title, meeting.id).folder;
    const jsonPath = join(folder, transcriptArtifact.path);
    const rawContent = await readFile(jsonPath, "utf8");
    const parsedData = JSON.parse(rawContent);

    let updatedSegmentsCount = 0;
    let extractedVoiceprintsCount = 0;
    const normalizedFrom = fromLabel.trim().toLowerCase();

    const { segments, isArrayFormat, language, durationMs, speakers } = extractTranscriptSegments(parsedData);

    // 3. Adopt voiceprints if requested
    let voiceprintStatus: VoiceprintEnrollmentStatus | undefined;
    let statusReason: string | undefined;

    if (adoptVoiceprint) {
      const providerIds = parseJsonField<Record<string, string[]>>(targetSpeakerRow.provider_ids, {});
      let adoptedAny = false;

      // A. Adopt Speechmatics voiceprint identifiers
      const extractedIds: string[] = [];
      const speakerList = ((parsedData.speakers ?? speakers) ?? []) as any[];
      for (const s of speakerList) {
        const label = (s.label || s.speaker || "").trim().toLowerCase();
        if (label === normalizedFrom && s.speaker_identifiers) {
          const ids = Array.isArray(s.speaker_identifiers)
            ? s.speaker_identifiers
            : Array.from(s.speaker_identifiers);
          for (const id of ids as string[]) {
            if (id && !extractedIds.includes(id)) {
              extractedIds.push(id);
            }
          }
        }
      }

      if (extractedIds.length > 0) {
        extractedVoiceprintsCount += extractedIds.length;
        const currentSmIds = new Set(providerIds.speechmatics ?? []);
        for (const id of extractedIds) {
          currentSmIds.add(id);
        }
        providerIds.speechmatics = Array.from(currentSmIds);
        adoptedAny = true;
      }

      // B. Extract speaker's audio from recording on disk
      const recording = await this.db
        .selectFrom("recordings")
        .selectAll()
        .where("meeting_id", "=", meetingId)
        .orderBy("created_at", "asc")
        .executeTakeFirst();

      if (recording) {
        const audioFullPath = join(folder, recording.path);
        if (existsSync(audioFullPath)) {
          try {
            const audioBytes = new Uint8Array(await readFile(audioFullPath));
            if (audioBytes.byteLength >= 12) {
              const decoded = await loadAudioSamples({ audioPath: audioFullPath, audioBytes, enhance: false }, 16000);
              const fullSamples = decoded.samples;

              const isSingleSegment = options.segmentIndex !== undefined && options.scope === "single";
              const matchingSegments = isSingleSegment
                ? (segments[options.segmentIndex!] ? [segments[options.segmentIndex!]] : [])
                : segments.filter(
                    (s) => (s.speaker || "").trim().toLowerCase() === normalizedFrom
                  );

              const speakerSampleChunks: Float32Array[] = [];
              for (const seg of matchingSegments) {
                const sStart = Math.floor((seg.startMs / 1000) * 16000);
                const sEnd = Math.min(fullSamples.length, Math.floor((seg.endMs / 1000) * 16000));
                if (sEnd > sStart) {
                  speakerSampleChunks.push(fullSamples.subarray(sStart, sEnd));
                }
              }

              if (speakerSampleChunks.length > 0) {
                const totalLength = speakerSampleChunks.reduce((acc, c) => acc + c.length, 0);
                const mergedSamples = new Float32Array(totalLength);
                let offset = 0;
                for (const c of speakerSampleChunks) {
                  mergedSamples.set(c, offset);
                  offset += c.length;
                }

                const clipFilename = `clip_meeting_${meetingId}_${currentTime}.wav`;
                const adoptResult = await this.adoptVoiceprintSample({
                  speakerRow: targetSpeakerRow,
                  samples: mergedSamples,
                  sampleRate: 16000,
                  clipFilename,
                  isAnchor: false,
                  meetingId,
                  segmentIndex: options.segmentIndex
                });

                voiceprintStatus = adoptResult.status;
                statusReason = adoptResult.statusReason;

                if (adoptResult.voiceprintEnrolled) {
                  extractedVoiceprintsCount++;
                  targetSpeakerRow = adoptResult.updatedSpeakerRow;
                  adoptedAny = true;
                }
              }
            }
          } catch (err) {
            this.logger.warn("Could not extract audio clip during speaker reassignment", {
              meetingId,
              error: err instanceof Error ? err.message : String(err)
            });
          }
        }
      }

      if (extractedIds.length > 0) {
        // Ensure Speechmatics IDs are saved if extracted from transcript
        const currentTargetRow = await this.db
          .selectFrom("speakers")
          .selectAll()
          .where("id", "=", targetSpeakerRow.id)
          .executeTakeFirstOrThrow();
        const curProviderIds = parseJsonField<Record<string, string[]>>(currentTargetRow.provider_ids, {});
        const curSmSet = new Set(curProviderIds.speechmatics ?? []);
        for (const id of extractedIds) {
          curSmSet.add(id);
        }
        curProviderIds.speechmatics = Array.from(curSmSet);
        await this.db
          .updateTable("speakers")
          .set({
            provider_ids: JSON.stringify(curProviderIds),
            enrolled_at: currentTargetRow.enrolled_at ?? currentTime
          })
          .where("id", "=", targetSpeakerRow.id)
          .execute();

        targetSpeakerRow = await this.db
          .selectFrom("speakers")
          .selectAll()
          .where("id", "=", targetSpeakerRow.id)
          .executeTakeFirstOrThrow();
      }
    }

    // 4. Update speaker labels in segments
    const isSingleSegment = options.segmentIndex !== undefined && options.scope === "single";
    if (isSingleSegment) {
      const targetSeg = segments[options.segmentIndex!];
      if (targetSeg) {
        targetSeg.speaker = targetSpeakerRow.name;
        targetSeg.verified = true;
        updatedSegmentsCount++;
        if (targetSeg.words && Array.isArray(targetSeg.words)) {
          for (const word of targetSeg.words) {
            word.speaker = targetSpeakerRow.name;
          }
        }
      }
    } else {
      for (const segment of segments) {
        if (segment.speaker && segment.speaker.trim().toLowerCase() === normalizedFrom) {
          segment.speaker = targetSpeakerRow.name;
          segment.verified = true;
          updatedSegmentsCount++;
          if (segment.words && Array.isArray(segment.words)) {
            for (const word of segment.words) {
              word.speaker = targetSpeakerRow.name;
            }
          }
        }
      }
    }

    const coalescedSegments = coalesceSpeakerSegments(segments, 15000);

    const updatedTranscript: Transcript = {
      segments: coalescedSegments,
      language: language ?? parsedData.language,
      durationMs: durationMs ?? parsedData.durationMs,
      speakers: speakers ?? parsedData.speakers
    };

    const dataToSave = isArrayFormat ? coalescedSegments : updatedTranscript;
    const tmpJson = `${jsonPath}.tmp`;
    await writeFile(tmpJson, `${JSON.stringify(dataToSave, null, 2)}\n`, "utf8");
    await rename(tmpJson, jsonPath);

    const txtPath = join(folder, transcriptArtifact.path.replace(/\.json$/, ".txt"));
    const tmpTxt = `${txtPath}.tmp`;
    await writeFile(tmpTxt, `${transcriptToText(updatedTranscript)}\n`, "utf8");
    await rename(tmpTxt, txtPath);

    // 5. Link target speaker in meeting_speakers
    await this.db
      .insertInto("meeting_speakers")
      .values({
        meeting_id: meetingId,
        speaker_id: targetSpeakerRow.id,
        evidence_artifact_id: transcriptArtifact.id
      })
      .onConflict((conflict) =>
        conflict.columns(["meeting_id", "speaker_id"]).doUpdateSet({
          evidence_artifact_id: transcriptArtifact.id
        })
      )
      .execute();

    // 6. Clean up meeting_speakers links
    if (updatedTranscript && updatedTranscript.segments.length > 0) {
      const distinctSpeakerNames = new Set(
        updatedTranscript.segments.map((s) => (s.speaker || "").trim().toLowerCase()).filter(Boolean)
      );

      const currentMeetingSpeakers = await this.db
        .selectFrom("meeting_speakers")
        .innerJoin("speakers", "speakers.id", "meeting_speakers.speaker_id")
        .select([
          "speakers.id",
          "speakers.name",
          "speakers.enrolled_at",
          "speakers.enrollment_clip_paths"
        ])
        .where("meeting_speakers.meeting_id", "=", meetingId)
        .execute();

      for (const sp of currentMeetingSpeakers) {
        if (!distinctSpeakerNames.has(sp.name.trim().toLowerCase())) {
          await this.db
            .deleteFrom("meeting_speakers")
            .where("meeting_id", "=", meetingId)
            .where("speaker_id", "=", sp.id)
            .execute();

          const otherMeetingLinks = await this.db
            .selectFrom("meeting_speakers")
            .selectAll()
            .where("speaker_id", "=", sp.id)
            .execute();

          const isPlaceholder =
            /^speaker\s*\d+$/i.test(sp.name.trim()) ||
            /^s\d+$/i.test(sp.name.trim()) ||
            sp.name.trim().toLowerCase() === normalizedFrom;

          const clips = parseJsonField<string[]>(sp.enrollment_clip_paths, []);
          if (otherMeetingLinks.length === 0 && (isPlaceholder || (clips.length === 0 && !sp.enrolled_at))) {
            await this.db.deleteFrom("speakers").where("id", "=", sp.id).execute();
          }
        }
      }
    }

    return {
      speaker: toSpeaker(targetSpeakerRow),
      transcript: updatedTranscript,
      updatedSegmentsCount,
      extractedVoiceprintsCount,
      voiceprintStatus,
      statusReason
    };
  }

  async confirmMeetingSegmentSpeaker(
    options: ConfirmMeetingSegmentSpeakerOptions
  ): Promise<ConfirmMeetingSegmentSpeakerResult> {
    const { meetingId, segmentIndex } = options;
    const currentTime = this.now();

    const meeting = await this.db
      .selectFrom("meetings")
      .selectAll()
      .where("id", "=", meetingId)
      .executeTakeFirst();

    if (!meeting) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }

    if (!this.meetingsDir) {
      throw new Error("meetingsDir is required to confirm meeting segment");
    }

    let transcriptArtifact = meeting.primary_transcript_artifact_id
      ? await this.db
          .selectFrom("artifacts")
          .selectAll()
          .where("id", "=", meeting.primary_transcript_artifact_id)
          .executeTakeFirst()
      : undefined;

    if (!transcriptArtifact || transcriptArtifact.kind !== "transcript" || transcriptArtifact.format !== "json") {
      transcriptArtifact = await this.db
        .selectFrom("artifacts")
        .selectAll()
        .where("meeting_id", "=", meetingId)
        .where("kind", "=", "transcript")
        .where("format", "=", "json")
        .orderBy("created_at", "desc")
        .executeTakeFirst();
    }

    if (!transcriptArtifact) {
      throw new Error(`No JSON transcript artifact found for meeting ${meetingId}`);
    }

    const folder = meetingPaths(this.meetingsDir, meeting.start_time, meeting.title, meeting.id).folder;
    const jsonPath = join(folder, transcriptArtifact.path);
    const rawContent = await readFile(jsonPath, "utf8");
    const parsedData = JSON.parse(rawContent);

    const { segments, isArrayFormat, language, durationMs, speakers } = extractTranscriptSegments(parsedData);
    if (segmentIndex < 0 || segmentIndex >= segments.length) {
      throw new Error(`Invalid segment index ${segmentIndex} (total ${segments.length})`);
    }

    const segment = segments[segmentIndex];
    const targetName = options.speakerName?.trim() || segment.speaker?.trim() || "Speaker";

    let targetSpeakerRow: SpeakerRow | undefined;
    if (options.speakerId) {
      targetSpeakerRow = await this.db
        .selectFrom("speakers")
        .selectAll()
        .where("id", "=", options.speakerId)
        .executeTakeFirst();
    } else {
      const all = await this.db.selectFrom("speakers").selectAll().execute();
      targetSpeakerRow = all.find((s) => s.name.trim().toLowerCase() === targetName.toLowerCase());
    }

    if (!targetSpeakerRow) {
      const newId = randomUUID();
      await this.db
        .insertInto("speakers")
        .values({
          id: newId,
          name: targetName,
          provider_ids: "{}",
          enrolled_at: null,
          enrollment_clip_paths: "[]",
          created_at: currentTime
        })
        .execute();

      targetSpeakerRow = await this.db
        .selectFrom("speakers")
        .selectAll()
        .where("id", "=", newId)
        .executeTakeFirstOrThrow();
    }

    segment.speaker = targetSpeakerRow.name;
    segment.verified = true;
    if (segment.words && Array.isArray(segment.words)) {
      for (const w of segment.words) {
        w.speaker = targetSpeakerRow.name;
      }
    }

    let voiceprintEnrolled = false;
    let voiceprintStatus: VoiceprintEnrollmentStatus = "not_available";
    let statusReason: string | undefined;
    let similarity: number | undefined;

    const recording = await this.db
      .selectFrom("recordings")
      .selectAll()
      .where("meeting_id", "=", meetingId)
      .orderBy("created_at", "asc")
      .executeTakeFirst();

    if (recording) {
      const audioFullPath = join(folder, recording.path);
      if (existsSync(audioFullPath)) {
        try {
          const audioBytes = new Uint8Array(await readFile(audioFullPath));
          if (audioBytes.byteLength >= 12) {
            const decoded = await loadAudioSamples({ audioPath: audioFullPath, audioBytes, enhance: false }, 16000);
            const fullSamples = decoded.samples;
            const sStart = Math.floor((segment.startMs / 1000) * 16000);
            const sEnd = Math.min(fullSamples.length, Math.floor((segment.endMs / 1000) * 16000));

            if (sEnd > sStart) {
              const segSamples = fullSamples.subarray(sStart, sEnd);
              const clipFilename = `clip_confirmed_meeting_${meetingId}_${segmentIndex}_${currentTime}.wav`;
              const adoptResult = await this.adoptVoiceprintSample({
                speakerRow: targetSpeakerRow,
                samples: segSamples,
                sampleRate: 16000,
                clipFilename,
                isAnchor: false,
                meetingId,
                segmentIndex
              });

              voiceprintEnrolled = adoptResult.voiceprintEnrolled;
              voiceprintStatus = adoptResult.status;
              statusReason = adoptResult.statusReason;
              similarity = adoptResult.similarity;

              if (adoptResult.voiceprintEnrolled) {
                targetSpeakerRow = adoptResult.updatedSpeakerRow;
              }
            }
          }
        } catch (err) {
          this.logger.warn("Could not extract audio clip during segment confirmation", {
            meetingId,
            segmentIndex,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }

    const updatedTranscript: Transcript = {
      segments,
      language: language ?? parsedData.language,
      durationMs: durationMs ?? parsedData.durationMs,
      speakers: speakers ?? parsedData.speakers
    };

    const dataToSave = isArrayFormat ? segments : updatedTranscript;
    const tmpJson = `${jsonPath}.tmp`;
    await writeFile(tmpJson, `${JSON.stringify(dataToSave, null, 2)}\n`, "utf8");
    await rename(tmpJson, jsonPath);

    const txtPath = join(folder, transcriptArtifact.path.replace(/\.json$/, ".txt"));
    const tmpTxt = `${txtPath}.tmp`;
    await writeFile(tmpTxt, `${transcriptToText(updatedTranscript)}\n`, "utf8");
    await rename(tmpTxt, txtPath);

    await this.db
      .insertInto("meeting_speakers")
      .values({
        meeting_id: meetingId,
        speaker_id: targetSpeakerRow.id,
        evidence_artifact_id: transcriptArtifact.id
      })
      .onConflict((conflict) =>
        conflict.columns(["meeting_id", "speaker_id"]).doUpdateSet({
          evidence_artifact_id: transcriptArtifact.id
        })
      )
      .execute();

    return {
      speaker: toSpeaker(targetSpeakerRow),
      transcript: updatedTranscript,
      segmentIndex,
      voiceprintEnrolled,
      voiceprintStatus,
      statusReason,
      similarity
    };
  }

  async unassignMeetingSegmentSpeaker(
    options: UnassignMeetingSegmentSpeakerOptions
  ): Promise<UnassignMeetingSegmentSpeakerResult> {
    const { meetingId, segmentIndex } = options;

    const meeting = await this.db
      .selectFrom("meetings")
      .selectAll()
      .where("id", "=", meetingId)
      .executeTakeFirst();

    if (!meeting) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }

    if (!this.meetingsDir) {
      throw new Error("meetingsDir is required to unassign meeting segment");
    }

    let transcriptArtifact = meeting.primary_transcript_artifact_id
      ? await this.db
          .selectFrom("artifacts")
          .selectAll()
          .where("id", "=", meeting.primary_transcript_artifact_id)
          .executeTakeFirst()
      : undefined;

    if (!transcriptArtifact || transcriptArtifact.kind !== "transcript" || transcriptArtifact.format !== "json") {
      transcriptArtifact = await this.db
        .selectFrom("artifacts")
        .selectAll()
        .where("meeting_id", "=", meetingId)
        .where("kind", "=", "transcript")
        .where("format", "=", "json")
        .orderBy("created_at", "desc")
        .executeTakeFirst();
    }

    if (!transcriptArtifact) {
      throw new Error(`No JSON transcript artifact found for meeting ${meetingId}`);
    }

    const folder = meetingPaths(this.meetingsDir, meeting.start_time, meeting.title, meeting.id).folder;
    const jsonPath = join(folder, transcriptArtifact.path);
    const rawContent = await readFile(jsonPath, "utf8");
    const parsedData = JSON.parse(rawContent);

    const { segments, isArrayFormat, language, durationMs, speakers } = extractTranscriptSegments(parsedData);
    if (segmentIndex < 0 || segmentIndex >= segments.length) {
      throw new Error(`Invalid segment index ${segmentIndex} (total ${segments.length})`);
    }

    const segment = segments[segmentIndex];
    segment.speaker = "Unknown";
    segment.verified = false;
    if (segment.words && Array.isArray(segment.words)) {
      for (const w of segment.words) {
        w.speaker = "Unknown";
      }
    }

    const updatedTranscript: Transcript = {
      segments,
      language: language ?? parsedData.language,
      durationMs: durationMs ?? parsedData.durationMs,
      speakers: speakers ?? parsedData.speakers
    };

    const dataToSave = isArrayFormat ? segments : updatedTranscript;
    const tmpJson = `${jsonPath}.tmp`;
    await writeFile(tmpJson, `${JSON.stringify(dataToSave, null, 2)}\n`, "utf8");
    await rename(tmpJson, jsonPath);

    const txtPath = join(folder, transcriptArtifact.path.replace(/\.json$/, ".txt"));
    const tmpTxt = `${txtPath}.tmp`;
    await writeFile(tmpTxt, `${transcriptToText(updatedTranscript)}\n`, "utf8");
    await rename(tmpTxt, txtPath);

    const distinctSpeakerNames = new Set(
      segments.map((s) => (s.speaker || "").trim().toLowerCase()).filter(Boolean)
    );

    const allDbSpeakers = await this.db.selectFrom("speakers").selectAll().execute();
    const linkedSpeakers = await this.db
      .selectFrom("meeting_speakers")
      .selectAll()
      .where("meeting_id", "=", meetingId)
      .execute();

    for (const link of linkedSpeakers) {
      const spk = allDbSpeakers.find((s) => s.id === link.speaker_id);
      if (spk && !distinctSpeakerNames.has(spk.name.trim().toLowerCase())) {
        await this.db
          .deleteFrom("meeting_speakers")
          .where("meeting_id", "=", meetingId)
          .where("speaker_id", "=", link.speaker_id)
          .execute();
      }
    }

    return {
      transcript: updatedTranscript,
      segmentIndex
    };
  }

  async splitMeetingSegment(
    options: SplitMeetingSegmentOptions
  ): Promise<SplitMeetingSegmentResult> {
    const { meetingId, segmentIndex } = options;
    const currentTime = this.now();

    const meeting = await this.db
      .selectFrom("meetings")
      .selectAll()
      .where("id", "=", meetingId)
      .executeTakeFirst();

    if (!meeting) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }

    if (!this.meetingsDir) {
      throw new Error("meetingsDir is required to split meeting segment");
    }

    let transcriptArtifact = meeting.primary_transcript_artifact_id
      ? await this.db
          .selectFrom("artifacts")
          .selectAll()
          .where("id", "=", meeting.primary_transcript_artifact_id)
          .executeTakeFirst()
      : undefined;

    if (!transcriptArtifact || transcriptArtifact.kind !== "transcript" || transcriptArtifact.format !== "json") {
      transcriptArtifact = await this.db
        .selectFrom("artifacts")
        .selectAll()
        .where("meeting_id", "=", meetingId)
        .where("kind", "=", "transcript")
        .where("format", "=", "json")
        .orderBy("created_at", "desc")
        .executeTakeFirst();
    }

    if (!transcriptArtifact) {
      throw new Error(`No JSON transcript artifact found for meeting ${meetingId}`);
    }

    const folder = meetingPaths(this.meetingsDir, meeting.start_time, meeting.title, meeting.id).folder;
    const jsonPath = join(folder, transcriptArtifact.path);
    const rawContent = await readFile(jsonPath, "utf8");
    const parsedData = JSON.parse(rawContent);

    const { segments, isArrayFormat, language, durationMs, speakers } = extractTranscriptSegments(parsedData);
    if (segmentIndex < 0 || segmentIndex >= segments.length) {
      throw new Error(`Invalid segment index ${segmentIndex} (total ${segments.length})`);
    }

    const targetSeg = segments[segmentIndex];
    let secondSpeakerName = options.newSpeakerName?.trim() || targetSeg.speaker;

    let targetSpeakerRow: SpeakerRow | undefined;
    if (options.newSpeakerId) {
      targetSpeakerRow = await this.db
        .selectFrom("speakers")
        .selectAll()
        .where("id", "=", options.newSpeakerId)
        .executeTakeFirst();
      if (targetSpeakerRow) {
        secondSpeakerName = targetSpeakerRow.name;
      }
    } else if (options.newSpeakerName && options.newSpeakerName.trim()) {
      const all = await this.db.selectFrom("speakers").selectAll().execute();
      targetSpeakerRow = all.find((s) => s.name.trim().toLowerCase() === secondSpeakerName.toLowerCase());

      if (!targetSpeakerRow) {
        const newId = randomUUID();
        await this.db
          .insertInto("speakers")
          .values({
            id: newId,
            name: secondSpeakerName,
            provider_ids: "{}",
            enrolled_at: null,
            enrollment_clip_paths: "[]",
            created_at: currentTime
          })
          .execute();

        targetSpeakerRow = await this.db
          .selectFrom("speakers")
          .selectAll()
          .where("id", "=", newId)
          .executeTakeFirstOrThrow();
      }
    }

    let firstSeg: TranscriptSegment;
    let secondSeg: TranscriptSegment;

    if (targetSeg.words && targetSeg.words.length > 0) {
      let splitWordIdx: number;
      if (options.wordIndex !== undefined) {
        splitWordIdx = Math.max(1, Math.min(targetSeg.words.length - 1, options.wordIndex));
      } else if (options.splitMs !== undefined) {
        splitWordIdx = targetSeg.words.findIndex((w) => w.startMs >= options.splitMs!);
        if (splitWordIdx <= 0) splitWordIdx = Math.floor(targetSeg.words.length / 2);
      } else {
        splitWordIdx = Math.floor(targetSeg.words.length / 2);
      }

      const words1 = targetSeg.words.slice(0, splitWordIdx);
      const words2 = targetSeg.words.slice(splitWordIdx);

      const endMs1 = words1[words1.length - 1]?.endMs ?? Math.round((targetSeg.startMs + targetSeg.endMs) / 2);
      const startMs2 = words2[0]?.startMs ?? endMs1;

      if (secondSpeakerName !== targetSeg.speaker) {
        for (const w of words2) {
          w.speaker = secondSpeakerName;
        }
      }

      firstSeg = {
        startMs: targetSeg.startMs,
        endMs: endMs1,
        speaker: targetSeg.speaker,
        text: words1.map((w) => w.word).join(" "),
        verified: targetSeg.verified,
        words: words1
      };

      secondSeg = {
        startMs: startMs2,
        endMs: targetSeg.endMs,
        speaker: secondSpeakerName,
        text: words2.map((w) => w.word).join(" "),
        verified: false,
        words: words2
      };
    } else {
      const words = targetSeg.text.split(/\s+/).filter(Boolean);
      let splitWordIdx: number;
      if (options.wordIndex !== undefined) {
        splitWordIdx = Math.max(1, Math.min(words.length - 1, options.wordIndex));
      } else if (options.splitMs !== undefined) {
        const ratio = Math.max(0.1, Math.min(0.9, (options.splitMs - targetSeg.startMs) / Math.max(1, targetSeg.endMs - targetSeg.startMs)));
        splitWordIdx = Math.max(1, Math.min(words.length - 1, Math.round(ratio * words.length)));
      } else {
        splitWordIdx = Math.max(1, Math.floor(words.length / 2));
      }

      const text1 = words.slice(0, splitWordIdx).join(" ");
      const text2 = words.slice(splitWordIdx).join(" ");
      const ratio = splitWordIdx / Math.max(1, words.length);
      const splitTime = Math.round(targetSeg.startMs + ratio * (targetSeg.endMs - targetSeg.startMs));

      firstSeg = {
        startMs: targetSeg.startMs,
        endMs: splitTime,
        speaker: targetSeg.speaker,
        text: text1,
        verified: targetSeg.verified
      };

      secondSeg = {
        startMs: splitTime,
        endMs: targetSeg.endMs,
        speaker: secondSpeakerName,
        text: text2,
        verified: false
      };
    }

    segments.splice(segmentIndex, 1, firstSeg, secondSeg);

    const updatedTranscript: Transcript = {
      segments,
      language: language ?? parsedData.language,
      durationMs: durationMs ?? parsedData.durationMs,
      speakers: speakers ?? parsedData.speakers
    };

    const dataToSave = isArrayFormat ? segments : updatedTranscript;
    const tmpJson = `${jsonPath}.tmp`;
    await writeFile(tmpJson, `${JSON.stringify(dataToSave, null, 2)}\n`, "utf8");
    await rename(tmpJson, jsonPath);

    const txtPath = join(folder, transcriptArtifact.path.replace(/\.json$/, ".txt"));
    const tmpTxt = `${txtPath}.tmp`;
    await writeFile(tmpTxt, `${transcriptToText(updatedTranscript)}\n`, "utf8");
    await rename(tmpTxt, txtPath);

    if (targetSpeakerRow) {
      await this.db
        .insertInto("meeting_speakers")
        .values({
          meeting_id: meetingId,
          speaker_id: targetSpeakerRow.id,
          evidence_artifact_id: transcriptArtifact.id
        })
        .onConflict((conflict) =>
          conflict.columns(["meeting_id", "speaker_id"]).doUpdateSet({
            evidence_artifact_id: transcriptArtifact.id
          })
        )
        .execute();
    }

    return {
      transcript: updatedTranscript,
      firstSegmentIndex: segmentIndex,
      secondSegmentIndex: segmentIndex + 1
    };
  }

  async mergeMeetingSegments(
    options: MergeMeetingSegmentsOptions
  ): Promise<MergeMeetingSegmentsResult> {
    const { meetingId, segmentIndex } = options;

    const meeting = await this.db
      .selectFrom("meetings")
      .selectAll()
      .where("id", "=", meetingId)
      .executeTakeFirst();

    if (!meeting) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }

    if (!this.meetingsDir) {
      throw new Error("meetingsDir is required to merge meeting segments");
    }

    let transcriptArtifact = meeting.primary_transcript_artifact_id
      ? await this.db
          .selectFrom("artifacts")
          .selectAll()
          .where("id", "=", meeting.primary_transcript_artifact_id)
          .executeTakeFirst()
      : undefined;

    if (!transcriptArtifact || transcriptArtifact.kind !== "transcript" || transcriptArtifact.format !== "json") {
      transcriptArtifact = await this.db
        .selectFrom("artifacts")
        .selectAll()
        .where("meeting_id", "=", meetingId)
        .where("kind", "=", "transcript")
        .where("format", "=", "json")
        .orderBy("created_at", "desc")
        .executeTakeFirst();
    }

    if (!transcriptArtifact) {
      throw new Error(`No JSON transcript artifact found for meeting ${meetingId}`);
    }

    const folder = meetingPaths(this.meetingsDir, meeting.start_time, meeting.title, meeting.id).folder;
    const jsonPath = join(folder, transcriptArtifact.path);
    const rawContent = await readFile(jsonPath, "utf8");
    const parsedData = JSON.parse(rawContent);

    const { segments, isArrayFormat, language, durationMs, speakers } = extractTranscriptSegments(parsedData);
    if (segmentIndex < 0 || segmentIndex >= segments.length - 1) {
      throw new Error(`Cannot merge segment ${segmentIndex} with next (total segments: ${segments.length})`);
    }

    const segA = segments[segmentIndex];
    const segB = segments[segmentIndex + 1];

    const mergedWords =
      segA.words && segB.words
        ? [...segA.words, ...segB.words]
        : segA.words || segB.words
        ? [...(segA.words || []), ...(segB.words || [])]
        : undefined;

    const mergedSeg: TranscriptSegment = {
      startMs: segA.startMs,
      endMs: Math.max(segA.endMs, segB.endMs),
      speaker: segA.speaker,
      text: `${segA.text.trim()} ${segB.text.trim()}`.trim(),
      verified: Boolean(segA.verified && segB.verified && segA.speaker === segB.speaker),
      words: mergedWords
    };

    segments.splice(segmentIndex, 2, mergedSeg);

    const updatedTranscript: Transcript = {
      segments,
      language: language ?? parsedData.language,
      durationMs: durationMs ?? parsedData.durationMs,
      speakers: speakers ?? parsedData.speakers
    };

    const dataToSave = isArrayFormat ? segments : updatedTranscript;
    const tmpJson = `${jsonPath}.tmp`;
    await writeFile(tmpJson, `${JSON.stringify(dataToSave, null, 2)}\n`, "utf8");
    await rename(tmpJson, jsonPath);

    const txtPath = join(folder, transcriptArtifact.path.replace(/\.json$/, ".txt"));
    const tmpTxt = `${txtPath}.tmp`;
    await writeFile(tmpTxt, `${transcriptToText(updatedTranscript)}\n`, "utf8");
    await rename(tmpTxt, txtPath);

    const distinctSpeakerNames = new Set(
      segments.map((s) => (s.speaker || "").trim().toLowerCase()).filter(Boolean)
    );

    const allDbSpeakers = await this.db.selectFrom("speakers").selectAll().execute();
    const linkedSpeakers = await this.db
      .selectFrom("meeting_speakers")
      .selectAll()
      .where("meeting_id", "=", meetingId)
      .execute();

    for (const link of linkedSpeakers) {
      const spk = allDbSpeakers.find((s) => s.id === link.speaker_id);
      if (spk && !distinctSpeakerNames.has(spk.name.trim().toLowerCase())) {
        await this.db
          .deleteFrom("meeting_speakers")
          .where("meeting_id", "=", meetingId)
          .where("speaker_id", "=", link.speaker_id)
          .execute();
      }
    }

    return {
      transcript: updatedTranscript,
      segmentIndex
    };
  }

  async mergeSpeakers(sourceSpeakerId: string, targetSpeakerId: string): Promise<Speaker> {
    if (sourceSpeakerId === targetSpeakerId) {
      throw new Error("Cannot merge speaker with themselves");
    }

    const [source, target] = await Promise.all([
      this.db.selectFrom("speakers").selectAll().where("id", "=", sourceSpeakerId).executeTakeFirst(),
      this.db.selectFrom("speakers").selectAll().where("id", "=", targetSpeakerId).executeTakeFirst()
    ]);

    if (!source) throw new Error(`Source speaker not found: ${sourceSpeakerId}`);
    if (!target) throw new Error(`Target speaker not found: ${targetSpeakerId}`);

    const sourceProviderIds = parseJsonField<Record<string, string[]>>(source.provider_ids, {});
    const targetProviderIds = parseJsonField<Record<string, string[]>>(target.provider_ids, {});
    const sourceClips = parseJsonField<string[]>(source.enrollment_clip_paths, []);
    const targetClips = parseJsonField<string[]>(target.enrollment_clip_paths, []);

    // Merge Speechmatics voiceprint identifiers
    const combinedSmIds = new Set([
      ...(targetProviderIds.speechmatics ?? []),
      ...(sourceProviderIds.speechmatics ?? [])
    ]);
    if (combinedSmIds.size > 0) {
      targetProviderIds.speechmatics = Array.from(combinedSmIds);
    }

    // Merge Local independent trusted voiceprints
    const combinedLocal = Array.from(new Set([
      ...(targetProviderIds.local ?? []),
      ...(sourceProviderIds.local ?? [])
    ]));
    if (combinedLocal.length > 0) {
      targetProviderIds.local = combinedLocal;
    }

    let combinedClips = Array.from(new Set([...targetClips, ...sourceClips]));
    if (combinedClips.length > MAX_ENROLLMENT_CLIPS) {
      const anchor = combinedClips[0];
      const otherClips = combinedClips.slice(1);
      const keepCount = MAX_ENROLLMENT_CLIPS - 1;
      const keptOthers = otherClips.slice(-keepCount);
      const evictedOthers = otherClips.slice(0, -keepCount);
      for (const evictedRel of evictedOthers) {
        try {
          const evictedFull = join(this.configDir, evictedRel);
          if (existsSync(evictedFull)) {
            await unlink(evictedFull);
          }
        } catch {}
      }
      combinedClips = [anchor, ...keptOthers];
    }
    const enrolledAt = target.enrolled_at || source.enrolled_at || null;

    await this.db
      .updateTable("speakers")
      .set({
        provider_ids: JSON.stringify(targetProviderIds),
        enrollment_clip_paths: JSON.stringify(combinedClips),
        enrolled_at: enrolledAt
      })
      .where("id", "=", targetSpeakerId)
      .execute();

    const sourceMeetingLinks = await this.db
      .selectFrom("meeting_speakers")
      .selectAll()
      .where("speaker_id", "=", sourceSpeakerId)
      .execute();

    for (const link of sourceMeetingLinks) {
      await this.db
        .insertInto("meeting_speakers")
        .values({
          meeting_id: link.meeting_id,
          speaker_id: targetSpeakerId,
          evidence_artifact_id: link.evidence_artifact_id
        })
        .onConflict((conflict) =>
          conflict.columns(["meeting_id", "speaker_id"]).doUpdateSet({
            evidence_artifact_id: link.evidence_artifact_id
          })
        )
        .execute();
    }

    await this.db.deleteFrom("meeting_speakers").where("speaker_id", "=", sourceSpeakerId).execute();
    await this.db.deleteFrom("speakers").where("id", "=", sourceSpeakerId).execute();

    const updatedTarget = await this.db
      .selectFrom("speakers")
      .selectAll()
      .where("id", "=", targetSpeakerId)
      .executeTakeFirstOrThrow();

    return toSpeaker(updatedTarget);
  }

  async enrollSpeaker(options: EnrollSpeakerOptions): Promise<Speaker> {
    const currentTime = this.now();
    const name = options.name.trim();
    if (!name) {
      throw new Error("Speaker name is required");
    }

    let speakerRow: SpeakerRow | undefined;
    if (options.speakerId) {
      speakerRow = await this.db
        .selectFrom("speakers")
        .selectAll()
        .where("id", "=", options.speakerId)
        .executeTakeFirst();
    } else {
      const all = await this.db.selectFrom("speakers").selectAll().execute();
      speakerRow = all.find((s) => s.name.trim().toLowerCase() === name.toLowerCase());
    }

    const speakerId = speakerRow?.id ?? options.speakerId ?? randomUUID();

    // 1. Validate audio duration & deduplicate by content hash
    const decoded = await loadAudioSamples({ audioBytes: options.audioBytes, enhance: false }, 16000);
    const durationSec = decoded.samples.length / 16000;

    if (durationSec < 2.5) {
      throw new Error(
        `Enrollment audio clip duration too short (${durationSec.toFixed(1)}s). Must be between 3 and 30 seconds.`
      );
    }
    if (durationSec > 35.0) {
      throw new Error(
        `Enrollment audio clip duration too long (${durationSec.toFixed(1)}s). Must be between 3 and 30 seconds to ensure single-speaker sample.`
      );
    }

    const clipHash = createHash("sha256").update(options.audioBytes).digest("hex");

    // Cross-speaker conflict check
    const allDbSpeakers = await this.db.selectFrom("speakers").selectAll().execute();
    for (const otherSpk of allDbSpeakers) {
      if (otherSpk.id !== speakerId) {
        const otherClips = parseJsonField<string[]>(otherSpk.enrollment_clip_paths, []);
        for (const otherRel of otherClips) {
          const otherFull = join(this.configDir, otherRel);
          if (existsSync(otherFull)) {
            try {
              const otherBytes = new Uint8Array(await readFile(otherFull));
              const otherHash = createHash("sha256").update(otherBytes).digest("hex");
              if (otherHash === clipHash) {
                throw new Error(
                  `Cannot enroll clip: exact audio content is already enrolled under speaker "${otherSpk.name}"`
                );
              }
            } catch (err) {
              if (err instanceof Error && err.message.includes("already enrolled")) {
                throw err;
              }
            }
          }
        }
      }
    }

    // 2. Save enrollment clip to disk
    const ext = options.filename ? extname(options.filename).slice(1) || "wav" : "wav";
    const speakerFolder = join(this.configDir, "speakers", speakerId);
    await mkdir(speakerFolder, { recursive: true });
    const clipFilename = `clip_${currentTime}.${ext}`;
    const clipRelativePath = join("speakers", speakerId, clipFilename);
    await writeFile(join(this.configDir, clipRelativePath), options.audioBytes);

    const existingProviderIds = speakerRow
      ? parseJsonField<Record<string, string[]>>(speakerRow.provider_ids, {})
      : {};
    const existingClips = speakerRow
      ? parseJsonField<string[]>(speakerRow.enrollment_clip_paths, [])
      : [];
    const existingLocal = existingProviderIds.local ?? [];

    if (existingClips.length >= MAX_ENROLLMENT_CLIPS) {
      if (existingClips.length > 1) {
        const evictedRel = existingClips.splice(1, 1)[0];
        if (existingLocal.length > 1) {
          existingLocal.splice(1, 1);
        }
        try {
          const evictedFull = join(this.configDir, evictedRel);
          if (existsSync(evictedFull)) {
            await unlink(evictedFull);
          }
        } catch (err) {
          this.logger.warn("Could not delete evicted enrollment clip", {
            path: evictedRel,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }

    if (!existingClips.includes(clipRelativePath)) {
      existingClips.push(clipRelativePath);
    }

    const providerMode = options.provider ?? "both";

    // 3. Extract Neural Speaker Embedding Vector
    if (providerMode === "local" || providerMode === "both") {
      try {
        const localEmbedding = await this.localEmbeddingExtractor.extract(decoded.samples, 16000);
        existingLocal.push(JSON.stringify(localEmbedding));
        existingProviderIds.local = existingLocal;
      } catch (err) {
        this.logger.warn("Could not compute local voiceprint from audio clip", {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    // 4. Submit enrollment job to Speechmatics if available
    if (providerMode === "speechmatics" || providerMode === "both") {
      try {
        const submitResult = await this.client.submitJob({
          audio: options.audioBytes,
          filename: options.filename || clipFilename,
          mime: options.mime || "audio/wav",
          language: options.language || "en",
          getSpeakers: true
        });

        const pollIntervalMs = options.pollIntervalMs ?? 2000;
        const maxWaitMs = options.maxPollWaitMs ?? 180_000;
        const startTime = this.now();

        let jsonV2: SpeechmaticsJsonV2 | undefined;
        while (this.now() - startTime < maxWaitMs) {
          const status = await this.client.getJob(submitResult.id);

          if (status.status === "done") {
            jsonV2 = (await this.client.getTranscript(submitResult.id, "json-v2")) as SpeechmaticsJsonV2;
            break;
          }

          if (status.status === "rejected" || status.status === "deleted") {
            const errorMsg =
              status.errors && status.errors.length > 0
                ? status.errors.map((e) => e.message).join("; ")
                : `Enrollment job ${status.status}`;
            throw new Error(`Speechmatics enrollment failed: ${errorMsg}`);
          }

          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }

        if (jsonV2) {
          const extractedIdentifiers: string[] = [];
          for (const s of (jsonV2.speakers ?? []) as any[]) {
            const identifiers =
              s.speaker_identifiers instanceof Set
                ? Array.from(s.speaker_identifiers)
                : Array.isArray(s.speaker_identifiers)
                ? s.speaker_identifiers
                : [];
            for (const id of identifiers) {
              if (id && !extractedIdentifiers.includes(id)) {
                extractedIdentifiers.push(id);
              }
            }
          }

          const existingSmIds = new Set(existingProviderIds.speechmatics ?? []);
          for (const id of extractedIdentifiers) {
            existingSmIds.add(id);
          }
          existingProviderIds.speechmatics = Array.from(existingSmIds);

          try {
            await this.client.deleteJob(submitResult.id);
          } catch {}
        }
      } catch (smErr) {
        if (providerMode === "speechmatics") {
          throw smErr;
        }
        this.logger.warn("Speechmatics enrollment failed during multi-provider enroll", {
          error: smErr instanceof Error ? smErr.message : String(smErr)
        });
      }
    }

    // 5. Update database record
    if (speakerRow) {
      await this.db
        .updateTable("speakers")
        .set({
          name,
          provider_ids: JSON.stringify(existingProviderIds),
          enrolled_at: currentTime,
          enrollment_clip_paths: JSON.stringify(existingClips)
        })
        .where("id", "=", speakerRow.id)
        .execute();
    } else {
      await this.db
        .insertInto("speakers")
        .values({
          id: speakerId,
          name,
          provider_ids: JSON.stringify(existingProviderIds),
          enrolled_at: currentTime,
          enrollment_clip_paths: JSON.stringify(existingClips),
          created_at: currentTime
        })
        .execute();
    }

    const updated = await this.db
      .selectFrom("speakers")
      .selectAll()
      .where("id", "=", speakerId)
      .executeTakeFirstOrThrow();

    return toSpeaker(updated);
  }

  async linkMeetingSpeaker(options: {
    meetingId: string;
    speakerId: string;
    speechmaticsLabel?: string;
  }): Promise<{ speaker: Speaker }> {
    const { meetingId, speakerId, speechmaticsLabel } = options;

    const speakerRow = await this.db
      .selectFrom("speakers")
      .selectAll()
      .where("id", "=", speakerId)
      .executeTakeFirst();

    if (!speakerRow) {
      throw new Error(`Speaker not found: ${speakerId}`);
    }

    const meetingRow = await this.db
      .selectFrom("meetings")
      .selectAll()
      .where("id", "=", meetingId)
      .executeTakeFirst();

    if (!meetingRow) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }

    await this.db
      .insertInto("meeting_speakers")
      .values({
        meeting_id: meetingId,
        speaker_id: speakerId,
        evidence_artifact_id: meetingRow.primary_transcript_artifact_id
      })
      .onConflict((conflict) =>
        conflict.columns(["meeting_id", "speaker_id"]).doUpdateSet({
          evidence_artifact_id: meetingRow.primary_transcript_artifact_id
        })
      )
      .execute();

    if (speechmaticsLabel && this.meetingsDir) {
      const folder = meetingPaths(
        this.meetingsDir,
        meetingRow.start_time,
        meetingRow.title,
        meetingRow.id
      ).folder;
      const transcriptArtifact = await this.db
        .selectFrom("artifacts")
        .selectAll()
        .where("meeting_id", "=", meetingId)
        .where("provider", "=", "speechmatics")
        .where("kind", "=", "transcript")
        .where("format", "=", "json")
        .executeTakeFirst();

      if (transcriptArtifact) {
        try {
          const rawContent = await readFile(join(folder, transcriptArtifact.path), "utf8");
          const parsed = JSON.parse(rawContent);
          if (parsed.speakers && Array.isArray(parsed.speakers)) {
            const match = parsed.speakers.find(
              (s: any) => (s.label || s.speaker || "").trim() === speechmaticsLabel.trim()
            );
            if (match && match.speaker_identifiers) {
              const ids = Array.isArray(match.speaker_identifiers)
                ? match.speaker_identifiers
                : Array.from(match.speaker_identifiers);
              const providerIds = parseJsonField<Record<string, string[]>>(speakerRow.provider_ids, {});
              const currentSmIds = new Set(providerIds.speechmatics ?? []);
              for (const id of ids as string[]) {
                currentSmIds.add(id);
              }
              providerIds.speechmatics = Array.from(currentSmIds);

              await this.db
                .updateTable("speakers")
                .set({
                  provider_ids: JSON.stringify(providerIds),
                  enrolled_at: speakerRow.enrolled_at ?? this.now()
                })
                .where("id", "=", speakerId)
                .execute();
            }
          }
        } catch {}
      }
    }

    const updated = await this.db
      .selectFrom("speakers")
      .selectAll()
      .where("id", "=", speakerId)
      .executeTakeFirstOrThrow();

    return { speaker: toSpeaker(updated) };
  }

  async updateSpeaker(
    id: string,
    updates: { name?: string; providerIds?: Record<string, string[]> }
  ): Promise<Speaker> {
    const setValues: Partial<SpeakerRow> = {};
    if (updates.name !== undefined) {
      setValues.name = updates.name.trim();
    }
    if (updates.providerIds !== undefined) {
      setValues.provider_ids = JSON.stringify(updates.providerIds);
    }

    if (Object.keys(setValues).length > 0) {
      await this.db.updateTable("speakers").set(setValues).where("id", "=", id).execute();
    }

    const updated = await this.db
      .selectFrom("speakers")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();

    return toSpeaker(updated);
  }

  async deleteSpeaker(id: string): Promise<void> {
    await this.db.deleteFrom("meeting_speakers").where("speaker_id", "=", id).execute();
    await this.db.deleteFrom("speakers").where("id", "=", id).execute();
  }

  async syncMeetingSpeakersAndTranscripts(): Promise<{ repairedMeetings: number; prunedSpeakers: number }> {
    if (!this.meetingsDir) {
      return { repairedMeetings: 0, prunedSpeakers: 0 };
    }

    let repairedMeetings = 0;
    let prunedSpeakers = 0;

    const meetings = await this.db.selectFrom("meetings").selectAll().execute();
    const allArtifacts = await this.db.selectFrom("artifacts").selectAll().where("kind", "=", "transcript").execute();

    for (const meeting of meetings) {
      const primaryTranscript = meeting.primary_transcript_artifact_id
        ? allArtifacts.find((a) => a.id === meeting.primary_transcript_artifact_id)
        : allArtifacts.find((a) => a.meeting_id === meeting.id && a.format === "json");

      if (!primaryTranscript || primaryTranscript.format !== "json") continue;

      const folder = meetingPaths(this.meetingsDir, meeting.start_time, meeting.title, meeting.id).folder;
      const jsonPath = join(folder, primaryTranscript.path);
      if (!existsSync(jsonPath)) continue;

      try {
        const raw = await readFile(jsonPath, "utf8");
        const parsed = JSON.parse(raw);
        let segments: TranscriptSegment[] = [];

        if (Array.isArray(parsed.segments)) {
          segments = parsed.segments;
        } else if (Array.isArray(parsed)) {
          segments = parsed
            .filter((item: any) => (item.text && item.text.trim()) || (item.content && item.content.trim()))
            .map((item: any) => ({
              speaker: item.speaker || "Speaker",
              text: item.text || item.content || "",
              startMs: item.startMs ?? item.start_time ?? 0,
              endMs: item.endMs ?? item.end_time ?? 0
            }));
        }

        if (segments.length > 0) {
          const coalesced = coalesceSpeakerSegments(segments, 15000);
          const needsSave = JSON.stringify(coalesced) !== JSON.stringify(segments);

          if (needsSave) {
            const updated = Array.isArray(parsed.segments)
              ? { ...parsed, segments: coalesced }
              : coalesced;
            const tmpJson = `${jsonPath}.tmp`;
            await writeFile(tmpJson, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
            await rename(tmpJson, jsonPath);

            const txtPath = join(folder, primaryTranscript.path.replace(/\.json$/, ".txt"));
            const tmpTxt = `${txtPath}.tmp`;
            await writeFile(tmpTxt, `${transcriptToText({ segments: coalesced })}\n`, "utf8");
            await rename(tmpTxt, txtPath);
            repairedMeetings++;
          }

          const distinctNames = new Set(
            coalesced.map((s) => (s.speaker || "").trim().toLowerCase()).filter(Boolean)
          );

          const linked = await this.db
            .selectFrom("meeting_speakers")
            .innerJoin("speakers", "speakers.id", "meeting_speakers.speaker_id")
            .select(["speakers.id", "speakers.name"])
            .where("meeting_speakers.meeting_id", "=", meeting.id)
            .execute();

          for (const l of linked) {
            if (!distinctNames.has(l.name.trim().toLowerCase())) {
              await this.db
                .deleteFrom("meeting_speakers")
                .where("meeting_id", "=", meeting.id)
                .where("speaker_id", "=", l.id)
                .execute();
            }
          }

          const allSpeakers = await this.db.selectFrom("speakers").selectAll().execute();
          for (const name of distinctNames) {
            const matchedSpeaker = allSpeakers.find(
              (s) => s.name.trim().toLowerCase() === name
            );
            if (matchedSpeaker) {
              await this.db
                .insertInto("meeting_speakers")
                .values({
                  meeting_id: meeting.id,
                  speaker_id: matchedSpeaker.id,
                  evidence_artifact_id: primaryTranscript.id
                })
                .onConflict((c) =>
                  c.columns(["meeting_id", "speaker_id"]).doUpdateSet({
                    evidence_artifact_id: primaryTranscript.id
                  })
                )
                .execute();
            }
          }
        }
      } catch (err) {
        this.logger.warn("Could not sync meeting transcript speakers", {
          meetingId: meeting.id,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    const allSpeakers = await this.db.selectFrom("speakers").selectAll().execute();
    const namedSpeakers = allSpeakers.filter((s) => !(/^speaker\s*\d+$/i.test(s.name.trim()) || /^s\d+$/i.test(s.name.trim())));

    for (const s of allSpeakers) {
      const isPlaceholder = /^speaker\s*\d+$/i.test(s.name.trim()) || /^s\d+$/i.test(s.name.trim());
      const links = await this.db
        .selectFrom("meeting_speakers")
        .selectAll()
        .where("speaker_id", "=", s.id)
        .execute();

      const clips = parseJsonField<string[]>(s.enrollment_clip_paths, []);
      const providerIds = parseJsonField<Record<string, string[]>>(s.provider_ids, {});

      if (isPlaceholder && providerIds.speechmatics?.length && namedSpeakers.length > 0) {
        const primaryUser = namedSpeakers.find((ns) => ns.name.toLowerCase().includes("matt")) || namedSpeakers[0];
        if (primaryUser) {
          const userProviderIds = parseJsonField<Record<string, string[]>>(primaryUser.provider_ids, {});
          if (!userProviderIds.speechmatics?.length) {
            userProviderIds.speechmatics = providerIds.speechmatics;
            await this.db
              .updateTable("speakers")
              .set({
                provider_ids: JSON.stringify(userProviderIds),
                enrolled_at: primaryUser.enrolled_at ?? this.now()
              })
              .where("id", "=", primaryUser.id)
              .execute();
          }
        }
      }

      if (links.length === 0 && (isPlaceholder || (clips.length === 0 && !s.enrolled_at))) {
        await this.db.deleteFrom("speakers").where("id", "=", s.id).execute();
        prunedSpeakers++;
      }
    }

    return { repairedMeetings, prunedSpeakers };
  }
}
