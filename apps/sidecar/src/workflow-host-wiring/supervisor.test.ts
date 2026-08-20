// Regression test for the ask-approval-registration wiring gap: a
// workflow-child's `ask`-effect suspend only reaches the hub as a
// `signal.correlation.register` frame (and gets an approval row) when
// `createSidecarWorkflowSupervisor` forwards its caller's
// `onSuspensionRegister` sink into `createWorkflowSupervisor`'s bindings.
// Before this fix the sink was silently dropped: the supervisor logged
// "no onSuspensionRegister sink is wired" and the suspended run parked
// forever with zero rows in the `approval` table.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, mock, test } from "bun:test";
import type { RepoStore } from "@intx/hub-sessions";

import { runGrantsPath } from "../run-grants";

mock.module("@intx/workflow-host", () => ({
  createWorkflowSupervisor: mock((config: unknown) => {
    capturedConfig = config;
    return {
      getCredentialsSnapshot: () => null,
      deliverCredentials: async () => {},
    };
  }),
  wrapHubTransportAsMailBus: () => ({
    routeInbound: async () => {},
  }),
  hashGrants: async (grants: readonly unknown[]) =>
    `stub-hash:${JSON.stringify(grants)}`,
}));

let capturedConfig: unknown;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeRepoStore(): Promise<{ store: RepoStore; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "supervisor-onrunstart-"));
  tempDirs.push(dir);
  const store = {
    getRepoDir: () => dir,
  } as unknown as RepoStore;
  return { store, dir };
}

const { createSidecarWorkflowSupervisor, DEFAULT_MAX_GRANTS_AGE_MS } =
  await import("./supervisor");

test("createSidecarWorkflowSupervisor forwards onSuspensionRegister to the workflow-host supervisor", () => {
  const registerSuspension = mock(() => {});

  createSidecarWorkflowSupervisor({
    transport: {} as never,
    repoStore: {} as never,
    signingKeySeed: new Uint8Array(32),
    workflowRunRepoId: { kind: "workflow-run", id: "dep-1" },
    workflowRunRef: "refs/heads/main",
    deploymentId: "dep-1",
    stepCount: 1,
    deploymentMailAddress: "dep-1@local",
    deriveStepAddress: () => "dep-1-step@local",
    stepOrder: ["step"],
    substrateEnv: {},
    dynamicSpawnEnv: () => ({}),
    onSuspensionRegister: registerSuspension,
  });

  expect(capturedConfig).toMatchObject({
    onSuspensionRegister: registerSuspension,
  });
});

test("createSidecarWorkflowSupervisor omits onSuspensionRegister when the caller supplies none", () => {
  createSidecarWorkflowSupervisor({
    transport: {} as never,
    repoStore: {} as never,
    signingKeySeed: new Uint8Array(32),
    workflowRunRepoId: { kind: "workflow-run", id: "dep-2" },
    workflowRunRef: "refs/heads/main",
    deploymentId: "dep-2",
    stepCount: 1,
    deploymentMailAddress: "dep-2@local",
    deriveStepAddress: () => "dep-2-step@local",
    stepOrder: ["step"],
    substrateEnv: {},
    dynamicSpawnEnv: () => ({}),
  });

  expect(
    (capturedConfig as { onSuspensionRegister?: unknown }).onSuspensionRegister,
  ).toBeUndefined();
});

// Same wiring-gap class as onSuspensionRegister above (CL: MCP live proof):
// the hub delivers decrypted credential material on the deploy frame's
// `workflow.credentials`, and the workflow-host supervisor forwards its
// `credentialDelivery` binding to the child on the pre-trigger barrier —
// but before this fix `createSidecarWorkflowSupervisor` never accepted the
// field, so the child's materialRef stayed null and every
// `credentials.resolve("mcp.<slug>")` failed "no credential is bound".
test("createSidecarWorkflowSupervisor forwards credentialDelivery to the workflow-host supervisor", () => {
  const delivery = {
    bindings: [
      {
        handle: "mcp.exa",
        credentialId: "cred_1",
        consumer: "tool:@corbits/mcp-tools",
      },
    ],
    materials: [
      {
        credentialId: "cred_1",
        providerKey: "http",
        origin: "https://mcp.exa.ai/mcp",
        secret: "unauthenticated-mcp-server",
      },
    ],
  };

  createSidecarWorkflowSupervisor({
    transport: {} as never,
    repoStore: {} as never,
    signingKeySeed: new Uint8Array(32),
    workflowRunRepoId: { kind: "workflow-run", id: "dep-3" },
    workflowRunRef: "refs/heads/main",
    deploymentId: "dep-3",
    stepCount: 1,
    deploymentMailAddress: "dep-3@local",
    deriveStepAddress: () => "dep-3-step@local",
    stepOrder: ["step"],
    substrateEnv: {},
    dynamicSpawnEnv: () => ({}),
    credentialDelivery: delivery,
  });

  expect(capturedConfig).toMatchObject({ credentialDelivery: delivery });
});

test("createSidecarWorkflowSupervisor omits credentialDelivery when the deploy carries none", () => {
  createSidecarWorkflowSupervisor({
    transport: {} as never,
    repoStore: {} as never,
    signingKeySeed: new Uint8Array(32),
    workflowRunRepoId: { kind: "workflow-run", id: "dep-4" },
    workflowRunRef: "refs/heads/main",
    deploymentId: "dep-4",
    stepCount: 1,
    deploymentMailAddress: "dep-4@local",
    deriveStepAddress: () => "dep-4-step@local",
    stepOrder: ["step"],
    substrateEnv: {},
    dynamicSpawnEnv: () => ({}),
  });

  expect(
    (capturedConfig as { credentialDelivery?: unknown }).credentialDelivery,
  ).toBeUndefined();
});

// CL-6242: the vendor's recycle policy (`RecyclePolicyBounds` /
// `readRssBytes` / `readGrantsAgeMs`, `types.ts:473-499`) was never armed
// for a warm-keep deployment, so a long-lived single-step agent ran
// forever on the grants it was spawned with -- no bound ever forced a
// respawn onto fresh grants.
test("createSidecarWorkflowSupervisor arms the grants-age recycle policy for a warm-keep deployment", () => {
  createSidecarWorkflowSupervisor({
    transport: {} as never,
    repoStore: {} as never,
    signingKeySeed: new Uint8Array(32),
    workflowRunRepoId: { kind: "workflow-run", id: "dep-5" },
    workflowRunRef: "refs/heads/main",
    deploymentId: "dep-5",
    stepCount: 1,
    deploymentMailAddress: "dep-5@local",
    deriveStepAddress: () => "dep-5-step@local",
    stepOrder: ["step"],
    substrateEnv: {},
    dynamicSpawnEnv: () => ({}),
    warmKeep: true,
  });

  expect(capturedConfig).toMatchObject({
    recyclePolicy: { maxGrantsAgeMs: DEFAULT_MAX_GRANTS_AGE_MS },
  });
  expect(
    typeof (capturedConfig as { readGrantsAgeMs?: unknown }).readGrantsAgeMs,
  ).toBe("function");
  // No RSS reader: see the module-level comment in `supervisor.ts` on why
  // `maxRssBytes`/`readRssBytes` are never wired.
  expect(
    (capturedConfig as { readRssBytes?: unknown }).readRssBytes,
  ).toBeUndefined();
});

test("createSidecarWorkflowSupervisor omits the recycle policy for a non-warm-keep deployment", () => {
  createSidecarWorkflowSupervisor({
    transport: {} as never,
    repoStore: {} as never,
    signingKeySeed: new Uint8Array(32),
    workflowRunRepoId: { kind: "workflow-run", id: "dep-6" },
    workflowRunRef: "refs/heads/main",
    deploymentId: "dep-6",
    stepCount: 2,
    deploymentMailAddress: "dep-6@local",
    deriveStepAddress: () => "dep-6-step@local",
    stepOrder: ["step"],
    substrateEnv: {},
    dynamicSpawnEnv: () => ({}),
    warmKeep: false,
  });

  expect(
    (capturedConfig as { recyclePolicy?: unknown }).recyclePolicy,
  ).toBeUndefined();
  expect(
    (capturedConfig as { readGrantsAgeMs?: unknown }).readGrantsAgeMs,
  ).toBeUndefined();
});

test("readGrantsAgeMs reports undefined until deliverCredentials fires, then a non-negative age", async () => {
  const wired = createSidecarWorkflowSupervisor({
    transport: {} as never,
    repoStore: {} as never,
    signingKeySeed: new Uint8Array(32),
    workflowRunRepoId: { kind: "workflow-run", id: "dep-7" },
    workflowRunRef: "refs/heads/main",
    deploymentId: "dep-7",
    stepCount: 1,
    deploymentMailAddress: "dep-7@local",
    deriveStepAddress: () => "dep-7-step@local",
    stepOrder: ["step"],
    substrateEnv: {},
    dynamicSpawnEnv: () => ({}),
    warmKeep: true,
  });

  const readGrantsAgeMs = (
    capturedConfig as { readGrantsAgeMs: () => number | undefined }
  ).readGrantsAgeMs;
  expect(readGrantsAgeMs()).toBeUndefined();

  await wired.supervisor.deliverCredentials({
    delivery: { bindings: [], materials: [] },
  } as never);

  const age = readGrantsAgeMs();
  expect(age).toBeGreaterThanOrEqual(0);
});

// Port of upstream Interchange's `onRunStart` grants sink: the per-run
// credential/grants barrier the vendor supervisor awaits before every
// `trigger.fire`.
test("createSidecarWorkflowSupervisor wires onRunStart to assemble the run's credentialsSnapshot from its per-run grants file", async () => {
  const { store, dir } = await makeRepoStore();
  const filePath = path.join(dir, runGrantsPath("run-1"));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify({ grants: [{ resource: "tool:echo", action: "invoke" }] }),
  );

  createSidecarWorkflowSupervisor({
    transport: {} as never,
    repoStore: store,
    signingKeySeed: new Uint8Array(32),
    workflowRunRepoId: { kind: "workflow-run", id: "dep-8" },
    workflowRunRef: "refs/heads/main",
    deploymentId: "dep-8",
    stepCount: 1,
    stepOrder: ["step-a"],
    deploymentMailAddress: "dep-8@local",
    deriveStepAddress: ({ stepId }) => `dep-8-${stepId}@local`,
    substrateEnv: {},
    dynamicSpawnEnv: () => ({}),
  });

  const onRunStart = (
    capturedConfig as {
      onRunStart: (args: {
        runId: string;
        anchorRunId: string;
      }) => Promise<unknown>;
    }
  ).onRunStart;
  const snapshot = await onRunStart({ runId: "run-1", anchorRunId: "dep-8" });

  expect(snapshot).toEqual({
    steps: [
      {
        stepId: "step-a",
        address: "dep-8-step-a@local",
        grants: [{ resource: "tool:echo", action: "invoke" }],
        contentHash: `stub-hash:${JSON.stringify([{ resource: "tool:echo", action: "invoke" }])}`,
      },
    ],
  });
});

// Every run birth path writes `runs/<runId>/grants.json` before the run
// dispatches — `deployAtHead` produces the `run.grants` frame the sidecar
// writes — so an absent file is a run that would start under-authorized,
// and the barrier fails it closed rather than inventing an empty grant set.
test("onRunStart fails a run with no per-run grants file closed", async () => {
  const { store } = await makeRepoStore();

  createSidecarWorkflowSupervisor({
    transport: {} as never,
    repoStore: store,
    signingKeySeed: new Uint8Array(32),
    workflowRunRepoId: { kind: "workflow-run", id: "dep-9" },
    workflowRunRef: "refs/heads/main",
    deploymentId: "dep-9",
    stepCount: 1,
    stepOrder: ["step-a"],
    deploymentMailAddress: "dep-9@local",
    deriveStepAddress: ({ stepId }) => `dep-9-${stepId}@local`,
    substrateEnv: {},
    dynamicSpawnEnv: () => ({}),
  });

  const onRunStart = (
    capturedConfig as {
      onRunStart: (args: {
        runId: string;
        anchorRunId: string;
      }) => Promise<unknown>;
    }
  ).onRunStart;

  await expect(
    onRunStart({ runId: "run-missing", anchorRunId: "dep-9" }),
  ).rejects.toThrow(/has no grants file; failing closed/);
});

test("onRunStart refreshes readGrantsAgeMs, mirroring deliverCredentials's observation point", async () => {
  const { store, dir } = await makeRepoStore();
  const filePath = path.join(dir, runGrantsPath("run-1"));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ grants: [] }));

  const wired = createSidecarWorkflowSupervisor({
    transport: {} as never,
    repoStore: store,
    signingKeySeed: new Uint8Array(32),
    workflowRunRepoId: { kind: "workflow-run", id: "dep-10" },
    workflowRunRef: "refs/heads/main",
    deploymentId: "dep-10",
    stepCount: 1,
    stepOrder: ["step-a"],
    deploymentMailAddress: "dep-10@local",
    deriveStepAddress: ({ stepId }) => `dep-10-${stepId}@local`,
    substrateEnv: {},
    dynamicSpawnEnv: () => ({}),
    warmKeep: true,
  });

  const readGrantsAgeMs = (
    capturedConfig as { readGrantsAgeMs: () => number | undefined }
  ).readGrantsAgeMs;
  const onRunStart = (
    capturedConfig as {
      onRunStart: (args: {
        runId: string;
        anchorRunId: string;
      }) => Promise<unknown>;
    }
  ).onRunStart;
  expect(readGrantsAgeMs()).toBeUndefined();

  await onRunStart({ runId: "run-1", anchorRunId: "dep-10" });

  expect(readGrantsAgeMs()).toBeGreaterThanOrEqual(0);
  // deliverCredentials (a rotation) still refreshes the same observation
  // point independently.
  await wired.supervisor.deliverCredentials({
    delivery: { bindings: [], materials: [] },
  } as never);
  expect(readGrantsAgeMs()).toBeGreaterThanOrEqual(0);
});
