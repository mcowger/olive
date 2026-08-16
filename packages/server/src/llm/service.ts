import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Kysely } from "kysely";
import type {
  Database,
  LlmCustomModel,
  LlmGenerateOptions,
  LlmGenerateResult,
  LlmModelCatalogItem,
  LlmProviderSummary,
  LlmSettings,
  LlmThinkingLevel,
  UpdateLlmSettingsInput
} from "@olive/shared";
import { llmSettingsSchema } from "@olive/shared";
import {
  builtinModels
} from "@earendil-works/pi-ai/providers/all";
import {
  contentText,
  getSupportedThinkingLevels,
  clampThinkingLevel,
  type Context,
  type Model,
  type AssistantMessage,
  type ModelThinkingLevel
} from "@earendil-works/pi-ai";
import { getDb } from "../db.ts";
import { logger } from "../logger.ts";
import { resolvePaths } from "../paths.ts";

// Bundled catalog from @oh-my-pi/pi-catalog
import modelsJson from "@oh-my-pi/pi-catalog/models.json";

export interface LlmServiceOptions {
  db?: Kysely<Database>;
  configDir?: string;
}

const PROVIDER_ENV_KEY_MAP: Record<string, string[]> = {
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  xai: ["XAI_API_KEY"],
  baseten: ["BASETEN_API_KEY"]
};

export class LlmService {
  private readonly db: Kysely<Database>;
  private readonly configDir: string;
  private readonly piModels = builtinModels();
  private webCatalog: Map<string, LlmModelCatalogItem> = new Map();
  private catalogLoaded = false;

  constructor(options: LlmServiceOptions = {}) {
    this.db = options.db ?? getDb();
    this.configDir = options.configDir ?? resolvePaths().configDir;
    this.loadCachedWebCatalog();
  }

  private loadCachedWebCatalog(): void {
    try {
      const cachePath = join(this.configDir, "models-web-cache.json");
      if (existsSync(cachePath)) {
        const raw = JSON.parse(readFileSync(cachePath, "utf-8")) as LlmModelCatalogItem[];
        for (const item of raw) {
          this.webCatalog.set(`${item.provider}:${item.id}`, item);
        }
      }
    } catch {
      // Ignore cache load errors
    }
  }

  private saveWebCatalog(): void {
    try {
      if (!existsSync(this.configDir)) {
        mkdirSync(this.configDir, { recursive: true });
      }
      const cachePath = join(this.configDir, "models-web-cache.json");
      const items = Array.from(this.webCatalog.values());
      writeFileSync(cachePath, JSON.stringify(items, null, 2), "utf-8");
    } catch (err) {
      logger.warn("Failed to persist web model cache", { error: String(err) });
    }
  }

  async getSettings(): Promise<LlmSettings> {
    const row = await this.db
      .selectFrom("sync_state")
      .selectAll()
      .where("key", "=", "llm_settings")
      .executeTakeFirst();

    if (row?.value) {
      try {
        const parsed = JSON.parse(row.value);
        return llmSettingsSchema.parse(parsed);
      } catch {
        // Fall back to default
      }
    }

    // Determine smart default provider based on available environment keys
    let defaultProvider = "google";
    let defaultModel = "gemini-2.5-flash";

    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
      defaultProvider = "google";
      defaultModel = "gemini-2.5-flash";
    } else if (process.env.ANTHROPIC_API_KEY) {
      defaultProvider = "anthropic";
      defaultModel = "claude-3-7-sonnet-20250219";
    } else if (process.env.OPENAI_API_KEY) {
      defaultProvider = "openai";
      defaultModel = "gpt-4o";
    } else if (process.env.GROQ_API_KEY) {
      defaultProvider = "groq";
      defaultModel = "llama-3.3-70b-versatile";
    }

    return {
      defaultProvider,
      defaultModel,
      defaultThinkingLevel: "off",
      providers: {},
      customModels: []
    };
  }

  async updateSettings(input: UpdateLlmSettingsInput): Promise<LlmSettings> {
    const current = await this.getSettings();
    const updated: LlmSettings = {
      defaultProvider: input.defaultProvider ?? current.defaultProvider,
      defaultModel: input.defaultModel ?? current.defaultModel,
      defaultThinkingLevel: input.defaultThinkingLevel ?? current.defaultThinkingLevel ?? "off",
      providers: {
        ...current.providers,
        ...(input.providers ?? {})
      },
      customModels: input.customModels ?? current.customModels
    };

    const validated = llmSettingsSchema.parse(updated);
    const json = JSON.stringify(validated);

    await this.db
      .insertInto("sync_state")
      .values({ key: "llm_settings", value: json })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value: json }))
      .execute();

    logger.info("Updated LLM settings", {
      defaultProvider: validated.defaultProvider,
      defaultModel: validated.defaultModel,
      defaultThinkingLevel: validated.defaultThinkingLevel
    });

    return validated;
  }

  async refreshCatalog(): Promise<{ count: number }> {
    try {
      const res = await fetch("https://models.dev/api.json", {
        headers: { "User-Agent": "Olive/1.0" }
      });

      if (res.ok) {
        const data = (await res.json()) as Record<string, any>;
        let added = 0;

        for (const [providerId, providerData] of Object.entries(data)) {
          if (!providerData || typeof providerData !== "object" || !providerData.models) {
            continue;
          }

          const modelsObj = providerData.models;
          for (const [modelId, modelDef] of Object.entries(modelsObj)) {
            const def = modelDef as any;
            const item: LlmModelCatalogItem = {
              id: modelId,
              name: def.name || modelId,
              provider: providerId,
              api: def.api || (providerId === "anthropic" ? "anthropic-messages" : "openai-completions"),
              baseUrl: def.baseUrl || providerData.baseUrl,
              contextWindow: def.contextWindow || def.limit?.context,
              maxTokens: def.maxTokens || def.limit?.output,
              reasoning: Boolean(def.reasoning || def.thinking),
              cost: def.cost
                ? {
                    input: def.cost.input ?? 0,
                    output: def.cost.output ?? 0,
                    cacheRead: def.cost.cacheRead,
                    cacheWrite: def.cost.cacheWrite
                  }
                : undefined,
              source: "web"
            };

            this.webCatalog.set(`${providerId}:${modelId}`, item);
            added++;
          }
        }

        this.saveWebCatalog();
        logger.info("Refreshed web model catalog", { modelsCount: this.webCatalog.size });
        return { count: this.webCatalog.size };
      }
    } catch (err) {
      logger.warn("Failed to fetch live web catalog, using fallback", { error: String(err) });
    }

    return { count: this.webCatalog.size };
  }

  getModelSupportedThinkingLevels(model: Model<any>): LlmThinkingLevel[] {
    if (!model.reasoning) {
      return ["off"];
    }

    let rawLevels: string[] = [];
    try {
      rawLevels = getSupportedThinkingLevels(model);
    } catch {
      rawLevels = ["off", "low", "medium", "high"];
    }

    // Workaround for Google Gemini 3 models where Google API does not accept "MINIMAL" or "off"
    if (model.provider === "google" && /gemini-3(?:\.\d+)?-flash/.test(model.id.toLowerCase())) {
      rawLevels = rawLevels.filter((lvl) => lvl !== "minimal" && lvl !== "off");
      if (!rawLevels.includes("low")) rawLevels.unshift("low");
      if (!rawLevels.includes("medium")) rawLevels.push("medium");
      if (!rawLevels.includes("high")) rawLevels.push("high");
    }

    if (rawLevels.length === 0) {
      rawLevels = ["low", "medium", "high"];
    }

    return rawLevels as LlmThinkingLevel[];
  }

  resolveEffectiveReasoning(
    model: Model<any>,
    requested?: LlmThinkingLevel,
    defaultLevel?: LlmThinkingLevel
  ): LlmThinkingLevel | undefined {
    if (!model.reasoning) {
      return undefined;
    }

    const supported = this.getModelSupportedThinkingLevels(model);
    const candidate = requested || defaultLevel || "off";

    if (candidate === "off") {
      if (supported.includes("off")) {
        return "off";
      }
      return supported[0] || "low";
    }

    if (supported.includes(candidate)) {
      return candidate;
    }

    try {
      const clamped = clampThinkingLevel(model, candidate as ModelThinkingLevel);
      if (supported.includes(clamped as LlmThinkingLevel)) {
        return clamped as LlmThinkingLevel;
      }
    } catch {}

    return supported[0] || "low";
  }

  async listModels(filter?: { provider?: string; search?: string; limit?: number }): Promise<LlmModelCatalogItem[]> {
    const settings = await this.getSettings();
    const map = new Map<string, LlmModelCatalogItem>();

    // 1. Built-in models from @earendil-works/pi-ai
    for (const m of this.piModels.getModels()) {
      map.set(`${m.provider}:${m.id}`, {
        id: m.id,
        name: m.name || m.id,
        provider: m.provider,
        api: m.api,
        baseUrl: m.baseUrl,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        reasoning: Boolean(m.reasoning),
        supportedThinkingLevels: this.getModelSupportedThinkingLevels(m),
        cost: m.cost
          ? {
              input: m.cost.input,
              output: m.cost.output,
              cacheRead: m.cost.cacheRead,
              cacheWrite: m.cost.cacheWrite
            }
          : undefined,
        source: "builtin"
      });
    }

    // 2. Bundled models from pi-catalog modelsJson
    for (const [providerId, modelsObj] of Object.entries(modelsJson as Record<string, Record<string, any>>)) {
      if (!modelsObj || typeof modelsObj !== "object") continue;
      for (const [modelId, def] of Object.entries(modelsObj)) {
        const key = `${providerId}:${modelId}`;
        if (!map.has(key)) {
          const reasoning = Boolean(def.reasoning || def.thinking);
          map.set(key, {
            id: modelId,
            name: def.name || modelId,
            provider: providerId,
            api: def.api || (providerId === "anthropic" ? "anthropic-messages" : "openai-completions"),
            baseUrl: def.baseUrl,
            contextWindow: def.contextWindow,
            maxTokens: def.maxTokens,
            reasoning,
            supportedThinkingLevels: reasoning ? ["low", "medium", "high"] : ["off"],
            cost: def.cost,
            source: "builtin"
          });
        }
      }
    }

    // 3. Web catalog entries
    for (const [key, item] of this.webCatalog) {
      if (!map.has(key)) {
        map.set(key, {
          ...item,
          supportedThinkingLevels: item.reasoning ? ["low", "medium", "high"] : ["off"]
        });
      }
    }

    // 4. Custom models from settings
    for (const custom of settings.customModels) {
      map.set(`${custom.provider}:${custom.id}`, {
        id: custom.id,
        name: custom.name,
        provider: custom.provider,
        api: custom.api || "openai-completions",
        baseUrl: custom.baseUrl,
        contextWindow: custom.contextWindow,
        maxTokens: custom.maxTokens,
        reasoning: custom.reasoning,
        supportedThinkingLevels: custom.reasoning ? ["low", "medium", "high"] : ["off"],
        source: "custom"
      });
    }

    let list = Array.from(map.values());

    if (filter?.provider) {
      const p = filter.provider.toLowerCase();
      list = list.filter((m) => m.provider.toLowerCase() === p);
    }

    if (filter?.search) {
      const q = filter.search.toLowerCase();
      list = list.filter(
        (m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q)
      );
    }

    // Sort: Popular providers first (google, anthropic, openai, groq, openrouter), then by name
    const providerPriority: Record<string, number> = {
      google: 1,
      anthropic: 2,
      openai: 3,
      groq: 4,
      openrouter: 5,
      deepseek: 6,
      mistral: 7
    };

    list.sort((a, b) => {
      const prioA = providerPriority[a.provider] ?? 99;
      const prioB = providerPriority[b.provider] ?? 99;
      if (prioA !== prioB) return prioA - prioB;
      if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
      return a.name.localeCompare(b.name);
    });

    if (filter?.limit && filter.limit > 0) {
      return list.slice(0, filter.limit);
    }

    return list;
  }

  async listProviders(): Promise<LlmProviderSummary[]> {
    const models = await this.listModels();
    const settings = await this.getSettings();

    const providerMap = new Map<string, { name: string; count: number }>();

    for (const m of models) {
      const existing = providerMap.get(m.provider);
      if (existing) {
        existing.count++;
      } else {
        const formattedName = m.provider
          .split("-")
          .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
          .join(" ");
        providerMap.set(m.provider, { name: formattedName, count: 1 });
      }
    }

    const summaries: LlmProviderSummary[] = [];

    for (const [providerId, info] of providerMap.entries()) {
      const envKeys = PROVIDER_ENV_KEY_MAP[providerId] || [];
      const hasEnvKey = envKeys.some((k) => Boolean(process.env[k]));
      const config = settings.providers[providerId];
      const hasStoredKey = Boolean(config?.apiKey);
      const isConfigured = hasEnvKey || hasStoredKey;
      const hasCustomBaseUrl = Boolean(config?.baseUrl);

      summaries.push({
        id: providerId,
        name: info.name,
        isConfigured,
        hasCustomBaseUrl,
        modelCount: info.count
      });
    }

    const priority: Record<string, number> = {
      google: 1,
      anthropic: 2,
      openai: 3,
      groq: 4,
      openrouter: 5,
      deepseek: 6,
      mistral: 7
    };

    summaries.sort((a, b) => {
      const prioA = priority[a.id] ?? 99;
      const prioB = priority[b.id] ?? 99;
      if (prioA !== prioB) return prioA - prioB;
      return a.name.localeCompare(b.name);
    });

    return summaries;
  }

  resolveApiKey(provider: string, override?: string, settings?: LlmSettings): string | undefined {
    if (override && override.trim()) {
      return override.trim();
    }

    if (settings?.providers[provider]?.apiKey) {
      return settings.providers[provider].apiKey;
    }

    const envKeys = PROVIDER_ENV_KEY_MAP[provider] || [
      `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`
    ];

    for (const k of envKeys) {
      const val = process.env[k];
      if (val) return val;
    }

    return undefined;
  }

  async resolveModel(provider: string, modelId: string, baseUrlOverride?: string): Promise<Model<any>> {
    const settings = await this.getSettings();

    // Check pi-ai builtin models
    const piModel = this.piModels.getModel(provider, modelId);
    const providerConfig = settings.providers[provider];
    const effectiveBaseUrl = baseUrlOverride || providerConfig?.baseUrl || piModel?.baseUrl;

    if (piModel) {
      if (effectiveBaseUrl && effectiveBaseUrl !== piModel.baseUrl) {
        return {
          ...piModel,
          baseUrl: effectiveBaseUrl
        };
      }
      return piModel;
    }

    // Check custom models in settings
    const custom = settings.customModels.find((c) => c.provider === provider && c.id === modelId);
    if (custom) {
      return {
        id: custom.id,
        name: custom.name,
        api: (custom.api as any) || "openai-completions",
        provider: custom.provider as any,
        baseUrl: baseUrlOverride || custom.baseUrl || providerConfig?.baseUrl || "https://api.openai.com/v1",
        reasoning: Boolean(custom.reasoning),
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: custom.contextWindow || 128000,
        maxTokens: custom.maxTokens || 4096
      };
    }

    // Check bundled pi-catalog json
    const providerCatalog = (modelsJson as Record<string, Record<string, any>>)[provider];
    const bundledDef = providerCatalog?.[modelId];
    if (bundledDef) {
      return {
        id: modelId,
        name: bundledDef.name || modelId,
        api: bundledDef.api || (provider === "anthropic" ? "anthropic-messages" : "openai-completions"),
        provider: provider as any,
        baseUrl: effectiveBaseUrl || bundledDef.baseUrl || (provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"),
        reasoning: Boolean(bundledDef.reasoning || bundledDef.thinking),
        input: ["text"],
        cost: bundledDef.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: bundledDef.contextWindow || 128000,
        maxTokens: bundledDef.maxTokens || 4096,
        compat: bundledDef.compat
      };
    }

    // Check web catalog
    const webDef = this.webCatalog.get(`${provider}:${modelId}`);
    if (webDef) {
      return {
        id: webDef.id,
        name: webDef.name,
        api: (webDef.api as any) || (provider === "anthropic" ? "anthropic-messages" : "openai-completions"),
        provider: webDef.provider as any,
        baseUrl: effectiveBaseUrl || webDef.baseUrl || "https://api.openai.com/v1",
        reasoning: Boolean(webDef.reasoning),
        input: ["text"],
        cost: webDef.cost
          ? {
              input: webDef.cost.input,
              output: webDef.cost.output,
              cacheRead: webDef.cost.cacheRead ?? 0,
              cacheWrite: webDef.cost.cacheWrite ?? 0
            }
          : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: webDef.contextWindow || 128000,
        maxTokens: webDef.maxTokens || 4096
      };
    }

    // Fallback: construct synthetic model
    return {
      id: modelId,
      name: modelId,
      api: (provider === "anthropic" ? "anthropic-messages" : "openai-completions") as any,
      provider: provider as any,
      baseUrl: effectiveBaseUrl || (provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"),
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096
    };
  }

  async generateText(options: LlmGenerateOptions): Promise<LlmGenerateResult> {
    const startTime = Date.now();
    const settings = await this.getSettings();

    const provider = options.provider || settings.defaultProvider;
    const modelId = options.model || settings.defaultModel;

    const apiKey = this.resolveApiKey(provider, options.apiKeyOverride, settings);
    if (!apiKey) {
      throw new Error(
        `No API key configured for provider "${provider}". Please configure an API key in settings or pass one in the request.`
      );
    }

    const model = await this.resolveModel(provider, modelId, options.baseUrlOverride);

    const context: Context = {
      systemPrompt: options.systemPrompt,
      messages: [
        {
          role: "user",
          content: options.prompt,
          timestamp: startTime
        }
      ]
    };

    const streamOptions: Record<string, any> = {
      apiKey
    };

    const effectiveReasoning = this.resolveEffectiveReasoning(
      model,
      options.thinkingLevel,
      settings.defaultThinkingLevel
    );
    if (effectiveReasoning) {
      streamOptions.reasoning = effectiveReasoning;
    }

    if (options.temperature !== undefined) {
      streamOptions.temperature = options.temperature;
    }
    if (options.maxTokens !== undefined) {
      streamOptions.maxTokens = options.maxTokens;
    }

    const providerConfig = settings.providers[provider];
    if (providerConfig?.headers) {
      streamOptions.headers = providerConfig.headers;
    }

    logger.info("Executing LLM generation", {
      provider,
      model: modelId,
      baseUrl: model.baseUrl,
      reasoning: effectiveReasoning
    });

    let assistantMessage: AssistantMessage;
    try {
      assistantMessage = await this.piModels.completeSimple(model, context, streamOptions as any);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error("LLM completion call failed", { provider, model: modelId, error: errorMsg });
      throw new Error(`LLM call failed (${provider}/${modelId}): ${errorMsg}`);
    }

    if (assistantMessage.stopReason === "error") {
      const errorMsg = assistantMessage.errorMessage || "Unknown error during completion";
      logger.error("LLM response returned error stopReason", { provider, model: modelId, error: errorMsg });
      throw new Error(`LLM error (${provider}/${modelId}): ${errorMsg}`);
    }

    const text = contentText(assistantMessage.content);
    const durationMs = Date.now() - startTime;

    const usage = {
      inputTokens: assistantMessage.usage?.input ?? 0,
      outputTokens: assistantMessage.usage?.output ?? 0,
      totalTokens: assistantMessage.usage?.totalTokens ?? (assistantMessage.usage?.input ?? 0) + (assistantMessage.usage?.output ?? 0),
      cost: assistantMessage.usage?.cost?.total
    };

    return {
      text,
      provider,
      model: modelId,
      durationMs,
      usage
    };
  }

  async streamText(
    options: LlmGenerateOptions,
    onDelta: (delta: string) => void
  ): Promise<LlmGenerateResult> {
    const startTime = Date.now();
    const settings = await this.getSettings();

    const provider = options.provider || settings.defaultProvider;
    const modelId = options.model || settings.defaultModel;

    const apiKey = this.resolveApiKey(provider, options.apiKeyOverride, settings);
    if (!apiKey) {
      throw new Error(
        `No API key configured for provider "${provider}". Please configure an API key in settings or pass one in the request.`
      );
    }

    const model = await this.resolveModel(provider, modelId, options.baseUrlOverride);

    const context: Context = {
      systemPrompt: options.systemPrompt,
      messages: [
        {
          role: "user",
          content: options.prompt,
          timestamp: startTime
        }
      ]
    };

    const streamOptions: Record<string, any> = {
      apiKey
    };

    const effectiveReasoning = this.resolveEffectiveReasoning(
      model,
      options.thinkingLevel,
      settings.defaultThinkingLevel
    );
    if (effectiveReasoning) {
      streamOptions.reasoning = effectiveReasoning;
    }

    if (options.temperature !== undefined) {
      streamOptions.temperature = options.temperature;
    }
    if (options.maxTokens !== undefined) {
      streamOptions.maxTokens = options.maxTokens;
    }

    const providerConfig = settings.providers[provider];
    if (providerConfig?.headers) {
      streamOptions.headers = providerConfig.headers;
    }

    const stream = this.piModels.streamSimple(model, context, streamOptions as any);

    let fullText = "";
    let finalMessage: AssistantMessage | undefined;

    for await (const event of stream) {
      if (event.type === "text_delta") {
        fullText += event.delta;
        onDelta(event.delta);
      } else if (event.type === "done") {
        finalMessage = (event as any).message || (event as any).partial;
      } else if (event.type === "error") {
        const errorMsg = (event as any).error?.errorMessage || (event as any).partial?.errorMessage || "Stream error";
        throw new Error(`LLM streaming error (${provider}/${modelId}): ${errorMsg}`);
      }
    }

    const durationMs = Date.now() - startTime;
    const usage = {
      inputTokens: finalMessage?.usage?.input ?? 0,
      outputTokens: finalMessage?.usage?.output ?? 0,
      totalTokens: finalMessage?.usage?.totalTokens ?? 0,
      cost: finalMessage?.usage?.cost?.total
    };

    return {
      text: fullText,
      provider,
      model: modelId,
      durationMs,
      usage
    };
  }
}
