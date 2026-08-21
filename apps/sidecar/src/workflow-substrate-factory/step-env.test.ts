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

import { SUMMARIZE_OLDER_TURNS_NAME } from "./compactors";
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

test("a body-step env with no staged deploy tree still carries definitionId, so the binding is not tool-materialization-gated", async () => {
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

// CL-6448: the body-turn history seam. A section body runs each message as
// its own child run (`turn__<n>`), so conversation continuity depends on
// the env builder resolving `storage` through the per-agent durable
// registry keyed by the STABLE stepId — never the per-run isogit store a
// changing runId would reset every turn.
test("with a durable-conversation registry, envs built for different runIds share one storage keyed by stepId", async () => {
  const dataDir = makeTmpDataDir();
  const acquired: string[] = [];
  const sharedStorage = { marker: "durable-store" };
  const registry = {
    acquire: (key: string) => {
      acquired.push(key);
      return Promise.resolve({ storage: sharedStorage } as never);
    },
    get: () => {
      throw new Error("unused");
    },
    peek: () => undefined,
  };
  const buildEnv = createSidecarStepBuildEnv({
    ...buildEnvDeps(dataDir),
    durableConversation: registry as never,
  });
  const sourcesRef: SourcesSnapshotRef = {
    current: {
      step_1: [{ id: "src_1", provider: "anthropic", model: "claude" }],
    },
  } as unknown as SourcesSnapshotRef;

  const turn1 = stepInvokeRequest();
  turn1.authzContext.runId = "turn__0";
  const turn2 = stepInvokeRequest();
  turn2.authzContext.runId = "turn__1";

  const env1 = await buildEnv(turn1, sourcesRef);
  const env2 = await buildEnv(turn2, sourcesRef);

  expect(acquired).toEqual(["step_1", "step_1"]);
  expect(env1.storage).toBe(sharedStorage as never);
  expect(env2.storage).toBe(env1.storage);
});

// CL-6448: without the registry, per-run isogit stores stay per-run — the
// multi-step cold path's behavior is unchanged.
test("without a durable-conversation registry, envs built for different runIds get distinct storage", async () => {
  const dataDir = makeTmpDataDir();
  const buildEnv = createSidecarStepBuildEnv(buildEnvDeps(dataDir));
  const sourcesRef: SourcesSnapshotRef = {
    current: {
      step_1: [{ id: "src_1", provider: "anthropic", model: "claude" }],
    },
  } as unknown as SourcesSnapshotRef;

  const turn1 = stepInvokeRequest();
  turn1.authzContext.runId = "turn__0";
  const turn2 = stepInvokeRequest();
  turn2.authzContext.runId = "turn__1";

  const env1 = await buildEnv(turn1, sourcesRef);
  const env2 = await buildEnv(turn2, sourcesRef);

  expect(env1.storage).not.toBe(env2.storage);
});

test("the built step env forwards the summarize-older-turns compactor (CL-6204) like the other env fields above", async () => {
  const dataDir = makeTmpDataDir();
  const buildEnv = createSidecarStepBuildEnv(buildEnvDeps(dataDir));
  const sourcesRef: SourcesSnapshotRef = {
    current: {
      step_1: [{ id: "src_1", provider: "anthropic", model: "claude" }],
    },
  } as unknown as SourcesSnapshotRef;

  const env = await buildEnv(stepInvokeRequest(), sourcesRef);

  const compactors = (
    env as unknown as { compactors: Record<string, { name: string }> }
  ).compactors;
  expect(Object.keys(compactors)).toEqual([SUMMARIZE_OLDER_TURNS_NAME]);
  expect(compactors[SUMMARIZE_OLDER_TURNS_NAME]?.name).toBe(
    SUMMARIZE_OLDER_TURNS_NAME,
  );
});
