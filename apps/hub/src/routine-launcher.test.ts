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

function buildLauncher() {
  return createHubRoutineLauncher({
    db: createFakeDb() as never,
    sessionService: {} as never,
    assetService: {} as never,
    sidecarRouter: {} as never,
    eventCollectors: {} as never,
    cryptoProviderCache: { get: async () => ({}) as never },
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
