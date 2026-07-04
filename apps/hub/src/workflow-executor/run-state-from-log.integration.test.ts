import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateKeyPair } from "@intx/crypto";
import type { KeyPair } from "@intx/types/runtime";
import {
  createRepoStore,
  encodeCombinedEventLog,
  type AgentRepoStore,
  type AuthorizeFn,
  type KindHandler,
  type Principal,
  type RepoId,
  type RepoStore,
  type ValidatePushResult,
} from "@intx/hub-sessions";
import { awaitSignal, defineWorkflow, step } from "@intx/workflow";
import { defineAgent } from "@intx/agent";
import { deterministicToolStep, inlineInferenceStep } from "@workbench/agents";

// readWorkflowDefinition (reached via run-state-from-log) reads its cache TTL
// from getConfig(); apps/hub tests do not preload test-setup/loadConfig, so stub
// the one field it touches.
mock.module("../config", () => ({
  getConfig: () => ({
    workflowDeploy: {
      modelSourceCacheTtlMs: 45_000,
      definitionCacheTtlMs: 45_000,
    },
  }),
}));

import { classifyStepKinds, getWorkflowRunState } from "./run-state-from-log";
import { deriveWorkflowRunRepoId } from "../routes/workflow-runs";

// Integration coverage for the CL-2669 Phase 1a log-derived read path. Proves a
// run is fully readable from the native git event log through the #534
// layout-aware reader + the native @intx/workflow fold — from BOTH the
// per-event `events/<seq>.json` layout (in-flight runs) and the sealed
// `events.jsonl` layout (terminated runs), yielding identical RunState.
//
// Uses a REAL on-disk RepoStore (createRepoStore) with committed event blobs and
// the REAL native state machine (getWorkflowRunState -> resumeFromLog); nothing
// at the @intx boundary is mocked — that is the seam under test.

const RUN_EVENT_REF = "refs/heads/main";
const HUB_PRINCIPAL: Principal = { kind: "hub" };
const DEPLOYMENT_ID = "dep-log-it";
const DEPLOYMENT_DOMAIN = "wf.localhost";
// getWorkflowRunState reads the run repo under the SLUGGED deployment address
// (deriveWorkflowRunRepoId), matching the sidecar's on-disk layout — so the test
// commits its blobs under that same id (CL-2669).
const REPO_ID: RepoId = {
  kind: "workflow-run",
  id: deriveWorkflowRunRepoId({
    deploymentId: DEPLOYMENT_ID,
    deploymentDomain: DEPLOYMENT_DOMAIN,
  }),
};

const allowAll: AuthorizeFn = () => ({ allowed: true });
const permissiveHandler: KindHandler = {
  kind: "workflow-run",
  directoryPrefix: "workflow-runs",
  validatePush(): ValidatePushResult {
    return { ok: true };
  },
  onRefUpdated() {
    /* no-op */
  },
};

// A valid native run log exercising a retried step, a failed step, and an
// awaitSignal gate, terminating in RunFailed. Each event's on-disk `type`
// mirrors the state-machine `kind`; `at` carries the ISO commit timestamp.
function buildEventLog(runId: string): Record<string, unknown>[] {
  const t = (n: number): string =>
    new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  return [
    {
      seq: 1,
      type: "RunStarted",
      runId,
      at: t(1),
      definitionHash: "hash-abc",
      trigger: { type: "manual", payload: {} },
    },
    {
      seq: 2,
      type: "StepStarted",
      stepId: "fetch",
      at: t(2),
      attempt: 1,
      input: { ref: "r0" },
    },
    {
      seq: 3,
      type: "StepFailed",
      stepId: "fetch",
      at: t(3),
      attempt: 1,
      error: { message: "transient boom" },
      retriesExhausted: false,
    },
    {
      seq: 4,
      type: "TimerSet",
      timerId: "tmr-1",
      at: t(4),
      fireAt: t(5),
      stepId: "fetch",
    },
    {
      seq: 5,
      type: "AttemptScheduled",
      stepId: "fetch",
      at: t(5),
      nextAttempt: 2,
      timerId: "tmr-1",
      fireAt: t(5),
    },
    { seq: 6, type: "TimerFired", timerId: "tmr-1", at: t(6) },
    {
      seq: 7,
      type: "StepCompleted",
      stepId: "fetch",
      at: t(7),
      attempt: 2,
      output: { ref: "r-fetch" },
    },
    {
      seq: 8,
      type: "StepStarted",
      stepId: "approve",
      at: t(8),
      attempt: 1,
      input: { ref: "r-fetch" },
    },
    {
      seq: 9,
      type: "SignalAwaited",
      stepId: "approve",
      at: t(9),
      signalName: "approval",
    },
    {
      seq: 10,
      type: "StepStarted",
      stepId: "score",
      at: t(10),
      attempt: 1,
      input: { ref: "r-fetch" },
    },
    {
      seq: 11,
      type: "StepFailed",
      stepId: "score",
      at: t(11),
      attempt: 1,
      error: { message: "scorer exploded" },
      retriesExhausted: true,
    },
    {
      seq: 12,
      type: "RunFailed",
      at: t(12),
      error: { message: "one or more steps failed" },
    },
  ];
}

let tempDir: string;
let repoStore: RepoStore;
let agentRepoStore: AgentRepoStore;
let signingKey: KeyPair;

async function commitPerEventLayout(runId: string): Promise<void> {
  const files: Record<string, string> = {};
  for (const event of buildEventLog(runId)) {
    files[`runs/${runId}/events/${String(event["seq"])}.json`] =
      JSON.stringify(event);
  }
  await repoStore.writeTree(HUB_PRINCIPAL, REPO_ID, RUN_EVENT_REF, {
    files,
    message: `per-event log for ${runId}`,
  });
}

async function commitSealedLayout(runId: string): Promise<void> {
  const blobs = buildEventLog(runId).map((event) =>
    new TextEncoder().encode(JSON.stringify(event)),
  );
  const combined = encodeCombinedEventLog(blobs);
  await repoStore.writeTree(HUB_PRINCIPAL, REPO_ID, RUN_EVENT_REF, {
    files: { [`runs/${runId}/events.jsonl`]: combined },
    message: `sealed log for ${runId}`,
  });
}

// Minimal AgentRepoStore facade — getWorkflowRunState only reads through
// `.repoStore` (for the run reader) and `readWorkflowDefinition` (which reads
// the workflow-kind repo via `.repoStore.getRepoDir`). No definition is
// deployed here, so classification degrades to `unknown` (covered separately).
function toAgentRepoStore(store: RepoStore): AgentRepoStore {
  return { repoStore: store } as unknown as AgentRepoStore;
}

beforeEach(async () => {
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "run-state-it-"));
  signingKey = await generateKeyPair();
  repoStore = createRepoStore({
    dataDir: tempDir,
    signingKey,
    handlers: { "workflow-run": permissiveHandler },
    authorize: allowAll,
  });
  agentRepoStore = toAgentRepoStore(repoStore);
  await repoStore.writeTree(HUB_PRINCIPAL, REPO_ID, RUN_EVENT_REF, {
    files: { ".gitignore": "" },
    message: "genesis",
  });
});

afterEach(async () => {
  await fs.promises
    .rm(tempDir, { recursive: true, force: true })
    .catch(() => {});
});

describe("getWorkflowRunState — native log fold across layouts", () => {
  test("per-event and sealed layouts yield identical RunState", async () => {
    await commitPerEventLayout("wfr-perevent");
    await commitSealedLayout("wfr-sealed");

    const fromPerEvent = await getWorkflowRunState(
      { repoStore: agentRepoStore },
      {
        deploymentId: DEPLOYMENT_ID,
        runId: "wfr-perevent",
        kind: "k",
        deploymentDomain: DEPLOYMENT_DOMAIN,
      },
    );
    const fromSealed = await getWorkflowRunState(
      { repoStore: agentRepoStore },
      {
        deploymentId: DEPLOYMENT_ID,
        runId: "wfr-sealed",
        kind: "k",
        deploymentDomain: DEPLOYMENT_DOMAIN,
      },
    );

    // Normalize the runId (the only field expected to differ) and compare the
    // whole projected state — phase, lastSeq, timing, and every step.
    const normalize = (s: typeof fromPerEvent): typeof fromPerEvent => ({
      ...s,
      runId: "R",
      steps: [...s.steps].sort((a, b) => a.stepId.localeCompare(b.stepId)),
    });
    expect(normalize(fromSealed)).toEqual(normalize(fromPerEvent));
  });

  test("the folded RunState reflects retry, failure, gate, and timing", async () => {
    await commitPerEventLayout("wfr-detail");
    const state = await getWorkflowRunState(
      { repoStore: agentRepoStore },
      {
        deploymentId: DEPLOYMENT_ID,
        runId: "wfr-detail",
        kind: "k",
        deploymentDomain: DEPLOYMENT_DOMAIN,
      },
    );

    expect(state.phase).toBe("failed");
    expect(state.lastSeq).toBe(12);
    expect(state.definitionHash).toBe("hash-abc");
    expect(state.startedAt).toBe("2026-01-01T00:00:01.000Z");
    expect(state.endedAt).toBe("2026-01-01T00:00:12.000Z");

    const byId = new Map(state.steps.map((s) => [s.stepId, s]));

    const fetch = byId.get("fetch");
    expect(fetch?.phase).toBe("completed");
    expect(fetch?.currentAttempt).toBe(2);
    expect(fetch?.outputRef).toBe("r-fetch");
    expect(fetch?.startedAt).toBe("2026-01-01T00:00:02.000Z");
    expect(fetch?.endedAt).toBe("2026-01-01T00:00:07.000Z");

    const approve = byId.get("approve");
    expect(approve?.phase).toBe("awaiting-signal");
    expect(approve?.awaitingSignalName).toBe("approval");

    const score = byId.get("score");
    expect(score?.phase).toBe("failed");
    expect(score?.lastError?.message).toBe("scorer exploded");
    expect(score?.endedAt).toBe("2026-01-01T00:00:11.000Z");
  });

  test("an unknown run yields an empty, pending RunState", async () => {
    const state = await getWorkflowRunState(
      { repoStore: agentRepoStore },
      {
        deploymentId: DEPLOYMENT_ID,
        runId: "wfr-nope",
        kind: "k",
        deploymentDomain: DEPLOYMENT_DOMAIN,
      },
    );
    expect(state.phase).toBe("pending");
    expect(state.lastSeq).toBe(0);
    expect(state.steps).toEqual([]);
  });
});

describe("classifyStepKinds — step-type classification from the definition", () => {
  test("classifies human, agent, deterministic, and inline steps", () => {
    const reasoningAgent = defineAgent({
      id: "reasoner",
      description: "A genuine reasoning agent",
      systemPrompt: "Think.",
      tools: [],
      capabilities: [],
      inference: { sources: [] },
    });

    const definition = defineWorkflow({
      id: "classify-wf",
      triggers: [{ type: "manual" }],
      steps: {
        gate: awaitSignal({ name: "approval" }),
        brains: step({ agent: reasoningAgent }),
        crunch: deterministicToolStep({
          id: "crunch-agent",
          tool: "some_tool",
        }),
        muse: inlineInferenceStep({ id: "muse-agent", systemPrompt: "Muse." }),
      },
    });

    const kinds = classifyStepKinds(definition);
    expect(kinds.get("gate")).toBe("human");
    expect(kinds.get("brains")).toBe("agent");
    expect(kinds.get("crunch")).toBe("deterministic");
    expect(kinds.get("muse")).toBe("inline");
  });
});
