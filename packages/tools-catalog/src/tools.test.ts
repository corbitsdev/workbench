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

// A package with more than the auto-expose limit of tools, so a search that
// matches it returns matches WITHOUT auto-loading — the only shape in which the
// consecutive-search loop guard still engages.
const wideCatalog: ToolCatalog = [
  {
    package: "linear",
    summary: "Linear issue tracker.",
    tags: ["issues"],
    tools: [
      { name: "linear__create_issue", description: "Create an issue." },
      { name: "linear__update_issue", description: "Update an issue." },
      { name: "linear__list_issue", description: "List issues." },
      { name: "linear__get_issue", description: "Get an issue." },
      { name: "linear__assign_issue", description: "Assign an issue." },
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

  test("load_tools by package includes a size warning naming the pinned count", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog, exposure });
    const result = await runner.run(
      call(LOAD_TOOLS_NAME, { package: "attio" }),
      signal,
    );
    const content = result.content as { warning?: string };
    expect(content.warning).toBeDefined();
    expect(content.warning).toContain("2");
  });

  test("load_tools by names has no size warning", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog, exposure });
    const result = await runner.run(
      call(LOAD_TOOLS_NAME, { names: ["attio__query_records"] }),
      signal,
    );
    expect((result.content as { warning?: string }).warning).toBeUndefined();
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

describe("createCatalogTools: catalogued-but-unavailable tools (CL-3795)", () => {
  // "linear" is catalogued (its factory is committed and search_tools must
  // advertise it) but its package never constructed a runner — the harness
  // passes `availableToolNames` excluding it, modeling a missing credential.
  const linearCatalog: ToolCatalog = [
    {
      package: "linear",
      summary: "Linear issue tracker.",
      tags: ["issues"],
      tools: [
        { name: "linear__create_issue", description: "Create an issue." },
      ],
    },
  ];

  test("search_tools still returns the catalogued-but-unavailable tool", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({
      catalog: linearCatalog,
      exposure,
      availableToolNames: new Set(),
    });
    const result = await runner.run(
      call(SEARCH_TOOLS_NAME, { query: "linear issue" }),
      signal,
    );
    expect(result.isError).toBeUndefined();
    const content = result.content as {
      packages: { package: string; tools: { name: string }[] }[];
    };
    expect(
      content.packages.some((p) =>
        p.tools.some((t) => t.name === "linear__create_issue"),
      ),
    ).toBe(true);
  });

  test("search_tools does not silently auto-expose an unavailable tool into the function list", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({
      catalog: linearCatalog,
      exposure,
      availableToolNames: new Set(),
    });
    await runner.run(
      call(SEARCH_TOOLS_NAME, { query: "linear issue" }),
      signal,
    );
    expect(exposure.exposed.has("linear__create_issue")).toBe(false);
  });

  test("search_tools auto-expose hint tells the model the tool needs a credential", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({
      catalog: linearCatalog,
      exposure,
      availableToolNames: new Set(),
    });
    const result = await runner.run(
      call(SEARCH_TOOLS_NAME, { query: "linear issue" }),
      signal,
    );
    const content = result.content as {
      hint: string;
      needsCredential?: string[];
    };
    expect(content.needsCredential).toEqual(["linear__create_issue"]);
    expect(content.hint).toMatch(/credential/i);
    expect(content.hint).toMatch(/Capabilities/);
  });

  test("load_tools by name returns an actionable credential-missing message instead of loading it", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({
      catalog: linearCatalog,
      exposure,
      availableToolNames: new Set(),
    });
    const result = await runner.run(
      call(LOAD_TOOLS_NAME, { names: ["linear__create_issue"] }),
      signal,
    );
    expect(result.isError).toBeUndefined();
    expect(exposure.exposed.size).toBe(0);
    const content = result.content as {
      loaded: string[];
      needsCredential?: string[];
      unknownNames: string[];
      note: string;
    };
    // Must not be reported as unknown — the tool IS catalogued, it just isn't
    // callable yet, which is a different, more useful message to the model.
    expect(content.unknownNames).toEqual([]);
    expect(content.loaded).toEqual([]);
    expect(content.needsCredential).toEqual(["linear__create_issue"]);
    expect(content.note).toMatch(/credential/i);
    expect(content.note).toMatch(/Capabilities/);
  });

  test("load_tools by package: available tools load and unavailable ones are reported separately", async () => {
    const mixedCatalog: ToolCatalog = [
      {
        package: "linear",
        summary: "Linear issue tracker.",
        tags: ["issues"],
        tools: [
          { name: "linear__create_issue", description: "Create an issue." },
          { name: "linear__list_issues", description: "List issues." },
        ],
      },
    ];
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({
      catalog: mixedCatalog,
      exposure,
      availableToolNames: new Set(["linear__list_issues"]),
    });
    const result = await runner.run(
      call(LOAD_TOOLS_NAME, { package: "linear" }),
      signal,
    );
    expect(exposure.exposed).toEqual(new Set(["linear__list_issues"]));
    const content = result.content as {
      loaded: string[];
      needsCredential?: string[];
    };
    expect(content.loaded).toEqual(["linear__list_issues"]);
    expect(content.needsCredential).toEqual(["linear__create_issue"]);
  });

  test("without availableToolNames, every catalogued tool is treated as available (backward compatible)", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog: linearCatalog, exposure });
    const result = await runner.run(
      call(LOAD_TOOLS_NAME, { names: ["linear__create_issue"] }),
      signal,
    );
    expect(exposure.exposed.has("linear__create_issue")).toBe(true);
    expect(
      (result.content as { needsCredential?: string[] }).needsCredential,
    ).toBeUndefined();
  });
});

describe("search_tools auto-expose and affordance", () => {
  test("auto-exposes the tools when three or fewer match", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog, exposure });
    const result = await runner.run(
      call(SEARCH_TOOLS_NAME, { query: "records" }),
      signal,
    );
    expect(result.isError).toBeUndefined();
    expect(exposure.exposed.has("attio__query_records")).toBe(true);
    const content = result.content as { loaded?: string[]; hint: string };
    expect(content.loaded).toEqual(["attio__query_records"]);
    expect(content.hint.toLowerCase()).toContain("call it directly");
  });

  test("auto-expose resets the loop guard (counts as a load)", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog, exposure });
    let last;
    for (let i = 0; i < 6; i++) {
      last = await runner.run(
        call(SEARCH_TOOLS_NAME, { query: "records" }),
        signal,
      );
    }
    expect(last?.isError).toBeUndefined();
  });

  test("more than three matches yields an explicit load_tools affordance", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog: wideCatalog, exposure });
    const result = await runner.run(
      call(SEARCH_TOOLS_NAME, { query: "issue" }),
      signal,
    );
    expect(result.isError).toBeUndefined();
    expect(exposure.exposed.size).toBe(0);
    const hint = (result.content as { hint: string }).hint;
    expect(hint).toContain("call load_tools with names:");
    expect(hint).toContain("linear__create_issue");
  });
});

describe("search_tools loop guard", () => {
  const hintOf = (r: { content: unknown }) =>
    (r.content as { hint?: string }).hint ?? "";

  test("first search of a query returns the normal load_tools hint", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog: wideCatalog, exposure });
    const r = await runner.run(
      call(SEARCH_TOOLS_NAME, { query: "issue" }),
      signal,
    );
    expect(r.isError).toBeUndefined();
    expect(hintOf(r)).toContain("Call load_tools");
  });

  test("repeating the same search escalates the hint but still returns matches", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog: wideCatalog, exposure });
    await runner.run(call(SEARCH_TOOLS_NAME, { query: "issue" }), signal);
    const second = await runner.run(
      call(SEARCH_TOOLS_NAME, { query: "issue" }),
      signal,
    );
    expect(second.isError).toBeUndefined();
    expect((second.content as { matchCount: number }).matchCount).toBe(1);
    expect(hintOf(second)).toContain("already ran this exact search");
  });

  test("the same search past the terminal threshold returns a stop error", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog: wideCatalog, exposure });
    let last;
    for (let i = 0; i < 4; i++) {
      last = await runner.run(
        call(SEARCH_TOOLS_NAME, { query: "issue" }),
        signal,
      );
    }
    expect(last?.isError).toBe(true);
    expect((last?.content as { error: string }).error).toContain(
      "Stop searching",
    );
  });

  test("the escalated hint tells the model to rephrase rather than give up", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog, exposure });
    await runner.run(call(SEARCH_TOOLS_NAME, { query: "crm" }), signal);
    const second = await runner.run(
      call(SEARCH_TOOLS_NAME, { query: "crm" }),
      signal,
    );
    expect(hintOf(second)).toMatch(/different wording|synonym|broader/i);
  });

  test("the escalated no-match hint points at rephrasing before concluding unavailable", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog, exposure });
    await runner.run(
      call(SEARCH_TOOLS_NAME, { query: "nonexistentzzz" }),
      signal,
    );
    const second = await runner.run(
      call(SEARCH_TOOLS_NAME, { query: "nonexistentzzz" }),
      signal,
    );
    const hint = hintOf(second);
    expect(hint).toMatch(/different wording|synonym|broader/i);
  });

  test("the terminal error instructs a reworded retry before declaring unavailable", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog, exposure });
    let last;
    for (let i = 0; i < 4; i++) {
      last = await runner.run(
        call(SEARCH_TOOLS_NAME, { query: "crm" }),
        signal,
      );
    }
    const error = (last?.content as { error: string }).error;
    expect(error).toMatch(/different wording|synonym|broader/i);
    expect(error).not.toMatch(/tell the user this capability is unavailable\b/);
  });

  test("a different query in between resets the run, so it never hard-errors", async () => {
    // Guards the 'no agent-chat regression' requirement: ordinary chat that
    // revisits the same query after other searches must never hit the stop
    // error, no matter how many total times a query recurs.
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog: wideCatalog, exposure });
    const results = [];
    for (let round = 0; round < 3; round++) {
      results.push(
        await runner.run(call(SEARCH_TOOLS_NAME, { query: "issue" }), signal),
      );
      results.push(
        await runner.run(call(SEARCH_TOOLS_NAME, { query: "issue" }), signal),
      );
      results.push(
        await runner.run(call(SEARCH_TOOLS_NAME, { query: "linear" }), signal),
      );
    }
    expect(results.some((r) => r.isError)).toBe(false);
  });

  test("distinct queries are unaffected by the repeat guard", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog: wideCatalog, exposure });
    const a = await runner.run(
      call(SEARCH_TOOLS_NAME, { query: "issue" }),
      signal,
    );
    const b = await runner.run(
      call(SEARCH_TOOLS_NAME, { query: "linear" }),
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
    const runner = createCatalogTools({ catalog: wideCatalog, exposure });
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(
        await runner.run(call(SEARCH_TOOLS_NAME, { query: "issue" }), signal),
      );
      await runner.run(call(LOAD_TOOLS_NAME, { package: "linear" }), signal);
    }
    expect(results.some((r) => r.isError)).toBe(false);
    expect(hintOf(results[1]!)).toContain("Call load_tools");
  });

  test("many distinct searches over a long session never trigger a stop or advisory", async () => {
    // The guard no longer counts a session total, so a genuinely exploring
    // long-lived session (Myra persists across days) is never pushed into a
    // 'stop searching' state by volume alone.
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog: wideCatalog, exposure });
    let last;
    for (let i = 0; i < 40; i++) {
      last = await runner.run(
        call(SEARCH_TOOLS_NAME, { query: `issue ${i}` }),
        signal,
      );
    }
    expect(last?.isError).toBeUndefined();
    expect(hintOf(last!)).toContain("Call load_tools");
  });
});
