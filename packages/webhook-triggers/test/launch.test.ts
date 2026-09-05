// Proves `launchWebhookTrigger` provisions through Interchange and
// hardens the opening-mail send: a delivery already accepted has
// already committed a real run, so a failed `sendUserMessage` must not
// throw past this function (or `createWebhookIngressRoutes` would
// reject an already-launched delivery, and a retried webhook client
// would then mint a duplicate run for the same event).
import { describe, expect, mock, test } from "bun:test";
import { AGENT_RUNTIME_ENTRY_PATH } from "@corbits/agent-runtime";
import { DEFAULT_ASSET_REF } from "@intx/hub-sessions";

const actualDb = await import("@intx/db");

const INERT_PROJECTION = {
  id: "wfd_1",
  stepOrder: ["host"],
  steps: {
    host: {
      kind: "step",
      agent: {
        systemPrompt: "you are a webhook-triggered agent",
        toolPackagePins: [],
        modelSources: [{ provider: "anthropic", model: "claude-sonnet-5" }],
      },
    },
  },
  credentialBindings: [],
};

const EXPECTED_FOLDED_BODY = {
  systemPrompt: "you are a webhook-triggered agent",
  toolPackagePins: [],
  grantRequirements: [],
  credentialBindings: [],
  model: "claude-sonnet-5",
};

const DEFAULT_VISIBLE_OFFERINGS = [
  {
    offering: { id: "off_1", priority: 0 },
    model: { canonicalName: "claude-sonnet-5" },
    provider: { name: "anthropic" },
  },
  {
    offering: { id: "off_2", priority: 10 },
    model: { canonicalName: "ignored-lower" },
    provider: { name: "other" },
  },
];

let visibleOfferings: typeof DEFAULT_VISIBLE_OFFERINGS = [
  ...DEFAULT_VISIBLE_OFFERINGS,
];
let frozenProjection: unknown = INERT_PROJECTION;

mock.module("@intx/db", () => ({
  ...actualDb,
  listVisibleOfferings: async () => visibleOfferings,
  loadFrozenWireProjection: async () => frozenProjection,
}));

let reportErrorCalls: unknown[] = [];

mock.module("@corbits/error-sink", () => ({
  reportError: (...args: unknown[]) => {
    reportErrorCalls.push(args);
    return "ref_test";
  },
}));

const { launchWebhookTrigger } = await import("../src/launch");

const DEFINITION_ROW = {
  id: "wfd_1",
  name: "webhook agent",
  tenantId: "ten_1",
  status: "deployed" as const,
  assetId: "ast_1",
  grantRequirements: [],
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

const taggedCipher = {
  encrypt: async (plaintext: string) => plaintext,
  decrypt: async (blob: string) => blob,
};

const INTERCHANGE_RUN_ID = "wfr_interchange";
const INTERCHANGE_ADDRESS = `${INTERCHANGE_RUN_ID}@${TENANT_ROW.domain}`;
const COMMIT_SHA = "sha_rendered";

type PrepareArgs = {
  readonly tenantId: string;
  readonly anchorRunId: string;
  readonly sessionId: string;
  readonly deploymentDomain: string;
  readonly source: unknown;
  readonly entry: string;
  readonly definitionAssetId: string;
  readonly sourceAuthorityPrincipalId: string;
  readonly sourceOfferingIds: readonly string[];
  readonly defaultSourceOfferingId: string;
  readonly deployContent: unknown;
  readonly toolPackagePins?: readonly unknown[];
};

let persistLaunchCalls: unknown[] = [];
let recordLaunchSourcesCalls: unknown[] = [];
let populateAssetCalls: unknown[] = [];
let prepareCalls: PrepareArgs[] = [];
let sendUserMessageCalls: unknown[] = [];
let sendUserMessageImpl: () => Promise<Uint8Array> = async () =>
  new Uint8Array([1]);
let cryptoGetKeys: string[] = [];

function baseDeps() {
  return {
    db: createFakeDb() as never,
    credentialCipher: taggedCipher,
    cryptoProviderCache: {
      get: async (key: string) => {
        cryptoGetKeys.push(key);
        return {} as never;
      },
    },
    launchMode: { kind: "section" as const, turnTimeoutMs: 60_000 },
    persistLaunch: async (input: unknown) => {
      persistLaunchCalls.push(input);
    },
    recordLaunchSources: async (input: unknown) => {
      recordLaunchSourcesCalls.push(input);
    },
    assetService: {
      populateAsset: async (args: unknown) => {
        populateAssetCalls.push(args);
        return { commitSha: COMMIT_SHA };
      },
    },
    workflowAllocationService: {
      prepareProvisionedDeployment: async (args: PrepareArgs) => {
        prepareCalls.push(args);
        return {
          anchorRunId: INTERCHANGE_RUN_ID,
          deploymentAddress: INTERCHANGE_ADDRESS,
          allocationId: "sal_1",
          status: "pending" as const,
        };
      },
    },
    sessionService: {
      sendUserMessage: async (args: unknown) => {
        sendUserMessageCalls.push(args);
        return sendUserMessageImpl();
      },
    },
  };
}

function resetLaunchSpies() {
  persistLaunchCalls = [];
  recordLaunchSourcesCalls = [];
  populateAssetCalls = [];
  prepareCalls = [];
  sendUserMessageCalls = [];
  cryptoGetKeys = [];
  reportErrorCalls = [];
  visibleOfferings = [...DEFAULT_VISIBLE_OFFERINGS];
  frozenProjection = INERT_PROJECTION;
  sendUserMessageImpl = async () => new Uint8Array([1]);
}

describe("launchWebhookTrigger", () => {
  test("still returns the Interchange run when input delivery fails after prepare", async () => {
    resetLaunchSpies();
    const deliveryError = new Error("sidecar unreachable");
    sendUserMessageImpl = async () => {
      throw deliveryError;
    };

    const result = await launchWebhookTrigger(baseDeps(), TRIGGER, {
      status: "ok",
    });

    expect(result).toEqual({
      instanceId: INTERCHANGE_RUN_ID,
      triggerAddress: INTERCHANGE_ADDRESS,
    });
    expect(prepareCalls).toHaveLength(1);
    expect(populateAssetCalls).toHaveLength(1);
    expect(sendUserMessageCalls).toHaveLength(1);
  });

  test("reports the delivery failure with the run's context", async () => {
    resetLaunchSpies();
    const deliveryError = new Error("sidecar unreachable");
    sendUserMessageImpl = async () => {
      throw deliveryError;
    };

    const result = await launchWebhookTrigger(baseDeps(), TRIGGER, {
      status: "ok",
    });

    expect(reportErrorCalls).toHaveLength(1);
    const [cause, context] = reportErrorCalls[0] as [
      unknown,
      {
        operation: string;
        tenantId: string;
        agentId: string;
        extra: Record<string, unknown>;
      },
    ];
    expect(cause).toBe(deliveryError);
    expect(context.operation).toBe("webhookTriggers.launch.deliverInput");
    expect(context.tenantId).toBe(TRIGGER.tenantId);
    expect(context.agentId).toBe(result.triggerAddress);
    expect(context.extra).toEqual({
      instanceId: result.instanceId,
      triggerId: TRIGGER.id,
    });
  });

  test("does not report anything when delivery succeeds", async () => {
    resetLaunchSpies();

    await launchWebhookTrigger(baseDeps(), TRIGGER, { status: "ok" });

    expect(reportErrorCalls).toHaveLength(0);
  });

  test("returns the Interchange run normally when delivery succeeds", async () => {
    resetLaunchSpies();

    const result = await launchWebhookTrigger(baseDeps(), TRIGGER, {
      status: "ok",
    });

    expect(result).toEqual({
      instanceId: INTERCHANGE_RUN_ID,
      triggerAddress: INTERCHANGE_ADDRESS,
    });
    expect(sendUserMessageCalls).toHaveLength(1);
    const params = sendUserMessageCalls[0] as {
      content: string;
      sessionId: string;
      from: string;
      agentAddress: string;
    };
    const preparedArgs = prepareCalls[0];
    if (preparedArgs === undefined) {
      throw new Error("expected prepareProvisionedDeployment to be called");
    }
    expect(params.content).toBe("deployed: ok");
    expect(params.sessionId).toBe(preparedArgs.sessionId);
    expect(params.from).toBe(`webhook-trigger:${TRIGGER.id}`);
    expect(params.agentAddress).toBe(INTERCHANGE_ADDRESS);
  });

  test("populates the definition asset and prepares through Interchange", async () => {
    resetLaunchSpies();

    await launchWebhookTrigger(baseDeps(), TRIGGER, { status: "ok" });

    expect(populateAssetCalls).toHaveLength(1);
    const populate = populateAssetCalls[0] as {
      assetId: string;
      ref: string;
      principal: { kind: string };
    };
    expect(populate.assetId).toBe(DEFINITION_ROW.assetId);
    expect(populate.ref).toBe(DEFAULT_ASSET_REF);
    expect(populate.principal).toEqual({ kind: "hub" });

    expect(prepareCalls).toHaveLength(1);
    expect(prepareCalls[0]).toMatchObject({
      tenantId: TRIGGER.tenantId,
      deploymentDomain: TENANT_ROW.domain,
      entry: AGENT_RUNTIME_ENTRY_PATH,
      definitionAssetId: DEFINITION_ROW.assetId,
      sourceAuthorityPrincipalId: TRIGGER.createdBy,
      sourceOfferingIds: ["off_1", "off_2"],
      defaultSourceOfferingId: "off_1",
      deployContent: { systemPrompt: "" },
      source: {
        kind: "asset",
        assetId: DEFINITION_ROW.assetId,
        package: { format: "source", commitSha: COMMIT_SHA },
      },
    });
    expect(prepareCalls[0]?.toolPackagePins).toBeUndefined();
  });

  test("persists the relaunch mapping against Interchange's returned run id", async () => {
    resetLaunchSpies();

    const result = await launchWebhookTrigger(baseDeps(), TRIGGER, {
      status: "ok",
    });

    expect(persistLaunchCalls).toEqual([
      {
        tenantId: "ten_1",
        instanceId: INTERCHANGE_RUN_ID,
        foldedBody: EXPECTED_FOLDED_BODY,
      },
    ]);
    expect(recordLaunchSourcesCalls).toEqual([
      { instanceId: INTERCHANGE_RUN_ID, sourcesDigest: "off_1\0off_2" },
    ]);
    expect(result.instanceId).toBe(INTERCHANGE_RUN_ID);
    expect(cryptoGetKeys).toEqual([INTERCHANGE_RUN_ID]);
  });
});
