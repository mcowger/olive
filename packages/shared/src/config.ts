import { z } from "zod";

export const appConfigSchema = z.object({
  pollIntervalMinutes: z.number().int().positive().default(15),
  retranscribePlaudWhenUnnamed: z.boolean().default(false),
  transcriptionProvider: z.enum(["speechmatics", "local"]).default("local"),
  localClusteringThreshold: z.number().min(0.1).max(0.99).default(0.85),
  localSimilarityThreshold: z.number().min(0.1).max(0.99).default(0.85),
  primaryArtifactPreference: z
    .array(z.string().min(1))
    .default(["speechmatics-with-named-speakers", "local", "plaud"]),
  llmProvider: z.enum(["openai", "anthropic"]).default("openai"),
  llmPrompt: z.string().default("")
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export const DEFAULT_CONFIG: AppConfig = appConfigSchema.parse({});
