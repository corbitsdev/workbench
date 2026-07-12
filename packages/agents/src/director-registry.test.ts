import { describe, expect, it } from "bun:test";
import { defaultDirectorFactory } from "@intx/agent";
import type {
  ReactorAction,
  ReactorCapabilities,
  ToolDefinition,
} from "@intx/types/runtime";
import { DYNAMIC_TOOLS_ENV_KEY, type ToolCatalog } from "@workbench/tools-catalog";
import {
  createWorkbenchDirectorRegistry,
  firecrawlDirector,
  granolaDirector,
  personalAgentDirector,
  triageBudgetDirector,
  TRIAGE_BUDGET_DIRECTOR_ID,
} from "./director-registry";

describe("createWorkbenchDirectorRegistry", () => {
  it("resolves every Workbench director id", () => {
    const registry = createWorkbenchDirectorRegistry();
    for (const id of [
      "@workbench/agents/personal-agent",
      "@workbench/agents/granola",
      "@workbench/agents/firecrawl",
      TRIAGE_BUDGET_DIRECTOR_ID,
    ]) {
      expect(registry.resolve({ id, config: { allowedSenders: [] } }).id).toBe(
        id,
      );
    }
  });

  it("falls back to the interchange default for an agent without a director ref", () => {
    const registry = createWorkbenchDirectorRegistry();
    expect(registry.buildDefaultRef().id).toBe(defaultDirectorFactory.id);
    expect(registry.defaultFactory().id).toBe(defaultDirectorFactory.id);
  });

  it("throws for an unknown director id", () => {
    const registry = createWorkbenchDirectorRegistry();
    expect(() =>
      registry.resolve({ id: "@workbench/agents/nope", config: {} }),
    ).toThrow();
  });
});

describe("director build() refs", () => {
  it("stamps the id and config into a sender-filter ref", () => {
    const ref = personalAgentDirector.build({
      allowedSenders: ["ada@workbench.dev"],
    });
    expect(ref).toEqual({
      id: "@workbench/agents/personal-agent",
      config: { allowedSenders: ["ada@workbench.dev"] },
    });
  });

  it("stamps the granola id into its ref", () => {
    expect(granolaDirector.build({ allowedSenders: [] }).id).toBe(
      "@workbench/agents/granola",
    );
  });

  it("builds the firecrawl director from an empty config", () => {
    expect(firecrawlDirector.build({}).id).toBe("@workbench/agents/firecrawl");
  });

  it("builds the triage-budget director from an empty config", () => {
    expect(triageBudgetDirector.build({}).id).toBe(TRIAGE_BUDGET_DIRECTOR_ID);
  });
});

describe("triageBudgetDirector.factory composition", () => {
  const managedToolDef: ToolDefinition = {
    name: "attio__query_records",
    description: "query attio",
    inputSchema: { type: "object", properties: {}, required: [] },
  };
  const unmanagedToolDef: ToolDefinition = {
    name: "read_file",
    description: "read a file",
    inputSchema: { type: "object", properties: {}, required: [] },
  };
  const catalog: ToolCatalog = [
    {
      package: "attio",
      summary: "attio",
      tags: [],
      tools: [{ name: managedToolDef.name, description: "query attio" }],
    },
  ];

  function recordingCapabilities(sink: ToolDefinition[][]): ReactorCapabilities {
    const noop: ReactorAction = { type: "wait" };
    return {
      infer: (options) => {
        sink.push([...(options?.tools ?? [])]);
        return { type: "infer", ...(options !== undefined ? { options } : {}) };
      },
      executeTools: () => noop,
      suspend: () => noop,
      fork: () => noop,
      emit: () => noop,
      reply: (content: string) => ({ type: "reply", content }),
      checkpoint: () => noop,
      compact: () => noop,
      wait: () => noop,
      done: () => noop,
    };
  }

  const agent = {
    systemPrompt: "You are Myra, triaging.",
    toolDefinitions: [managedToolDef, unmanagedToolDef],
    compactorNames: [],
  };

  it("wraps the interchange default director when env carries no dynamic-tools state", async () => {
    const director = triageBudgetDirector.factory({}, {}, agent);
    const sink: ToolDefinition[][] = [];
    const cap = recordingCapabilities(sink);

    const actions = await director.decide(
      { type: "message.received" } as never,
      {
        turns: [],
        activeForks: [],
        pendingOperations: [],
        activeGates: [],
        tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
        lastCycleUsage: null,
        lastCycleSource: null,
        sessionId: "s1",
      },
      cap,
    );

    const arr = Array.isArray(actions) ? actions : [actions];
    expect(arr[0]?.type).toBe("infer");
    // The default director advertises every resolved tool unfiltered.
    expect(sink[0]?.map((t) => t.name).sort()).toEqual(
      [managedToolDef.name, unmanagedToolDef.name].sort(),
    );
  });

  it("wraps the dynamic-tools director when env carries dynamic-tools state, hiding unexposed catalog tools", async () => {
    const env = {
      [DYNAMIC_TOOLS_ENV_KEY]: {
        catalog,
        exposure: { exposed: new Set<string>() },
      },
    };
    const director = triageBudgetDirector.factory({}, env, agent);
    const sink: ToolDefinition[][] = [];
    const cap = recordingCapabilities(sink);

    const actions = await director.decide(
      { type: "message.received" } as never,
      {
        turns: [],
        activeForks: [],
        pendingOperations: [],
        activeGates: [],
        tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
        lastCycleUsage: null,
        lastCycleSource: null,
        sessionId: "s1",
      },
      cap,
    );

    const arr = Array.isArray(actions) ? actions : [actions];
    expect(arr[0]?.type).toBe("infer");
    // The catalog-managed tool is hidden until exposed; the unmanaged tool
    // (not part of any catalog entry) still advertises.
    expect(sink[0]?.map((t) => t.name)).toEqual([unmanagedToolDef.name]);
  });
});
