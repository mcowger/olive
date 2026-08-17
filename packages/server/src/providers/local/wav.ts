import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

/**
 * WAV audio parser and resampler utilities for 16kHz mono PCM
 * used by local ASR and Speaker Diarization / Embedding extractors.
 */

export interface DecodedWav {
  samples: Float32Array; // mono samples normalized to [-1.0, 1.0]
  sampleRate: number;
  channels: number;
  durationMs: number;
}

/**
 * Checks if a byte buffer contains a standard RIFF/WAVE header.
 */
export function isWav(buffer: Uint8Array): boolean {
  if (!buffer || buffer.byteLength < 12) return false;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
  return riff === "RIFF" && wave === "WAVE";
}

/**
 * Parses a standard RIFF/WAVE file buffer into mono Float32Array samples.
 */
export function decodeWav(buffer: Uint8Array): DecodedWav {
  if (buffer.byteLength < 44) {
    throw new Error("Invalid WAV: file too short");
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // Check RIFF header
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));

  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error("Invalid WAV header: expected RIFF/WAVE");
  }

  let offset = 12;
  let audioFormat = 1; // 1 = PCM, 3 = IEEE float
  let numChannels = 1;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= buffer.byteLength) {
    const chunkId = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === "fmt ") {
      audioFormat = view.getUint16(offset + 8, true);
      numChannels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (chunkId === "data") {
      dataOffset = offset + 8;
      dataLength = Math.min(chunkSize, buffer.byteLength - dataOffset);
      break;
    }

    offset += 8 + chunkSize;
  }

  if (dataOffset === -1) {
    // Fallback: assume raw PCM from 44 bytes onward
    dataOffset = 44;
    dataLength = buffer.byteLength - 44;
  }

  const bytesPerSample = bitsPerSample / 8;
  const totalRawSamples = Math.floor(dataLength / bytesPerSample);
  const frameCount = Math.floor(totalRawSamples / numChannels);
  const monoSamples = new Float32Array(frameCount);

  if (audioFormat === 3) {
    // 32-bit float
    for (let i = 0; i < frameCount; i++) {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        const sampleIdx = (i * numChannels + ch) * 4;
        sum += view.getFloat32(dataOffset + sampleIdx, true);
      }
      monoSamples[i] = sum / numChannels;
    }
  } else if (bitsPerSample === 16) {
    // 16-bit PCM (signed int16)
    for (let i = 0; i < frameCount; i++) {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        const sampleIdx = (i * numChannels + ch) * 2;
        const intVal = view.getInt16(dataOffset + sampleIdx, true);
        sum += intVal / 32768.0;
      }
      monoSamples[i] = sum / numChannels;
    }
  } else if (bitsPerSample === 8) {
    // 8-bit PCM (unsigned uint8)
    for (let i = 0; i < frameCount; i++) {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        const sampleIdx = i * numChannels + ch;
        const uintVal = view.getUint8(dataOffset + sampleIdx);
        sum += (uintVal - 128) / 128.0;
      }
      monoSamples[i] = sum / numChannels;
    }
  } else if (bitsPerSample === 24) {
    // 24-bit PCM
    for (let i = 0; i < frameCount; i++) {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        const sampleIdx = (i * numChannels + ch) * 3;
        const b0 = view.getUint8(dataOffset + sampleIdx);
        const b1 = view.getUint8(dataOffset + sampleIdx + 1);
        const b2 = view.getUint8(dataOffset + sampleIdx + 2);
        let val = (b2 << 16) | (b1 << 8) | b0;
        if (val & 0x800000) val |= 0xff000000;
        sum += val / 8388608.0;
      }
      monoSamples[i] = sum / numChannels;
    }
  } else {
    throw new Error(`Unsupported WAV bitsPerSample: ${bitsPerSample}`);
  }

  const durationMs = Math.round((frameCount / sampleRate) * 1000);

  return {
    samples: monoSamples,
    sampleRate,
    channels: numChannels,
    durationMs
  };
}

/**
 * Resamples a Float32Array from sourceSampleRate to targetSampleRate using linear interpolation.
 */
export function resample(
  samples: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number
): Float32Array {
  if (sourceSampleRate === targetSampleRate) {
    return samples;
  }

  const ratio = sourceSampleRate / targetSampleRate;
  const targetLength = Math.round(samples.length / ratio);
  const result = new Float32Array(targetLength);

  for (let i = 0; i < targetLength; i++) {
    const origPos = i * ratio;
    const index = Math.floor(origPos);
    const fraction = origPos - index;

    const s0 = samples[index] ?? 0;
    const s1 = samples[index + 1] ?? s0;

    result[i] = s0 + (s1 - s0) * fraction;
  }

  return result;
}

export const SPEECH_ENHANCEMENT_FILTER =
  "highpass=f=80,afftdn=nr=10:nf=-35:tn=1,equalizer=f=350:t=q:w=1.5:g=-3,equalizer=f=3200:t=q:w=1.2:g=5,speechnorm=e=4:r=0.0001:l=1";

/**
 * Enhances a recorded audio file for vocal clarity and loudness normalization using FFmpeg (async non-blocking).
 */
export async function enhanceAudioFileAsync(sourcePath: string, targetPath: string): Promise<boolean> {
  if (!existsSync(sourcePath)) return false;
  return new Promise<boolean>((resolve) => {
    try {
      const ff = spawn(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          sourcePath,
          "-af",
          SPEECH_ENHANCEMENT_FILTER,
          "-c:a",
          "libmp3lame",
          "-b:a",
          "128k",
          targetPath
        ],
        { stdio: ["ignore", "ignore", "pipe"] }
      );

      ff.on("error", () => resolve(false));
      ff.on("close", (code) => {
        resolve(code === 0 && existsSync(targetPath));
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Synchronous backward-compatibility wrapper for audio enhancement.
 */
export function enhanceAudioFile(sourcePath: string, targetPath: string): boolean {
  if (!existsSync(sourcePath)) return false;
  try {
    const ff = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        sourcePath,
        "-af",
        SPEECH_ENHANCEMENT_FILTER,
        "-c:a",
        "libmp3lame",
        "-b:a",
        "128k",
        targetPath
      ],
      {
        maxBuffer: 500 * 1024 * 1024
      }
    );
    return ff.status === 0 && existsSync(targetPath);
  } catch {
    return false;
  }
}

/**
 * Universally loads and decodes any audio file (WAV, MP3, M4A, AAC, FLAC, OGG, WebM)
 * to 16kHz mono Float32Array samples using ffmpeg asynchronously without blocking the event loop.
 */
export async function loadAudioSamples(
  input: { audioPath?: string; audioBytes?: Uint8Array; enhance?: boolean },
  targetSampleRate = 16000
): Promise<DecodedWav> {
  // If raw bytes are provided and valid WAV
  if (input.audioBytes && isWav(input.audioBytes) && input.enhance !== true) {
    let decoded = decodeWav(input.audioBytes);
    if (decoded.sampleRate !== targetSampleRate) {
      decoded = {
        ...decoded,
        samples: resample(decoded.samples, decoded.sampleRate, targetSampleRate),
        sampleRate: targetSampleRate
      };
    }
    return decoded;
  }

  // If audioPath is provided and is a valid WAV
  if (input.audioPath && existsSync(input.audioPath) && input.enhance !== true) {
    try {
      const bytes = new Uint8Array(await readFile(input.audioPath));
      if (isWav(bytes)) {
        let decoded = decodeWav(bytes);
        if (decoded.sampleRate !== targetSampleRate) {
          decoded = {
            ...decoded,
            samples: resample(decoded.samples, decoded.sampleRate, targetSampleRate),
            sampleRate: targetSampleRate
          };
        }
        return decoded;
      }
    } catch {}
  }

  // Convert audio (mp3, m4a, wav, etc.) to 16kHz mono 16-bit PCM WAV via ffmpeg with speech enhancement
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y"
  ];

  let stdinData: Uint8Array | undefined;
  if (input.audioPath && existsSync(input.audioPath)) {
    args.push("-i", input.audioPath);
  } else if (input.audioBytes) {
    args.push("-i", "pipe:0");
    stdinData = input.audioBytes;
  } else {
    throw new Error("Either audioPath or audioBytes must be provided");
  }

  if (input.enhance !== false) {
    args.push("-af", SPEECH_ENHANCEMENT_FILTER);
  }

  args.push("-f", "wav", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(targetSampleRate), "pipe:1");

  return new Promise<DecodedWav>((resolve, reject) => {
    try {
      const ff = spawn("ffmpeg", args, {
        stdio: ["pipe", "pipe", "pipe"]
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      ff.stdout.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });

      ff.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      ff.on("error", (err: Error) => {
        reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
      });

      ff.on("close", (code: number | null) => {
        if (code === 0) {
          const totalBuffer = Buffer.concat(stdoutChunks);
          if (totalBuffer.byteLength >= 44) {
            try {
              const decoded = decodeWav(new Uint8Array(totalBuffer.buffer, totalBuffer.byteOffset, totalBuffer.byteLength));
              resolve(decoded);
              return;
            } catch (err) {
              reject(err);
              return;
            }
          }
        }
        const errMsg = Buffer.concat(stderrChunks).toString("utf8").trim() || `exit code ${code}`;
        reject(new Error(`ffmpeg audio conversion failed (${errMsg})`));
      });

      if (stdinData && ff.stdin) {
        ff.stdin.end(stdinData);
      } else {
        ff.stdin.end();
      }
    } catch (err) {
      reject(new Error(`Failed to decode audio: ${err instanceof Error ? err.message : String(err)}`));
    }
  });
}

/**
 * Encodes a mono Float32Array to 16-bit PCM WAV binary format.
 */
export function encodeWav(samples: Float32Array, sampleRate = 16000): Uint8Array {
  const byteLength = 44 + samples.length * 2;
  const buffer = new Uint8Array(byteLength);
  const view = new DataView(buffer.buffer);

  // RIFF identifier
  buffer.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, byteLength - 8, true);
  buffer.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"

  // fmt subchunk
  buffer.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
  view.setUint16(22, 1, true); // NumChannels (1 = mono)
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, sampleRate * 2, true); // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
  view.setUint16(32, 2, true); // BlockAlign (NumChannels * BitsPerSample/8)
  view.setUint16(34, 16, true); // BitsPerSample (16 bits)

  // data subchunk
  buffer.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  view.setUint32(40, samples.length * 2, true);

  // Write PCM samples
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    const int16 = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return buffer;
}
