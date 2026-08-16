export interface SpeechmaticsSpeakerConfig {
  label: string;
  speaker_identifiers: string[];
}

export interface SpeechmaticsSpeakerDiarizationConfig {
  speakers?: SpeechmaticsSpeakerConfig[];
  get_speakers?: boolean;
}

export interface SpeechmaticsTranscriptionConfig {
  language: string;
  diarization?: "speaker" | "channel" | "none";
  speaker_diarization_config?: SpeechmaticsSpeakerDiarizationConfig;
  additional_vocab?: Array<{ content: string; sounds_like?: string[] }>;
}

export interface SpeechmaticsNotificationConfig {
  url: string;
  contents?: Array<"transcript" | "data">;
  auth_headers?: string[];
}

export interface SpeechmaticsJobConfig {
  type: "transcription";
  transcription_config: SpeechmaticsTranscriptionConfig;
  notification_config?: SpeechmaticsNotificationConfig[];
  fetch_data?: { url: string; auth_headers?: string[] };
}

export interface SpeechmaticsJobStatus {
  id: string;
  status: "running" | "done" | "rejected" | "deleted";
  created_at: string;
  data_name?: string;
  duration?: number;
  errors?: Array<{ code: string; message: string }>;
}

export interface SpeechmaticsJobStatusResponse {
  job: SpeechmaticsJobStatus;
}

export interface SpeechmaticsAlternative {
  content: string;
  confidence: number;
  speaker?: string;
  language?: string;
}

export interface SpeechmaticsResultItem {
  type: "word" | "punctuation" | "entity";
  start_time: number;
  end_time: number;
  alternatives: SpeechmaticsAlternative[];
  channel?: string;
}

export interface SpeechmaticsSpeakerSummary {
  speaker?: string;
  label?: string;
  speaker_identifiers?: string[] | Set<string>;
}

export interface SpeechmaticsJsonV2 {
  format?: string;
  job?: {
    id: string;
    created_at?: string;
    duration?: number;
    lang?: string;
  };
  metadata?: {
    created_at?: string;
    type?: string;
    transcription_config?: SpeechmaticsTranscriptionConfig;
  };
  results: SpeechmaticsResultItem[];
  speakers?: SpeechmaticsSpeakerSummary[];
}
