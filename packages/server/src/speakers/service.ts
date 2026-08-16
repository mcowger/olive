import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Kysely } from "kysely";
import type { Database, Speaker, SpeakerRow, Transcript } from "@olive/shared";
import { logger as defaultLogger, type Logger } from "../logger.ts";
import { SpeechmaticsClient } from "../providers/speechmatics/client.ts";
import type { SpeechmaticsJsonV2 } from "../providers/speechmatics/types.ts";
import { meetingPaths } from "../layout.ts";
import { transcriptToText } from "../providers/speechmatics/normalize.ts";

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
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(options: SpeakerServiceOptions) {
    this.db = options.db;
    this.configDir = options.configDir;
    this.meetingsDir = options.meetingsDir;
    this.client = options.speechmaticsClient ?? new SpeechmaticsClient();
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
      await writeFile(jsonPath, `${JSON.stringify(parsedData, null, 2)}\n`, "utf8");

      const txtPath = join(folder, transcriptArtifact.path.replace(/\.json$/, ".txt"));
      const textLines = parsedData
        .filter((item: any) => item.content && item.content.trim())
        .map((item: any) => `${item.speaker || "Speaker"}: ${item.content}`);
      await writeFile(txtPath, `${textLines.join("\n\n")}\n`, "utf8");

      updatedTranscript = {
        segments: parsedData
          .filter((item: any) => item.content && item.content.trim())
          .map((item: any) => ({
            speaker: item.speaker || "Speaker",
            text: item.content,
            startMs: item.start_time ?? 0,
            endMs: item.end_time ?? 0
          }))
      };
    } else {
      // Canonical Transcript format
      const segments: any[] = parsedData.segments ?? [];

      // 3. Adopt voiceprint from the meeting transcript metadata if requested
      if (adoptVoiceprint) {
        const extractedIds: string[] = [];
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

        if (extractedIds.length > 0) {
          extractedVoiceprintsCount = extractedIds.length;
          const providerIds = parseJsonField<Record<string, string[]>>(targetSpeakerRow.provider_ids, {});
          const currentSmIds = new Set(providerIds.speechmatics ?? []);
          for (const id of extractedIds) {
            currentSmIds.add(id);
          }
          providerIds.speechmatics = Array.from(currentSmIds);

          await this.db
            .updateTable("speakers")
            .set({
              provider_ids: JSON.stringify(providerIds),
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

      updatedTranscript = {
        segments,
        language: parsedData.language,
        durationMs: parsedData.durationMs
      };

      await writeFile(jsonPath, `${JSON.stringify(updatedTranscript, null, 2)}\n`, "utf8");

      const txtPath = join(folder, transcriptArtifact.path.replace(/\.json$/, ".txt"));
      await writeFile(txtPath, `${transcriptToText(updatedTranscript)}\n`, "utf8");
    }

    // 6. Link target speaker in meeting_speakers
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

    const combinedSmIds = new Set([
      ...(targetProviderIds.speechmatics ?? []),
      ...(sourceProviderIds.speechmatics ?? [])
    ]);
    targetProviderIds.speechmatics = Array.from(combinedSmIds);

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

    // 2. Submit enrollment job to Speechmatics with get_speakers: true
    const submitResult = await this.client.submitJob({
      audio: options.audioBytes,
      filename: options.filename || clipFilename,
      mime: options.mime || "audio/wav",
      language: options.language || "en",
      getSpeakers: true
    });

    // 3. Poll Speechmatics job until completion
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

    if (!jsonV2) {
      throw new Error(`Speechmatics enrollment timed out after ${maxWaitMs}ms`);
    }

    // 4. Extract generated speaker identifiers
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

    // 5. Delete job from Speechmatics (retention cleanup)
    try {
      await this.client.deleteJob(submitResult.id);
    } catch (err) {
      this.logger.warn("Failed to delete Speechmatics enrollment job", {
        jobId: submitResult.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }

    // 6. Update database record
    const existingProviderIds = speakerRow
      ? parseJsonField<Record<string, string[]>>(speakerRow.provider_ids, {})
      : {};
    const existingClips = speakerRow
      ? parseJsonField<string[]>(speakerRow.enrollment_clip_paths, [])
      : [];

    const existingSmIds = new Set(existingProviderIds.speechmatics ?? []);
    for (const id of extractedIdentifiers) {
      existingSmIds.add(id);
    }
    existingProviderIds.speechmatics = Array.from(existingSmIds);
    existingClips.push(clipRelativePath);

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
}
