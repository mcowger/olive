import type { Generated, Insertable, Selectable, Updateable } from "kysely";

export type MeetingSource = "plaud" | "upload" | "ios-shortcut";
export type MeetingStatus = "pending" | "processing" | "ready" | "error";
export type ArtifactKind = "transcript" | "summary";
export type ArtifactFormat = "md" | "txt" | "json" | "srt";

export interface MeetingTable {
  id: string;
  title: string;
  start_time: number;
  end_time: number;
  source: MeetingSource;
  status: Generated<MeetingStatus>;
  tags: Generated<string>;
  primary_transcript_artifact_id: string | null;
  primary_summary_artifact_id: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface RecordingTable {
  id: string;
  meeting_id: string;
  path: string;
  mime: string;
  duration_ms: number | null;
  size_bytes: number;
  sha256: string;
  provider: MeetingSource;
  provider_recording_id: string | null;
  created_at: number;
}

export interface ArtifactTable {
  id: string;
  meeting_id: string;
  recording_id: string | null;
  kind: ArtifactKind;
  provider: string;
  format: ArtifactFormat;
  path: string;
  created_at: number;
}

export interface SpeakerTable {
  id: string;
  name: string;
  provider_ids: Generated<string>;
  enrolled_at: number | null;
  enrollment_clip_paths: Generated<string>;
  created_at: number;
}

export interface MeetingSpeakerTable {
  meeting_id: string;
  speaker_id: string;
  evidence_artifact_id: string | null;
}

export interface StageRunTable {
  id: string;
  meeting_id: string;
  stage: string;
  status: Generated<"pending" | "running" | "done" | "error">;
  provider_job_id: string | null;
  attempts: Generated<number>;
  last_error: string | null;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface PlaudIngestStateTable {
  meeting_id: string;
  plaud_file_id: string;
  first_seen_at: number;
  pcs_deadline_at: number;
  pcs_resolved: Generated<number>;
}

export interface SyncStateTable {
  key: string;
  value: string;
}

export interface TemplateTable {
  id: string;
  name: string;
  description: string | null;
  system_prompt: string;
  user_prompt: string;
  is_default: Generated<number>;
  is_builtin: Generated<number>;
  created_at: number;
  updated_at: number;
}

export interface Database {
  meetings: MeetingTable;
  recordings: RecordingTable;
  artifacts: ArtifactTable;
  speakers: SpeakerTable;
  meeting_speakers: MeetingSpeakerTable;
  stage_runs: StageRunTable;
  plaud_ingest_state: PlaudIngestStateTable;
  sync_state: SyncStateTable;
  templates: TemplateTable;
}

export type MeetingRow = Selectable<MeetingTable>;
export type NewMeeting = Insertable<MeetingTable>;
export type MeetingUpdate = Updateable<MeetingTable>;
export type RecordingRow = Selectable<RecordingTable>;
export type NewRecording = Insertable<RecordingTable>;
export type ArtifactRow = Selectable<ArtifactTable>;
export type NewArtifact = Insertable<ArtifactTable>;
export type SpeakerRow = Selectable<SpeakerTable>;
export type NewSpeaker = Insertable<SpeakerTable>;
export type MeetingSpeakerRow = Selectable<MeetingSpeakerTable>;
export type NewMeetingSpeaker = Insertable<MeetingSpeakerTable>;
export type StageRunRow = Selectable<StageRunTable>;
export type NewStageRun = Insertable<StageRunTable>;
export type PlaudIngestStateRow = Selectable<PlaudIngestStateTable>;
export type NewPlaudIngestState = Insertable<PlaudIngestStateTable>;
export type SyncStateRow = Selectable<SyncStateTable>;
export type NewSyncState = Insertable<SyncStateTable>;
export type TemplateRow = Selectable<TemplateTable>;
export type NewTemplate = Insertable<TemplateTable>;
export type TemplateUpdate = Updateable<TemplateTable>;

export interface Template {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string;
  userPrompt: string;
  isDefault: boolean;
  isBuiltin: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Meeting {
  id: string;
  title: string;
  startTime: number;
  endTime: number;
  source: MeetingSource;
  status: MeetingStatus;
  tags: string[];
  primaryTranscriptArtifactId: string | null;
  primarySummaryArtifactId: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Recording {
  id: string;
  meetingId: string;
  path: string;
  mime: string;
  durationMs: number | null;
  sizeBytes: number;
  sha256: string;
  provider: MeetingSource;
  providerRecordingId: string | null;
  createdAt: number;
}

export interface Artifact {
  id: string;
  meetingId: string;
  recordingId: string | null;
  kind: ArtifactKind;
  provider: string;
  format: ArtifactFormat;
  path: string;
  createdAt: number;
}

export interface Speaker {
  id: string;
  name: string;
  providerIds: Record<string, string[]>;
  enrolledAt: number | null;
  enrollmentClipPaths: string[];
  createdAt: number;
}

export interface MeetingSpeaker {
  meetingId: string;
  speakerId: string;
  evidenceArtifactId: string | null;
}

export interface TranscriptWord {
  startMs: number;
  endMs: number;
  word: string;
  confidence?: number;
  speaker?: string;
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  speaker: string;
  text: string;
  words?: TranscriptWord[];
}

export interface Transcript {
  segments: TranscriptSegment[];
  language?: string;
  durationMs?: number;
}

export interface EnrolledSpeaker {
  id: string;
  name: string;
  providerIds: Record<string, string[]>;
}

export interface TranscriptionProviderCaps {
  diarization: boolean;
  speakerId: boolean;
  customVocab: boolean;
}

export type MeetingListItem = Meeting;

export interface LlmProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export type LlmThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface LlmCustomModel {
  id: string;
  name: string;
  provider: string;
  api?: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

export interface LlmSettings {
  defaultProvider: string;
  defaultModel: string;
  defaultThinkingLevel?: LlmThinkingLevel;
  providers: Record<string, LlmProviderConfig>;
  customModels: LlmCustomModel[];
}

export interface LlmModelCatalogItem {
  id: string;
  name: string;
  provider: string;
  api: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  supportedThinkingLevels?: LlmThinkingLevel[];
  cost?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  source: "builtin" | "web" | "custom";
}

export interface LlmProviderSummary {
  id: string;
  name: string;
  isConfigured: boolean;
  hasCustomBaseUrl: boolean;
  modelCount: number;
}

export interface LlmGenerateOptions {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  thinkingLevel?: LlmThinkingLevel;
  apiKeyOverride?: string;
  baseUrlOverride?: string;
}

export interface LlmGenerateResult {
  text: string;
  provider: string;
  model: string;
  durationMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost?: number;
  };
}

export interface MeetingSummaryItem {
  id: string;
  provider: string;
  format: ArtifactFormat;
  path: string;
  createdAt: number;
  content: string;
  isPrimary: boolean;
}

export interface MeetingDetailAggregate {
  meeting: MeetingListItem;
  recordings: Recording[];
  artifacts: Artifact[];
  speakers: Speaker[];
  stageRuns: StageRunRow[];
  transcriptContent?: string | null;
  summaryContent?: string | null;
  summaries: MeetingSummaryItem[];
}

export interface BackupManifestStats {
  meetingCount: number;
  recordingCount: number;
  audioFilesCount: number;
  totalAudioSizeBytes: number;
  summaryCount: number;
  speakerCount: number;
  templateCount: number;
}

export interface BackupManifest {
  version: string;
  createdAt: string;
  oliveVersion: string;
  app: string;
  stats: BackupManifestStats;
}

export interface BackupInfo {
  filename: string;
  sizeBytes: number;
  createdAt: string;
  manifest: BackupManifest | null;
}

export interface RestoreResult {
  success: boolean;
  restoredAt: string;
  manifest: BackupManifest | null;
  stats: {
    meetings: number;
    recordings: number;
    audioFiles: number;
    summaries: number;
    speakers: number;
    templates: number;
  };
}

