import { describe, expect, test } from "bun:test";
import type {
  ReactorAction,
  ReactorCapabilities,
  ReactorInboundEvent,
  ReactorState,
  ToolCall,
  ToolDefinition,
} from "@intx/types/runtime";
import type { ToolCatalog, ToolExposureState } from "@workbench/tools-catalog";
import { createCatalogTools } from "@workbench/tools-catalog";
import { canonicalizeToolNames, toLlmToolName } from "../tool-names";
import {
  PERSONAL_AGENT_BASE_TOOLS,
  PERSONAL_AGENT_NAME,
} from "../personal-agent/definition";
import { buildPersonalAgentSystemPrompt } from "../personal-agent/prompt";
import { createDynamicToolsDirector } from "./director";
import { MYRA_TOOL_CATALOG } from "./catalog";
import {
  PERSONAL_AGENT_DYNAMIC_TOOLS,
  resolveDynamicToolConfig,
} from "./index";

function def(name: string): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {}, required: [] },
  };
}

function recordingCapabilities(sink: {
  tools: ToolDefinition[][];
}): ReactorCapabilities {
  const action: ReactorAction = { type: "wait" };
  return {
    infer: (options) => {
      sink.tools.push([...(options?.tools ?? [])]);
      return { type: "infer", ...(options !== undefined ? { options } : {}) };
    },
    executeTools: () => action,
    suspend: () => action,
    fork: () => action,
    emit: () => action,
    reply: () => action,
    checkpoint: () => action,
    compact: () => action,
    wait: () => action,
    done: () => action,
  };
}

const messageReceived: ReactorInboundEvent = {
  type: "message.received",
  message: {
    id: "m1",
    headers: { from: "user@example.com", to: [], subject: "" },
    body: "hi",
  } as never,
};

const state = {} as ReactorState;

const catalog: ToolCatalog = [
  {
    package: "attio",
    summary: "Attio CRM.",
    tags: ["crm"],
    tools: [{ name: "attio__query_records", description: "Query records." }],
  },
];

const toolDefs: ToolDefinition[] = [
  def("exa__search"),
  def("search_tools"),
  def("load_tools"),
  def("attio__query_records"),
];

describe("createDynamicToolsDirector advertisement", () => {
  test("hides catalog-managed tools but keeps base and catalog tools on turn one", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const director = createDynamicToolsDirector("sys", toolDefs, {
      catalog,
      exposure,
    });
    const sink = { tools: [] as ToolDefinition[][] };
    await director.decide(messageReceived, state, recordingCapabilities(sink));
    const advertised = (sink.tools[0] ?? []).map((d) => d.name);
    expect(advertised).toContain("exa__search");
    expect(advertised).toContain("search_tools");
    expect(advertised).toContain("load_tools");
    expect(advertised).not.toContain("attio__query_records");
  });

  test("exposed tools become advertised and stay sticky across turns", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const director = createDynamicToolsDirector("sys", toolDefs, {
      catalog,
      exposure,
    });

    const first = { tools: [] as ToolDefinition[][] };
    await director.decide(messageReceived, state, recordingCapabilities(first));
    expect((first.tools[0] ?? []).map((d) => d.name)).not.toContain(
      "attio__query_records",
    );

    exposure.exposed.add("attio__query_records");

    const second = { tools: [] as ToolDefinition[][] };
    await director.decide(
      messageReceived,
      state,
      recordingCapabilities(second),
    );
    expect((second.tools[0] ?? []).map((d) => d.name)).toContain(
      "attio__query_records",
    );

    // Sticky: a later turn still advertises it without re-loading.
    const third = { tools: [] as ToolDefinition[][] };
    await director.decide(messageReceived, state, recordingCapabilities(third));
    expect((third.tools[0] ?? []).map((d) => d.name)).toContain(
      "attio__query_records",
    );
  });
});

describe("resolveDynamicToolConfig opt-in gating", () => {
  test("returns the Myra config for the personal-agent prompt", () => {
    const prompt =
      "You are Myra, Chief of Staff to the one person you work for.";
    expect(resolveDynamicToolConfig(prompt)).toBe(PERSONAL_AGENT_DYNAMIC_TOOLS);
  });

  test("returns undefined for a non-personal-agent prompt", () => {
    expect(
      resolveDynamicToolConfig("You are Oat, a meeting agent."),
    ).toBeUndefined();
  });

  // Guards the silent-disable landmine: the opt-in marker is a substring match
  // against Myra's real prompt. If the prompt's role opening is reworded, the
  // marker stops matching and the whole feature silently reverts to full
  // advertisement with no other test failing — so pin it to the ACTUAL built
  // prompt, not a hand-written literal.
  test("matches the real built Myra system prompt (marker↔prompt drift guard)", () => {
    const realPrompt = buildPersonalAgentSystemPrompt(PERSONAL_AGENT_NAME, {
      xml: true,
    });
    expect(resolveDynamicToolConfig(realPrompt)).toBe(
      PERSONAL_AGENT_DYNAMIC_TOOLS,
    );
  });
});

// The critical seam AGENTS.md requires an integration test for: the REAL
// load_tools runner and the director share ONE exposureState by reference, so a
// load must flow through to advertisement. The unit tests above hand-mutate the
// set; this exercises the actual runner → shared-state → director path end to
// end, catching an env/by-reference regression that would otherwise be green.
describe("load_tools → shared exposureState → director advertises (integration)", () => {
  test("a tool loaded by the real runner becomes advertised by the director", async () => {
    const exposure: ToolExposureState = { exposed: new Set() };
    const runner = createCatalogTools({ catalog, exposure });
    const director = createDynamicToolsDirector("sys", toolDefs, {
      catalog,
      exposure,
    });

    // Turn one: the catalog-managed tool is hidden.
    const before = { tools: [] as ToolDefinition[][] };
    await director.decide(
      messageReceived,
      state,
      recordingCapabilities(before),
    );
    expect((before.tools[0] ?? []).map((d) => d.name)).not.toContain(
      "attio__query_records",
    );

    // Load it through the REAL runner (mutates the shared exposureState).
    await runner.run(
      {
        id: "c1",
        name: "load_tools",
        arguments: { package: "attio" },
      } as ToolCall,
      new AbortController().signal,
    );
    expect(exposure.exposed.has("attio__query_records")).toBe(true);

    // Next turn: the director advertises it — via the same shared state, not a
    // hand-mutation.
    const after = { tools: [] as ToolDefinition[][] };
    await director.decide(messageReceived, state, recordingCapabilities(after));
    expect((after.tools[0] ?? []).map((d) => d.name)).toContain(
      "attio__query_records",
    );
  });
});

describe("MYRA_TOOL_CATALOG metadata", () => {
  test("every cataloged tool is one Myra is actually granted (in base tools)", () => {
    const baseSafeNames = new Set(
      PERSONAL_AGENT_BASE_TOOLS.map((n) => toLlmToolName(n)),
    );
    for (const entry of MYRA_TOOL_CATALOG) {
      for (const tool of entry.tools) {
        expect(baseSafeNames.has(tool.name)).toBe(true);
      }
    }
  });

  test("catalog names are the toLlmToolName form (match live definitions)", () => {
    const attio = MYRA_TOOL_CATALOG.find((e) => e.package === "attio");
    const expected = toLlmToolName(
      canonicalizeToolNames(["attio_query_records"])[0] ?? "",
    );
    expect(attio?.tools.some((t) => t.name === expected)).toBe(true);
    expect(expected).toBe("attio__query_records");
  });
});
