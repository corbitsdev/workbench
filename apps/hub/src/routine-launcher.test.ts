// Proves the gap CL-6038 closes: a routine's stored `input` (the
// stepper-collected topic/focus a routine's creator recorded) reaches
// the launched run as its first-turn mail, via the same
// `sendFoldedMailWithRetry` seam every other folded-run first message
// goes through — and that a delivery failure past launch never un-does
// or hides the already-real run. `@corbits/folded-runs` is real here
// except for `launchFoldedRun`/`sendFoldedMailWithRetry`/
// `readDefinitionJSON`, which would otherwise need a real tenant catalog
// and asset store — the same "swap the one export that needs a join"
// approach `packages/folded-runs/test/launch.test.ts` and
// `packages/webhook-triggers/test/launch.test.ts` use.
import { describe, expect, mock, test } from "bun:test";
import { RECURRING_TASK_ASSET_NAME } from "@corbits/workflow-catalog";

const actualFoldedRuns = await import("@corbits/folded-runs");

const FOLDED_BODY = {
  systemPrompt: "you are a routine agent",
  toolPackagePins: [],
  grantRequirements: [],
  credentialBindings: [],
  model: "claude-sonnet-5",
};

const FRAME_HEADER = "Input from this routine's setup:";

let launchFoldedRunCalls: unknown[] = [];
let sendFoldedMailWithRetryCalls: unknown[] = [];
let sendFoldedMailWithRetryResult: unknown = {
  ok: true,
  mail: { id: "m_1", createdAt: new Date().toISOString() },
};

mock.module("@corbits/folded-runs", () => ({
  ...actualFoldedRuns,
  readDefinitionJSON: async () => ({ __fake: true }),
  readFoldedBody: () => FOLDED_BODY,
  launchFoldedRun: async (...args: unknown[]) => {
    launchFoldedRunCalls.push(args);
    return { instancePrincipalId: "prn_run1", sessionId: "ses_run1" };
  },
  sendFoldedMailWithRetry: async (...args: unknown[]) => {
    sendFoldedMailWithRetryCalls.push(args);
    return sendFoldedMailWithRetryResult;
  },
  createCryptoProviderCache: () => ({
    get: async () => ({ __fakeCryptoProvider: true }) as never,
  }),
}));

const { createHubRoutineLauncher } = await import("./routine-launcher");

// The hub-grant plane is exercised on its own (`run-hub-grants` and the
// real-DB suite); these doubles only care about launch mechanics.
const noopRunHubGrants = {
  prepare: async () => async () => undefined,
  revoke: async () => undefined,
};

const DEFINITION_ROW = {
  id: "wfd_1",
  tenantId: "ten_1",
  status: "deployed" as const,
  assetId: "ast_1",
};

const TENANT_ROW = {
  id: "ten_1",
  domain: "acme.workbench.test",
};

function createFakeDb(
  overrides: {
    definition?: unknown;
    tenant?: unknown;
  } = {},
) {
  return {
    query: {
      workflowDefinition: {
        findFirst: async () =>
          "definition" in overrides ? overrides.definition : DEFINITION_ROW,
      },
      tenant: {
        findFirst: async () =>
          "tenant" in overrides ? overrides.tenant : TENANT_ROW,
      },
    },
  };
}

function baseInput(input: Record<string, unknown>) {
  return {
    tenantId: "ten_1",
    principalId: "usr_1",
    definitionId: "wfd_1",
    input,
  };
}

let dispatchTaskCalls: unknown[] = [];
let dispatchTaskResult: unknown = { runId: "wfr_task1" };
let dispatchTaskShouldThrow: Error | null = null;

function dispatchTask(input: unknown) {
  dispatchTaskCalls.push(input);
  if (dispatchTaskShouldThrow !== null) {
    return Promise.reject(dispatchTaskShouldThrow);
  }
  return Promise.resolve(dispatchTaskResult as never);
}

let joinDeliveryWorkbenchCalls: unknown[] = [];

function buildLauncher(overrides: { definition?: unknown } = {}) {
  return createHubRoutineLauncher({
    joinDeliveryWorkbench: async (input: unknown) => {
      joinDeliveryWorkbenchCalls.push(input);
    },
    db: createFakeDb(overrides) as never,
    sessionService: {} as never,
    assetService: {} as never,
    sidecarRouter: {} as never,
    hubPublicKey: "hub-key",
    toolGrantsForPins: () => [],
    runHubGrants: noopRunHubGrants,
    eventCollectors: {} as never,
    cryptoProviderCache: { get: async () => ({}) as never },
    dispatchTask: dispatchTask as never,
  });
}

describe("createHubRoutineLauncher", () => {
  test("threads the routine's stored input into the run's first-turn mail", async () => {
    launchFoldedRunCalls = [];
    sendFoldedMailWithRetryCalls = [];
    sendFoldedMailWithRetryResult = {
      ok: true,
      mail: { id: "m_1", createdAt: new Date().toISOString() },
    };

    const result = await buildLauncher().launchRoutineRun(
      baseInput({ topic: "AI coding agents", focus: "Competing launches" }),
    );

    expect(result.runId).toBeTruthy();
    expect(launchFoldedRunCalls).toHaveLength(1);
    expect(sendFoldedMailWithRetryCalls).toHaveLength(1);

    const [, params] = sendFoldedMailWithRetryCalls[0] as [
      unknown,
      {
        sessionId: string;
        agentAddress: string;
        from: string;
        domain: string;
        content: string;
      },
    ];
    expect(params.sessionId).toBe("ses_run1");
    expect(params.domain).toBe("acme.workbench.test");
    expect(params.from).toBe("usr_1@acme.workbench.test");
    expect(params.content).toBe(
      `${FRAME_HEADER}\ntopic: AI coding agents\nfocus: Competing launches`,
    );
  });

  test("sends no mail when the routine's stored input is empty", async () => {
    launchFoldedRunCalls = [];
    sendFoldedMailWithRetryCalls = [];

    const result = await buildLauncher().launchRoutineRun(baseInput({}));

    expect(result.runId).toBeTruthy();
    expect(launchFoldedRunCalls).toHaveLength(1);
    expect(sendFoldedMailWithRetryCalls).toHaveLength(0);
  });

  test("still returns the run id when input delivery fails after every retry — the run is never hidden or un-launched", async () => {
    launchFoldedRunCalls = [];
    sendFoldedMailWithRetryCalls = [];
    sendFoldedMailWithRetryResult = {
      ok: false,
      error: new Error("sidecar unreachable"),
      attempts: 3,
    };

    const result = await buildLauncher().launchRoutineRun(
      baseInput({ topic: "AI coding agents" }),
    );

    expect(result.runId).toBeTruthy();
    expect(launchFoldedRunCalls).toHaveLength(1);
    expect(sendFoldedMailWithRetryCalls).toHaveLength(1);
  });
});

const RECURRING_TASK_DEFINITION_ROW = {
  id: "wfd_recurring",
  tenantId: "ten_1",
  status: "deployed" as const,
  assetId: "ast_recurring",
  name: RECURRING_TASK_ASSET_NAME,
};

describe("createHubRoutineLauncher — delivery workbench", () => {
  test("joins the launched run into the routine's delivery workbench so the orchestrator posts its replies there", async () => {
    launchFoldedRunCalls = [];
    joinDeliveryWorkbenchCalls = [];

    const result = await buildLauncher().launchRoutineRun({
      ...baseInput({}),
      deliveryWorkbenchId: "chn_delivery",
      routineName: "Daily GTM digest",
    });

    expect(joinDeliveryWorkbenchCalls).toEqual([
      {
        tenantId: "ten_1",
        workbenchId: "chn_delivery",
        principalId: "usr_1",
        address: `${result.runId}@acme.workbench.test`,
        handle: "daily-gtm-digest",
      },
    ]);
  });

  test("joins nothing when the routine has no delivery workbench", async () => {
    joinDeliveryWorkbenchCalls = [];
    await buildLauncher().launchRoutineRun(baseInput({}));
    expect(joinDeliveryWorkbenchCalls).toHaveLength(0);
  });

  test("a join failure never un-launches or hides the run", async () => {
    const launcher = createHubRoutineLauncher({
      joinDeliveryWorkbench: async () => {
        throw new Error("settings write failed");
      },
      db: createFakeDb() as never,
      sessionService: {} as never,
      assetService: {} as never,
      sidecarRouter: {} as never,
      hubPublicKey: "hub-key",
      toolGrantsForPins: () => [],
      runHubGrants: noopRunHubGrants,
      eventCollectors: {} as never,
      cryptoProviderCache: { get: async () => ({}) as never },
      dispatchTask: dispatchTask as never,
    });
    const result = await launcher.launchRoutineRun({
      ...baseInput({}),
      deliveryWorkbenchId: "chn_delivery",
    });
    expect(result.runId).toBeTruthy();
  });
});

describe("createHubRoutineLauncher — recurring-task bridge", () => {
  test("dispatches through dispatchTask instead of launching its own folded run", async () => {
    launchFoldedRunCalls = [];
    dispatchTaskCalls = [];
    dispatchTaskShouldThrow = null;
    dispatchTaskResult = { runId: "wfr_task1" };

    const result = await createHubRoutineLauncher({
      joinDeliveryWorkbench: async () => {},
      db: createFakeDb({ definition: RECURRING_TASK_DEFINITION_ROW }) as never,
      sessionService: {} as never,
      assetService: {} as never,
      sidecarRouter: {} as never,
      hubPublicKey: "hub-key",
      toolGrantsForPins: () => [],
      runHubGrants: noopRunHubGrants,
      eventCollectors: {} as never,
      cryptoProviderCache: { get: async () => ({}) as never },
      dispatchTask: dispatchTask as never,
    }).launchRoutineRun(
      baseInput({
        agent: "wfd_summarizer",
        prompt: "Summarize last night's incidents",
      }),
    );

    expect(result.runId).toBe("wfr_task1");
    // The placeholder definition's own folded run is never launched —
    // the whole point of the bridge is to skip it.
    expect(launchFoldedRunCalls).toHaveLength(0);
    expect(dispatchTaskCalls).toEqual([
      {
        tenantId: "ten_1",
        principalId: "usr_1",
        definitionId: "wfd_summarizer",
        prompt: "Summarize last night's incidents",
      },
    ]);
  });

  test("a deleted/unknown agent fails the routine run honestly, propagating dispatchTask's own error", async () => {
    dispatchTaskCalls = [];
    dispatchTaskShouldThrow = new Error(
      'No definition "wfd_deleted" for this tenant',
    );

    const launcher = createHubRoutineLauncher({
      joinDeliveryWorkbench: async () => {},
      db: createFakeDb({ definition: RECURRING_TASK_DEFINITION_ROW }) as never,
      sessionService: {} as never,
      assetService: {} as never,
      sidecarRouter: {} as never,
      hubPublicKey: "hub-key",
      toolGrantsForPins: () => [],
      runHubGrants: noopRunHubGrants,
      eventCollectors: {} as never,
      cryptoProviderCache: { get: async () => ({}) as never },
      dispatchTask: dispatchTask as never,
    });

    await expect(
      launcher.launchRoutineRun(
        baseInput({ agent: "wfd_deleted", prompt: "Do the thing" }),
      ),
    ).rejects.toThrow('No definition "wfd_deleted" for this tenant');

    dispatchTaskShouldThrow = null;
  });

  test("behaves the same whether the agent id is a manually-created or planner-created (myra-task-*) definition — no shape validation beyond non-empty", async () => {
    dispatchTaskCalls = [];
    dispatchTaskShouldThrow = null;
    dispatchTaskResult = { runId: "wfr_task2" };

    const result = await createHubRoutineLauncher({
      joinDeliveryWorkbench: async () => {},
      db: createFakeDb({ definition: RECURRING_TASK_DEFINITION_ROW }) as never,
      sessionService: {} as never,
      assetService: {} as never,
      sidecarRouter: {} as never,
      hubPublicKey: "hub-key",
      toolGrantsForPins: () => [],
      runHubGrants: noopRunHubGrants,
      eventCollectors: {} as never,
      cryptoProviderCache: { get: async () => ({}) as never },
      dispatchTask: dispatchTask as never,
    }).launchRoutineRun(
      baseInput({
        agent: "myra-task-a1b2c3",
        prompt: "Draft the weekly digest",
      }),
    );

    expect(result.runId).toBe("wfr_task2");
    expect(dispatchTaskCalls).toEqual([
      {
        tenantId: "ten_1",
        principalId: "usr_1",
        definitionId: "myra-task-a1b2c3",
        prompt: "Draft the weekly digest",
      },
    ]);
  });

  test("refuses to dispatch when the stored input is missing its agent field", async () => {
    dispatchTaskCalls = [];

    const launcher = createHubRoutineLauncher({
      joinDeliveryWorkbench: async () => {},
      db: createFakeDb({ definition: RECURRING_TASK_DEFINITION_ROW }) as never,
      sessionService: {} as never,
      assetService: {} as never,
      sidecarRouter: {} as never,
      hubPublicKey: "hub-key",
      toolGrantsForPins: () => [],
      runHubGrants: noopRunHubGrants,
      eventCollectors: {} as never,
      cryptoProviderCache: { get: async () => ({}) as never },
      dispatchTask: dispatchTask as never,
    });

    await expect(
      launcher.launchRoutineRun(baseInput({ prompt: "Do the thing" })),
    ).rejects.toThrow(/agent/);
    expect(dispatchTaskCalls).toHaveLength(0);
  });

  test("refuses to dispatch when the stored input is missing its prompt field", async () => {
    dispatchTaskCalls = [];

    const launcher = createHubRoutineLauncher({
      joinDeliveryWorkbench: async () => {},
      db: createFakeDb({ definition: RECURRING_TASK_DEFINITION_ROW }) as never,
      sessionService: {} as never,
      assetService: {} as never,
      sidecarRouter: {} as never,
      hubPublicKey: "hub-key",
      toolGrantsForPins: () => [],
      runHubGrants: noopRunHubGrants,
      eventCollectors: {} as never,
      cryptoProviderCache: { get: async () => ({}) as never },
      dispatchTask: dispatchTask as never,
    });

    await expect(
      launcher.launchRoutineRun(baseInput({ agent: "wfd_summarizer" })),
    ).rejects.toThrow(/prompt/);
    expect(dispatchTaskCalls).toHaveLength(0);
  });
  // A scheduled routine has no human in the loop, so the routine's own
  // caller — its creator on the scheduled path — is the invoker the run is
  // bounded by. Without it a routine run would carry no relationship to
  // anyone and could reach further than whoever set it up.
  test("launches bounded by the principal who asked for the run", async () => {
    launchFoldedRunCalls = [];

    await buildLauncher().launchRoutineRun(baseInput({}));

    const [, params] = launchFoldedRunCalls[0] as [
      unknown,
      { invokerPrincipalId: string },
    ];
    expect(params.invokerPrincipalId).toBe("usr_1");
  });
});
