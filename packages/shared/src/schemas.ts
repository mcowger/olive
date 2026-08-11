import { z } from "zod";

export const meetingSourceSchema = z.enum(["plaud", "upload", "ios-shortcut"]);
export const meetingStatusSchema = z.enum(["pending", "processing", "ready", "error"]);
export const artifactKindSchema = z.enum(["transcript", "summary"]);
export const artifactFormatSchema = z.enum(["md", "txt", "json", "srt"]);
export const stageRunStatusSchema = z.enum(["pending", "running", "done", "error"]);

const idSchema = z.string().uuid();

export const meetingSchema = z.object({
  id: idSchema,
  title: z.string(),
  startTime: z.number().int(),
  endTime: z.number().int(),
  source: meetingSourceSchema,
  status: meetingStatusSchema,
  tags: z.array(z.string()),
  primaryTranscriptArtifactId: idSchema.nullable(),
  primarySummaryArtifactId: idSchema.nullable(),
  lastError: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
});

export const recordingSchema = z.object({
  id: idSchema,
  meetingId: idSchema,
  path: z.string(),
  mime: z.string(),
  durationMs: z.number().int().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string(),
  provider: meetingSourceSchema,
  providerRecordingId: z.string().nullable(),
  createdAt: z.number().int()
});

export const artifactSchema = z.object({
  id: idSchema,
  meetingId: idSchema,
  recordingId: idSchema.nullable(),
  kind: artifactKindSchema,
  provider: z.string(),
  format: artifactFormatSchema,
  path: z.string(),
  createdAt: z.number().int()
});

export const speakerSchema = z.object({
  id: idSchema,
  name: z.string(),
  providerIds: z.record(z.string(), z.array(z.string())),
  enrolledAt: z.number().int().nullable(),
  enrollmentClipPaths: z.array(z.string()),
  createdAt: z.number().int()
});

export const meetingSpeakerSchema = z.object({
  meetingId: idSchema,
  speakerId: idSchema,
  evidenceArtifactId: idSchema.nullable()
});

export const stageRunSchema = z.object({
  id: idSchema,
  meetingId: idSchema,
  stage: z.string(),
  status: stageRunStatusSchema,
  providerJobId: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
});

export const plaudIngestStateSchema = z.object({
  meetingId: idSchema,
  plaudFileId: z.string(),
  firstSeenAt: z.number().int(),
  pcsDeadlineAt: z.number().int(),
  pcsResolved: z.number().int().min(0).max(1)
});

export const syncStateSchema = z.object({
  key: z.string(),
  value: z.string()
});
