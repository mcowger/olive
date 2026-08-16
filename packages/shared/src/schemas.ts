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

export const transcriptWordSchema = z.object({
  startMs: z.number().int(),
  endMs: z.number().int(),
  word: z.string(),
  confidence: z.number().optional(),
  speaker: z.string().optional()
});

export const transcriptSegmentSchema = z.object({
  startMs: z.number().int(),
  endMs: z.number().int(),
  speaker: z.string(),
  text: z.string(),
  words: z.array(transcriptWordSchema).optional()
});

export const transcriptSchema = z.object({
  segments: z.array(transcriptSegmentSchema),
  language: z.string().optional(),
  durationMs: z.number().int().optional()
});

export const enrolledSpeakerSchema = z.object({
  id: idSchema,
  name: z.string(),
  providerIds: z.record(z.string(), z.array(z.string()))
});

export const templateSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  description: z.string().nullable(),
  systemPrompt: z.string(),
  userPrompt: z.string().min(1),
  isDefault: z.boolean(),
  isBuiltin: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
});

export const createTemplateInputSchema = z.object({
  name: z.string().trim().min(1, "Template name is required"),
  description: z.string().trim().nullable().optional(),
  systemPrompt: z.string().default(""),
  userPrompt: z.string().trim().min(1, "User prompt template is required"),
  isDefault: z.boolean().optional().default(false)
});

export const updateTemplateInputSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().trim().nullable().optional(),
  systemPrompt: z.string().optional(),
  userPrompt: z.string().trim().min(1).optional(),
  isDefault: z.boolean().optional()
});

export type CreateTemplateInput = z.input<typeof createTemplateInputSchema>;
export type UpdateTemplateInput = z.input<typeof updateTemplateInputSchema>;

export const llmProviderConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().url().or(z.string().min(1)).optional(),
  headers: z.record(z.string(), z.string()).optional()
});

export const llmCustomModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().min(1),
  api: z.string().optional(),
  baseUrl: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  reasoning: z.boolean().optional()
});

export const llmSettingsSchema = z.object({
  defaultProvider: z.string().default("google"),
  defaultModel: z.string().default("gemini-2.5-flash"),
  providers: z.record(z.string(), llmProviderConfigSchema).default({}),
  customModels: z.array(llmCustomModelSchema).default([])
});

export const updateLlmSettingsInputSchema = z.object({
  defaultProvider: z.string().optional(),
  defaultModel: z.string().optional(),
  providers: z.record(z.string(), llmProviderConfigSchema).optional(),
  customModels: z.array(llmCustomModelSchema).optional()
});

export const llmGenerateInputSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  prompt: z.string().min(1, "Prompt is required"),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  apiKeyOverride: z.string().optional(),
  baseUrlOverride: z.string().optional()
});

export type UpdateLlmSettingsInput = z.infer<typeof updateLlmSettingsInputSchema>;
export type LlmGenerateInput = z.infer<typeof llmGenerateInputSchema>;
