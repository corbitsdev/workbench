import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema as intxSchema } from "@intx/db";
import {
  deriveDeploymentAddress,
  type CapabilityWalkResult,
} from "@intx/workflow-deploy";
import type { WorkflowDefinition } from "@intx/workflow";
import type { HarnessConfig, InferenceSource } from "@intx/types/runtime";
import type { DirectorRegistry } from "@intx/agent";
import type { AgentRepoStore, SidecarRouter } from "@workbench/hub-sessions";
import type { HubDb } from "../db";
import { evaluateGrants } from "@intx/authz";
import { toolPackagesForCapabilities } from "@workbench/agents";
import type { GrantRule } from "@intx/authz";
import { createEffectContext, defineWorkflow, map, step } from "@intx/workflow";
import { defineAgent } from "@intx/agent";
import {
  createWorkbenchDirectorRegistry,
  deterministicToolStep,
  agentStep,
} from "@workbench/agents";

// readWorkflowDefinition reads its cache TTL from getConfig(); apps/hub tests do
// not preload test-setup/loadConfig, so stub the one field it touches.
mock.module("../config", () => ({
  getConfig: () => ({
    workflowDeploy: {
      modelSourceCacheTtlMs: 45_000,
      definitionCacheTtlMs: 45_000,
    },
  }),
}));

import {
  buildStepGrantRules,
  buildSupervisorDeployFrame,
  capabilityNames,
  stepGrantCapabilityNames,
  collectDeterministicToolStepIds,
  collectGrants,
  createWorkflowDeployService,
  createWorkflowRepoWriter,
  readWorkflowDefinition,
  resetWorkflowDefinitionCache,
  toSendMultiStepDeploy,
  ensureDeploymentInstanceActive,
  writeDeploymentAgentRow,
  writeDeploymentInstanceRow,
  writeStepAgentRows,
  writeStepGrantFiles,
  writeStepInstanceRows,
} from "./workflow-deploy";

describe("createWorkflowRepoWriter", () => {
  test("writes the definition tree on refs/heads/main as the hub principal", async () => {
    const writeTree = mock(
      async (
        _principal: { kind: string },
        _repoId: { kind: string; id: string },
        _ref: string,
        _content: { files: Record<string, string> },
      ) => ({ commitSha: "sha" }),
    );
    const repoStore = { repoStore: { writeTree } } as unknown as AgentRepoStore;

    await createWorkflowRepoWriter(repoStore).writeWorkflowRepo({
      workflowRepoId: "wf",
      files: new Map([
        ["workflow.json", "{}"],
        [".gitignore", ""],
      ]),
    });

    const call = writeTree.mock.calls.at(0);
    if (!call) throw new Error("writeTree was not called");
    const [principal, repoId, ref, content] = call;
    expect(principal).toEqual({ kind: "hub" });
    expect(repoId).toEqual({ kind: "workflow", id: "wf" });
    expect(ref).toBe("refs/heads/main");
    expect(content.files).toEqual({ "workflow.json": "{}", ".gitignore": "" });
  });
});

describe("toSendMultiStepDeploy", () => {
  test("forwards the definition and per-step sources to the sidecar", async () => {
    const sendAgentDeploy = mock(
      async (
        _agentAddress: string,
        _config: HarnessConfig,
        _workflow: {
          definition: { id: string };
          sources: Record<string, unknown>;
        },
      ) => ({ publicKey: "pk" }),
    );
    const sidecarRouter = { sendAgentDeploy } as unknown as SidecarRouter;
    const definition = { id: "wf" } as unknown as WorkflowDefinition;
    const sources = { first: { id: "s1" } };

    const result = await toSendMultiStepDeploy(sidecarRouter)({
      agentAddress: "dep@local",
      agentId: "dep",
      config: {} as HarnessConfig,
      definition,
      sources: sources as never,
      hubPublicKey: "hubkey",
    });

    const call = sendAgentDeploy.mock.calls.at(0);
    if (!call) throw new Error("sendAgentDeploy was not called");
    const [address, , workflow] = call;
    expect(address).toBe("dep@local");
    expect(workflow.definition.id).toBe("wf");
    expect(workflow.sources).toBe(sources);
    expect(result).toEqual({ publicKey: "pk" });
  });
});

describe("writeStepAgentRows", () => {
  test("inserts one agent row per step keyed by the derived step agent id", async () => {
    const values = mock(async (_rows: unknown) => undefined);
    const insert = mock(() => ({ values }));
    const db = { insert } as unknown as HubDb;

    await writeStepAgentRows({
      db,
      deploymentId: "dep1",
      tenantId: "t1",
      creatorPrincipalId: "p1",
      stepIds: ["intake", "generate"],
      toolPackagePins: [
        { name: "@workbench/tools-granola", version: "^0.1.0" },
      ],
      capabilityNames: ["granola_list_notes"],
    });

    const call = values.mock.calls.at(0);
    if (!call) throw new Error("insert().values was not called");
    const rows = call[0] as {
      id: string;
      toolPackages: unknown;
      capabilities: unknown;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual([
      "ins_dep1-intake",
      "ins_dep1-generate",
    ]);
    expect(rows[0]?.toolPackages).toEqual([
      { name: "@workbench/tools-granola", version: "^0.1.0" },
    ]);
    expect(rows[0]?.capabilities).toEqual({ tools: ["granola_list_notes"] });
  });

  test("writes nothing when the workflow has no steps", async () => {
    const insert = mock(() => ({ values: mock(async () => undefined) }));
    const db = { insert } as unknown as HubDb;
    await writeStepAgentRows({
      db,
      deploymentId: "dep1",
      tenantId: "t1",
      creatorPrincipalId: "p1",
      stepIds: [],
      toolPackagePins: [],
      capabilityNames: [],
    });
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("writeStepInstanceRows", () => {
  test("inserts one agent_instance row per step with derived id, address, and deploying principal", async () => {
    const values = mock(async (_rows: unknown) => undefined);
    const insert = mock(() => ({ values }));
    const db = { insert } as unknown as HubDb;

    await writeStepInstanceRows({
      db,
      deploymentId: "dep1",
      deploymentDomain: "gtm.localhost",
      tenantId: "t1",
      creatorPrincipalId: "p1",
      stepIds: ["intake", "generate"],
    });

    const call = values.mock.calls.at(0);
    if (!call) throw new Error("insert().values was not called");
    const rows = call[0] as {
      id: string;
      agentId: string;
      tenantId: string;
      principalId: string;
      address: string;
      status: string;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual([
      "ins_dep1-intake",
      "ins_dep1-generate",
    ]);
    expect(rows.map((r) => r.address)).toEqual([
      "ins_dep1-intake@gtm.localhost",
      "ins_dep1-generate@gtm.localhost",
    ]);
    expect(rows[0]?.agentId).toBe("ins_dep1-intake");
    expect(rows[0]?.tenantId).toBe("t1");
    expect(rows[0]?.principalId).toBe("p1");
    expect(rows[0]?.status).toBe("deployed");
  });

  test("writes nothing when the workflow has no steps", async () => {
    const insert = mock(() => ({ values: mock(async () => undefined) }));
    const db = { insert } as unknown as HubDb;
    await writeStepInstanceRows({
      db,
      deploymentId: "dep1",
      deploymentDomain: "gtm.localhost",
      tenantId: "t1",
      creatorPrincipalId: "p1",
      stepIds: [],
    });
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("writeDeploymentAgentRow", () => {
  test("inserts the supervisor agent row keyed by ins_<deploymentId>", async () => {
    const values = mock(async (_rows: unknown) => undefined);
    const insert = mock(() => ({ values }));
    const db = { insert } as unknown as HubDb;

    await writeDeploymentAgentRow({
      db,
      deploymentId: "dep1",
      tenantId: "t1",
      creatorPrincipalId: "p1",
    });

    const call = values.mock.calls.at(0);
    if (!call) throw new Error("insert().values was not called");
    const row = call[0] as {
      id: string;
      tenantId: string;
      creatorPrincipalId: string;
      toolPackages: unknown;
      capabilities: unknown;
      status: string;
    };
    expect(row.id).toBe("ins_dep1");
    expect(row.tenantId).toBe("t1");
    expect(row.creatorPrincipalId).toBe("p1");
    expect(row.status).toBe("deployed");
    // The supervisor is not tool-capable: no capabilities, no tool packages.
    expect(row.toolPackages).toEqual([]);
    expect(row.capabilities).toBeNull();
  });
});

function insertWithHarnessSession(
  onInstanceValues: (rows: unknown) => void | Promise<void>,
): ReturnType<typeof mock> {
  return mock((table: unknown) => {
    if (table === intxSchema.agentSession) {
      return {
        values: () => ({
          onConflictDoNothing: mock(async () => undefined),
        }),
      };
    }
    return { values: onInstanceValues };
  });
}

function deployWorkflowInsertMock(
  insertedRows: {
    table: "agent" | "agentInstance" | "asset" | "workflowDeployment" | "grant";
    rows: { id: string }[];
  }[],
): ReturnType<typeof mock> {
  const record = (
    table: "agent" | "agentInstance" | "asset" | "workflowDeployment" | "grant",
    rows: unknown,
  ) => {
    const arr = Array.isArray(rows) ? rows : [rows];
    insertedRows.push({ table, rows: arr as { id: string }[] });
    return arr as { id: string }[];
  };
  return mock((table: unknown) => {
    if (table === intxSchema.agentSession) {
      return {
        values: () => ({
          onConflictDoNothing: mock(async () => undefined),
        }),
      };
    }
    // Native identity rows chain .onConflictDoNothing().returning(); echo the
    // inserted ids back (fresh-insert path) so callers proceed without a
    // select round-trip.
    if (table === intxSchema.asset || table === intxSchema.workflowDeployment) {
      const kind = table === intxSchema.asset ? "asset" : "workflowDeployment";
      return {
        values: (rows: unknown) => ({
          onConflictDoNothing: () => ({
            returning: async () =>
              record(kind, rows).map((row) => ({ id: row.id })),
          }),
        }),
      };
    }
    if (table === intxSchema.grant) {
      return {
        values: async (rows: unknown) => {
          record("grant", rows);
        },
      };
    }
    return {
      values: async (rows: unknown) => {
        record(table === intxSchema.agent ? "agent" : "agentInstance", rows);
      },
    };
  });
}

describe("writeDeploymentInstanceRow", () => {
  test("inserts an active supervisor instance row at ins_<deploymentId>@<domain>", async () => {
    const values = mock(async (_rows: unknown) => undefined);
    const insert = insertWithHarnessSession(values);
    const db = { insert } as unknown as HubDb;

    await writeDeploymentInstanceRow({
      db,
      deploymentId: "dep1",
      deploymentDomain: "gtm.localhost",
      tenantId: "t1",
      creatorPrincipalId: "p1",
      harnessSessionId: "ses_supervisor",
    });

    const call = values.mock.calls.at(0);
    if (!call) throw new Error("insert().values was not called");
    const row = call[0] as {
      id: string;
      agentId: string;
      tenantId: string;
      principalId: string;
      address: string;
      status: string;
      sessionId?: string;
      endedAt?: unknown;
    };
    expect(row.id).toBe("ins_dep1");
    expect(row.agentId).toBe("ins_dep1");
    expect(row.address).toBe("ins_dep1@gtm.localhost");
    expect(row.tenantId).toBe("t1");
    expect(row.principalId).toBe("p1");
    expect(row.status).toBe("deployed");
    expect(row.endedAt).toBeUndefined();
    expect(row.sessionId).toBe("ses_supervisor");
  });
});

describe("ensureDeploymentInstanceActive", () => {
  test("upserts the supervisor agent (do-nothing) and revives the instance row (endedAt cleared)", async () => {
    const agentOnConflictDoNothing = mock(async () => undefined);
    const instanceOnConflictDoUpdate = mock(async (_arg: unknown) => undefined);
    const agentValues = mock((_row: unknown) => ({
      onConflictDoNothing: agentOnConflictDoNothing,
    }));
    const instanceValues = mock((_row: unknown) => ({
      onConflictDoUpdate: instanceOnConflictDoUpdate,
    }));
    const insert = mock((table: unknown) =>
      table === intxSchema.agent
        ? { values: agentValues }
        : { values: instanceValues },
    );
    const db = { insert } as unknown as HubDb;

    await ensureDeploymentInstanceActive({
      db,
      deploymentId: "dep1",
      deploymentDomain: "gtm.localhost",
      tenantId: "t1",
      creatorPrincipalId: "p1",
    });

    const agentRow = agentValues.mock.calls.at(0)?.[0] as { id: string };
    expect(agentRow.id).toBe("ins_dep1");
    expect(agentOnConflictDoNothing).toHaveBeenCalledTimes(1);

    const instanceRow = instanceValues.mock.calls.at(0)?.[0] as {
      id: string;
      agentId: string;
      address: string;
      status: string;
    };
    expect(instanceRow.id).toBe("ins_dep1");
    expect(instanceRow.agentId).toBe("ins_dep1");
    expect(instanceRow.address).toBe("ins_dep1@gtm.localhost");
    expect(instanceRow.status).toBe("deployed");

    const update = instanceOnConflictDoUpdate.mock.calls.at(0)?.[0] as {
      target: unknown;
      set: { endedAt: unknown; status: string };
    };
    expect(update.target).toBe(intxSchema.agentInstance.id);
    expect(update.set.endedAt).toBeNull();
    expect(update.set.status).toBe("deployed");
  });
});

describe("stepGrantCapabilityNames", () => {
  // The grant surface a deploy authorizes is the FULL canonical tool surface
  // of the staged packages, not the hand-collected union of per-step declared
  // names. The declared-name union stranded three workflows in one day, all
  // with the same runtime denial and nothing at deploy time to catch it:
  // granola-call's digest calling granola_get_note ("No matching grants"),
  // last30days' ground-queries action ("effect
  // @workbench/tools-last30days/core:last30days_ground_queries was not
  // authorized (null)"), and heartbeat's brief-title action (same, for
  // heartbeat_format_brief_title). Declaring one tool from a package stages
  // the whole package's definitions in front of the model — entitlement to
  // call must match entitlement to see.
  test("declaring one granola tool grants the package's whole canonical surface", () => {
    const declared = ["@workbench/tools-granola/granola:granola_list_notes"];
    const names = stepGrantCapabilityNames(
      declared,
      toolPackagesForCapabilities(declared),
    );
    expect(names).toContain(
      "@workbench/tools-granola/granola:granola_get_note",
    );
    expect(names).toContain(
      "@workbench/tools-granola/granola:granola_list_notes",
    );
  });

  test("declared names survive expansion even when no package backs them (local-runner tools)", () => {
    const names = stepGrantCapabilityNames(["send_mail"], []);
    expect(names).toContain("send_mail");
  });

  test("the expanded surface authorizes an action effect no step declared, through the real evaluator", async () => {
    // The exact production check that failed: EffectContext.perform
    // authorizes `effect:<canonical>` for a name the workflow's steps never
    // listed. Expansion from the staged package must satisfy it.
    const declared = [
      "@workbench/tools-last30days/core:last30days_ground_queries",
    ];
    const names = stepGrantCapabilityNames(
      declared,
      toolPackagesForCapabilities(declared),
    );
    const rules = buildStepGrantRules(names);
    const granted = await evaluateGrants(
      rules,
      "effect:@workbench/tools-last30days/core:heartbeat_format_brief_title",
      "invoke",
    );
    expect(granted.effect).toBe("allow");
  });
});

describe("buildStepGrantRules", () => {
  test("emits a tool:<name> AND an effect:<name>/invoke allow rule per de-duplicated capability", () => {
    const rules = buildStepGrantRules([
      "granola_list_notes",
      "gamma_generate",
      "granola_list_notes",
    ]);
    expect(rules).toHaveLength(4);
    expect(rules.map((r) => r.resource).sort()).toEqual([
      "effect:gamma_generate",
      "effect:granola_list_notes",
      "tool:gamma_generate",
      "tool:granola_list_notes",
    ]);
    expect(
      rules.every((r) => r.action === "invoke" && r.effect === "allow"),
    ).toBe(true);
  });

  test("the rules are matched by the runtime evaluator the step reactor uses", async () => {
    const rules = buildStepGrantRules(["granola_list_notes"]);
    const granted = await evaluateGrants(
      rules,
      "tool:granola_list_notes",
      "invoke",
    );
    expect(granted.effect).toBe("allow");
    const ungranted = await evaluateGrants(
      rules,
      "tool:gamma_generate",
      "invoke",
    );
    expect(ungranted.effect).not.toBe("allow");
  });

  test("also grants effect:<name>/invoke — the resource a native action step's EffectContext.perform authorizes (createEffectContext) — so an action step is not authorized against a tool:-only grants file", async () => {
    // Regression test for the pain-point-collateral `intake`/`fetch` action
    // steps failing every dispatch: `EffectContext.perform` (interchange's
    // `createEffectContext`) authorizes `effect:<capability>`, not
    // `tool:<capability>`. Before this fix, `buildStepGrantRules` emitted
    // only `tool:` rules, so this check always found zero matching grant and
    // threw "action effect ... was not authorized (null)" regardless of
    // credentials or tool pinning.
    const rules = buildStepGrantRules(["granola_list_notes"]);
    const granted = await evaluateGrants(
      rules,
      "effect:granola_list_notes",
      "invoke",
    );
    expect(granted.effect).toBe("allow");
  });

  test("end-to-end through the REAL @intx/workflow EffectContext: a step's persisted grants file authorizes its own action's effect call", async () => {
    // Drives the exact seam that was broken: interchange's own
    // `createEffectContext` (not a test double) evaluating an authorize
    // function backed by the grants `buildStepGrantRules` writes to
    // `state/grants.json`. Before this fix, `perform` threw here with
    // "action effect ... was not authorized (null)" even though the tool
    // was pinned and its credential was configured — proving the failure
    // was a pure authorization-resource mismatch, not a credential or
    // pinning defect.
    const rules = buildStepGrantRules(["granola_list_notes"]);
    const authorize: Parameters<typeof createEffectContext>[0]["authorize"] =
      async (resource, action) => {
        const decision = await evaluateGrants(rules, resource, action);
        return { effect: decision.effect, matchingGrants: [], resolvedBy: null };
      };
    const ctx = createEffectContext({
      authorize,
      effects: {
        lookup: async () => undefined,
        record: async () => {},
      },
      requires: ["granola_list_notes"],
      authzContext: { runId: "run_1", stepId: "intake" },
      input: {},
    });
    const output = await ctx.perform({
      effectId: "tool-call",
      capability: "granola_list_notes",
      run: async () => ({ notes: [], hasMore: false }),
    });
    expect(output).toEqual({ notes: [], hasMore: false });
  });
});

describe("writeStepGrantFiles", () => {
  test("writes state/grants.json into each step agent-state repo on the main ref", async () => {
    const writeTree = mock(
      async (
        _principal: { kind: string },
        _repoId: { kind: string; id: string },
        _ref: string,
        _content: { files: Record<string, string> },
      ) => ({ commitSha: "sha" }),
    );
    const repoStore = { repoStore: { writeTree } } as unknown as AgentRepoStore;

    await writeStepGrantFiles({
      repoStore,
      deploymentId: "dep1",
      stepIds: ["intake", "generate"],
      capabilityNames: ["granola_list_notes"],
    });

    expect(writeTree).toHaveBeenCalledTimes(2);
    const [principal, repoId, ref, content] = writeTree.mock.calls[0]!;
    expect(principal).toEqual({ kind: "hub" });
    expect(repoId).toEqual({ kind: "agent-state", id: "dep1-intake" });
    expect(ref).toBe("refs/heads/main");
    const parsed = JSON.parse(content.files["state/grants.json"]!) as {
      grants: GrantRule[];
    };
    const allowed = await evaluateGrants(
      parsed.grants,
      "tool:granola_list_notes",
      "invoke",
    );
    expect(allowed.effect).toBe("allow");
  });

  test("writes nothing when there are no steps", async () => {
    const writeTree = mock(async () => ({ commitSha: "sha" }));
    const repoStore = { repoStore: { writeTree } } as unknown as AgentRepoStore;
    await writeStepGrantFiles({
      repoStore,
      deploymentId: "dep1",
      stepIds: [],
      capabilityNames: ["granola_list_notes"],
    });
    expect(writeTree).not.toHaveBeenCalled();
  });
});

describe("collectGrants", () => {
  test("unions and dedups every grant across steps", () => {
    const walk: CapabilityWalkResult = {
      perStep: new Map([
        ["a", { grants: ["tool:x", "director:default"] }],
        ["b", { grants: ["tool:x", "inference.source:p:m"] }],
      ]),
      unresolvedDirectors: [],
    };
    expect([...collectGrants(walk)].sort()).toEqual([
      "director:default",
      "inference.source:p:m",
      "tool:x",
    ]);
  });
});

describe("capabilityNames", () => {
  test("folds an action step's effect: grants in alongside an agent step's capability: grants", () => {
    // An `action` step carries no `toolFactories`/`capabilities` of its own —
    // `capability-walk.ts` emits `effect:<cap>` for it instead, from the
    // primitive's `effect.requires`. Without also folding `effect:` here, a
    // deployment whose steps are actions would resolve zero tool packages
    // and ship with none of its tools loaded — the incident this fix
    // prevents.
    const walk: CapabilityWalkResult = {
      perStep: new Map([
        ["agent-step", { grants: ["capability:granola_list_notes"] }],
        [
          "action-step",
          { grants: ["effect:@workbench/tools-gamma/gamma:create_deck"] },
        ],
      ]),
      unresolvedDirectors: [],
    };
    expect(capabilityNames(walk).sort()).toEqual([
      "@workbench/tools-gamma/gamma:create_deck",
      "granola_list_notes",
    ]);
  });

  test("dedups a capability name declared by both an agent step and an action step", () => {
    const walk: CapabilityWalkResult = {
      perStep: new Map([
        ["a", { grants: ["capability:exa_search"] }],
        ["b", { grants: ["effect:exa_search"] }],
      ]),
      unresolvedDirectors: [],
    };
    expect(capabilityNames(walk)).toEqual(["exa_search"]);
  });
});

const TENANT_SOURCE: InferenceSource = {
  id: "openai-compatible:m",
  provider: "openai-compatible",
  baseURL: "https://llm.example.com",
  apiKey: "secret",
  model: "m",
};

const VALID_DEFINITION = {
  id: "pain-point-collateral",
  triggers: [{ type: "manual" }],
  stepOrder: ["intake", "analyze"],
  steps: { intake: { kind: "step" }, analyze: { kind: "step" } },
} as unknown as WorkflowDefinition;

describe("buildSupervisorDeployFrame", () => {
  test("targets the deployment-level address + agentId derived from the persisted deploymentId", () => {
    const frame = buildSupervisorDeployFrame({
      deploymentId: "ses_abc",
      deploymentDomain: "deploy.example.com",
      tenantId: "t1",
      creatorPrincipalId: "p1",
      definition: VALID_DEFINITION,
      sources: [TENANT_SOURCE],
    });
    expect(frame.address).toBe(
      deriveDeploymentAddress({
        deploymentId: "ses_abc",
        deploymentDomain: "deploy.example.com",
      }),
    );
    // The orchestrator overrides the base config's address/id to the deployment
    // level; a re-drive must reproduce that exactly so the frame targets the
    // supervisor address the original deploy registered.
    expect(frame.config.agentAddress).toBe(frame.address);
    expect(frame.config.agentId).toBe("ins_ses_abc");
  });

  test("pins one inference source per step id in the workflow projection", () => {
    const frame = buildSupervisorDeployFrame({
      deploymentId: "ses_abc",
      deploymentDomain: "deploy.example.com",
      tenantId: "t1",
      creatorPrincipalId: "p1",
      definition: VALID_DEFINITION,
      sources: [TENANT_SOURCE],
    });
    expect(Object.keys(frame.workflow.sources).sort()).toEqual([
      "analyze",
      "intake",
    ]);
    expect(frame.workflow.sources.intake).toEqual([TENANT_SOURCE]);
    expect(frame.workflow.sources.analyze).toEqual([TENANT_SOURCE]);
  });

  test("pins a step's preferred model when the resolved set carries it", () => {
    const WRITER_SOURCE: InferenceSource = {
      id: "openai-compatible:w",
      provider: "openai-compatible",
      baseURL: "https://llm.example.com",
      apiKey: "secret",
      model: "writer-model",
    };
    const definition = {
      id: "wf",
      triggers: [{ type: "manual" }],
      stepOrder: ["intake", "write"],
      steps: {
        intake: { kind: "step" },
        write: {
          kind: "step",
          agent: {
            inference: {
              sources: [
                { provider: "openai-compatible", model: "writer-model" },
              ],
            },
          },
        },
      },
    } as unknown as WorkflowDefinition;

    const frame = buildSupervisorDeployFrame({
      deploymentId: "ses_abc",
      deploymentDomain: "deploy.example.com",
      tenantId: "t1",
      creatorPrincipalId: "p1",
      definition,
      sources: [TENANT_SOURCE, WRITER_SOURCE],
    });

    // The write step prefers the writer model and the resolved set carries it,
    // so it pins WRITER_SOURCE; intake declares no preference and rides the head.
    expect(frame.workflow.sources.write).toEqual([WRITER_SOURCE]);
    expect(frame.workflow.sources.intake).toEqual([TENANT_SOURCE]);
  });

  test("falls a step's preferred model back to the head when the set lacks it", () => {
    const definition = {
      id: "wf",
      triggers: [{ type: "manual" }],
      stepOrder: ["write"],
      steps: {
        write: {
          kind: "step",
          agent: {
            inference: {
              sources: [
                { provider: "openai-compatible", model: "absent-model" },
              ],
            },
          },
        },
      },
    } as unknown as WorkflowDefinition;

    const frame = buildSupervisorDeployFrame({
      deploymentId: "ses_abc",
      deploymentDomain: "deploy.example.com",
      tenantId: "t1",
      creatorPrincipalId: "p1",
      definition,
      sources: [TENANT_SOURCE],
    });

    expect(frame.workflow.sources.write).toEqual([TENANT_SOURCE]);
  });
});

describe("readWorkflowDefinition", () => {
  async function withRepoDir(
    fn: (dir: string, repoStore: AgentRepoStore) => Promise<void>,
  ) {
    const dir = await mkdtemp(join(tmpdir(), "wf-read-"));
    const repoStore = {
      repoStore: { getRepoDir: () => dir },
    } as unknown as AgentRepoStore;
    try {
      await fn(dir, repoStore);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  beforeEach(() => {
    resetWorkflowDefinitionCache();
  });

  const TTL = 45_000;

  // A second valid envelope with a DIFFERENT id, used to prove the mtime cache
  // returns the previously-parsed result while mtime is unchanged, and re-parses
  // once mtime moves or the TTL elapses.
  const CHANGED_DEFINITION = {
    id: "changed-definition",
    triggers: [{ type: "manual" }],
    stepOrder: ["intake", "analyze"],
    steps: { intake: { kind: "step" }, analyze: { kind: "step" } },
  } as unknown as WorkflowDefinition;

  test("serves the cached parse while mtime is unchanged AND within the TTL (CL-2760 F4)", async () => {
    await withRepoDir(async (dir, repoStore) => {
      const path = join(dir, "workflow.json");
      // Pin an integer-ms mtime so a later restore reproduces the exact mtimeMs
      // (utimes takes a Date, so a fractional stat mtime cannot be restored).
      const fixed = new Date(Math.floor(Date.now() / 1000) * 1000);
      await writeFile(path, JSON.stringify(VALID_DEFINITION), "utf8");
      await utimes(path, fixed, fixed);

      const first = await readWorkflowDefinition(repoStore, "f4-unchanged", {
        ttlMs: TTL,
        now: () => 1_000,
      });
      expect(first.id).toBe("pain-point-collateral");

      // Overwrite the file bytes but restore the SAME mtime. A cache keyed on
      // mtime must serve the previously-parsed definition, ignoring the new
      // bytes on disk — so a re-read within the TTL must NOT reflect the change.
      await writeFile(path, JSON.stringify(CHANGED_DEFINITION), "utf8");
      await utimes(path, fixed, fixed);

      const second = await readWorkflowDefinition(repoStore, "f4-unchanged", {
        ttlMs: TTL,
        now: () => 1_000 + TTL - 1,
      });
      expect(second.id).toBe("pain-point-collateral");
      // The returned value is a clone, never the shared cached reference.
      expect(second).not.toBe(first);
      expect(second).toEqual(first);
    });
  });

  test("re-reads once the TTL elapses even when mtime is unchanged (CL-2760 F4 backstop)", async () => {
    await withRepoDir(async (dir, repoStore) => {
      const path = join(dir, "workflow.json");
      const fixed = new Date(Math.floor(Date.now() / 1000) * 1000);
      await writeFile(path, JSON.stringify(VALID_DEFINITION), "utf8");
      await utimes(path, fixed, fixed);

      const first = await readWorkflowDefinition(repoStore, "f4-ttl", {
        ttlMs: TTL,
        now: () => 1_000,
      });
      expect(first.id).toBe("pain-point-collateral");

      // A checkout/restore that preserves mtime while changing content. Past the
      // TTL the (kind, mtime) entry must NOT be served — the read re-validates
      // and reflects the new content.
      await writeFile(path, JSON.stringify(CHANGED_DEFINITION), "utf8");
      await utimes(path, fixed, fixed);

      const second = await readWorkflowDefinition(repoStore, "f4-ttl", {
        ttlMs: TTL,
        now: () => 1_000 + TTL + 1,
      });
      expect(second.id).toBe("changed-definition");
    });
  });

  test("re-parses when the file mtime changes (CL-2760 F4)", async () => {
    await withRepoDir(async (dir, repoStore) => {
      const path = join(dir, "workflow.json");
      await writeFile(path, JSON.stringify(VALID_DEFINITION), "utf8");
      const first = await readWorkflowDefinition(repoStore, "f4-changed", {
        ttlMs: TTL,
        now: () => 1_000,
      });
      expect(first.id).toBe("pain-point-collateral");

      // New bytes AND a bumped mtime — the cache entry is stale, so the read must
      // re-parse and reflect the new definition even well within the TTL.
      await writeFile(path, JSON.stringify(CHANGED_DEFINITION), "utf8");
      const bumped = new Date(Date.now() + 5_000);
      await utimes(path, bumped, bumped);

      const second = await readWorkflowDefinition(repoStore, "f4-changed", {
        ttlMs: TTL,
        now: () => 1_000 + 1,
      });
      expect(second.id).toBe("changed-definition");
    });
  });

  test("returns an isolated clone — mutating the result does not corrupt the cache (CL-2760 F4)", async () => {
    await withRepoDir(async (dir, repoStore) => {
      const path = join(dir, "workflow.json");
      const fixed = new Date(Math.floor(Date.now() / 1000) * 1000);
      await writeFile(path, JSON.stringify(VALID_DEFINITION), "utf8");
      await utimes(path, fixed, fixed);

      const first = await readWorkflowDefinition(repoStore, "f4-clone", {
        ttlMs: TTL,
        now: () => 1_000,
      });
      // Mutate the returned definition as a downstream seam might.
      (first as { id: string }).id = "mutated-by-caller";
      (first.stepOrder as string[]).push("injected");

      const second = await readWorkflowDefinition(repoStore, "f4-clone", {
        ttlMs: TTL,
        now: () => 1_000 + 1,
      });
      expect(second.id).toBe("pain-point-collateral");
      expect(second.stepOrder).toEqual(["intake", "analyze"]);
    });
  });

  test("reads and validates workflow.json from the repo working tree", async () => {
    await withRepoDir(async (dir, repoStore) => {
      await writeFile(
        join(dir, "workflow.json"),
        JSON.stringify(VALID_DEFINITION),
        "utf8",
      );
      const out = await readWorkflowDefinition(
        repoStore,
        "pain-point-collateral",
      );
      expect(out.id).toBe("pain-point-collateral");
      expect(out.stepOrder).toEqual(["intake", "analyze"]);
    });
  });

  test("fails loudly when workflow.json is missing", async () => {
    await withRepoDir(async (_dir, repoStore) => {
      await expect(
        readWorkflowDefinition(repoStore, "missing"),
      ).rejects.toThrow(/missing or unreadable/);
    });
  });

  test("fails loudly on corrupt (non-JSON) workflow.json", async () => {
    await withRepoDir(async (dir, repoStore) => {
      await writeFile(join(dir, "workflow.json"), "{ not json", "utf8");
      await expect(
        readWorkflowDefinition(repoStore, "corrupt"),
      ).rejects.toThrow(/missing or unreadable/);
    });
  });

  test("rejects a definition that fails envelope validation", async () => {
    await withRepoDir(async (dir, repoStore) => {
      await writeFile(
        join(dir, "workflow.json"),
        JSON.stringify({ not: "a workflow" }),
        "utf8",
      );
      await expect(readWorkflowDefinition(repoStore, "bad")).rejects.toThrow(
        /persisted definition is invalid/,
      );
    });
  });
});

describe("collectDeterministicToolStepIds", () => {
  test("collects only steps whose agent carries the deterministic-tool marker tag", () => {
    const deployedAgent = defineAgent({
      id: "draft",
      description: "deployed reasoning",
      systemPrompt: "reason",
      tools: [],
      capabilities: [],
      inference: { sources: [{ provider: "openai-compatible", model: "m" }] },
    });
    const wf = defineWorkflow({
      id: "wf",
      trigger: { type: "manual" },
      steps: {
        fetch: deterministicToolStep({
          id: "fetch",
          tool: "granola_list_notes",
        }),
        analyze: agentStep({
          id: "analyze",
          systemPrompt: "reason",
          after: ["fetch"],
        }),
        draft: step({ agent: deployedAgent, after: ["analyze"] }),
      },
    });

    const deterministic = collectDeterministicToolStepIds(wf);
    expect([...deterministic]).toEqual(["fetch"]);
    expect(deterministic.has("analyze")).toBe(false);
    expect(deterministic.has("draft")).toBe(false);
  });

  test("finds a deterministic-tool step nested inside a map primitive", () => {
    const wf = defineWorkflow({
      id: "wf",
      trigger: { type: "manual" },
      steps: {
        fan: map({
          over: { literal: [] },
          step: deterministicToolStep({
            id: "fan-inner",
            tool: "granola_list_notes",
          }),
        }),
      },
    });
    expect([...collectDeterministicToolStepIds(wf)]).toEqual(["fan"]);
  });
});

// Integration-style proof of CONDITION 2: a workflow with an inline step
// deploys creating ZERO agent-state repos for the inline step, while the
// deployed step still gets its agent-state grants repo + agent/instance rows.
// Neither launches a session — CL-2782 no-op'd the deployed-step launch too, so
// launches=0 for the whole deploy. Exercises the real `createWorkflowDeployService`
// (real director registry + real orchestrator) across its seams; only the
// db / repoStore / sessionService / sidecarRouter boundaries are mocked.
describe("deployWorkflow inline-step partition (CL-2251)", () => {
  const SOURCE: InferenceSource = {
    id: "openai-compatible:m",
    provider: "openai-compatible",
    baseURL: "https://llm.example.com",
    apiKey: "secret",
    model: "m",
  };

  function makeConfig(
    deploymentId: string,
    deploymentDomain: string,
  ): HarnessConfig {
    return {
      sessionId: "sess_1",
      agentId: deploymentId,
      tenantId: "t1",
      principalId: "p1",
      agentAddress: `${deploymentId}@${deploymentDomain}`,
      systemPrompt: "",
      tools: [],
      grants: [],
      sources: [SOURCE],
      defaultSource: SOURCE.id,
    } as unknown as HarnessConfig;
  }

  test("skips per-step agent-state repo writes + launchSession for the inline step only", async () => {
    const deploymentId = "ses_inline";
    const deploymentDomain = "deploy.example.com";

    // The deployed reasoning step declares the tenant source so the walk
    // surfaces its inference grant (which becomes an operator approval); the
    // inline step's source falls back to the same approved default.
    const draftAgent = defineAgent({
      id: "draft",
      description: "deployed reasoning step",
      systemPrompt: "draft something",
      tools: [],
      capabilities: [],
      inference: { sources: [{ provider: "openai-compatible", model: "m" }] },
    });
    const workflow = defineWorkflow({
      id: "pain-point-collateral",
      trigger: { type: "manual" },
      steps: {
        analyze: inlineInferenceStep({
          id: "analyze",
          systemPrompt: "extract pain points",
        }),
        draft: step({ agent: draftAgent, after: ["analyze"] }),
      },
    });

    // Record every writeTree (workflow repo + per-step grants repos) and every
    // DB insert (step agent/instance rows) so we can prove the inline step
    // produced none of its own.
    const writeTreeRepoIds: { kind: string; id: string }[] = [];
    const writeTree = mock(
      async (
        _principal: { kind: string },
        repoId: { kind: string; id: string },
        _ref: string,
        _content: unknown,
      ) => {
        writeTreeRepoIds.push(repoId);
        return { commitSha: "sha" };
      },
    );
    const repoStore = { repoStore: { writeTree } } as unknown as AgentRepoStore;

    const insertedRows: {
      table:
        | "agent"
        | "agentInstance"
        | "asset"
        | "workflowDeployment"
        | "grant";
      rows: { id: string }[];
    }[] = [];
    const db = {
      insert: deployWorkflowInsertMock(insertedRows),
    } as unknown as HubDb;

    const sendAgentDeploy = mock(
      async (
        _agentAddress: string,
        _config: HarnessConfig,
        _workflow: { sources: Record<string, InferenceSource[]> },
      ) => ({ publicKey: "pk" }),
    );
    const sidecarRouter = {
      getRoutableAddresses: () => [],
      sendAgentDeploy,
    } as unknown as SidecarRouter;

    const service = createWorkflowDeployService({
      db,
      repoStore,
      sidecarRouter,
      directorRegistry: createWorkbenchDirectorRegistry(),
      // Provisioning REQUIRES a stager (FIX 2b); this unit test stages no real
      // tool tree, so inject an explicit no-op rather than relying on a
      // silent fallback.
      stageWorkflowStep: () => Promise.resolve(),
    });

    const result = await service.deployWorkflow({
      workflow,
      deploymentId,
      deploymentDomain,
      tenantId: "t1",
      creatorPrincipalId: "p1",
      config: makeConfig(deploymentId, deploymentDomain),
      deployContent: { systemPrompt: "" },
      hubPublicKey: "hubkey",
    });

    // CONDITION 2 — NO step launches a per-step session (CL-2782 no-op'd the
    // deployed-step launch too); the inline step never did. The supervisor uses
    // No per-step launch happens at all now: the deploy service wires a no-op
    // launch hook (the in-process session runtime is retired), so the sidecar is
    // touched only by the single supervisor sendAgentDeploy above.

    // The deployed step's grants repo is STILL written (execution reads it at
    // run time) even though it no longer launches; the inline step gets none.
    // (The workflow-kind repo write is separate.)
    const agentStateIds = writeTreeRepoIds
      .filter((r) => r.kind === "agent-state")
      .map((r) => r.id);
    expect(agentStateIds).toContain("ses_inline-draft");
    expect(agentStateIds).not.toContain("ses_inline-analyze");

    // Every step gets its agent/instance rows uniformly (interchange's pack
    // phase FKs session_asset -> agent_instance for every staged step); the
    // inline partition now only scopes the grants repo.
    const allRowIds = insertedRows.flatMap((b) => b.rows.map((r) => r.id));
    expect(allRowIds).toContain("ins_ses_inline-draft");
    expect(allRowIds).toContain("ins_ses_inline-analyze");
    // The supervisor rows are still written (deployment-level, not step-level).
    expect(allRowIds).toContain("ins_ses_inline");

    // The supervisor frame still pins an inference source for the inline step
    // (the sidecar's STEP_INFERENCE_SOURCES table reads it for the bare-agent
    // inference) — proving the inline step is reachable, just not deployed.
    const deployCall = sendAgentDeploy.mock.calls.at(0);
    if (!deployCall) throw new Error("sendAgentDeploy was not called");
    const frameWorkflow = deployCall[2];
    expect(frameWorkflow.sources.analyze).toEqual([SOURCE]);
    expect(frameWorkflow.sources.draft).toEqual([SOURCE]);
  });
});

// Integration-style proof of CL-2252: a deterministic tool step deploys
// keeping ONLY its `agent` row — no `agent_instance` row, no `state/grants.json`
// agent-state repo, and no launchSession. The fully-deployed step keeps both
// rows + its grants repo but (as of CL-2782) also no longer launches. Exercises
// the real `createWorkflowDeployService` across its
// seams; only the db / repoStore / sessionService / sidecarRouter boundaries
// are mocked.
describe("deployWorkflow deterministic-tool partition (CL-2252)", () => {
  const SOURCE: InferenceSource = {
    id: "openai-compatible:m",
    provider: "openai-compatible",
    baseURL: "https://llm.example.com",
    apiKey: "secret",
    model: "m",
  };

  function makeConfig(
    deploymentId: string,
    deploymentDomain: string,
  ): HarnessConfig {
    return {
      sessionId: "sess_1",
      agentId: deploymentId,
      tenantId: "t1",
      principalId: "p1",
      agentAddress: `${deploymentId}@${deploymentDomain}`,
      systemPrompt: "",
      tools: [],
      grants: [],
      sources: [SOURCE],
      defaultSource: SOURCE.id,
    } as unknown as HarnessConfig;
  }

  test("keeps agent + instance rows for every step but scopes the grants repo to deployed steps", async () => {
    const deploymentId = "ses_det";
    const deploymentDomain = "deploy.example.com";

    const draftAgent = defineAgent({
      id: "draft",
      description: "deployed reasoning step",
      systemPrompt: "draft something",
      tools: [],
      capabilities: [],
      inference: { sources: [{ provider: "openai-compatible", model: "m" }] },
    });
    const workflow = defineWorkflow({
      id: "pain-point-collateral",
      trigger: { type: "manual" },
      steps: {
        fetch: deterministicToolStep({
          id: "fetch",
          tool: "granola_list_notes",
        }),
        analyze: agentStep({
          id: "analyze",
          systemPrompt: "extract pain points",
          after: ["fetch"],
        }),
        draft: step({ agent: draftAgent, after: ["analyze"] }),
      },
    });

    const writeTreeRepoIds: { kind: string; id: string }[] = [];
    const writeTree = mock(
      async (
        _principal: { kind: string },
        repoId: { kind: string; id: string },
        _ref: string,
        _content: unknown,
      ) => {
        writeTreeRepoIds.push(repoId);
        return { commitSha: "sha" };
      },
    );
    const repoStore = { repoStore: { writeTree } } as unknown as AgentRepoStore;

    const insertedRows: {
      table:
        | "agent"
        | "agentInstance"
        | "asset"
        | "workflowDeployment"
        | "grant";
      rows: { id: string }[];
    }[] = [];
    const db = {
      insert: deployWorkflowInsertMock(insertedRows),
    } as unknown as HubDb;

    const sendAgentDeploy = mock(
      async (
        _agentAddress: string,
        _config: HarnessConfig,
        _workflow: { sources: Record<string, InferenceSource[]> },
      ) => ({ publicKey: "pk" }),
    );
    const sidecarRouter = {
      getRoutableAddresses: () => [],
      sendAgentDeploy,
    } as unknown as SidecarRouter;

    const service = createWorkflowDeployService({
      db,
      repoStore,
      sidecarRouter,
      directorRegistry: createWorkbenchDirectorRegistry(),
      // Provisioning REQUIRES a stager (FIX 2b); this unit test stages no real
      // tool tree, so inject an explicit no-op rather than relying on a
      // silent fallback.
      stageWorkflowStep: () => Promise.resolve(),
    });

    const result = await service.deployWorkflow({
      workflow,
      deploymentId,
      deploymentDomain,
      tenantId: "t1",
      creatorPrincipalId: "p1",
      config: makeConfig(deploymentId, deploymentDomain),
      deployContent: { systemPrompt: "" },
      hubPublicKey: "hubkey",
    });

    // No per-step launch happens at all now: the deploy service wires a no-op
    // launch hook (the in-process session runtime is retired), so no step —
    // deterministic or fully-deployed reasoning — launches a session.

    // 0 agent-state repos for the deterministic tool step (no grants.json);
    // both reasoning steps (`analyze`, a native `agentStep`, and `draft`, a
    // hand-built `defineAgent`+`step`) get one — execution reads it.
    const agentStateIds = writeTreeRepoIds
      .filter((r) => r.kind === "agent-state")
      .map((r) => r.id);
    expect(agentStateIds).toContain("ses_det-draft");
    expect(agentStateIds).toContain("ses_det-analyze");
    expect(agentStateIds).not.toContain("ses_det-fetch");

    // Every step keeps BOTH rows uniformly: interchange's pack phase records
    // a session_asset row per staged attachment with a hard FK to
    // agent_instance, and every stepOrder entry is staged — so a row-less
    // step fails the provision at phase "pack".
    const agentRowIds = insertedRows
      .filter((b) => b.table === "agent")
      .flatMap((b) => b.rows.map((r) => r.id));
    const instanceRowIds = insertedRows
      .filter((b) => b.table === "agentInstance")
      .flatMap((b) => b.rows.map((r) => r.id));
    expect(agentRowIds).toContain("ins_ses_det-fetch");
    expect(instanceRowIds).toContain("ins_ses_det-fetch");

    // Both reasoning steps keep both rows too.
    expect(agentRowIds).toContain("ins_ses_det-draft");
    expect(instanceRowIds).toContain("ins_ses_det-draft");
    expect(agentRowIds).toContain("ins_ses_det-analyze");
    expect(instanceRowIds).toContain("ins_ses_det-analyze");

    // Supervisor rows are still written (deployment-level).
    expect(agentRowIds).toContain("ins_ses_det");
    expect(instanceRowIds).toContain("ins_ses_det");

    // The supervisor frame still pins an inference source for every step id
    // (the sidecar's STEP_INFERENCE_SOURCES table reads it).
    const deployCall = sendAgentDeploy.mock.calls.at(0);
    if (!deployCall) throw new Error("sendAgentDeploy was not called");
    const frameWorkflow = deployCall[2];
    expect(frameWorkflow.sources.fetch).toEqual([SOURCE]);
    expect(frameWorkflow.sources.analyze).toEqual([SOURCE]);
    expect(frameWorkflow.sources.draft).toEqual([SOURCE]);
  });
});

// Regression for the catalog-inference fix: a workflow whose steps declare NO
// preferred model (`sources:[]` on every step, e.g. every `agentStep` built
// with no `model` opt) emits NO `inference.source:*` grant from the
// capability walk. Before the fix, `pickStepInferenceSource` rejected the
// deploy's catalog-resolved `defaultSource` as unapproved and the deploy
// threw "step ... has no approved inference source". The deploy now seeds
// `operatorApprovals` from the resolved chain, so the deploy succeeds.
// Exercises the real orchestrator across its seams.
describe("deployWorkflow approves the catalog inference chain", () => {
  const HEAD: InferenceSource = {
    id: "off_head",
    provider: "openai-compatible",
    baseURL: "https://llm-a.example.com",
    apiKey: "ka",
    model: "deepseek-v4-flash",
  };
  const FAILOVER: InferenceSource = {
    id: "off_failover",
    provider: "xai",
    baseURL: "https://llm-b.example.com",
    apiKey: "kb",
    model: "deepseek-v4-flash",
  };

  function makeConfig(
    deploymentId: string,
    deploymentDomain: string,
  ): HarnessConfig {
    return {
      sessionId: "sess_1",
      agentId: deploymentId,
      tenantId: "t1",
      principalId: "p1",
      agentAddress: `${deploymentId}@${deploymentDomain}`,
      systemPrompt: "",
      tools: [],
      grants: [],
      sources: [HEAD, FAILOVER],
      defaultSource: HEAD.id,
    } as unknown as HarnessConfig;
  }

  function makeService(
    sendAgentDeploy: SidecarRouter["sendAgentDeploy"],
    opts: { withStager?: boolean } = {},
  ) {
    const writeTree = mock(async () => ({ commitSha: "sha" }));
    const repoStore = { repoStore: { writeTree } } as unknown as AgentRepoStore;
    const db = {
      insert: mock((table: unknown) => {
        if (table === intxSchema.agentSession) {
          return {
            values: () => ({
              onConflictDoNothing: mock(async () => undefined),
            }),
          };
        }
        if (
          table === intxSchema.asset ||
          table === intxSchema.workflowDeployment
        ) {
          return {
            values: (rows: unknown) => ({
              onConflictDoNothing: () => ({
                returning: async () =>
                  (Array.isArray(rows) ? rows : [rows]).map(
                    (row: { id: string }) => ({ id: row.id }),
                  ),
              }),
            }),
          };
        }
        return { values: async () => undefined };
      }),
    } as unknown as HubDb;
    const sidecarRouter = {
      getRoutableAddresses: () => [],
      sendAgentDeploy,
    } as unknown as SidecarRouter;
    return createWorkflowDeployService({
      db,
      repoStore,
      sidecarRouter,
      directorRegistry: createWorkbenchDirectorRegistry(),
      // Provisioning REQUIRES a stager (FIX 2b); this unit test stages no real
      // tool tree, so inject an explicit no-op rather than relying on a silent
      // fallback. The `withStager: false` case deliberately omits it to prove
      // the misconfiguration guard fires.
      ...(opts.withStager === false
        ? {}
        : { stageWorkflowStep: () => Promise.resolve() }),
    });
  }

  test("deploys a workflow whose steps declare no preferred inference source", async () => {
    const deploymentId = "ses_allinline";
    const deploymentDomain = "deploy.example.com";
    const workflow = defineWorkflow({
      id: "all-inline",
      trigger: { type: "manual" },
      steps: {
        analyze: agentStep({
          id: "analyze",
          systemPrompt: "extract pain points",
        }),
        summarize: agentStep({
          id: "summarize",
          systemPrompt: "summarize",
          after: ["analyze"],
        }),
      },
    });
    const sendAgentDeploy = mock(
      async (
        _agentAddress: string,
        _config: HarnessConfig,
        _workflow: { sources: Record<string, InferenceSource[]> },
      ) => ({ publicKey: "pk" }),
    );
    const service = makeService(
      sendAgentDeploy as unknown as SidecarRouter["sendAgentDeploy"],
    );

    const result = await service.deployWorkflow({
      workflow,
      deploymentId,
      deploymentDomain,
      tenantId: "t1",
      creatorPrincipalId: "p1",
      config: makeConfig(deploymentId, deploymentDomain),
      deployContent: { systemPrompt: "" },
      hubPublicKey: "hubkey",
    });

    // The supervisor frame pinned the catalog chain head to every inline step —
    // proving the orchestrator's pickStepInferenceSource accepted the
    // defaultSource as approved (it would have thrown otherwise).
    const deployCall = sendAgentDeploy.mock.calls.at(0);
    if (!deployCall) throw new Error("sendAgentDeploy was not called");
    const frameWorkflow = deployCall[2];
    expect(frameWorkflow.sources.analyze).toEqual([HEAD]);
    expect(frameWorkflow.sources.summarize).toEqual([HEAD]);
  });

  // FIX 2b: a production provision (sendSupervisorFrame=true) with no injected
  // stager must FAIL LOUD, not silently degrade to no-op tool staging (which
  // would deploy every step with zero tools). The catalog-publish path keeps
  // the no-op — that is asserted by the persistCatalog suite, which provisions
  // no stager and does not throw.
  test("provisioning without an injected stageWorkflowStep throws instead of silently staging zero tools", async () => {
    const deploymentId = "ses_nostager";
    const deploymentDomain = "deploy.example.com";
    const workflow = defineWorkflow({
      id: "no-stager",
      trigger: { type: "manual" },
      steps: {
        analyze: agentStep({
          id: "analyze",
          systemPrompt: "extract pain points",
        }),
      },
    });
    const sendAgentDeploy = mock(async () => ({ publicKey: "pk" }));
    const service = makeService(
      sendAgentDeploy as unknown as SidecarRouter["sendAgentDeploy"],
      { withStager: false },
    );

    await expect(
      service.deployWorkflow({
        workflow,
        deploymentId,
        deploymentDomain,
        tenantId: "t1",
        creatorPrincipalId: "p1",
        config: makeConfig(deploymentId, deploymentDomain),
        deployContent: { systemPrompt: "" },
        hubPublicKey: "hubkey",
      }),
    ).rejects.toThrow(/stageWorkflowStep/);

    // The guard fires before any sidecar hand-off is made.
    expect(sendAgentDeploy).not.toHaveBeenCalled();
  });
});

// A single-step (one-step workflow) definition -- `stepOrder.length === 1` --
// routes through the orchestrator's single-step branch, which collapses
// on-disk tool-tree staging and the `agent.deploy` frame onto ONE hand-off
// (`deps.deploySingleStepAtHead`, interchange's
// `SessionService.deploySingleStepAtHead`). Before this fix the hub only ever
// wired the multi-step `agent.deploy` frame for single-step workflows and
// threw if the step declared tool pins -- these tests prove staging now
// actually happens and the missing-dep case fails loud instead of silently
// degrading, mirroring the multi-step `stageWorkflowStep` guard above.
describe("deployWorkflow single-step (one-step workflow) tool staging", () => {
  const SOURCE: InferenceSource = {
    id: "openai-compatible:m",
    provider: "openai-compatible",
    baseURL: "https://llm.example.com",
    apiKey: "secret",
    model: "m",
  };

  function makeConfig(
    deploymentId: string,
    deploymentDomain: string,
  ): HarnessConfig {
    return {
      sessionId: "sess_1",
      agentId: deploymentId,
      tenantId: "t1",
      principalId: "p1",
      agentAddress: `${deploymentId}@${deploymentDomain}`,
      systemPrompt: "",
      tools: [],
      grants: [],
      sources: [SOURCE],
      defaultSource: SOURCE.id,
    } as unknown as HarnessConfig;
  }

  function makeSingleStepWorkflow() {
    const draftAgent = defineAgent({
      id: "draft",
      description: "single-step deployed reasoning step",
      systemPrompt: "draft something",
      tools: [],
      capabilities: [],
      inference: { sources: [{ provider: "openai-compatible", model: "m" }] },
    });
    return defineWorkflow({
      id: "single-step-wf",
      trigger: { type: "manual" },
      steps: {
        draft: step({ agent: draftAgent }),
      },
    });
  }

  function makeServiceDeps() {
    const writeTree = mock(async () => ({ commitSha: "sha" }));
    const repoStore = { repoStore: { writeTree } } as unknown as AgentRepoStore;
    const db = {
      insert: mock((table: unknown) => {
        if (table === intxSchema.agentSession) {
          return {
            values: () => ({
              onConflictDoNothing: mock(async () => undefined),
            }),
          };
        }
        if (
          table === intxSchema.asset ||
          table === intxSchema.workflowDeployment
        ) {
          return {
            values: (rows: unknown) => ({
              onConflictDoNothing: () => ({
                returning: async () =>
                  (Array.isArray(rows) ? rows : [rows]).map(
                    (row: { id: string }) => ({ id: row.id }),
                  ),
              }),
            }),
          };
        }
        return { values: async () => undefined };
      }),
    } as unknown as HubDb;
    const sendAgentDeploy = mock(async () => ({ publicKey: "pk" }));
    const sidecarRouter = {
      getRoutableAddresses: () => [],
      sendAgentDeploy,
    } as unknown as SidecarRouter;
    return { db, repoStore, sidecarRouter, sendAgentDeploy };
  }

  // RED-BEFORE-FIX: without a real staging hand-off wired, a single-step
  // deploy either dropped tool pins on the floor (old `sendAgentDeploy`-only
  // path) or threw the old "not implemented" tripwire whenever the step
  // carried tool pins. This is the current-state guard: with NO
  // `deploySingleStepAtHead` dep injected at all, the orchestrator's own
  // `SingleStepDeployHandoffMissingError` fires -- fail loud, not a silent
  // zero-tools deploy.
  test("provisioning a single-step workflow without an injected deploySingleStepAtHead throws", async () => {
    const deploymentId = "ses_single";
    const deploymentDomain = "deploy.example.com";
    const { db, repoStore, sidecarRouter, sendAgentDeploy } = makeServiceDeps();

    const service = createWorkflowDeployService({
      db,
      repoStore,
      sidecarRouter,
      directorRegistry: createWorkbenchDirectorRegistry(),
      stageWorkflowStep: () => Promise.resolve(),
      // deploySingleStepAtHead deliberately omitted.
    });

    await expect(
      service.deployWorkflow({
        workflow: makeSingleStepWorkflow(),
        deploymentId,
        deploymentDomain,
        tenantId: "t1",
        creatorPrincipalId: "p1",
        config: makeConfig(deploymentId, deploymentDomain),
        deployContent: { systemPrompt: "" },
        hubPublicKey: "hubkey",
      }),
    ).rejects.toThrow(/deploySingleStepAtHead/);
    expect(sendAgentDeploy).not.toHaveBeenCalled();
  });

  // GREEN: with the real staging hand-off injected, the single-step deploy
  // routes through it (not the bare `sendAgentDeploy` frame), and the pinned
  // tool packages the capability walk resolved are forwarded to the stager --
  // proving the head's deploy tree is staged rather than silently dropped.
  test("routes a single-step workflow's tool pins through the injected deploySingleStepAtHead stager", async () => {
    const deploymentId = "ses_single";
    const deploymentDomain = "deploy.example.com";
    const { db, repoStore, sidecarRouter, sendAgentDeploy } = makeServiceDeps();

    const deploySingleStepAtHead = mock(
      async (_params: {
        toolPackagePins?: readonly { name: string; version: string }[];
      }) => ({ publicKey: "pk" }),
    );

    const service = createWorkflowDeployService({
      db,
      repoStore,
      sidecarRouter,
      directorRegistry: createWorkbenchDirectorRegistry(),
      stageWorkflowStep: () => Promise.resolve(),
      deploySingleStepAtHead,
    });

    const toolPackagePins = [
      { name: "@workbench/tools-granola", version: "1.0.0" },
    ];

    await service.deployWorkflow({
      workflow: makeSingleStepWorkflow(),
      deploymentId,
      deploymentDomain,
      tenantId: "t1",
      creatorPrincipalId: "p1",
      config: makeConfig(deploymentId, deploymentDomain),
      deployContent: { systemPrompt: "" },
      hubPublicKey: "hubkey",
      toolPackagePins,
    });

    expect(deploySingleStepAtHead).toHaveBeenCalledTimes(1);
    const call = deploySingleStepAtHead.mock.calls.at(0)?.[0] as {
      toolPackagePins?: readonly { name: string; version: string }[];
    };
    expect(call.toolPackagePins).toEqual(toolPackagePins);
    // The bare multi-step `agent.deploy` frame is never sent directly for a
    // single-step deploy -- the staging hand-off owns both the tree write and
    // the frame.
    expect(sendAgentDeploy).not.toHaveBeenCalled();
  });
});

// persistCatalog is the hub-only publish path: it must write the git `workflow`
// definition repo + per-step DB/grant rows exactly like deployWorkflow, but send
// NO supervisor `agent.deploy` frame — so publishing succeeds with the sidecar
// disconnected (a throwing sendAgentDeploy is never reached).
describe("persistCatalog (hub-only publish)", () => {
  const SOURCE: InferenceSource = {
    id: "openai-compatible:m",
    provider: "openai-compatible",
    baseURL: "https://llm.example.com",
    apiKey: "secret",
    model: "m",
  };

  function makeConfig(
    deploymentId: string,
    deploymentDomain: string,
  ): HarnessConfig {
    return {
      sessionId: "sess_1",
      agentId: deploymentId,
      tenantId: "t1",
      principalId: "p1",
      agentAddress: `${deploymentId}@${deploymentDomain}`,
      systemPrompt: "",
      tools: [],
      grants: [],
      sources: [SOURCE],
      defaultSource: SOURCE.id,
    } as unknown as HarnessConfig;
  }

  test("persists the definition repo + DB rows and sends no supervisor frame even when the sidecar is down", async () => {
    const deploymentId = "ses_catalog";
    const deploymentDomain = "deploy.example.com";

    const draftAgent = defineAgent({
      id: "draft",
      description: "deployed reasoning step",
      systemPrompt: "draft something",
      tools: [],
      capabilities: [],
      inference: { sources: [{ provider: "openai-compatible", model: "m" }] },
    });
    const workflow = defineWorkflow({
      id: "pain-point-collateral",
      trigger: { type: "manual" },
      steps: {
        analyze: agentStep({
          id: "analyze",
          systemPrompt: "extract pain points",
        }),
        draft: step({ agent: draftAgent, after: ["analyze"] }),
      },
    });

    const writeTreeRepoIds: { kind: string; id: string }[] = [];
    const writeTree = mock(
      async (
        _principal: { kind: string },
        repoId: { kind: string; id: string },
        _ref: string,
        _content: unknown,
      ) => {
        writeTreeRepoIds.push(repoId);
        return { commitSha: "sha" };
      },
    );
    const repoStore = { repoStore: { writeTree } } as unknown as AgentRepoStore;

    const insertedRows: {
      table:
        | "agent"
        | "agentInstance"
        | "asset"
        | "workflowDeployment"
        | "grant";
      rows: { id: string }[];
    }[] = [];
    const db = {
      insert: deployWorkflowInsertMock(insertedRows),
    } as unknown as HubDb;

    // The sidecar is disconnected: any frame send throws. persistCatalog must
    // never reach it.
    const sendAgentDeploy = mock(async () => {
      throw new Error("sidecar disconnected");
    });
    const sidecarRouter = {
      getRoutableAddresses: () => [],
      sendAgentDeploy,
    } as unknown as SidecarRouter;

    const service = createWorkflowDeployService({
      db,
      repoStore,
      sidecarRouter,
      directorRegistry: createWorkbenchDirectorRegistry(),
    });

    const result = await service.persistCatalog({
      workflow,
      deploymentId,
      deploymentDomain,
      tenantId: "t1",
      creatorPrincipalId: "p1",
      config: makeConfig(deploymentId, deploymentDomain),
      deployContent: { systemPrompt: "" },
      hubPublicKey: "hubkey",
    });

    // No supervisor frame — the disconnected sidecar was never touched.
    expect(sendAgentDeploy).not.toHaveBeenCalled();

    // The git `workflow` definition repo IS written (the catalog registry entry).
    const workflowRepoIds = writeTreeRepoIds
      .filter((r) => r.kind === "workflow")
      .map((r) => r.id);
    expect(workflowRepoIds).toContain("pain-point-collateral");

    // The deployed step's grants repo + the per-step/supervisor `agent` rows are
    // still persisted — the whole catalog fan-out runs, only the frame is gone.
    const agentStateIds = writeTreeRepoIds
      .filter((r) => r.kind === "agent-state")
      .map((r) => r.id);
    expect(agentStateIds).toContain("ses_catalog-draft");

    const agentRowIds = insertedRows
      .filter((b) => b.table === "agent")
      .flatMap((b) => b.rows.map((r) => r.id));
    expect(agentRowIds).toContain("ins_ses_catalog-draft");
    expect(agentRowIds).toContain("ins_ses_catalog");

    // NO `agent_instance` rows: a catalog publish never spawns a supervisor or
    // runs steps, so active (endedAt NULL) instance rows here would be phantom
    // "live" instances nothing ever ends. Per-run deploys mint their own.
    const instanceRowIds = insertedRows
      .filter((b) => b.table === "agentInstance")
      .flatMap((b) => b.rows.map((r) => r.id));
    expect(instanceRowIds).toEqual([]);
  });
});

describe("ensureDeploymentRoutable", () => {
  function makeService(opts: {
    routableAddresses: string[];
    sendAgentDeploy: SidecarRouter["sendAgentDeploy"];
  }) {
    const sidecarRouter = {
      getRoutableAddresses: () => opts.routableAddresses,
      sendAgentDeploy: opts.sendAgentDeploy,
    } as unknown as SidecarRouter;
    return createWorkflowDeployService({
      db: {} as unknown as HubDb,
      repoStore: {
        repoStore: { writeTree: async () => ({ commitSha: "sha" }) },
      } as unknown as AgentRepoStore,
      sidecarRouter,
      directorRegistry: {} as unknown as DirectorRegistry,
    });
  }

  test("is a no-op when the supervisor address is already routable", async () => {
    const address = deriveDeploymentAddress({
      deploymentId: "ses_live",
      deploymentDomain: "deploy.example.com",
    });
    const sendAgentDeploy = mock(async () => ({ publicKey: "pk" }));
    const service = makeService({
      routableAddresses: [address],
      sendAgentDeploy:
        sendAgentDeploy as unknown as SidecarRouter["sendAgentDeploy"],
    });

    const result = await service.ensureDeploymentRoutable({
      deploymentId: "ses_live",
      kind: "pain-point-collateral",
      tenantId: "t1",
      creatorPrincipalId: "p1",
      deploymentDomain: "deploy.example.com",
    });

    expect(result.reestablished).toBe(false);
    expect(sendAgentDeploy).not.toHaveBeenCalled();
  });
});
