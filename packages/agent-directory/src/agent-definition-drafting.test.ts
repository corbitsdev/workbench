import { describe, expect, test } from "bun:test";

import {
  createMyraAgentDefinitionDrafting,
  parseAgentDefinitionDraftReply,
  validateAgentDefinitionDraftReplyAgainstInventory,
  AgentDefinitionDraftReplyUnparseableError,
  AgentDefinitionDraftReferenceOutOfInventoryError,
  MyraAgentDefinitionDraftingUnavailableError,
  type AgentDefinitionDraftingRunnerDeps,
} from "./agent-definition-drafting";
import type { InventorySources, PlannerInventory } from "./inventory";
import { FoldedRunTimedOutError } from "@corbits/folded-run-one-shot";

const INVENTORY_SOURCES: InventorySources = {
  async listConversationalAgents() {
    return [];
  },
  async listUsableToolPackages() {
    return [
      {
        name: "@corbits/granola-tools",
        connectorId: "granola",
        credentialBinding: {
          package: "@corbits/granola-tools",
          handle: "granola",
          provider: "granola",
          locator: "tenant",
        },
      },
    ];
  },
  async listSkills() {
    return [{ name: "incident-review" }];
  },
  memoryAvailable: false,
  async listModels() {
    return [{ canonicalName: "anthropic/claude-sonnet-5" }];
  },
};

const INVENTORY: PlannerInventory = {
  agents: [],
  toolPackages: [
    {
      name: "@corbits/granola-tools",
      connectorId: "granola",
      credentialBinding: {
        package: "@corbits/granola-tools",
        handle: "granola",
        provider: "granola",
        locator: "tenant",
      },
    },
  ],
  skills: [{ name: "incident-review" }],
  memoryAvailable: false,
  models: [{ canonicalName: "anthropic/claude-sonnet-5" }],
};

function buildDeps(
  overrides: Partial<AgentDefinitionDraftingRunnerDeps> = {},
): AgentDefinitionDraftingRunnerDeps {
  return {
    runner: {
      run: async () => ({
        content: JSON.stringify({
          systemPrompt: "You review incident reports and summarize them.",
          description: "Summarizes incident reports",
          modelPreference: "anthropic/claude-sonnet-5",
          toolPackagePins: ["@corbits/granola-tools"],
          skills: ["incident-review"],
        }),
        runId: "wfr_draft_1",
      }),
    },
    inventorySources: INVENTORY_SOURCES,
    resolveMyraDefinitionId: async () => "wfd_myra",
    ...overrides,
  };
}

const INPUT = {
  tenantId: "tnt_1",
  principalId: "prn_alice",
  name: "Incident Bot",
  purpose: "Summarize incident reports for the on-call workbench",
};

describe("parseAgentDefinitionDraftReply", () => {
  test("rejects malformed JSON", () => {
    expect(() => parseAgentDefinitionDraftReply("not json")).toThrow(
      AgentDefinitionDraftReplyUnparseableError,
    );
  });

  test("rejects a reply missing the required systemPrompt", () => {
    expect(() =>
      parseAgentDefinitionDraftReply(JSON.stringify({ description: "x" })),
    ).toThrow(AgentDefinitionDraftReplyUnparseableError);
  });

  test("rejects an empty systemPrompt", () => {
    expect(() =>
      parseAgentDefinitionDraftReply(JSON.stringify({ systemPrompt: "" })),
    ).toThrow(AgentDefinitionDraftReplyUnparseableError);
  });

  test("rejects a toolPackagePins array over the cardinality bound", () => {
    const pins = Array.from({ length: 9 }, (_, i) => `pkg-${i}`);
    expect(() =>
      parseAgentDefinitionDraftReply(
        JSON.stringify({ systemPrompt: "You help.", toolPackagePins: pins }),
      ),
    ).toThrow(AgentDefinitionDraftReplyUnparseableError);
  });

  test("rejects duplicate toolPackagePins", () => {
    expect(() =>
      parseAgentDefinitionDraftReply(
        JSON.stringify({
          systemPrompt: "You help.",
          toolPackagePins: ["a", "a"],
        }),
      ),
    ).toThrow(AgentDefinitionDraftReplyUnparseableError);
  });

  test("a minimal valid reply parses", () => {
    const parsed = parseAgentDefinitionDraftReply(
      JSON.stringify({ systemPrompt: "You help with incidents." }),
    );
    expect(parsed.systemPrompt).toBe("You help with incidents.");
  });
});

describe("validateAgentDefinitionDraftReplyAgainstInventory", () => {
  test("an out-of-inventory modelPreference is rejected", () => {
    expect(() =>
      validateAgentDefinitionDraftReplyAgainstInventory(
        { systemPrompt: "You help.", modelPreference: "made-up/model" },
        INVENTORY,
      ),
    ).toThrow(AgentDefinitionDraftReferenceOutOfInventoryError);
  });

  test("an out-of-inventory tool package pin is rejected", () => {
    expect(() =>
      validateAgentDefinitionDraftReplyAgainstInventory(
        { systemPrompt: "You help.", toolPackagePins: ["@corbits/made-up"] },
        INVENTORY,
      ),
    ).toThrow(AgentDefinitionDraftReferenceOutOfInventoryError);
  });

  test("an out-of-inventory skill is rejected", () => {
    expect(() =>
      validateAgentDefinitionDraftReplyAgainstInventory(
        { systemPrompt: "You help.", skills: ["made-up-skill"] },
        INVENTORY,
      ),
    ).toThrow(AgentDefinitionDraftReferenceOutOfInventoryError);
  });

  test("a fully in-inventory reply resolves with defaulted collections", () => {
    const draft = validateAgentDefinitionDraftReplyAgainstInventory(
      { systemPrompt: "You help." },
      INVENTORY,
    );
    expect(draft).toEqual({
      systemPrompt: "You help.",
      toolPackagePins: [],
      skills: [],
    });
  });

  test("@corbits/capability-tools is pinned by default when the inventory offers it, even though Myra never chose it", () => {
    const inventoryWithCapabilityTools: PlannerInventory = {
      ...INVENTORY,
      toolPackages: [
        ...INVENTORY.toolPackages,
        {
          name: "@corbits/capability-tools",
          connectorId: "capability",
          credentialBinding: null,
        },
      ],
    };
    const draft = validateAgentDefinitionDraftReplyAgainstInventory(
      { systemPrompt: "You help." },
      inventoryWithCapabilityTools,
    );
    expect(draft.toolPackagePins).toEqual(["@corbits/capability-tools"]);
  });

  test("the default capability-tools pin is never duplicated when Myra already chose it", () => {
    const inventoryWithCapabilityTools: PlannerInventory = {
      ...INVENTORY,
      toolPackages: [
        ...INVENTORY.toolPackages,
        {
          name: "@corbits/capability-tools",
          connectorId: "capability",
          credentialBinding: null,
        },
      ],
    };
    const draft = validateAgentDefinitionDraftReplyAgainstInventory(
      {
        systemPrompt: "You help.",
        toolPackagePins: ["@corbits/capability-tools"],
      },
      inventoryWithCapabilityTools,
    );
    expect(draft.toolPackagePins).toEqual(["@corbits/capability-tools"]);
  });

  test("no capability-tools pin is added when the tenant's inventory never offers it", () => {
    const draft = validateAgentDefinitionDraftReplyAgainstInventory(
      { systemPrompt: "You help." },
      INVENTORY,
    );
    expect(draft.toolPackagePins).not.toContain("@corbits/capability-tools");
  });
});

describe("createMyraAgentDefinitionDrafting", () => {
  test("a valid in-inventory reply succeeds", async () => {
    const drafting = createMyraAgentDefinitionDrafting(buildDeps());
    const draft = await drafting.propose(INPUT);
    expect(draft).toEqual({
      systemPrompt: "You review incident reports and summarize them.",
      description: "Summarizes incident reports",
      modelPreference: "anthropic/claude-sonnet-5",
      toolPackagePins: ["@corbits/granola-tools"],
      skills: ["incident-review"],
    });
  });

  test("an unparseable reply propagates as AgentDefinitionDraftReplyUnparseableError", async () => {
    const drafting = createMyraAgentDefinitionDrafting(
      buildDeps({
        runner: { run: async () => ({ content: "nope", runId: "wfr_x" }) },
      }),
    );
    await expect(drafting.propose(INPUT)).rejects.toBeInstanceOf(
      AgentDefinitionDraftReplyUnparseableError,
    );
  });

  test("an out-of-inventory reply propagates as AgentDefinitionDraftReferenceOutOfInventoryError", async () => {
    const drafting = createMyraAgentDefinitionDrafting(
      buildDeps({
        runner: {
          run: async () => ({
            content: JSON.stringify({
              systemPrompt: "You help.",
              modelPreference: "made-up/model",
            }),
            runId: "wfr_x",
          }),
        },
      }),
    );
    await expect(drafting.propose(INPUT)).rejects.toBeInstanceOf(
      AgentDefinitionDraftReferenceOutOfInventoryError,
    );
  });

  test("a runner failure propagates unchanged, never fabricating a draft", async () => {
    const drafting = createMyraAgentDefinitionDrafting(
      buildDeps({
        runner: {
          run: async () => {
            throw new FoldedRunTimedOutError(60_000);
          },
        },
      }),
    );
    await expect(drafting.propose(INPUT)).rejects.toBeInstanceOf(
      FoldedRunTimedOutError,
    );
  });

  test("a name-only propose (no purpose) still runs the drafting flow, never a template", async () => {
    let sentPrompt = "";
    const drafting = createMyraAgentDefinitionDrafting(
      buildDeps({
        runner: {
          run: async ({ prompt }) => {
            sentPrompt = prompt;
            return {
              content: JSON.stringify({
                systemPrompt: "You are a friendly, capable assistant.",
              }),
              runId: "wfr_draft_2",
            };
          },
        },
      }),
    );
    const draft = await drafting.propose({
      tenantId: "tnt_1",
      principalId: "prn_alice",
      name: "New Agent",
    });
    expect(draft.systemPrompt).toBe("You are a friendly, capable assistant.");
    expect(sentPrompt).toContain("New Agent");
    expect(sentPrompt).not.toContain("undefined");
  });

  test("the drafting brief instructs the drafted agent to greet, introduce itself, and ask what it's for on its first reply", async () => {
    let sentPrompt = "";
    const drafting = createMyraAgentDefinitionDrafting(
      buildDeps({
        runner: {
          run: async ({ prompt }) => {
            sentPrompt = prompt;
            return {
              content: JSON.stringify({ systemPrompt: "You help." }),
              runId: "wfr_draft_3",
            };
          },
        },
      }),
    );
    await drafting.propose(INPUT);

    expect(sentPrompt).toContain("first reply");
    expect(sentPrompt).toContain("greet the person by name");
    expect(sentPrompt).toContain("introduce itself");
    expect(sentPrompt).toContain("one concrete first step");
    expect(sentPrompt).toContain("never as a menu");
    expect(sentPrompt).not.toContain("request_capability");
  });

  // CL-5879: a specialist agent delegated to via @mention deep-dives in
  // a thread; the drafting brief must tell the drafted agent to close
  // that thread out with a summary back to whoever delegated it and to
  // the main conversation, so a handoff never dead-ends in the thread.
  test("the drafting brief instructs the drafted agent to finish a delegated thread with a summary back to the host/main", async () => {
    let sentPrompt = "";
    const drafting = createMyraAgentDefinitionDrafting(
      buildDeps({
        runner: {
          run: async ({ prompt }) => {
            sentPrompt = prompt;
            return {
              content: JSON.stringify({ systemPrompt: "You help." }),
              runId: "wfr_draft_3b",
            };
          },
        },
      }),
    );
    await drafting.propose(INPUT);

    expect(sentPrompt).toContain("@mentions it to delegate a job");
    expect(sentPrompt).toContain("finish that thread with a one-line");
    expect(sentPrompt).toContain("whoever delegated it and to the main");
  });

  // CL-6350: every drafted agent's systemPrompt must carry an explicit
  // output contract and name its own tools, matching the prompt
  // discipline Myra's own system prompt already follows.
  test("the drafting brief requires an explicit output contract and named tools in the drafted systemPrompt", async () => {
    let sentPrompt = "";
    const drafting = createMyraAgentDefinitionDrafting(
      buildDeps({
        runner: {
          run: async ({ prompt }) => {
            sentPrompt = prompt;
            return {
              content: JSON.stringify({ systemPrompt: "You help." }),
              runId: "wfr_draft_3c",
            };
          },
        },
      }),
    );
    await drafting.propose(INPUT);

    expect(sentPrompt).toContain("explicit output");
    expect(sentPrompt).toContain("contract");
    expect(sentPrompt).toContain("Name");
    expect(sentPrompt).toContain("agent's own tools in the systemPrompt");
  });

  test("the prompt tells the model request_capability is pinned automatically, only when @corbits/capability-tools is offered", async () => {
    let sentPrompt = "";
    const drafting = createMyraAgentDefinitionDrafting(
      buildDeps({
        inventorySources: {
          ...INVENTORY_SOURCES,
          async listUsableToolPackages(tenantId: string) {
            return [
              ...(await INVENTORY_SOURCES.listUsableToolPackages(tenantId)),
              {
                name: "@corbits/capability-tools",
                connectorId: "capability-tools",
                credentialBinding: null,
              },
            ];
          },
        },
        runner: {
          run: async ({ prompt }) => {
            sentPrompt = prompt;
            return {
              content: JSON.stringify({ systemPrompt: "You help." }),
              runId: "wfr_draft_4",
            };
          },
        },
      }),
    );
    await drafting.propose(INPUT);
    expect(sentPrompt).toContain("@corbits/capability-tools");
    expect(sentPrompt).toContain("request_capability");
    expect(sentPrompt).toContain("a human has to approve");
  });

  test("an unresolvable Myra definition surfaces as MyraAgentDefinitionDraftingUnavailableError", async () => {
    const drafting = createMyraAgentDefinitionDrafting(
      buildDeps({
        resolveMyraDefinitionId: async () => {
          throw new Error("no myra deployed for this tenant");
        },
      }),
    );
    await expect(drafting.propose(INPUT)).rejects.toBeInstanceOf(
      MyraAgentDefinitionDraftingUnavailableError,
    );
  });
});
