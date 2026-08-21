// Proves the gap CL-6038 closes: a routine's stored `input` (the
// stepper-collected topic/focus a routine's creator recorded) reaches
// the launched run as its first-turn mail, via the same
// `sendFoldedMailWithRetry` seam every other folded-run first message
// goes through — and that a delivery failure past launch never un-does
// or hides the already-real run. `@corbits/folded-runs` is real here
// except for `launchFoldedRun`/`sendFoldedMailWithRetry`/
// `readDefinitionProjection`, which would otherwise need a real tenant catalog
// and asset store — the same "swap the one export that needs a join"
// approach `packages/folded-runs/test/launch.test.ts` and
// `packages/webhook-triggers/test/launch.test.ts` use.
import { describe, expect, mock, test } from "bun:test";
import { CHAT_TURN_TIMEOUT_MS } from "@corbits/chat";
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

// "single" mirrors every shipped routine today (readFoldedBody
// succeeds); "multi" simulates a code-sourced, multi-step definition —
// readFoldedBody always throws for one of these, by construction (see
// packages/folded-runs/src/definition.ts) — so the launcher's own
// try/catch routing is what these tests exercise, not a fake that
// picks its own outcome.
let foldedBodyMode: "single" | "multi" = "single";

mock.module("@corbits/folded-runs", () => ({
  ...actualFoldedRuns,
  readDefinitionProjection: async () => ({ __fake: true }),
  readFoldedBody: (_projection: unknown, _grantRequirements: unknown) => {
    if (foldedBodyMode === "multi") {
      throw new actualFoldedRuns.MultiStepFoldUnsupportedError("wfd_1", 3);
    }
    return FOLDED_BODY;
  },
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

// The multi-step native trigger is exercised for real here (not
// mocked): `mock.module` replaces a module process-wide, and this
// file's own `./native-workflow-routine-launch.test.ts` sibling needs
// the genuine export it would otherwise shadow for the whole bun test
// process. A fake db/sidecarRouter (below) is enough to drive it.
const { createHubRoutineLauncher } = await import("./routine-launcher");

const NATIVE_ANCHOR_ROW = {
  id: "wfr_native1",
  address: "wfr_native1@acme.workbench.test",
  status: "deployed" as const,
};

let routeMailCalls: unknown[] = [];
let routeMailShouldDeliver = true;

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
    // Drives `triggerNativeWorkflowRoutineRun`'s real anchor-run
    // lookup for the multi-step tests below — see that module's own
    // test file for coverage of its query shape in isolation.
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => [NATIVE_ANCHOR_ROW],
          }),
        }),
      }),
    }),
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
    sidecarRouter: {
      routeMail: (address: string, base64: string, messageId: string) => {
        routeMailCalls.push({ address, base64, messageId });
        return routeMailShouldDeliver;
      },
    } as never,
    toolGrantsForPins: () => [],
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

  // CL-6367: a routine-driven run with no stable-id -> current-run
  // mapping could never be relaunched after its sidecar died — chat's
  // terminal sweep and wake path both resolve through that mapping.
  test("launches as an onTrigger section and persists the relaunch mapping with the run", async () => {
    launchFoldedRunCalls = [];
    sendFoldedMailWithRetryCalls = [];

    const result = await buildLauncher().launchRoutineRun(baseInput({}));

    const [, params] = launchFoldedRunCalls[0] as [
      unknown,
      {
        mode: unknown;
        persistExtra: (tx: unknown) => Promise<void>;
      },
    ];
    expect(params.mode).toEqual({
      kind: "section",
      turnTimeoutMs: CHAT_TURN_TIMEOUT_MS,
    });

    const written: { values: unknown }[] = [];
    await params.persistExtra({
      insert: () => ({
        values: async (values: unknown) => {
          written.push({ values });
        },
      }),
    } as never);
    expect(written).toHaveLength(1);
    expect(written[0]?.values).toMatchObject({
      tenantId: "ten_1",
      instanceId: result.runId,
      currentRunId: result.runId,
      foldedBody: FOLDED_BODY,
    });
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
      toolGrantsForPins: () => [],
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
      toolGrantsForPins: () => [],
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
      toolGrantsForPins: () => [],
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
      toolGrantsForPins: () => [],
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
      toolGrantsForPins: () => [],
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
      toolGrantsForPins: () => [],
      eventCollectors: {} as never,
      cryptoProviderCache: { get: async () => ({}) as never },
      dispatchTask: dispatchTask as never,
    });

    await expect(
      launcher.launchRoutineRun(baseInput({ agent: "wfd_summarizer" })),
    ).rejects.toThrow(/prompt/);
    expect(dispatchTaskCalls).toHaveLength(0);
  });
});

describe("createHubRoutineLauncher — multi-step native routing", () => {
  test("routes a multi-step definition onto the native trigger instead of the folded launcher", async () => {
    foldedBodyMode = "multi";
    launchFoldedRunCalls = [];
    routeMailCalls = [];
    routeMailShouldDeliver = true;

    const result = await buildLauncher().launchRoutineRun(
      baseInput({ topic: "AI coding agents" }),
    );

    expect(result).toEqual({ runId: NATIVE_ANCHOR_ROW.id });
    // The folded launcher never runs for a multi-step definition — no
    // coexisting path silently folds it to one step.
    expect(launchFoldedRunCalls).toHaveLength(0);
    expect(routeMailCalls).toHaveLength(1);

    const [call] = routeMailCalls as [
      { address: string; base64: string; messageId: string },
    ];
    expect(call.address).toBe(NATIVE_ANCHOR_ROW.address);
    expect(Buffer.from(call.base64, "base64").toString("utf-8")).toContain(
      "AI coding agents",
    );

    foldedBodyMode = "single";
  });

  test("still fires the native trigger when the routine stored no input, rather than launching nothing", async () => {
    foldedBodyMode = "multi";
    routeMailCalls = [];
    routeMailShouldDeliver = true;

    const result = await buildLauncher().launchRoutineRun(baseInput({}));

    expect(result).toEqual({ runId: NATIVE_ANCHOR_ROW.id });
    expect(routeMailCalls).toHaveLength(1);

    foldedBodyMode = "single";
  });

  test("joins the delivery workbench using the native deployment's own address", async () => {
    foldedBodyMode = "multi";
    routeMailShouldDeliver = true;
    joinDeliveryWorkbenchCalls = [];

    await buildLauncher().launchRoutineRun({
      ...baseInput({}),
      deliveryWorkbenchId: "chn_delivery",
      routineName: "Native pipeline",
    });

    expect(joinDeliveryWorkbenchCalls).toEqual([
      {
        tenantId: "ten_1",
        workbenchId: "chn_delivery",
        principalId: "usr_1",
        address: NATIVE_ANCHOR_ROW.address,
        handle: "native-pipeline",
      },
    ]);

    foldedBodyMode = "single";
  });

  test("throws when the multi-step definition has no live native deployment, rather than launching nothing", async () => {
    foldedBodyMode = "multi";

    const { NativeWorkflowDeploymentMissingError } =
      await import("./native-workflow-routine-launch");
    const launcher = createHubRoutineLauncher({
      joinDeliveryWorkbench: async () => {},
      db: {
        query: {
          workflowDefinition: { findFirst: async () => DEFINITION_ROW },
          tenant: { findFirst: async () => TENANT_ROW },
        },
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({ limit: async () => [] }),
            }),
          }),
        }),
      } as never,
      sessionService: {} as never,
      assetService: {} as never,
      sidecarRouter: { routeMail: () => true } as never,
      toolGrantsForPins: () => [],
      eventCollectors: {} as never,
      cryptoProviderCache: { get: async () => ({}) as never },
      dispatchTask: dispatchTask as never,
    });

    await expect(launcher.launchRoutineRun(baseInput({}))).rejects.toThrow(
      NativeWorkflowDeploymentMissingError,
    );

    foldedBodyMode = "single";
  });
});
