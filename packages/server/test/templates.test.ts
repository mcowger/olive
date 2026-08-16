import { describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import type { Database } from "@olive/shared";
import { runMigrations } from "@olive/shared/migrations";
import { TemplateService } from "../src/templates/service.ts";
import { createApp } from "../src/app.ts";

function createTestDb(): { sqlite: BunDatabase; db: Kysely<Database> } {
  const sqlite = new BunDatabase(":memory:");
  runMigrations(sqlite);
  const db = new Kysely<Database>({ dialect: new BunSqliteDialect({ database: sqlite }) });
  return { sqlite, db };
}

describe("TemplateService", () => {
  test("seeds built-in templates with Executive Summary as default", async () => {
    const { db } = createTestDb();
    const service = new TemplateService(db);

    const templates = await service.listTemplates();
    expect(templates.length).toBe(4);

    const defaultTpl = await service.getDefaultTemplate();
    expect(defaultTpl?.name).toBe("Executive Summary");
    expect(defaultTpl?.isDefault).toBe(true);
    expect(defaultTpl?.isBuiltin).toBe(true);
  });

  test("creates a custom template and manages default status", async () => {
    const { db } = createTestDb();
    const service = new TemplateService(db);

    const custom = await service.createTemplate({
      name: "Retrospective",
      description: "Sprint retro notes",
      systemPrompt: "You are an agile facilitator.",
      userPrompt: "# Retro: {{title}}\n\n## What went well\n\n{{transcript}}",
      isDefault: true
    });

    expect(custom.id).toBeDefined();
    expect(custom.name).toBe("Retrospective");
    expect(custom.isDefault).toBe(true);
    expect(custom.isBuiltin).toBe(false);

    // Old default should now be false
    const execSummary = (await service.listTemplates()).find((t) => t.name === "Executive Summary");
    expect(execSummary?.isDefault).toBe(false);

    // Default template should now be the custom one
    const currentDefault = await service.getDefaultTemplate();
    expect(currentDefault?.id).toBe(custom.id);
  });

  test("updates custom template", async () => {
    const { db } = createTestDb();
    const service = new TemplateService(db);

    const created = await service.createTemplate({
      name: "Draft Template",
      userPrompt: "Initial prompt {{transcript}}"
    });

    const updated = await service.updateTemplate(created.id, {
      name: "Refined Template",
      description: "Updated description",
      userPrompt: "New prompt: {{transcript}}"
    });

    expect(updated.name).toBe("Refined Template");
    expect(updated.description).toBe("Updated description");
    expect(updated.userPrompt).toBe("New prompt: {{transcript}}");
  });

  test("prevents deleting built-in templates and allows deleting custom templates", async () => {
    const { db } = createTestDb();
    const service = new TemplateService(db);

    const builtins = await service.listTemplates();
    const firstBuiltin = builtins[0]!;

    expect(service.deleteTemplate(firstBuiltin.id)).rejects.toThrow("Cannot delete built-in templates");

    const custom = await service.createTemplate({
      name: "Disposable Template",
      userPrompt: "Prompt text"
    });

    await service.deleteTemplate(custom.id);
    const fetched = await service.getTemplate(custom.id);
    expect(fetched).toBeNull();
  });

  test("switches default template", async () => {
    const { db } = createTestDb();
    const service = new TemplateService(db);

    const templates = await service.listTemplates();
    const techDesign = templates.find((t) => t.name.includes("Technical Architecture"))!;

    await service.setDefaultTemplate(techDesign.id);

    const currentDefault = await service.getDefaultTemplate();
    expect(currentDefault?.id).toBe(techDesign.id);
    expect(currentDefault?.isDefault).toBe(true);
  });
});

describe("Templates API", () => {
  test("GET /api/templates and /api/templates/:id", async () => {
    const { db } = createTestDb();
    const app = createApp({ db });

    const listRes = await app.request("http://localhost/api/templates");
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { templates: any[] };
    expect(listBody.templates.length).toBe(4);

    const firstId = listBody.templates[0].id;
    const getRes = await app.request(`http://localhost/api/templates/${firstId}`);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { template: any };
    expect(getBody.template.id).toBe(firstId);
  });

  test("POST, PATCH, POST default, and DELETE /api/templates", async () => {
    const { db } = createTestDb();
    const app = createApp({ db });

    // Create custom
    const createRes = await app.request("http://localhost/api/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Standup Notes",
        description: "Daily standup summary",
        systemPrompt: "Summarize daily standup.",
        userPrompt: "Standup: {{transcript}}"
      })
    });

    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as { template: any };
    const templateId = createBody.template.id;
    expect(createBody.template.name).toBe("Standup Notes");

    // Patch
    const patchRes = await app.request(`http://localhost/api/templates/${templateId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Updated standup description"
      })
    });

    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as { template: any };
    expect(patchBody.template.description).toBe("Updated standup description");

    // Set Default
    const defaultRes = await app.request(`http://localhost/api/templates/${templateId}/default`, {
      method: "POST"
    });
    expect(defaultRes.status).toBe(200);
    const defaultBody = (await defaultRes.json()) as { template: any };
    expect(defaultBody.template.isDefault).toBe(true);

    // Delete custom
    const deleteRes = await app.request(`http://localhost/api/templates/${templateId}`, {
      method: "DELETE"
    });
    expect(deleteRes.status).toBe(200);

    // Verify deleted
    const verifyRes = await app.request(`http://localhost/api/templates/${templateId}`);
    expect(verifyRes.status).toBe(404);
  });
});
