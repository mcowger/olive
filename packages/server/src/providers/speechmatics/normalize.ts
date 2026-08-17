import type { Transcript, TranscriptSegment, TranscriptWord } from "@olive/shared";
import type { RetrieveTranscriptResponse } from "@speechmatics/batch-client";
import type { SpeechmaticsJsonV2 } from "./types.ts";

const TRAILING_PUNCTUATION = new Set([".", ",", "!", "?", ":", ";", ")", "]", "}", "%", "...", "”", "’", "'"]);
const LEADING_PUNCTUATION = new Set(["(", "[", "{", "“", "$", "£", "€", "#"]);
const MAX_GAP_SPLIT_MS = 3000;

function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

function normalizeSpeakerLabel(speaker: string | undefined): string {
  if (!speaker) {
    return "Speaker";
  }
  const trimmed = speaker.trim();
  return trimmed || "Speaker";
}

export function parseSpeechmaticsJsonV2(json: RetrieveTranscriptResponse | SpeechmaticsJsonV2): Transcript {
  const results = (json.results ?? []) as Array<{
    type?: string;
    start_time?: number;
    end_time?: number;
    attaches_to?: string;
    alternatives?: Array<{
      content?: string;
      confidence?: number;
      speaker?: string;
      language?: string;
    }>;
  }>;

  const segments: TranscriptSegment[] = [];

  let currentSegment: {
    speaker: string;
    startMs: number;
    endMs: number;
    tokens: Array<{ text: string; isPunctuation: boolean; isLeading: boolean }>;
    words: TranscriptWord[];
  } | null = null;

  for (const item of results) {
    const alt = item.alternatives?.[0];
    if (!alt || !alt.content) {
      continue;
    }

    const itemStartMs = secondsToMs(item.start_time ?? 0);
    const itemEndMs = secondsToMs(item.end_time ?? item.start_time ?? 0);
    const speaker = normalizeSpeakerLabel(alt.speaker);

    if (item.type === "word") {
      const shouldSplit =
        !currentSegment ||
        currentSegment.speaker !== speaker ||
        (itemStartMs - currentSegment.endMs > MAX_GAP_SPLIT_MS && currentSegment.words.length > 0);

      if (shouldSplit || !currentSegment) {
        if (currentSegment) {
          segments.push(finalizeSegment(currentSegment));
        }
        currentSegment = {
          speaker,
          startMs: itemStartMs,
          endMs: itemEndMs,
          tokens: [{ text: alt.content, isPunctuation: false, isLeading: false }],
          words: [
            {
              startMs: itemStartMs,
              endMs: itemEndMs,
              word: alt.content,
              confidence: alt.confidence,
              speaker
            }
          ]
        };
      } else {
        currentSegment.endMs = Math.max(currentSegment.endMs, itemEndMs);
        currentSegment.tokens.push({ text: alt.content, isPunctuation: false, isLeading: false });
        currentSegment.words.push({
          startMs: itemStartMs,
          endMs: itemEndMs,
          word: alt.content,
          confidence: alt.confidence,
          speaker
        });
      }
    } else if (item.type === "punctuation") {
      const punct = alt.content;
      const isLeading = item.attaches_to === "next" || LEADING_PUNCTUATION.has(punct);

      if (currentSegment) {
        currentSegment.endMs = Math.max(currentSegment.endMs, itemEndMs);
        currentSegment.tokens.push({ text: punct, isPunctuation: true, isLeading });
      } else {
        currentSegment = {
          speaker,
          startMs: itemStartMs,
          endMs: itemEndMs,
          tokens: [{ text: punct, isPunctuation: true, isLeading }],
          words: []
        };
      }
    }
  }

  if (currentSegment) {
    segments.push(finalizeSegment(currentSegment));
  }

  const durationMs = json.job?.duration ? secondsToMs(json.job.duration) : segments.at(-1)?.endMs ?? 0;
  const language = (json.job as any)?.lang || (json.metadata?.transcription_config as any)?.language || "en";

  return {
    segments,
    language,
    durationMs,
    speakers: (json.speakers ?? []) as any[]
  };
}

function finalizeSegment(segment: {
  speaker: string;
  startMs: number;
  endMs: number;
  tokens: Array<{ text: string; isPunctuation: boolean; isLeading: boolean }>;
  words: TranscriptWord[];
}): TranscriptSegment {
  let text = "";
  for (let i = 0; i < segment.tokens.length; i++) {
    const token = segment.tokens[i];
    if (i === 0) {
      text += token.text;
    } else {
      const prev = segment.tokens[i - 1];
      if (token.isPunctuation && !token.isLeading) {
        text += token.text;
      } else if (prev.isLeading) {
        text += token.text;
      } else {
        text += ` ${token.text}`;
      }
    }
  }

  return {
    startMs: segment.startMs,
    endMs: segment.endMs,
    speaker: segment.speaker,
    text: text.trim(),
    words: segment.words.length > 0 ? segment.words : undefined
  };
}

export function transcriptToText(transcript: Transcript): string {
  if (transcript.segments.length === 0) {
    return "";
  }

  return transcript.segments
    .map((segment) => `${segment.speaker}: ${segment.text}`)
    .join("\n\n");
}
