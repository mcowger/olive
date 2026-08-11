import { z } from "zod";

export const appConfigSchema = z.object({
  pollIntervalMinutes: z.number().int().positive().default(15),
  retranscribePlaudWhenUnnamed: z.boolean().default(false),
  primaryArtifactPreference: z
    .array(z.string().min(1))
    .default(["speechmatics-with-named-speakers", "plaud"]),
  llmProvider: z.enum(["openai", "anthropic"]).default("openai"),
  llmPrompt: z.string().default("")
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export const DEFAULT_CONFIG: AppConfig = appConfigSchema.parse({});
