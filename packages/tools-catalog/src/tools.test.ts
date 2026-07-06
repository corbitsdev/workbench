import { describe, expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";
import {
  CATALOG_TOOL_DEFINITIONS,
  createCatalogTools,
  LOAD_TOOLS_NAME,
  SEARCH_TOOLS_NAME,
} from "./tools";
import type { ToolCatalog, ToolExposureState } from "./schema";

const catalog: ToolCatalog = [
  {
    package: "attio",
    summary: "Attio CRM records.",
    tags: ["crm"],
    tools: [
      { name: "attio__query_records", description: "Query CRM records." },
      { name: "attio__create_note", description: "Create a note." },
    ],
  },
];

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: "c1", name, arguments: args };
}

const signal = new AbortController().signal;

describe("createCatalogTools", () => {
  test("advertises exactly search_tools and load_tools", () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog, exposure });
    expect(runner.definitions.map((d) => d.name).sort()).toEqual(
      [LOAD_TOOLS_NAME, SEARCH_TOOLS_NAME].sort(),
    );
    expect(CATALOG_TOOL_DEFINITIONS).toHaveLength(2);
  });

  test("search_tools returns matching packages", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog, exposure });
    const result = await runner.run(
      call(SEARCH_TOOLS_NAME, { query: "crm" }),
      signal,
    );
    expect(result.isError).toBeUndefined();
    const content = result.content as { matchCount: number };
    expect(content.matchCount).toBe(1);
  });

  test("load_tools by package mutates the shared exposure set", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog, exposure });
    await runner.run(call(LOAD_TOOLS_NAME, { package: "attio" }), signal);
    expect(exposure.exposed).toEqual(
      new Set(["attio__query_records", "attio__create_note"]),
    );
  });

  test("load_tools by names exposes only the named tools", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog, exposure });
    await runner.run(
      call(LOAD_TOOLS_NAME, { names: ["attio__query_records"] }),
      signal,
    );
    expect(exposure.exposed).toEqual(new Set(["attio__query_records"]));
  });

  test("load_tools with neither names nor package is an error and mutates nothing", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog, exposure });
    const result = await runner.run(call(LOAD_TOOLS_NAME, {}), signal);
    expect(result.isError).toBe(true);
    expect(exposure.exposed.size).toBe(0);
  });

  test("load_tools reports unknown names without throwing", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog, exposure });
    const result = await runner.run(
      call(LOAD_TOOLS_NAME, { names: ["nope"] }),
      signal,
    );
    const content = result.content as { unknownNames: string[] };
    expect(content.unknownNames).toEqual(["nope"]);
    expect(exposure.exposed.size).toBe(0);
  });
});
