import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema as intxSchema } from "@intx/db";
import { deriveDeploymentAddress } from "@intx/workflow-deploy";
import { defineWorkflow } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";
import type { HarnessConfig, InferenceSource } from "@intx/types/runtime";
import type { AgentRepoStore, SidecarRouter } from "@intx/hub-sessions";
import type { HubDb } from "../db";
import {
  createWorkbenchDirectorRegistry,
  inlineInferenceStep,
} from "@workbench/agents";
import { workflowRun } from "../db/schema";

// Per-run deployment (CL-2582): provisionRunDeployment reads the published
// definition by kind, resolves a FRESH deploymentId, and deploys — writing NO
// `workflow_run` registry row (that row stays the operator's definition entry).
//
// We exercise the real createWorkflowDeployService + real orchestrator across
// their seams, mocking only the deploy-config resolver so the minted id is
// deterministic (and @intx/db's catalog lookup is out of scope here). The
// definition is read from a real on-disk workflow.json.

const FRESH_ID = "ses_freshXYZ";
const SOURCE: InferenceSource = {
  id: "openai-compatible:m",
  provider: "openai-compatible",
  baseURL: "https://llm.example.com",
  apiKey: "secret",
  model: "m",
};

const resolveCalls: {
  tenantId: string;
  principalId: string;
  deploymentDomain: string;
  definitionId: string;
}[] = [];

const realConfig = await import("./workflow-deploy-config");
mock.module("./workflow-deploy-config", () => ({
  ...realConfig,
  resolveWorkflowDeployConfig: async (args: {
    tenantId: string;
    principalId: string;
    deploymentDomain: string;
    definition: WorkflowDefinition;
  }) => {
    resolveCalls.push({
      tenantId: args.tenantId,
      principalId: args.principalId,
      deploymentDomain: args.deploymentDomain,
      definitionId: args.definition.id,
    });
    const config: HarnessConfig = {
      sessionId: "sess_1",
      agentId: FRESH_ID,
      tenantId: args.tenantId,
      principalId: args.principalId,
      agentAddress: `${FRESH_ID}@${args.deploymentDomain}`,
      systemPrompt: "",
      tools: [],
      grants: [],
      sources: [SOURCE],
      defaultSource: SOURCE.id,
    } as unknown as HarnessConfig;
    return {
      deploymentId: FRESH_ID,
      config,
      deployContent: { systemPrompt: "" },
    };
  },
}));

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

const { createWorkflowDeployService } = await import("./workflow-deploy");

describe("provisionRunDeployment (per-run deployment, CL-2582)", () => {
  test("reads the kind's definition, deploys a FRESH id, and writes no workflow_run registry row", async () => {
    const deploymentDomain = "deploy.example.com";
    const dir = await mkdtemp(join(tmpdir(), "wf-provision-"));

    // A single inline-inference step keeps the deploy to just the supervisor —
    // no deployed step sessions, no per-step agent-state repos.
    const workflow = defineWorkflow({
      id: "k1",
      trigger: { type: "manual" },
      steps: {
        analyze: inlineInferenceStep({
          id: "analyze",
          systemPrompt: "extract pain points",
        }),
      },
    });
    await writeFile(
      join(dir, "workflow.json"),
      JSON.stringify(workflow),
      "utf8",
    );

    const insertedTables: unknown[] = [];
    const db = {
      insert: mock((table: unknown) => {
        insertedTables.push(table);
        if (table === intxSchema.agentSession) {
          return {
            values: () => ({ onConflictDoNothing: async () => undefined }),
          };
        }
        return { values: async () => undefined };
      }),
    } as unknown as HubDb;

    const repoStore = {
      repoStore: {
        getRepoDir: () => dir,
        writeTree: async () => ({ commitSha: "sha" }),
      },
    } as unknown as AgentRepoStore;

    const deployedAddresses: string[] = [];
    const sidecarRouter = {
      getRoutableAddresses: () => [],
      sendAgentDeploy: async (address: string) => {
        deployedAddresses.push(address);
        return { publicKey: "pk" };
      },
    } as unknown as SidecarRouter;

    const service = createWorkflowDeployService({
      db,
      repoStore,
      sidecarRouter,
      directorRegistry: createWorkbenchDirectorRegistry(),
      // Provisioning REQUIRES a stager (FIX 2b); this test stages no real tool
      // tree, so inject an explicit no-op rather than relying on a silent
      // fallback.
      stageWorkflowStep: () => Promise.resolve(),
    });

    try {
      const result = await service.provisionRunDeployment({
        kind: "k1",
        tenantId: "t1",
        creatorPrincipalId: "p1",
        deploymentDomain,
        hubPublicKey: "hubkey",
      });

      // Config was resolved from the definition read off disk, into the
      // definition's tenant + deploy principal.
      expect(resolveCalls).toHaveLength(1);
      expect(resolveCalls[0]).toEqual({
        tenantId: "t1",
        principalId: "p1",
        deploymentDomain,
        definitionId: "k1",
      });

      // The run gets its OWN freshly-minted deployment id (returned to the
      // caller and used as the supervisor address) — never a caller-supplied or
      // shared id.
      expect(result.deploymentId).toBe(FRESH_ID);
      expect(deployedAddresses).toContain(
        deriveDeploymentAddress({ deploymentId: FRESH_ID, deploymentDomain }),
      );

      // The definition-registry row is the operator's; a per-run provision must
      // never insert one, or run-start resolution would start picking ephemeral
      // per-run deployments.
      expect(insertedTables).not.toContain(workflowRun);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rolls the partial deploy back via reclaimDeployment when deploy fails, then rethrows (CL-2582 Step D, class 1)", async () => {
    const deploymentDomain = "deploy.example.com";
    const dir = await mkdtemp(join(tmpdir(), "wf-provision-fail-"));
    const workflow = defineWorkflow({
      id: "k1",
      trigger: { type: "manual" },
      steps: {
        analyze: inlineInferenceStep({ id: "analyze", systemPrompt: "x" }),
      },
    });
    await writeFile(
      join(dir, "workflow.json"),
      JSON.stringify(workflow),
      "utf8",
    );

    const db = {
      insert: (table: unknown) => {
        if (table === intxSchema.agentSession) {
          return {
            values: () => ({ onConflictDoNothing: async () => undefined }),
          };
        }
        return { values: async () => undefined };
      },
    } as unknown as HubDb;
    const repoStore = {
      repoStore: {
        getRepoDir: () => dir,
        writeTree: async () => ({ commitSha: "sha" }),
      },
    } as unknown as AgentRepoStore;
    // Force the deploy to fail at the supervisor frame.
    const sidecarRouter = {
      getRoutableAddresses: () => [],
      sendAgentDeploy: async () => {
        throw new Error("sidecar deploy boom");
      },
    } as unknown as SidecarRouter;

    const reclaimed: { deploymentId: string; tenantId: string }[] = [];
    const service = createWorkflowDeployService({
      db,
      repoStore,
      sidecarRouter,
      directorRegistry: createWorkbenchDirectorRegistry(),
      // Provisioning REQUIRES a stager (FIX 2b); inject an explicit no-op so
      // the rollback path is reached via the sidecar error, not the guard.
      stageWorkflowStep: () => Promise.resolve(),
      reclaimDeployment: async (args) => {
        reclaimed.push({
          deploymentId: args.deploymentId,
          tenantId: args.tenantId,
        });
      },
    });

    try {
      await expect(
        service.provisionRunDeployment({
          kind: "k1",
          tenantId: "t1",
          creatorPrincipalId: "p1",
          deploymentDomain,
          hubPublicKey: "hubkey",
        }),
      ).rejects.toThrow(/boom/);

      // The partial deploy was rolled back with the SAME freshly-minted id, so a
      // provision failure leaves no orphaned supervisor/step rows.
      expect(reclaimed).toEqual([{ deploymentId: FRESH_ID, tenantId: "t1" }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
