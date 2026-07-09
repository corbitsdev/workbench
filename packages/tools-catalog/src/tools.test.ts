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

describe("search_tools loop guard", () => {
  const hintOf = (r: { content: unknown }) =>
    (r.content as { hint?: string }).hint ?? "";

  test("first search of a query returns the normal load_tools hint", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog, exposure });
    const r = await runner.run(
      call(SEARCH_TOOLS_NAME, { query: "crm" }),
      signal,
    );
    expect(r.isError).toBeUndefined();
    expect(hintOf(r)).toContain("Call load_tools");
  });

  test("repeating the same search escalates the hint but still returns matches", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog, exposure });
    await runner.run(call(SEARCH_TOOLS_NAME, { query: "crm" }), signal);
    const second = await runner.run(
      call(SEARCH_TOOLS_NAME, { query: "crm" }),
      signal,
    );
    expect(second.isError).toBeUndefined();
    expect((second.content as { matchCount: number }).matchCount).toBe(1);
    expect(hintOf(second)).toContain("already ran this exact search");
  });

  test("the same search past the terminal threshold returns a stop error", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog, exposure });
    let last;
    for (let i = 0; i < 4; i++) {
      last = await runner.run(
        call(SEARCH_TOOLS_NAME, { query: "crm" }),
        signal,
      );
    }
    expect(last?.isError).toBe(true);
    expect((last?.content as { error: string }).error).toContain(
      "Stop searching",
    );
  });

  test("a different query in between resets the run, so it never hard-errors", async () => {
    // Guards the 'no agent-chat regression' requirement: ordinary chat that
    // revisits the same query after other searches must never hit the stop
    // error, no matter how many total times a query recurs.
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog, exposure });
    const results = [];
    for (let round = 0; round < 3; round++) {
      results.push(
        await runner.run(call(SEARCH_TOOLS_NAME, { query: "crm" }), signal),
      );
      results.push(
        await runner.run(call(SEARCH_TOOLS_NAME, { query: "crm" }), signal),
      );
      results.push(
        await runner.run(call(SEARCH_TOOLS_NAME, { query: "note" }), signal),
      );
    }
    expect(results.some((r) => r.isError)).toBe(false);
  });

  test("distinct queries are unaffected by the repeat guard", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog, exposure });
    const a = await runner.run(
      call(SEARCH_TOOLS_NAME, { query: "records" }),
      signal,
    );
    const b = await runner.run(
      call(SEARCH_TOOLS_NAME, { query: "note" }),
      signal,
    );
    expect(a.isError).toBeUndefined();
    expect(b.isError).toBeUndefined();
    expect(hintOf(a)).toContain("Call load_tools");
    expect(hintOf(b)).toContain("Call load_tools");
  });

  test("a load_tools between identical searches resets the run so it never hard-errors", async () => {
    // Guards against turning a transient load_tools failure into a false
    // 'capability unavailable' stop: search -> load -> search -> load is
    // progress, not a loop, and must never reach the terminal error.
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog, exposure });
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(
        await runner.run(call(SEARCH_TOOLS_NAME, { query: "crm" }), signal),
      );
      await runner.run(call(LOAD_TOOLS_NAME, { package: "attio" }), signal);
    }
    expect(results.some((r) => r.isError)).toBe(false);
    expect(hintOf(results[1]!)).toContain("Call load_tools");
  });

  test("many distinct searches over a long session never trigger a stop or advisory", async () => {
    // The guard no longer counts a session total, so a genuinely exploring
    // long-lived session (Myra persists across days) is never pushed into a
    // 'stop searching' state by volume alone.
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog, exposure });
    let last;
    for (let i = 0; i < 40; i++) {
      last = await runner.run(
        call(SEARCH_TOOLS_NAME, { query: `crm ${i}` }),
        signal,
      );
    }
    expect(last?.isError).toBeUndefined();
    expect(hintOf(last!)).toContain("Call load_tools");
  });
});
