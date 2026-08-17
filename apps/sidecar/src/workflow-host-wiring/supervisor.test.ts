// Regression test for the ask-approval-registration wiring gap: a
// workflow-child's `ask`-effect suspend only reaches the hub as a
// `signal.correlation.register` frame (and gets an approval row) when
// `createSidecarWorkflowSupervisor` forwards its caller's
// `onSuspensionRegister` sink into `createWorkflowSupervisor`'s bindings.
// Before this fix the sink was silently dropped: the supervisor logged
// "no onSuspensionRegister sink is wired" and the suspended run parked
// forever with zero rows in the `approval` table.

import { expect, mock, test } from "bun:test";

mock.module("@intx/workflow-host", () => ({
  createWorkflowSupervisor: mock((config: unknown) => {
    capturedConfig = config;
    return {
      getCredentialsSnapshot: () => null,
    };
  }),
  wrapHubTransportAsMailBus: () => ({
    routeInbound: async () => {},
  }),
}));

let capturedConfig: unknown;

const { createSidecarWorkflowSupervisor } = await import("./supervisor");

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
    substrateEnv: {},
    dynamicSpawnEnv: () => ({}),
  });

  expect(
    (capturedConfig as { onSuspensionRegister?: unknown }).onSuspensionRegister,
  ).toBeUndefined();
});
