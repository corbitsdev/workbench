import { describe, expect, it } from "bun:test";
import { createThemeTools } from "./themes";
import type { GammaFetch } from "./shared";

function makeFetcher(status: number, body: unknown): GammaFetch {
  return async (_input, _init) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

const baseConfig = { apiKey: "test-key" };

describe("gamma_list_themes", () => {
  it("returns themes from the paginated data array", async () => {
    const tools = createThemeTools({
      ...baseConfig,
      fetcher: makeFetcher(200, {
        data: [
          { id: "th1", name: "Corporate Blue", type: "custom" },
          { id: "th2", name: "Minimal Dark", type: "standard" },
        ],
        hasMore: false,
      }),
    });
    const tool = tools.find((t) => t.definition.name === "gamma_list_themes");
    if (!tool || tool.kind !== "string") throw new Error("tool not found");

    const result = await tool.handler({}, new AbortController().signal);
    const parsed: unknown = JSON.parse(result);
    expect(Array.isArray(parsed)).toBe(true);
    if (!Array.isArray(parsed)) return;
    expect(parsed).toHaveLength(2);
    expect((parsed[0] as Record<string, unknown>)["id"]).toBe("th1");
    expect((parsed[0] as Record<string, unknown>)["name"]).toBe(
      "Corporate Blue",
    );
    expect((parsed[0] as Record<string, unknown>)["type"]).toBe("custom");
  });

  it("returns empty array when response has no data array", async () => {
    const tools = createThemeTools({
      ...baseConfig,
      fetcher: makeFetcher(200, { hasMore: false }),
    });
    const tool = tools.find((t) => t.definition.name === "gamma_list_themes");
    if (!tool || tool.kind !== "string") throw new Error("tool not found");

    const result = await tool.handler({}, new AbortController().signal);
    expect(JSON.parse(result)).toEqual([]);
  });

  it("returns empty array when API returns a non-object", async () => {
    const tools = createThemeTools({
      ...baseConfig,
      fetcher: makeFetcher(200, []),
    });
    const tool = tools.find((t) => t.definition.name === "gamma_list_themes");
    if (!tool || tool.kind !== "string") throw new Error("tool not found");

    const result = await tool.handler({}, new AbortController().signal);
    expect(JSON.parse(result)).toEqual([]);
  });

  it("throws on non-2xx response", async () => {
    const tools = createThemeTools({
      ...baseConfig,
      fetcher: makeFetcher(403, { error: "Forbidden" }),
    });
    const tool = tools.find((t) => t.definition.name === "gamma_list_themes");
    if (!tool || tool.kind !== "string") throw new Error("tool not found");
    await expect(
      tool.handler({}, new AbortController().signal),
    ).rejects.toThrow("Gamma API error: 403");
  });
});
