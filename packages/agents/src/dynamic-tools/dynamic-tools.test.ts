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
import {
  canonicalizeToolNames,
  producibleLlmToolNames,
  producibleLlmToolNamesForPins,
  toLlmToolName,
} from "../tool-names";
import { catalogManagedNames } from "@workbench/tools-catalog";
import {
  PERSONAL_AGENT_BASE_TOOLS,
  PERSONAL_AGENT_NAME,
  PERSONAL_AGENT_PLATFORM_TOOLS,
  buildPersonalAgentSystemPrompt,
} from "@workbench/myra";
import { AGENT_TEMPLATES } from "../templates";
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

// CL-3190: the loadout is a strict partition. Every tool Myra materializes
// from her pins is EITHER an advertised platform tool OR catalog-managed
// (hidden until load_tools). Nothing leaks onto turn one, and the catalog is
// the single source of truth for the integration grants.
describe("Myra loadout partition (CL-3190)", () => {
  const myra = AGENT_TEMPLATES.find((t) => t.key === "myra");
  const myraPins = myra?.toolPackages ?? [];
  const platformLlm = new Set(
    PERSONAL_AGENT_PLATFORM_TOOLS.map((n) => toLlmToolName(n)),
  );
  const catalogLlm = catalogManagedNames(MYRA_TOOL_CATALOG);

  test("platform tools are exactly the minimal advertised set", () => {
    expect(PERSONAL_AGENT_PLATFORM_TOOLS).toEqual([
      "search_tools",
      "load_tools",
      "@workbench/tools-artifact/artifact:memory_load",
      "@workbench/tools-artifact/artifact:memory_save",
      "@workbench/tools-artifact/artifact:artifact_create",
      "@workbench/tools-artifact/artifact:artifact_read",
      "@workbench/tools-artifact/artifact:artifact_write",
      "@workbench/tools-artifact/artifact:artifact_list",
      "@workbench/tools-workflows/workflows:workflow_list_kinds",
      "@workbench/tools-workflows/workflows:workflow_start",
      "@workbench/tools-skills/skills:search_skills",
      "@workbench/tools-skills/skills:load_skill",
      "@workbench/tools-skills/skills:list_skill_drafts",
      "@workbench/tools-skills/skills:load_skill_draft",
      "mail_send",
      "task_create",
    ]);
  });

  test("no producible Myra tool leaks onto turn one (platform ∪ catalog covers all)", () => {
    const producible = producibleLlmToolNamesForPins(myraPins);
    const leaks = [...producible].filter(
      (n) => !platformLlm.has(n) && !catalogLlm.has(n),
    );
    expect(leaks).toEqual([]);
  });

  test("every catalog tool is producible from Myra's pins", () => {
    const producible = producibleLlmToolNamesForPins(myraPins);
    const dead = [...catalogLlm].filter((n) => !producible.has(n));
    expect(dead).toEqual([]);
  });

  test("every non-local platform tool is producible from Myra's pins", () => {
    const producible = producibleLlmToolNamesForPins(myraPins);
    // mail_send/task_create are native sidecar/hub tools (see
    // MYRA_PLATFORM_BARE_TOOL_NAMES) — always mounted by the harness, not
    // shipped by a pinned package, so they are locals like search_tools.
    const locals = new Set([
      "search_tools",
      "load_tools",
      "mail_send",
      "task_create",
    ]);
    const missing = [...platformLlm].filter(
      (n) => !locals.has(n) && !producible.has(n),
    );
    expect(missing).toEqual([]);
  });

  test("platform and catalog do not overlap", () => {
    const overlap = [...platformLlm].filter((n) => catalogLlm.has(n));
    expect(overlap).toEqual([]);
  });

  test("base tools (the grant list) are exactly platform ∪ catalog", () => {
    const baseLlm = new Set(
      PERSONAL_AGENT_BASE_TOOLS.map((n) => toLlmToolName(n)),
    );
    const expected = new Set([...platformLlm, ...catalogLlm]);
    expect([...baseLlm].sort()).toEqual([...expected].sort());
  });

  test("all Myra pins use the '*' version policy", () => {
    expect(myraPins.length).toBeGreaterThan(0);
    for (const pin of myraPins) expect(pin.version).toBe("*");
  });

  // A pin must be a bare @scope/package name — one published tarball ships all
  // its factories. A factory subpath (e.g. `@workbench/tools-vercel/deploy-
  // artifact`) has no tarball and throws in the closure resolver at launch
  // (`resolveClosure` → `fetchPackument`), breaking Myra's tool manifest. The
  // partition helper prefix-matches subpaths, so only this guard catches it.
  test("every Myra pin is a bare @scope/package name (no factory subpath)", () => {
    for (const pin of myraPins) {
      expect(pin.name).toMatch(/^@[^/]+\/[^/]+$/);
    }
  });

  test("no workflow-only tool packages (gamma, last30days) on Myra", () => {
    for (const pin of myraPins) {
      expect(pin.name.includes("tools-gamma")).toBe(false);
      expect(pin.name.includes("tools-last30days")).toBe(false);
    }
    for (const tool of PERSONAL_AGENT_BASE_TOOLS) {
      expect(tool.includes("tools-gamma")).toBe(false);
      expect(tool.includes("tools-last30days")).toBe(false);
    }
    for (const name of catalogLlm) {
      expect(name.startsWith("gamma__")).toBe(false);
      expect(name.startsWith("last30days__")).toBe(false);
    }
  });
});

// CL-3190: the guarantee that actually matters — the director advertises
// EXACTLY the platform set on turn one, given Myra's real materialized tools.
describe("advertised turn-1 loadout == platform (CL-3190)", () => {
  test("director advertises exactly PERSONAL_AGENT_PLATFORM_TOOLS", async () => {
    const myra = AGENT_TEMPLATES.find((t) => t.key === "myra");
    const producible = [
      ...producibleLlmToolNamesForPins(myra?.toolPackages ?? []),
    ];
    const toolDefs = [
      def("search_tools"),
      def("load_tools"),
      // Native sidecar/hub tools, not from a pinned package (see
      // MYRA_PLATFORM_BARE_TOOL_NAMES) — the harness always mounts these
      // alongside the pinned-package tool set at launch.
      def(toLlmToolName("mail_send")),
      def(toLlmToolName("task_create")),
      ...producible.map(def),
    ];
    const exposure: ToolExposureState = { exposed: new Set() };
    const director = createDynamicToolsDirector("sys", toolDefs, {
      catalog: MYRA_TOOL_CATALOG,
      exposure,
    });
    const sink = { tools: [] as ToolDefinition[][] };
    await director.decide(messageReceived, state, recordingCapabilities(sink));
    const advertised = new Set((sink.tools[0] ?? []).map((d) => d.name));
    const platformLlm = PERSONAL_AGENT_PLATFORM_TOOLS.map((n) =>
      toLlmToolName(n),
    );
    expect([...advertised].sort()).toEqual([...platformLlm].sort());
  });
});

describe("catalog / loaded-tool name invariant", () => {
  // The sidecar credential-gate advertises a catalog package only when its
  // tools appear in the loaded tool-name set, matched by exact LLM-facing name.
  // This pins the catalog against the PACKAGE_TOOLS table (catch a catalog bare
  // name that no declared package tool backs). It does NOT catch drift between
  // PACKAGE_TOOLS and a package's real runtime tool-definition names — but that
  // drift is safe: a loaded tool whose name matches no catalog entry falls into
  // the director's base set and is always advertised (see director.ts
  // advertised()), never hidden. So the worst case a mismatch causes is "shown
  // in the base set instead of via search", not "invisible".
  test("every MYRA_TOOL_CATALOG tool name is producible by a known package", () => {
    const producible = producibleLlmToolNames();
    const orphans = [...catalogManagedNames(MYRA_TOOL_CATALOG)].filter(
      (name) => !producible.has(name),
    );
    expect(orphans).toEqual([]);
  });
});
