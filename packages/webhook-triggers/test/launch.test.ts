// Proves `launchWebhookTrigger`'s post-launch mail send is hardened the
// same way `apps/hub/src/routine-launcher.test.ts` proves its own copy
// of this shape: a delivery already accepted has already committed a
// real run, so an exhausted `sendFoldedMailWithRetry` must not throw
// past this function (or `createWebhookIngressRoutes` would reject an
// already-launched delivery, and a retried webhook client would then
// mint a duplicate run for the same event).
import { describe, expect, mock, test } from "bun:test";

const actualFoldedRuns = await import("@corbits/folded-runs");

const FOLDED_BODY = {
  systemPrompt: "you are a webhook-triggered agent",
  toolPackagePins: [],
  grantRequirements: [],
  credentialBindings: [],
  model: "claude-sonnet-5",
};

let launchFoldedRunCalls: unknown[] = [];
let sendFoldedMailWithRetryCalls: unknown[] = [];
let sendFoldedMailWithRetryResult: unknown = { ok: true, mail: { id: "m_1" } };

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
}));

const { launchWebhookTrigger } = await import("../src/launch");

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

function createFakeDb() {
  return {
    query: {
      workflowDefinition: { findFirst: async () => DEFINITION_ROW },
      tenant: { findFirst: async () => TENANT_ROW },
    },
  };
}

const TRIGGER = {
  id: "wht_1",
  tenantId: "ten_1",
  name: "Deploy hook",
  workflowDefinitionId: "wfd_1",
  inputTemplate: "deployed: {{status}}",
  secret: "shh",
  enabled: true,
  createdBy: "usr_1",
  createdAt: new Date(),
  lastFiredAt: null,
};

function baseDeps() {
  return {
    db: createFakeDb() as never,
    sessionService: {} as never,
    assetService: {} as never,
    sidecarRouter: {} as never,
    hubPublicKey: "hub-key",
    eventCollectors: {} as never,
    cryptoProviderCache: { get: async () => ({}) as never },
  };
}

describe("launchWebhookTrigger", () => {
  test("still returns the launched run when input delivery fails after every retry", async () => {
    launchFoldedRunCalls = [];
    sendFoldedMailWithRetryCalls = [];
    sendFoldedMailWithRetryResult = {
      ok: false,
      error: new Error("sidecar unreachable"),
      attempts: 3,
    };

    const result = await launchWebhookTrigger(baseDeps(), TRIGGER, {
      status: "ok",
    });

    expect(result.instanceId).toBeTruthy();
    expect(result.triggerAddress).toContain(result.instanceId);
    expect(launchFoldedRunCalls).toHaveLength(1);
    expect(sendFoldedMailWithRetryCalls).toHaveLength(1);
  });

  test("returns the launched run normally when delivery succeeds", async () => {
    launchFoldedRunCalls = [];
    sendFoldedMailWithRetryCalls = [];
    sendFoldedMailWithRetryResult = { ok: true, mail: { id: "m_1" } };

    const result = await launchWebhookTrigger(baseDeps(), TRIGGER, {
      status: "ok",
    });

    expect(result.instanceId).toBeTruthy();
    expect(sendFoldedMailWithRetryCalls).toHaveLength(1);
    const [, params] = sendFoldedMailWithRetryCalls[0] as [
      unknown,
      { content: string; sessionId: string },
    ];
    expect(params.content).toBe("deployed: ok");
    expect(params.sessionId).toBe("ses_run1");
  });
});
