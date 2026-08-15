// Proves the gap CL-6038 closes: a routine's stored `input` (the
// stepper-collected topic/focus a routine's creator recorded) reaches
// the launched run as its first-turn mail, via the same `sendFoldedMail`
// seam every other folded-run first message goes through. `@corbits/folded-runs`
// is real here except for `launchFoldedRun`/`sendFoldedMail`/
// `readDefinitionJSON`, which would otherwise need a real tenant catalog
// and asset store — the same "swap the one export that needs a join"
// approach `packages/folded-runs/test/launch.test.ts` and
// `packages/webhook-triggers/src/launch.test.ts` use.
import { describe, expect, mock, test } from "bun:test";

const actualFoldedRuns = await import("@corbits/folded-runs");

const FOLDED_BODY = {
  systemPrompt: "you are a routine agent",
  toolPackagePins: [],
  grantRequirements: [],
  credentialBindings: [],
  model: "claude-sonnet-5",
};

let launchFoldedRunCalls: unknown[] = [];
let sendFoldedMailCalls: unknown[] = [];

mock.module("@corbits/folded-runs", () => ({
  ...actualFoldedRuns,
  readDefinitionJSON: async () => ({ __fake: true }),
  readFoldedBody: () => FOLDED_BODY,
  launchFoldedRun: async (...args: unknown[]) => {
    launchFoldedRunCalls.push(args);
    return { instancePrincipalId: "prn_run1", sessionId: "ses_run1" };
  },
  sendFoldedMail: async (...args: unknown[]) => {
    sendFoldedMailCalls.push(args);
    return { id: crypto.randomUUID(), createdAt: new Date().toISOString() };
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

describe("createHubRoutineLauncher", () => {
  test("threads the routine's stored input into the run's first-turn mail", async () => {
    launchFoldedRunCalls = [];
    sendFoldedMailCalls = [];

    const launcher = createHubRoutineLauncher({
      db: createFakeDb() as never,
      sessionService: {} as never,
      assetService: {} as never,
      sidecarRouter: {} as never,
      eventCollectors: {} as never,
      cryptoProviderCache: { get: async () => ({}) as never },
    });

    const result = await launcher.launchRoutineRun(
      baseInput({ topic: "AI coding agents", focus: "Competing launches" }),
    );

    expect(result.runId).toBeTruthy();
    expect(launchFoldedRunCalls).toHaveLength(1);
    expect(sendFoldedMailCalls).toHaveLength(1);

    const [, params] = sendFoldedMailCalls[0] as [
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
      "topic: AI coding agents\nfocus: Competing launches",
    );
  });

  test("sends no mail when the routine's stored input is empty", async () => {
    launchFoldedRunCalls = [];
    sendFoldedMailCalls = [];

    const launcher = createHubRoutineLauncher({
      db: createFakeDb() as never,
      sessionService: {} as never,
      assetService: {} as never,
      sidecarRouter: {} as never,
      eventCollectors: {} as never,
      cryptoProviderCache: { get: async () => ({}) as never },
    });

    const result = await launcher.launchRoutineRun(baseInput({}));

    expect(result.runId).toBeTruthy();
    expect(launchFoldedRunCalls).toHaveLength(1);
    expect(sendFoldedMailCalls).toHaveLength(0);
  });
});
