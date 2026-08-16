// Proves the CL-6086 binding: `createSidecarStepBuildEnv` threads the
// deploying definition's own `definitionId` (and the derived
// `hubCapabilitiesUrl`) onto the built step env, following exactly the
// binding pattern `hubMemoryUrl`/`hubSkillsUrl`/`sidecarToken`/`address`
// already use — see this file's header comment for the memory-tools
// precedent this mirrors.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import type { AgentDefinition, BaseEnv } from "@intx/agent";
import type { RepoId } from "@intx/hub-sessions/substrate";
import type { StepInvokeRequest } from "@intx/workflow";
import type {
  ChildOutboundMailBridge,
  SourcesSnapshotRef,
} from "@intx/workflow-host";

import { createSidecarStepBuildEnv } from "./step-env";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tmpDirs
      .splice(0)
      .map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
});

function makeTmpDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "step-env-test-"));
  tmpDirs.push(dir);
  return dir;
}

const WORKFLOW_RUN_REPO_ID: RepoId = { kind: "workflow-run", id: "wfr_1" };

function buildEnvDeps(dataDir: string) {
  return {
    dataDir,
    workflowRunRepoId: WORKFLOW_RUN_REPO_ID,
    signer: () => Promise.resolve("fake-signature"),
    registries: new Map(),
    mailboxAddress: "run_1@example.com",
    stepCount: 1,
    outboundMailBridge: {} as ChildOutboundMailBridge,
    cache: { cacheMaxBytes: 1_000_000, registryMaxTarballBytes: 1_000_000 },
    hubArtifactsUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    adapters: { resolve: () => undefined } as never,
    toolless: true,
    definitionId: "wfd_capability_owner",
  };
}

function stepInvokeRequest(): StepInvokeRequest {
  return {
    agent: {} as AgentDefinition<BaseEnv>,
    input: "hello",
    authzContext: { stepId: "step_1", runId: "run_1", attempt: 1 },
    signal: new AbortController().signal,
  };
}

test("the built step env carries the deploying definition's own definitionId and a derived hubCapabilitiesUrl", async () => {
  const dataDir = makeTmpDataDir();
  const buildEnv = createSidecarStepBuildEnv(buildEnvDeps(dataDir));
  const sourcesRef: SourcesSnapshotRef = {
    current: {
      step_1: [{ id: "src_1", provider: "anthropic", model: "claude" }],
    },
  } as unknown as SourcesSnapshotRef;

  const env = await buildEnv(stepInvokeRequest(), sourcesRef);

  expect((env as unknown as { definitionId: string }).definitionId).toBe(
    "wfd_capability_owner",
  );
  expect(
    (env as unknown as { hubCapabilitiesUrl: string }).hubCapabilitiesUrl,
  ).toBe("https://hub.example.com");
  // Same hub origin as the sibling artifacts/memory/skills bindings —
  // one origin, one name per tool-bundle surface, never overloaded.
  expect((env as unknown as { hubArtifactsUrl: string }).hubArtifactsUrl).toBe(
    "https://hub.example.com",
  );
  expect((env as unknown as { hubMemoryUrl: string }).hubMemoryUrl).toBe(
    "https://hub.example.com",
  );
  expect((env as unknown as { address: string }).address).toBe(
    "run_1@example.com",
  );
});

test("a toolless body-step env still carries definitionId, so the binding is not tool-materialization-gated", async () => {
  const dataDir = makeTmpDataDir();
  const buildEnv = createSidecarStepBuildEnv({
    ...buildEnvDeps(dataDir),
    definitionId: "wfd_parent_definition",
  });
  const sourcesRef: SourcesSnapshotRef = {
    current: {
      step_1: [{ id: "src_1", provider: "anthropic", model: "claude" }],
    },
  } as unknown as SourcesSnapshotRef;

  const env = await buildEnv(stepInvokeRequest(), sourcesRef);
  expect((env as unknown as { definitionId: string }).definitionId).toBe(
    "wfd_parent_definition",
  );
});
