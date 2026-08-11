import { mkdirSync } from "node:fs";
import { join } from "node:path";

const UNSAFE_CHARS = /[/\\:*?"<>|\r\n\t]/g;

export function sanitizeFilename(name: string): string {
  return name
    .replace(UNSAFE_CHARS, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 100);
}

export function dateStamp(startTimeMs: number): string {
  const date = new Date(startTimeMs);
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
    .map((value, index) => (index === 0 ? String(value) : String(value).padStart(2, "0")))
    .join("-");
}

export function meetingFolderName(startTimeMs: number, title: string, id: string): string {
  const safeTitle = sanitizeFilename(title) || "meeting";
  return `${dateStamp(startTimeMs)}_${safeTitle}__${id.slice(0, 8)}`;
}

export interface MeetingPaths {
  folder: string;
  audioDir: string;
  transcriptsDir: string;
  summariesDir: string;
}

export function meetingPaths(meetingsDir: string, startTimeMs: number, title: string, id: string): MeetingPaths {
  const folder = join(meetingsDir, meetingFolderName(startTimeMs, title, id));
  return {
    folder,
    audioDir: join(folder, "audio"),
    transcriptsDir: join(folder, "transcripts"),
    summariesDir: join(folder, "summaries")
  };
}

export function ensureMeetingFolder(paths: MeetingPaths): MeetingPaths {
  mkdirSync(paths.audioDir, { recursive: true });
  mkdirSync(paths.transcriptsDir, { recursive: true });
  mkdirSync(paths.summariesDir, { recursive: true });
  return paths;
}
