import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateKeyPair } from "@intx/crypto";
import type { KeyPair } from "@intx/types/runtime";
import {
  createRepoStore,
  type AuthorizeFn,
  type KindHandler,
  type Principal,
  type RepoId,
  type RepoStore,
  type ValidatePushResult,
} from "@intx/hub-sessions";

import { describePendingGates } from "./pending-gate-info";
import { deriveWorkflowRunRepoId } from "../routes/workflow-runs";

// Real-seam coverage (CL-2870): prove `describePendingGates` recovers the live
// gate signalName from a run's native git event log through the REAL
// `getAwaitingSignalNames` fold (nothing at the @intx boundary is mocked — that
// is the seam under test) and joins it to the registered payload schema. The
// resume-payload registry (describeResumePayload) is exercised directly by its
// own unit suite; here it is the real join used by the tool path.

const RUN_EVENT_REF = "refs/heads/main";
const HUB_PRINCIPAL: Principal = { kind: "hub" };
const DEPLOYMENT_ID = "dep-gate-it";
const DEPLOYMENT_DOMAIN = "wf.localhost";
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

// A run parked at the last30days-research `intake` gate: RunStarted → the intake
// step starts → SignalAwaited(intake). The fold leaves `intake` open.
function parkedAtIntake(runId: string): Record<string, unknown>[] {
  const t = (n: number): string =>
    new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  return [
    {
      seq: 1,
      type: "RunStarted",
      runId,
      at: t(1),
      definitionHash: "hash-l30",
      trigger: { type: "manual", payload: {} },
    },
    { seq: 2, type: "StepStarted", stepId: "intake", at: t(2), attempt: 1 },
    {
      seq: 3,
      type: "SignalAwaited",
      stepId: "intake",
      at: t(3),
      signalName: "intake",
    },
  ];
}

// A run whose only step completed and terminated — no open gate.
function completedRun(runId: string): Record<string, unknown>[] {
  const t = (n: number): string =>
    new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  return [
    {
      seq: 1,
      type: "RunStarted",
      runId,
      at: t(1),
      definitionHash: "hash-l30",
      trigger: { type: "manual", payload: {} },
    },
    { seq: 2, type: "StepStarted", stepId: "intake", at: t(2), attempt: 1 },
    {
      seq: 3,
      type: "StepCompleted",
      stepId: "intake",
      at: t(3),
      attempt: 1,
      output: {},
    },
    { seq: 4, type: "RunCompleted", at: t(4) },
  ];
}

let tempDir: string;
let repoStore: RepoStore;
let signingKey: KeyPair;

async function commit(
  runId: string,
  events: Record<string, unknown>[],
): Promise<void> {
  const files: Record<string, string> = {};
  for (const event of events) {
    files[`runs/${runId}/events/${String(event["seq"])}.json`] =
      JSON.stringify(event);
  }
  await repoStore.writeTree(HUB_PRINCIPAL, REPO_ID, RUN_EVENT_REF, {
    files,
    message: `log for ${runId}`,
  });
}

beforeEach(async () => {
  tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pending-gate-it-"),
  );
  signingKey = await generateKeyPair();
  repoStore = createRepoStore({
    dataDir: tempDir,
    signingKey,
    handlers: { "workflow-run": permissiveHandler },
    authorize: allowAll,
  });
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

describe("describePendingGates — live gate recovery + payload schema", () => {
  test("recovers the open gate signalName and its registered payload schema", async () => {
    await commit("wfr-parked", parkedAtIntake("wfr-parked"));

    const gates = await describePendingGates(
      { repoStore, deploymentDomain: DEPLOYMENT_DOMAIN },
      {
        runId: "wfr-parked",
        kind: "last30days-research",
        deploymentId: DEPLOYMENT_ID,
      },
    );

    expect(gates).toHaveLength(1);
    expect(gates[0]?.signalName).toBe("intake");
    // The join to the resume-payload registry surfaces the expected fields so
    // Myra never has to guess the payload shape.
    expect(gates[0]?.payloadSchema).toContain("topic");
  });

  test("surfaces the signalName with no payloadSchema for an unregistered gate", async () => {
    await commit("wfr-parked2", parkedAtIntake("wfr-parked2"));

    // Same open gate ("intake") but a kind with no registered schema → the gate
    // is still surfaced (so the signal can be delivered), payloadSchema omitted.
    const gates = await describePendingGates(
      { repoStore, deploymentDomain: DEPLOYMENT_DOMAIN },
      {
        runId: "wfr-parked2",
        kind: "some-unregistered-workflow",
        deploymentId: DEPLOYMENT_ID,
      },
    );

    expect(gates).toHaveLength(1);
    expect(gates[0]?.signalName).toBe("intake");
    expect(gates[0]?.payloadSchema).toBeUndefined();
  });

  test("returns no gates for a run with no open awaitSignal", async () => {
    await commit("wfr-done", completedRun("wfr-done"));

    const gates = await describePendingGates(
      { repoStore, deploymentDomain: DEPLOYMENT_DOMAIN },
      {
        runId: "wfr-done",
        kind: "last30days-research",
        deploymentId: DEPLOYMENT_ID,
      },
    );

    expect(gates).toEqual([]);
  });

  test("returns no gates (does not throw) when the run log is unreadable", async () => {
    const gates = await describePendingGates(
      { repoStore, deploymentDomain: DEPLOYMENT_DOMAIN },
      {
        runId: "wfr-never-committed",
        kind: "last30days-research",
        deploymentId: DEPLOYMENT_ID,
      },
    );

    expect(gates).toEqual([]);
  });
});
