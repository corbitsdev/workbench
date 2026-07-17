import { describe, expect, it } from "bun:test";
import { defaultDirectorFactory } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type {
  ReactorAction,
  ReactorCapabilities,
  ToolDefinition,
} from "@intx/types/runtime";

// These budget directors wrap the interchange default director and never read
// env in their constructor, so a bare stub is the correct fixture — mirrors the
// upstream default-director.test.ts pattern.
const stubEnv = {} as BaseEnv;
import {
  createWorkbenchDirectorRegistry,
  firecrawlDirector,
  granolaDirector,
  personalAgentDirector,
  triageBudgetDirector,
  TRIAGE_BUDGET_DIRECTOR_ID,
  workflowStepBudgetDirector,
  WORKFLOW_STEP_BUDGET_DIRECTOR_ID,
  WORKFLOW_STEP_MAX_TOOL_CALLS,
} from "./director-registry";
import { SUMMARIZE_COMPACTOR_NAME } from "./summarize-compactor";

describe("createWorkbenchDirectorRegistry", () => {
  it("resolves every Workbench director id", () => {
    const registry = createWorkbenchDirectorRegistry();
    for (const id of [
      "@workbench/agents/personal-agent",
      "@workbench/agents/granola",
      "@workbench/agents/firecrawl",
      TRIAGE_BUDGET_DIRECTOR_ID,
      WORKFLOW_STEP_BUDGET_DIRECTOR_ID,
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

  function recordingCapabilities(
    sink: ToolDefinition[][],
  ): ReactorCapabilities {
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

  it("wraps the interchange default director unconditionally — a triage prompt never carries the dynamic-tools opt-in marker", async () => {
    const director = triageBudgetDirector.factory({}, stubEnv, agent);
    const sink: ToolDefinition[][] = [];
    const cap = recordingCapabilities(sink);

    const actions = await director.decide(
      { type: "message.received" } as never,
      {
        turns: [],
        activeForks: [],
        pendingOperations: [],
        activeGates: [],
        tokenUsage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          thinking: 0,
        },
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
});

describe("workflowStepBudgetDirector.factory composition", () => {
  const readToolDef: ToolDefinition = {
    name: "attio__query_records",
    description: "query attio",
    inputSchema: { type: "object", properties: {}, required: [] },
  };

  function recordingCapabilities(
    sink: ToolDefinition[][],
  ): ReactorCapabilities {
    const noop: ReactorAction = { type: "wait" };
    return {
      infer: (options) => {
        sink.push([...(options?.tools ?? [])]);
        return { type: "infer", ...(options !== undefined ? { options } : {}) };
      },
      executeTools: (calls, parallel, addToHistory) => ({
        type: "execute_tools",
        calls,
        ...(parallel !== undefined ? { parallel } : {}),
        ...(addToHistory !== undefined ? { addToHistory } : {}),
      }),
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
    systemPrompt: "Analyze the CRM record.",
    toolDefinitions: [readToolDef],
    compactorNames: [],
  };

  it("resolves via the registry and wraps the default director for a step agent", async () => {
    const registry = createWorkbenchDirectorRegistry();
    const factory = registry.resolve({
      id: WORKFLOW_STEP_BUDGET_DIRECTOR_ID,
      config: {},
    });
    const director = factory({}, stubEnv, agent);
    const sink: ToolDefinition[][] = [];
    const cap = recordingCapabilities(sink);

    const actions = await director.decide(
      { type: "message.received" } as never,
      {
        turns: [],
        activeForks: [],
        pendingOperations: [],
        activeGates: [],
        tokenUsage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          thinking: 0,
        },
        lastCycleUsage: null,
        lastCycleSource: null,
        sessionId: "s1",
      },
      cap,
    );

    const arr = Array.isArray(actions) ? actions : [actions];
    expect(arr[0]?.type).toBe("infer");
    expect(sink[0]?.map((t) => t.name)).toEqual([readToolDef.name]);
  });

  it("caps tool calls at the workflow-step preset, above the triage preset", async () => {
    const director = workflowStepBudgetDirector.factory({}, stubEnv, agent);
    const cap = recordingCapabilities([]);

    const manyCalls = Array.from(
      { length: WORKFLOW_STEP_MAX_TOOL_CALLS },
      (_, i) => ({
        type: "tool_call" as const,
        id: `call-${i}`,
        name: readToolDef.name,
        arguments: {},
      }),
    );

    const actions = await director.decide(
      {
        type: "inference.done",
        turn: {
          role: "assistant",
          model: "test-model",
          timestamp: Date.now(),
          content: manyCalls,
        },
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          thinking: 0,
        },
        source: { id: "test-source", provider: "test", model: "test" },
      } as never,
      {
        turns: [],
        activeForks: [],
        pendingOperations: [],
        activeGates: [],
        tokenUsage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          thinking: 0,
        },
        lastCycleUsage: null,
        lastCycleSource: null,
        sessionId: "s1",
      },
      cap,
    );

    const arr = Array.isArray(actions) ? actions : [actions];
    const exec = arr.find((a) => a.type === "execute_tools");
    expect(exec).toBeDefined();
    if (exec?.type === "execute_tools") {
      expect(exec.calls).toHaveLength(WORKFLOW_STEP_MAX_TOOL_CALLS);
    }
  });
});

describe("withCompaction wrap applied by the registry", () => {
  const readToolDef: ToolDefinition = {
    name: "attio__query_records",
    description: "query attio",
    inputSchema: { type: "object", properties: {}, required: [] },
  };

  function makeCapabilities(): ReactorCapabilities {
    const noop: ReactorAction = { type: "wait" };
    return {
      infer: (options) => ({
        type: "infer",
        ...(options !== undefined ? { options } : {}),
      }),
      executeTools: () => noop,
      suspend: () => noop,
      fork: () => noop,
      emit: () => noop,
      reply: (content: string) => ({ type: "reply", content }),
      checkpoint: () => noop,
      compact: (compactor: string, reason: string) => ({
        type: "compact",
        compactor,
        reason,
      }),
      wait: () => noop,
      done: () => noop,
    };
  }

  // Any input/window ratio at or above COMPACTION_TRIGGER_THRESHOLD (0.8)
  // fires the trigger. The model id is unknown to the catalog, so
  // `contextWindowForModel` falls back to `DEFAULT_CONTEXT_WINDOW`
  // (128_000); 120_000/128_000 ≈ 0.94 clears the threshold with margin.
  const overThresholdState = {
    turns: [],
    activeForks: [],
    pendingOperations: [],
    activeGates: [],
    tokenUsage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      thinking: 0,
    },
    lastCycleUsage: {
      input: 120_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      thinking: 0,
    },
    lastCycleSource: {
      sourceId: "test-source",
      provider: "test",
      model: "claude-opus-4-1",
    },
    sessionId: "s1",
  };

  const messageEvent = { type: "message.received" } as never;

  it("emits caps.compact for an agent with the summarize compactor registered", async () => {
    const registry = createWorkbenchDirectorRegistry();
    const factory = registry.resolve({
      id: defaultDirectorFactory.id,
      config: {},
    });
    const director = factory({}, stubEnv, {
      systemPrompt: "You are a workbench agent.",
      toolDefinitions: [readToolDef],
      compactorNames: [SUMMARIZE_COMPACTOR_NAME],
    });
    const cap = makeCapabilities();

    const actions = await director.decide(
      messageEvent,
      overThresholdState,
      cap,
    );
    const arr = Array.isArray(actions) ? actions : [actions];

    expect(arr.some((a) => a.type === "compact")).toBe(true);
  });

  it("is a no-op for an agent without the summarize compactor registered", async () => {
    const registry = createWorkbenchDirectorRegistry();
    const factory = registry.resolve({
      id: WORKFLOW_STEP_BUDGET_DIRECTOR_ID,
      config: {},
    });
    const director = factory({}, stubEnv, {
      systemPrompt: "Analyze the CRM record.",
      toolDefinitions: [readToolDef],
      compactorNames: [],
    });
    const cap = makeCapabilities();

    const actions = await director.decide(
      messageEvent,
      overThresholdState,
      cap,
    );
    const arr = Array.isArray(actions) ? actions : [actions];

    expect(arr.some((a) => a.type === "compact")).toBe(false);
  });
});
