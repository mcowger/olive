import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
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
  AcousticFeatureEmbeddingExtractor,
  decodeWav,
  encodeWav,
  loadAudioSamples,
  mergeVoiceprintVectors,
  normalizeVector,
  resample,
  updateVoiceprintCentroid,
  type VoiceprintVector
} from "../providers/local/index.ts";

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
}

export interface ReassignMeetingSpeakerResult {
  speaker: Speaker;
  transcript: Transcript;
  updatedSegmentsCount: number;
  extractedVoiceprintsCount: number;
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
  private readonly localEmbeddingExtractor: AcousticFeatureEmbeddingExtractor;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(options: SpeakerServiceOptions) {
    this.db = options.db;
    this.configDir = options.configDir;
    this.meetingsDir = options.meetingsDir;
    this.client = options.speechmaticsClient ?? new SpeechmaticsClient();
    this.localEmbeddingExtractor = new AcousticFeatureEmbeddingExtractor(192);
    this.logger = options.logger ?? defaultLogger;
    this.now = options.now ?? Date.now;
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
   * Cross-fills voiceprints across providers for all or specific speakers.
   * If a speaker has enrollment clips on disk:
   * - Computes and populates local voiceprints if missing or out-of-date.
   * - Submits enrollment to Speechmatics if missing and client is configured.
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

      // 1. Cross-fill Local Voiceprint from saved audio clips if missing or forced
      if (clips.length > 0 && (!providerIds.local?.length || options.force)) {
        const clipVectors: VoiceprintVector[] = [];
        for (const relPath of clips) {
          const fullPath = join(this.configDir, relPath);
          if (existsSync(fullPath)) {
            try {
              const fileBytes = new Uint8Array(await readFile(fullPath));
              if (fileBytes.byteLength >= 12) {
                const decoded = await loadAudioSamples({ audioBytes: fileBytes, audioPath: fullPath }, 16000);
                const emb = await this.localEmbeddingExtractor.extract(decoded.samples, 16000);
                clipVectors.push(emb);
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
          const merged = mergeVoiceprintVectors(clipVectors);
          providerIds.local = [JSON.stringify(merged)];
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

    // 2. Read meeting transcript artifact (primary or any json transcript)
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

    let updatedTranscript: Transcript;

    if (Array.isArray(parsedData)) {
      // Plaud or legacy array format
      for (const item of parsedData) {
        if (item.speaker && item.speaker.trim().toLowerCase() === normalizedFrom) {
          item.speaker = targetSpeakerRow.name;
          updatedSegmentsCount++;
        }
      }

      const convertedSegments: TranscriptSegment[] = parsedData
        .filter((item: any) => item.content && item.content.trim())
        .map((item: any) => ({
          speaker: item.speaker || "Speaker",
          text: item.content,
          startMs: item.start_time ?? 0,
          endMs: item.end_time ?? 0
        }));

      const coalescedSegments = coalesceSpeakerSegments(convertedSegments, 15000);

      const tmpJson = `${jsonPath}.tmp`;
      await writeFile(tmpJson, `${JSON.stringify(parsedData, null, 2)}\n`, "utf8");
      await rename(tmpJson, jsonPath);

      const txtPath = join(folder, transcriptArtifact.path.replace(/\.json$/, ".txt"));
      const tmpTxt = `${txtPath}.tmp`;
      await writeFile(tmpTxt, `${transcriptToText({ segments: coalescedSegments })}\n`, "utf8");
      await rename(tmpTxt, txtPath);

      updatedTranscript = {
        segments: coalescedSegments
      };
    } else {
      // Canonical Transcript format
      const segments: any[] = parsedData.segments ?? [];

      // 3. Adopt voiceprints across BOTH Speechmatics and Local providers if requested
      if (adoptVoiceprint) {
        const providerIds = parseJsonField<Record<string, string[]>>(targetSpeakerRow.provider_ids, {});
        const clips = parseJsonField<string[]>(targetSpeakerRow.enrollment_clip_paths, []);
        let adoptedAny = false;

        // A. Adopt Speechmatics voiceprint identifiers if in transcript metadata or on disk
        const extractedIds: string[] = [];

        // 1. From current parsed transcript
        const speakerList = (parsedData.speakers ?? []) as any[];
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

        // 2. From transcripts/speechmatics.json in meeting folder if exists
        const smJsonPath = join(folder, "transcripts/speechmatics.json");
        if (existsSync(smJsonPath)) {
          try {
            const smRaw = JSON.parse(await readFile(smJsonPath, "utf8"));
            const smSpeakerList = (smRaw.speakers ?? []) as any[];
            for (const s of smSpeakerList) {
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
          } catch {}
        }

        // 3. From fromLabel speaker in database if present
        const allDbSpeakers = await this.db.selectFrom("speakers").selectAll().execute();
        const fromSpeaker = allDbSpeakers.find((s) => s.name.trim().toLowerCase() === normalizedFrom);
        if (fromSpeaker) {
          const fromProviderIds = parseJsonField<Record<string, string[]>>(fromSpeaker.provider_ids, {});
          for (const id of fromProviderIds.speechmatics ?? []) {
            if (id && !extractedIds.includes(id)) {
              extractedIds.push(id);
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

        // B. Extract speaker's audio from recording on disk to compute Local voiceprint and save clip
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
                const decoded = await loadAudioSamples({ audioPath: audioFullPath, audioBytes }, 16000);
                const fullSamples = decoded.samples;

                // Slice audio from matching speaker segments
                const matchingSegments = segments.filter(
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

                  // 1. Compute and update local voiceprint
                  const newLocalEmbedding = await this.localEmbeddingExtractor.extract(mergedSamples, 16000);
                  const existingLocalVec = providerIds.local?.[0]
                    ? JSON.parse(providerIds.local[0])
                    : undefined;

                  const updatedLocalVec = existingLocalVec
                    ? updateVoiceprintCentroid(existingLocalVec, newLocalEmbedding)
                    : newLocalEmbedding;

                  providerIds.local = [JSON.stringify(updatedLocalVec)];
                  extractedVoiceprintsCount++;
                  adoptedAny = true;

                  // 2. Save extracted audio slice as an enrollment clip
                  const speakerFolder = join(this.configDir, "speakers", targetSpeakerRow.id);
                  await mkdir(speakerFolder, { recursive: true });
                  const clipFilename = `clip_meeting_${meetingId}_${currentTime}.wav`;
                  const clipRelativePath = join("speakers", targetSpeakerRow.id, clipFilename);
                  const clipWavBytes = encodeWav(mergedSamples, 16000);
                  await writeFile(join(this.configDir, clipRelativePath), clipWavBytes);

                  if (!clips.includes(clipRelativePath)) {
                    clips.push(clipRelativePath);
                  }

                  // 3. If Speechmatics identifiers are missing and client is configured, enroll audio slice directly
                  if (this.client?.isConfigured && (!providerIds.speechmatics || providerIds.speechmatics.length === 0)) {
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
                          try {
                            await this.client.deleteJob(enrollJob.id);
                          } catch {}
                          break;
                        }
                        if (status.status === "rejected" || status.status === "deleted") break;
                        await new Promise((r) => setTimeout(r, 1500));
                      }

                      if (extractedIds.length > 0) {
                        const currentSmIds = new Set(providerIds.speechmatics ?? []);
                        for (const id of extractedIds) {
                          currentSmIds.add(id);
                        }
                        providerIds.speechmatics = Array.from(currentSmIds);
                        adoptedAny = true;
                      }
                    } catch (smErr) {
                      this.logger.warn("Could not enroll audio slice with Speechmatics", {
                        error: smErr instanceof Error ? smErr.message : String(smErr)
                      });
                    }
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

        if (adoptedAny) {
          await this.db
            .updateTable("speakers")
            .set({
              provider_ids: JSON.stringify(providerIds),
              enrollment_clip_paths: JSON.stringify(clips),
              enrolled_at: targetSpeakerRow.enrolled_at ?? currentTime
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
      for (const segment of segments) {
        if (segment.speaker && segment.speaker.trim().toLowerCase() === normalizedFrom) {
          segment.speaker = targetSpeakerRow.name;
          updatedSegmentsCount++;
          if (segment.words && Array.isArray(segment.words)) {
            for (const word of segment.words) {
              word.speaker = targetSpeakerRow.name;
            }
          }
        }
      }

      // Coalesce sequential segments from the same speaker into natural conversational turns
      const coalescedSegments = coalesceSpeakerSegments(segments, 15000);

      updatedTranscript = {
        segments: coalescedSegments,
        language: parsedData.language,
        durationMs: parsedData.durationMs
      };

      const tmpJson = `${jsonPath}.tmp`;
      await writeFile(tmpJson, `${JSON.stringify(updatedTranscript, null, 2)}\n`, "utf8");
      await rename(tmpJson, jsonPath);

      const txtPath = join(folder, transcriptArtifact.path.replace(/\.json$/, ".txt"));
      const tmpTxt = `${txtPath}.tmp`;
      await writeFile(tmpTxt, `${transcriptToText(updatedTranscript)}\n`, "utf8");
      await rename(tmpTxt, txtPath);
    }

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

    // 6. Clean up meeting_speakers links for speakers no longer in the transcript
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
      extractedVoiceprintsCount
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

    // Merge Local voiceprint embedding centroids
    const localVectors: VoiceprintVector[] = [];
    if (targetProviderIds.local?.[0]) {
      try {
        localVectors.push(JSON.parse(targetProviderIds.local[0]));
      } catch {}
    }
    if (sourceProviderIds.local?.[0]) {
      try {
        localVectors.push(JSON.parse(sourceProviderIds.local[0]));
      } catch {}
    }
    if (localVectors.length > 0) {
      const mergedVector = mergeVoiceprintVectors(localVectors);
      targetProviderIds.local = [JSON.stringify(mergedVector)];
    }

    const combinedClips = Array.from(new Set([...targetClips, ...sourceClips]));
    const enrolledAt = target.enrolled_at || source.enrolled_at || null;

    // Update target speaker
    await this.db
      .updateTable("speakers")
      .set({
        provider_ids: JSON.stringify(targetProviderIds),
        enrollment_clip_paths: JSON.stringify(combinedClips),
        enrolled_at: enrolledAt
      })
      .where("id", "=", targetSpeakerId)
      .execute();

    // Re-link meetings
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

    // Delete source speaker
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

    // 1. Save enrollment clip to disk
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
    existingClips.push(clipRelativePath);

    // Cross-fill by default across both Local & Speechmatics when audio is provided
    const providerMode = options.provider ?? "both";

    // 2. Extract Local Voiceprint Embedding (cross-filled)
    if ((providerMode === "local" || providerMode === "both") && options.audioBytes.byteLength >= 12) {
      try {
        const decoded = await loadAudioSamples({ audioBytes: options.audioBytes }, 16000);
        const localEmbedding = await this.localEmbeddingExtractor.extract(decoded.samples, 16000);
        const existingLocalVec = existingProviderIds.local?.[0]
          ? JSON.parse(existingProviderIds.local[0])
          : undefined;

        const updatedLocalVec = existingLocalVec
          ? updateVoiceprintCentroid(existingLocalVec, localEmbedding)
          : localEmbedding;

        existingProviderIds.local = [JSON.stringify(updatedLocalVec)];
      } catch (err) {
        this.logger.warn("Could not compute local voiceprint from audio clip", {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    // 3. Submit enrollment job to Speechmatics (cross-filled if available)
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

    // 4. Update database record
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

    // Link in meeting_speakers table
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

    // If a label was given (e.g. S1) and meetingsDir is available, check if we can extract voiceprint IDs from meeting transcript artifact
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
          // If the raw file contains speakers array
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
        } catch {
          // non-fatal if transcript artifact cannot be read
        }
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
            .filter((item: any) => item.content && item.content.trim())
            .map((item: any) => ({
              speaker: item.speaker || "Speaker",
              text: item.content,
              startMs: item.start_time ?? 0,
              endMs: item.end_time ?? 0
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

          // Get linked meeting speakers
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

          // Ensure speakers in distinctNames are linked
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

    // Clean up orphaned placeholder speakers and transfer any orphan Speechmatics identifiers to real speakers if applicable
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

      // If this placeholder has speechmatics identifiers and only 1 named speaker exists (e.g. Matt Cowger), transfer if missing
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

    // Auto cross-fill voiceprints across providers if client is configured
    if (this.client?.isConfigured) {
      try {
        await this.backfillVoiceprints({ force: false });
      } catch {}
    }

    return { repairedMeetings, prunedSpeakers };
  }
}
