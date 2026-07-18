import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema as intxSchema } from "@intx/db";
import { deriveDeploymentAddress } from "@intx/workflow-deploy";
import { defineWorkflow } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";
import type { HarnessConfig, InferenceSource } from "@intx/types/runtime";
import type {
  AgentRepoStore,
  SidecarRouter,
} from "@intx/hub-sessions";
import type { HubDb } from "../db";
import {
  createWorkbenchDirectorRegistry,
  inlineInferenceStep,
} from "@workbench/agents";

// Catalog publish is hub-only: persistCatalog writes the git `workflow`
// definition repo + DB rows with the sidecar disconnected, and the supervisor is
// minted per RUN by provisionRunDeployment. This proves the two halves across
// their real seam: publish with a throwing (disconnected) sidecar succeeds and
// commits workflow.json to disk; a later run reads that definition back and
// deploys a fresh supervisor once the sidecar is up.

const FRESH_ID = "ses_freshRUN";
const SOURCE: InferenceSource = {
  id: "openai-compatible:m",
  provider: "openai-compatible",
  baseURL: "https://llm.example.com",
  apiKey: "secret",
  model: "m",
};

const realConfig = await import("./workflow-deploy-config");
mock.module("./workflow-deploy-config", () => ({
  ...realConfig,
  resolveWorkflowDeployConfig: async (args: {
    tenantId: string;
    principalId: string;
    deploymentDomain: string;
    definition: WorkflowDefinition;
  }) => {
    const config: HarnessConfig = {
      sessionId: "sess_run",
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

describe("catalog publish (disconnected) then per-run provision", () => {
  test("persistCatalog commits the definition with the sidecar down; a run then provisions a supervisor", async () => {
    const deploymentDomain = "deploy.example.com";
    const dir = await mkdtemp(join(tmpdir(), "wf-catalog-run-"));

    // A single inline-inference step keeps the deploy to just the supervisor.
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

    // writeTree materializes the git `workflow` repo's workflow.json on disk so
    // the later per-run provision reads back exactly what publish committed.
    const writeTree = mock(
      async (
        _principal: { kind: string },
        repoId: { kind: string; id: string },
        _ref: string,
        content: { files: Record<string, string> },
      ) => {
        if (repoId.kind === "workflow") {
          await writeFile(
            join(dir, "workflow.json"),
            content.files["workflow.json"]!,
            "utf8",
          );
        }
        return { commitSha: "sha" };
      },
    );
    const repoStore = {
      repoStore: { getRepoDir: () => dir, writeTree },
    } as unknown as AgentRepoStore;

    const db = {
      insert: mock((table: unknown) => {
        if (table === intxSchema.agentSession) {
          return {
            values: () => ({ onConflictDoNothing: async () => undefined }),
          };
        }
        return { values: async () => undefined };
      }),
    } as unknown as HubDb;


    // Sidecar starts disconnected: any frame send throws until flipped.
    let sidecarConnected = false;
    const deployedAddresses: string[] = [];
    const sidecarRouter = {
      getRoutableAddresses: () => [],
      sendAgentDeploy: async (address: string) => {
        if (!sidecarConnected) throw new Error("sidecar disconnected");
        deployedAddresses.push(address);
        return { publicKey: "pk" };
      },
    } as unknown as SidecarRouter;

    const service = createWorkflowDeployService({
      db,
      repoStore,
      sidecarRouter,
      directorRegistry: createWorkbenchDirectorRegistry(),
    });

    try {
      // 1. Publish the catalog while the sidecar is DOWN. It must succeed and
      // commit workflow.json without ever sending a frame.
      const config: HarnessConfig = {
        sessionId: "sess_pub",
        agentId: "ses_catalog",
        tenantId: "t1",
        principalId: "p1",
        agentAddress: `ses_catalog@${deploymentDomain}`,
        systemPrompt: "",
        tools: [],
        grants: [],
        sources: [SOURCE],
        defaultSource: SOURCE.id,
      } as unknown as HarnessConfig;

      await service.persistCatalog({
        workflow,
        deploymentId: "ses_catalog",
        deploymentDomain,
        tenantId: "t1",
        creatorPrincipalId: "p1",
        config,
        deployContent: { systemPrompt: "" },
        hubPublicKey: "hubkey",
      });

      // The definition was committed to disk even though the sidecar was down.
      const committed = JSON.parse(
        await readFile(join(dir, "workflow.json"), "utf8"),
      ) as { id: string };
      expect(committed.id).toBe("k1");
      expect(deployedAddresses).toHaveLength(0);

      // 2. Sidecar reconnects; a run provisions a fresh supervisor from the
      // published definition — the kind that never had a sidecar deploy.
      sidecarConnected = true;
      const result = await service.provisionRunDeployment({
        kind: "k1",
        tenantId: "t1",
        creatorPrincipalId: "p1",
        deploymentDomain,
        hubPublicKey: "hubkey",
      });

      expect(result.deploymentId).toBe(FRESH_ID);
      expect(deployedAddresses).toContain(
        deriveDeploymentAddress({ deploymentId: FRESH_ID, deploymentDomain }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
