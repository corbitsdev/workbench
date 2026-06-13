import { describe, expect, it } from "bun:test";
import { createTemplateTools } from "./templates";
import type { GammaFetch } from "./shared";

function makeFetcher(
  responses: Array<{ status: number; body: unknown }>,
): GammaFetch {
  let callIndex = 0;
  return async (_input, _init) => {
    const response = responses[callIndex++] ?? responses[responses.length - 1];
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

const baseConfig = { apiKey: "test-key" };

describe("gamma_list_templates", () => {
  it("calls GET /templates and returns normalized entries", async () => {
    const tools = createTemplateTools({
      ...baseConfig,
      fetcher: makeFetcher([
        {
          status: 200,
          body: {
            data: [
              {
                id: "g_abc",
                name: "Sales Proposal",
                description: "Standard sales proposal",
              },
              {
                id: "g_def",
                name: "Post-Call Summary",
                description: "Summary after a call",
              },
            ],
          },
        },
      ]),
    });
    const tool = tools.find(
      (t) => t.definition.name === "gamma_list_templates",
    );
    if (!tool || tool.kind !== "string") throw new Error("tool not found");

    const result = await tool.handler({}, new AbortController().signal);
    const parsed = JSON.parse(result) as unknown[];

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    const first = parsed[0] as Record<string, unknown>;
    expect(first["gammaId"]).toBe("g_abc");
    expect(first["name"]).toBe("Sales Proposal");
    expect(first["description"]).toBe("Standard sales proposal");
  });

  it("returns empty array when API returns no data", async () => {
    const tools = createTemplateTools({
      ...baseConfig,
      fetcher: makeFetcher([{ status: 200, body: { data: [] } }]),
    });
    const tool = tools.find(
      (t) => t.definition.name === "gamma_list_templates",
    );
    if (!tool || tool.kind !== "string") throw new Error("tool not found");

    const result = await tool.handler({}, new AbortController().signal);
    const parsed = JSON.parse(result) as unknown[];
    expect(parsed).toHaveLength(0);
  });

  it("returns empty array when API response has unexpected shape", async () => {
    const tools = createTemplateTools({
      ...baseConfig,
      fetcher: makeFetcher([{ status: 200, body: {} }]),
    });
    const tool = tools.find(
      (t) => t.definition.name === "gamma_list_templates",
    );
    if (!tool || tool.kind !== "string") throw new Error("tool not found");

    const result = await tool.handler({}, new AbortController().signal);
    const parsed = JSON.parse(result) as unknown[];
    expect(parsed).toHaveLength(0);
  });

  it("throws on non-2xx response", async () => {
    const tools = createTemplateTools({
      ...baseConfig,
      fetcher: makeFetcher([{ status: 403, body: { error: "Forbidden" } }]),
    });
    const tool = tools.find(
      (t) => t.definition.name === "gamma_list_templates",
    );
    if (!tool || tool.kind !== "string") throw new Error("tool not found");

    await expect(
      tool.handler({}, new AbortController().signal),
    ).rejects.toThrow("Gamma API error: 403");
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
});
