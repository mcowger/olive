import { describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import type { Database } from "@olive/shared";
import { runMigrations } from "@olive/shared/migrations";
import { LlmService } from "../src/llm/service.ts";
import { createApp } from "../src/app.ts";

function createTestDb(): { sqlite: BunDatabase; db: Kysely<Database> } {
  const sqlite = new BunDatabase(":memory:");
  runMigrations(sqlite);
  const db = new Kysely<Database>({ dialect: new BunSqliteDialect({ database: sqlite }) });
  return { sqlite, db };
}

describe("LlmService", () => {
  test("lists models across multiple providers with metadata", async () => {
    const { db } = createTestDb();
    const service = new LlmService({ db });

    const allModels = await service.listModels();
    expect(allModels.length).toBeGreaterThan(50);

    const anthropicModels = await service.listModels({ provider: "anthropic" });
    expect(anthropicModels.length).toBeGreaterThan(0);
    expect(anthropicModels.some((m) => m.id.includes("claude"))).toBe(true);

    const googleModels = await service.listModels({ provider: "google" });
    expect(googleModels.length).toBeGreaterThan(0);
    expect(googleModels.some((m) => m.id.includes("gemini"))).toBe(true);

    const openaiModels = await service.listModels({ provider: "openai" });
    expect(openaiModels.length).toBeGreaterThan(0);
    expect(openaiModels.some((m) => m.id.includes("gpt-4"))).toBe(true);
  });

  test("lists provider summaries with configuration state", async () => {
    const { db } = createTestDb();
    const service = new LlmService({ db });

    const providers = await service.listProviders();
    expect(providers.length).toBeGreaterThan(5);

    const googleProvider = providers.find((p) => p.id === "google");
    expect(googleProvider).toBeDefined();
    expect(googleProvider?.name).toBe("Google");
    expect(googleProvider?.modelCount).toBeGreaterThan(0);
  });

  test("manages settings and custom model definitions", async () => {
    const { db } = createTestDb();
    const service = new LlmService({ db });

    const initial = await service.getSettings();
    expect(initial.defaultProvider).toBeDefined();

    const updated = await service.updateSettings({
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      providers: {
        openai: {
          baseUrl: "http://localhost:11434/v1"
        }
      },
      customModels: [
        {
          id: "local-llama",
          name: "Local Llama 3.3",
          provider: "openai",
          baseUrl: "http://localhost:11434/v1",
          contextWindow: 64000
        }
      ]
    });

    expect(updated.defaultProvider).toBe("openai");
    expect(updated.defaultModel).toBe("gpt-4o");
    expect(updated.providers.openai?.baseUrl).toBe("http://localhost:11434/v1");
    expect(updated.customModels.length).toBe(1);

    const models = await service.listModels({ provider: "openai" });
    const localLlama = models.find((m) => m.id === "local-llama");
    expect(localLlama).toBeDefined();
    expect(localLlama?.source).toBe("custom");
  });

  test("resolves models with custom baseUrl overrides", async () => {
    const { db } = createTestDb();
    const service = new LlmService({ db });

    await service.updateSettings({
      providers: {
        groq: {
          baseUrl: "https://custom-groq-proxy.internal/v1"
        }
      }
    });

    const model = await service.resolveModel("groq", "llama-3.3-70b-versatile");
    expect(model.baseUrl).toBe("https://custom-groq-proxy.internal/v1");
  });

  test("executes real LLM call when GEMINI_API_KEY is available", async () => {
    if (!process.env.GEMINI_API_KEY) {
      console.log("Skipping live LLM test: GEMINI_API_KEY not set");
      return;
    }

    const { db } = createTestDb();
    const service = new LlmService({ db });

    const result = await service.generateText({
      provider: "google",
      model: "gemini-2.5-flash",
      prompt: "Reply with strictly the word: PONG",
      maxTokens: 100
    });

    expect(result.text).toBeDefined();
    expect(result.text.trim().toLowerCase()).toContain("pong");
    expect(result.provider).toBe("google");
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);

    // Test Gemini 3.7 Flash thinking level handling
    const result37 = await service.generateText({
      provider: "google",
      model: "gemini-3.7-flash",
      prompt: "Reply with strictly the word: PONG",
      thinkingLevel: "low",
      maxTokens: 1000
    });

    expect(result37.text.trim().toLowerCase()).toContain("pong");
  });

  test("throws informative error when API key is missing", async () => {
    const { db } = createTestDb();
    const service = new LlmService({ db });

    // Pick provider without key
    const promise = service.generateText({
      provider: "cerebras",
      model: "llama-3.3-70b",
      prompt: "Hello"
    });

    expect(promise).rejects.toThrow("No API key configured for provider");
  });
});

describe("LLM API Endpoints", () => {
  test("GET /api/llm/providers and /api/llm/models", async () => {
    const { db } = createTestDb();
    const app = createApp({ db });

    const provRes = await app.request("http://localhost/api/llm/providers");
    expect(provRes.status).toBe(200);
    const provBody = (await provRes.json()) as { providers: any[] };
    expect(provBody.providers.length).toBeGreaterThan(5);

    const modelsRes = await app.request("http://localhost/api/llm/models?provider=google");
    expect(modelsRes.status).toBe(200);
    const modelsBody = (await modelsRes.json()) as { models: any[] };
    expect(modelsBody.models.length).toBeGreaterThan(0);
  });

  test("GET /api/llm/config and POST /api/llm/config", async () => {
    const { db } = createTestDb();
    const app = createApp({ db });

    const configRes = await app.request("http://localhost/api/llm/config");
    expect(configRes.status).toBe(200);
    const configBody = (await configRes.json()) as any;
    expect(configBody.defaultProvider).toBeDefined();

    const updateRes = await app.request("http://localhost/api/llm/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        defaultProvider: "anthropic",
        defaultModel: "claude-3-7-sonnet-20250219",
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com"
          }
        }
      })
    });

    expect(updateRes.status).toBe(200);
    const updateBody = (await updateRes.json()) as any;
    expect(updateBody.settings.defaultProvider).toBe("anthropic");
  });

  test("POST /api/llm/test endpoint", async () => {
    const { db } = createTestDb();
    const app = createApp({ db });

    if (process.env.GEMINI_API_KEY) {
      const testRes = await app.request("http://localhost/api/llm/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "google",
          model: "gemini-2.5-flash"
        })
      });

      expect(testRes.status).toBe(200);
      const testBody = (await testRes.json()) as any;
      expect(testBody.ok).toBe(true);
      expect(testBody.response.toLowerCase()).toContain("pong");
    } else {
      const testRes = await app.request("http://localhost/api/llm/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "nonexistent",
          model: "dummy"
        })
      });

      expect(testRes.status).toBe(400);
    }
  });
});
