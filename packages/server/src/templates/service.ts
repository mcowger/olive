import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type {
  CreateTemplateInput,
  Database,
  Template,
  TemplateRow,
  UpdateTemplateInput
} from "@olive/shared";
import {
  createTemplateInputSchema,
  updateTemplateInputSchema
} from "@olive/shared";
import { getDb } from "../db.ts";
import { logger } from "../logger.ts";

function mapTemplateRow(row: TemplateRow): Template {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    systemPrompt: row.system_prompt,
    userPrompt: row.user_prompt,
    isDefault: row.is_default === 1,
    isBuiltin: row.is_builtin === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class TemplateService {
  private readonly db: Kysely<Database>;

  constructor(db?: Kysely<Database>) {
    this.db = db ?? getDb();
  }

  async listTemplates(): Promise<Template[]> {
    const rows = await this.db
      .selectFrom("templates")
      .selectAll()
      .orderBy("is_default", "desc")
      .orderBy("is_builtin", "desc")
      .orderBy("name", "asc")
      .execute();

    return rows.map(mapTemplateRow);
  }

  async getTemplate(id: string): Promise<Template | null> {
    const row = await this.db
      .selectFrom("templates")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    return row ? mapTemplateRow(row) : null;
  }

  async getDefaultTemplate(): Promise<Template | null> {
    const defaultRow = await this.db
      .selectFrom("templates")
      .selectAll()
      .where("is_default", "=", 1)
      .executeTakeFirst();

    if (defaultRow) {
      return mapTemplateRow(defaultRow);
    }

    const firstBuiltin = await this.db
      .selectFrom("templates")
      .selectAll()
      .where("is_builtin", "=", 1)
      .orderBy("name", "asc")
      .executeTakeFirst();

    return firstBuiltin ? mapTemplateRow(firstBuiltin) : null;
  }

  async createTemplate(rawInput: CreateTemplateInput): Promise<Template> {
    const input = createTemplateInputSchema.parse(rawInput);
    const now = Date.now();
    const id = randomUUID();

    if (input.isDefault) {
      await this.db
        .updateTable("templates")
        .set({ is_default: 0, updated_at: now })
        .execute();
    }

    await this.db
      .insertInto("templates")
      .values({
        id,
        name: input.name,
        description: input.description ?? null,
        system_prompt: input.systemPrompt ?? "",
        user_prompt: input.userPrompt,
        is_default: input.isDefault ? 1 : 0,
        is_builtin: 0,
        created_at: now,
        updated_at: now
      })
      .execute();

    logger.info("Created custom summary template", { id, name: input.name, isDefault: input.isDefault });
    const created = await this.getTemplate(id);
    if (!created) {
      throw new Error(`Failed to retrieve newly created template ${id}`);
    }

    return created;
  }

  async updateTemplate(id: string, rawInput: UpdateTemplateInput): Promise<Template> {
    const input = updateTemplateInputSchema.parse(rawInput);
    const existing = await this.getTemplate(id);

    if (!existing) {
      throw new Error(`Template not found: ${id}`);
    }

    const now = Date.now();

    if (input.isDefault) {
      await this.db
        .updateTable("templates")
        .set({ is_default: 0, updated_at: now })
        .where("id", "!=", id)
        .execute();
    }

    const updateValues: Record<string, unknown> = {
      updated_at: now
    };

    if (input.name !== undefined) {
      updateValues.name = input.name;
    }
    if (input.description !== undefined) {
      updateValues.description = input.description;
    }
    if (input.systemPrompt !== undefined) {
      updateValues.system_prompt = input.systemPrompt;
    }
    if (input.userPrompt !== undefined) {
      updateValues.user_prompt = input.userPrompt;
    }
    if (input.isDefault !== undefined) {
      updateValues.is_default = input.isDefault ? 1 : 0;
    }

    await this.db
      .updateTable("templates")
      .set(updateValues)
      .where("id", "=", id)
      .execute();

    logger.info("Updated summary template", { id, name: input.name ?? existing.name });
    const updated = await this.getTemplate(id);
    if (!updated) {
      throw new Error(`Failed to retrieve updated template ${id}`);
    }

    return updated;
  }

  async deleteTemplate(id: string): Promise<void> {
    const existing = await this.getTemplate(id);
    if (!existing) {
      throw new Error(`Template not found: ${id}`);
    }

    if (existing.isBuiltin) {
      throw new Error("Cannot delete built-in templates");
    }

    await this.db.deleteFrom("templates").where("id", "=", id).execute();
    logger.info("Deleted summary template", { id, name: existing.name });

    if (existing.isDefault) {
      // If deleted template was default, fallback to Executive Summary builtin
      const fallback = await this.db
        .selectFrom("templates")
        .selectAll()
        .where("is_builtin", "=", 1)
        .orderBy("name", "asc")
        .executeTakeFirst();

      if (fallback) {
        await this.db
          .updateTable("templates")
          .set({ is_default: 1, updated_at: Date.now() })
          .where("id", "=", fallback.id)
          .execute();
      }
    }
  }

  async setDefaultTemplate(id: string): Promise<Template> {
    const existing = await this.getTemplate(id);
    if (!existing) {
      throw new Error(`Template not found: ${id}`);
    }

    const now = Date.now();
    await this.db
      .updateTable("templates")
      .set({ is_default: 0, updated_at: now })
      .execute();

    await this.db
      .updateTable("templates")
      .set({ is_default: 1, updated_at: now })
      .where("id", "=", id)
      .execute();

    logger.info("Set default summary template", { id, name: existing.name });
    const updated = await this.getTemplate(id);
    return updated!;
  }
}
