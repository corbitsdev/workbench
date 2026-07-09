import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import {
  createTemplateTools,
  GAMMA_CREATE_FROM_TEMPLATE_DEFINITION,
  GAMMA_LIST_TEMPLATES_DEFINITION,
  GammaTemplateSchema,
} from "./templates";
import type { GammaFetch } from "./shared";

function makeFetcher(
  responses: { status: number; body: unknown }[],
): GammaFetch {
  let callIndex = 0;
  return async (_input, _init) => {
    const response = responses[callIndex++] ?? responses[responses.length - 1];
    if (!response) throw new Error("no mock response configured");
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

const baseConfig = { apiKey: "test-key" };

describe("GammaTemplateSchema", () => {
  it("accepts a template with a description and rejects a systemPrompt-only shape", () => {
    const ok = GammaTemplateSchema({
      id: "t1",
      gammaId: "g1",
      name: "Sales Deck",
      description: "A deck for sales calls",
    });
    expect(ok).toMatchObject({ description: "A deck for sales calls" });
    expect("description" in (ok as Record<string, unknown>)).toBe(true);

    const missingDescription = GammaTemplateSchema({
      id: "t1",
      gammaId: "g1",
      name: "Sales Deck",
      systemPrompt: "old field",
    });
    expect(missingDescription instanceof type.errors).toBe(true);
  });
});

describe("GAMMA_LIST_TEMPLATES_DEFINITION", () => {
  it("describes description (not systemPrompt) and how to use names and gammaId", () => {
    const { description } = GAMMA_LIST_TEMPLATES_DEFINITION;
    expect(description).toContain("description");
    expect(description).not.toContain("systemPrompt");
    expect(description).toContain("gamma_create_from_template");
  });
});

describe("createTemplateTools", () => {
  it("does not include gamma_list_templates — it is a hub-backed factory", () => {
    const tools = createTemplateTools(baseConfig);
    const names = tools.map((t) => t.definition.name);
    expect(names).not.toContain("gamma_list_templates");
    expect(names).toContain(GAMMA_CREATE_FROM_TEMPLATE_DEFINITION.name);
  });
});

describe("gamma_create_from_template", () => {
  it("polls until completed and returns gammaUrl and gammaId", async () => {
    const tools = createTemplateTools({
      ...baseConfig,
      fetcher: makeFetcher([
        // POST /generations/from-template → generationId
        { status: 200, body: { generationId: "gen_abc" } },
        // GET /generations/gen_abc → pending
        { status: 200, body: { status: "pending" } },
        // GET /generations/gen_abc → completed
        {
          status: 200,
          body: {
            status: "completed",
            gammaUrl: "https://gamma.app/deck/abc",
            gammaId: "g_abc",
          },
        },
      ]),
    });
    const tool = tools.find(
      (t) => t.definition.name === "gamma_create_from_template",
    );
    if (!tool || tool.kind !== "string") throw new Error("tool not found");

    // Override sleep to make polling instant in tests
    const result = await tool.handler(
      { gammaId: "g_template", prompt: "Build a sales deck for Acme Corp" },
      new AbortController().signal,
    );
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed["gammaUrl"]).toBe("https://gamma.app/deck/abc");
    expect(parsed["gammaId"]).toBe("g_abc");
  });

  it("throws when gammaId is missing", async () => {
    const tools = createTemplateTools({
      ...baseConfig,
      fetcher: makeFetcher([{ status: 200, body: {} }]),
    });
    const tool = tools.find(
      (t) => t.definition.name === "gamma_create_from_template",
    );
    if (!tool || tool.kind !== "string") throw new Error("tool not found");
    await expect(
      tool.handler({ prompt: "Make a deck" }, new AbortController().signal),
    ).rejects.toThrow("gammaId is required");
  });

  it("throws when prompt is missing", async () => {
    const tools = createTemplateTools({
      ...baseConfig,
      fetcher: makeFetcher([{ status: 200, body: {} }]),
    });
    const tool = tools.find(
      (t) => t.definition.name === "gamma_create_from_template",
    );
    if (!tool || tool.kind !== "string") throw new Error("tool not found");
    await expect(
      tool.handler({ gammaId: "g_template" }, new AbortController().signal),
    ).rejects.toThrow("prompt is required");
  });

  it("throws when generation fails", async () => {
    const tools = createTemplateTools({
      ...baseConfig,
      fetcher: makeFetcher([
        { status: 200, body: { generationId: "gen_fail" } },
        { status: 200, body: { status: "failed" } },
      ]),
    });
    const tool = tools.find(
      (t) => t.definition.name === "gamma_create_from_template",
    );
    if (!tool || tool.kind !== "string") throw new Error("tool not found");
    await expect(
      tool.handler(
        { gammaId: "g_template", prompt: "Make a deck" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Gamma generation failed");
  });

  it("throws when completed generation is missing gammaUrl", async () => {
    const tools = createTemplateTools({
      ...baseConfig,
      fetcher: makeFetcher([
        { status: 200, body: { generationId: "gen_bad" } },
        { status: 200, body: { status: "completed", gammaId: "g_abc" } },
      ]),
    });
    const tool = tools.find(
      (t) => t.definition.name === "gamma_create_from_template",
    );
    if (!tool || tool.kind !== "string") throw new Error("tool not found");
    await expect(
      tool.handler(
        { gammaId: "g_t", prompt: "Make a deck" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("gammaUrl or gammaId is missing");
  });

  it("throws on non-2xx response", async () => {
    const tools = createTemplateTools({
      ...baseConfig,
      fetcher: makeFetcher([
        { status: 500, body: { error: "Internal Server Error" } },
      ]),
    });
    const tool = tools.find(
      (t) => t.definition.name === "gamma_create_from_template",
    );
    if (!tool || tool.kind !== "string") throw new Error("tool not found");
    await expect(
      tool.handler(
        { gammaId: "g_t", prompt: "Make a deck" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Gamma API error: 500");
  });

  it("includes optional themeId and title in the request body", async () => {
    const capturedBodies: string[] = [];
    const fetcher: GammaFetch = async (_input, init) => {
      capturedBodies.push(init.body as string);
      if (capturedBodies.length === 1) {
        return new Response(JSON.stringify({ generationId: "gen_x" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          status: "completed",
          gammaUrl: "https://gamma.app/deck/x",
          gammaId: "g_x",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const tools = createTemplateTools({ ...baseConfig, fetcher });
    const tool = tools.find(
      (t) => t.definition.name === "gamma_create_from_template",
    );
    if (!tool || tool.kind !== "string") throw new Error("tool not found");
    await tool.handler(
      {
        gammaId: "g_t",
        prompt: "Make a deck",
        title: "Q3 Deck",
        themeId: "theme-42",
      },
      new AbortController().signal,
    );
    const body = JSON.parse(capturedBodies[0] ?? "{}") as Record<
      string,
      unknown
    >;
    expect(body["themeId"]).toBe("theme-42");
    expect(body["title"]).toBe("Q3 Deck");
  });
  it("shares the generated deck with the workspace and via link (sharingOptions)", async () => {
    const capturedBodies: string[] = [];
    const fetcher: GammaFetch = async (_input, init) => {
      capturedBodies.push(init.body as string);
      if (capturedBodies.length === 1) {
        return new Response(JSON.stringify({ generationId: "gen_x" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          status: "completed",
          gammaUrl: "https://gamma.app/docs/x",
          gammaId: "g_x",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const tools = createTemplateTools({ ...baseConfig, fetcher });
    const tool = tools.find(
      (t) => t.definition.name === "gamma_create_from_template",
    );
    if (!tool || tool.kind !== "string") throw new Error("tool not found");
    await tool.handler(
      { gammaId: "g_t", prompt: "Make a deck" },
      new AbortController().signal,
    );
    const body = JSON.parse(capturedBodies[0] ?? "{}") as Record<
      string,
      unknown
    >;
    expect(body["sharingOptions"]).toEqual({
      workspaceAccess: "fullAccess",
      externalAccess: "view",
    });
  });
  it("requests a pdf export via exportAs and returns the exportUrl from the completed generation", async () => {
    const capturedBodies: string[] = [];
    const fetcher: GammaFetch = async (_input, init) => {
      capturedBodies.push(init.body as string);
      if (capturedBodies.length === 1) {
        return new Response(JSON.stringify({ generationId: "gen_pdf" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          status: "completed",
          gammaUrl: "https://gamma.app/docs/pdf",
          gammaId: "g_pdf",
          exportUrl: "https://exports.gamma.app/deck.pdf",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const tools = createTemplateTools({ ...baseConfig, fetcher });
    const tool = tools.find(
      (t) => t.definition.name === "gamma_create_from_template",
    );
    if (!tool || tool.kind !== "string") throw new Error("tool not found");
    const result = await tool.handler(
      { gammaId: "g_t", prompt: "Make a deck" },
      new AbortController().signal,
    );
    const body = JSON.parse(capturedBodies[0] ?? "{}") as Record<
      string,
      unknown
    >;
    expect(body["exportAs"]).toBe("pdf");
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed["exportUrl"]).toBe("https://exports.gamma.app/deck.pdf");
  });

  it("always surfaces an exportUrl key (empty) so the persist argMap resolves when Gamma returns no export link", async () => {
    const tools = createTemplateTools({
      ...baseConfig,
      fetcher: makeFetcher([
        { status: 200, body: { generationId: "gen_no_export" } },
        {
          status: 200,
          body: {
            status: "completed",
            gammaUrl: "https://gamma.app/docs/x",
            gammaId: "g_x",
          },
        },
      ]),
    });
    const tool = tools.find(
      (t) => t.definition.name === "gamma_create_from_template",
    );
    if (!tool || tool.kind !== "string") throw new Error("tool not found");
    const result = await tool.handler(
      { gammaId: "g_t", prompt: "Make a deck" },
      new AbortController().signal,
    );
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect("exportUrl" in parsed).toBe(true);
    expect(parsed["exportUrl"]).toBe("");
  });

  it("emits both gammaUrl and url aliases so a consumer keyed on either resolves", async () => {
    const tools = createTemplateTools({
      ...baseConfig,
      fetcher: makeFetcher([
        { status: 200, body: { generationId: "gen_alias" } },
        {
          status: 200,
          body: {
            status: "completed",
            gammaUrl: "https://gamma.app/docs/alias",
            gammaId: "g_alias",
          },
        },
      ]),
    });
    const tool = tools.find(
      (t) => t.definition.name === "gamma_create_from_template",
    );
    if (!tool || tool.kind !== "string") throw new Error("tool not found");
    const result = await tool.handler(
      { gammaId: "g_t", prompt: "Make a deck" },
      new AbortController().signal,
    );
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed["gammaUrl"]).toBe("https://gamma.app/docs/alias");
    expect(parsed["url"]).toBe("https://gamma.app/docs/alias");
  });

  it("normalizes a completed generation whose deck URL arrives under `url` into gammaUrl", async () => {
    const tools = createTemplateTools({
      ...baseConfig,
      fetcher: makeFetcher([
        { status: 200, body: { generationId: "gen_urlkey" } },
        {
          status: 200,
          body: {
            status: "completed",
            url: "https://gamma.app/docs/urlkey",
            gammaId: "g_urlkey",
          },
        },
      ]),
    });
    const tool = tools.find(
      (t) => t.definition.name === "gamma_create_from_template",
    );
    if (!tool || tool.kind !== "string") throw new Error("tool not found");
    const result = await tool.handler(
      { gammaId: "g_t", prompt: "Make a deck" },
      new AbortController().signal,
    );
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed["gammaUrl"]).toBe("https://gamma.app/docs/urlkey");
    expect(parsed["url"]).toBe("https://gamma.app/docs/urlkey");
  });

  it("throws immediately on unknown generation status rather than exhausting poll attempts", async () => {
    const tools = createTemplateTools({
      ...baseConfig,
      fetcher: makeFetcher([
        { status: 200, body: { generationId: "gen_unknown" } },
        { status: 200, body: { status: "processing" } },
      ]),
    });
    const tool = tools.find(
      (t) => t.definition.name === "gamma_create_from_template",
    );
    if (!tool || tool.kind !== "string") throw new Error("tool not found");
    await expect(
      tool.handler(
        { gammaId: "g_t", prompt: "Make a deck" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Unknown generation status: processing");
  });
});
