import { describe, expect, test } from "bun:test";
import { SpeechmaticsClient } from "../src/providers/speechmatics/client.ts";
import type { BatchClient } from "@speechmatics/batch-client";

describe("Speechmatics client", () => {
  test("submits transcription job with audio and speakers", async () => {
    let capturedInput: any = null;
    let capturedConfig: any = null;

    const mockBatchClient: Partial<BatchClient> = {
      createTranscriptionJob: async (input, config) => {
        capturedInput = input;
        capturedConfig = config;
        return { id: "job-sm-123" };
      }
    };

    const client = new SpeechmaticsClient({
      apiKey: "test-api-key",
      batchClient: mockBatchClient as BatchClient
    });

    const result = await client.submitJob({
      audio: new Uint8Array([1, 2, 3, 4]),
      filename: "test.m4a",
      mime: "audio/mp4",
      language: "en",
      speakers: [{ label: "Alice", speaker_identifiers: ["id-1", "id-2"] }],
      webhookUrl: "https://olive.test/api/webhooks/speechmatics",
      webhookSecret: "secret-abc"
    });

    expect(result).toEqual({ id: "job-sm-123" });
    expect(capturedInput.fileName).toBe("test.m4a");
    expect(capturedConfig.transcription_config.language).toBe("en");
    expect(capturedConfig.transcription_config.diarization).toBe("speaker");
    expect(capturedConfig.transcription_config.speaker_diarization_config.speakers).toEqual([
      { label: "Alice", speaker_identifiers: ["id-1", "id-2"] }
    ]);
    expect(capturedConfig.notification_config).toEqual([
      {
        url: "https://olive.test/api/webhooks/speechmatics",
        contents: ["transcript"],
        auth_headers: ["Authorization: Bearer secret-abc"]
      }
    ]);
  });

  test("fetches job status, transcript, and deletes job", async () => {
    let deletedId = "";

    const mockBatchClient: Partial<BatchClient> = {
      getJob: async (id: string) => ({
        job: {
          id,
          status: "done" as any,
          created_at: "2026-08-16T00:00:00Z",
          data_name: "test.m4a",
          duration: 12
        }
      }),
      getJobResult: (async (id: string, format: string) => {
        if (format === "json-v2") {
          return { format: "2.0", results: [] } as any;
        }
        return "Alice: Hello world";
      }) as any,
      deleteJob: async (id: string) => {
        deletedId = id;
        return { job: { id, status: "deleted" as any, created_at: "", data_name: "" } };
      }
    };

    const client = new SpeechmaticsClient({
      apiKey: "test-api-key",
      batchClient: mockBatchClient as BatchClient
    });

    const job = await client.getJob("job-123");
    expect(job.status).toBe("done");

    const transcript = await client.getTranscript("job-123", "json-v2");
    expect((transcript as any).format).toBe("2.0");

    const textTranscript = await client.getTranscript("job-123", "txt");
    expect(textTranscript).toBe("Alice: Hello world");

    await client.deleteJob("job-123");
    expect(deletedId).toBe("job-123");
  });
});
