// Proves `launchWebhookTrigger` provisions through Interchange and
// hardens the opening-mail send: a delivery already accepted has
// already committed a real run, so a failed `routeMail` must not
// throw past this function (or `createWebhookIngressRoutes` would
// reject an already-launched delivery, and a retried webhook client
// would then mint a duplicate run for the same event).
import { describe, expect, mock, test } from "bun:test";
import { WORKFLOW_SOURCE_ENTRY } from "@corbits/workflows";
import { DEFAULT_ASSET_REF } from "@intx/hub-sessions";
import { base64Decode } from "@intx/types";

const actualDb = await import("@intx/db");

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

let visibleOfferings: typeof DEFAULT_VISIBLE_OFFERINGS = [...DEFAULT_VISIBLE_OFFERINGS];

mock.module("@intx/db", () => ({
  ...actualDb,
  listVisibleOfferings: async () => visibleOfferings,
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
      workflowRun: {
        findFirst: async () => ({
          id: INTERCHANGE_RUN_ID,
          tenantId: TENANT_ROW.id,
          definitionId: DEFINITION_ROW.id,
          address: INTERCHANGE_ADDRESS,
          principalId: null,
        }),
      },
    },
    insert: () => ({
      values: () => ({
        onConflictDoNothing: async () => undefined,
      }),
    }),
  };
}

let eventCollectorCreateCalls: unknown[] = [];

function createFakeEventCollectors() {
  return {
    create: (...args: unknown[]) => {
      eventCollectorCreateCalls.push(args);
    },
    has: () => false,
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

type RouteMailCall = {
  readonly address: string;
  readonly base64: string;
  readonly authenticatedSender: string;
  readonly messageId: string;
};

let resolveRefCalls: unknown[] = [];
let prepareCalls: PrepareArgs[] = [];
let routeMailCalls: RouteMailCall[] = [];
let routeMailImpl: () => boolean = () => true;
let cryptoGetKeys: string[] = [];
let isRoutableForTest = true;

function baseDeps() {
  return {
    db: createFakeDb() as never,
    credentialCipher: taggedCipher,
    cryptoProviderCache: {
      get: async (key: string) => {
        cryptoGetKeys.push(key);
        return { sign: async () => new Uint8Array(64) } as never;
      },
    },
    repoStore: {
      resolveRef: async (...args: unknown[]) => {
        resolveRefCalls.push(args);
        return COMMIT_SHA;
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
    sidecarRouter: {
      routeMail: (
        address: string,
        base64: string,
        authenticatedSender: string,
        messageId?: string,
      ) => {
        routeMailCalls.push({ address, base64, authenticatedSender, messageId: messageId ?? "" });
        return routeMailImpl();
      },
    },
    isRoutable: () => isRoutableForTest,
    eventCollectors: createFakeEventCollectors(),
  };
}

function resetLaunchSpies() {
  resolveRefCalls = [];
  prepareCalls = [];
  routeMailCalls = [];
  cryptoGetKeys = [];
  reportErrorCalls = [];
  eventCollectorCreateCalls = [];
  visibleOfferings = [...DEFAULT_VISIBLE_OFFERINGS];
  routeMailImpl = () => true;
  isRoutableForTest = true;
}

function decodedContent(call: RouteMailCall): string {
  return new TextDecoder().decode(base64Decode(call.base64));
}

describe("launchWebhookTrigger", () => {
  test("still returns the Interchange run when input delivery fails after prepare", async () => {
    resetLaunchSpies();
    routeMailImpl = () => false;

    const result = await launchWebhookTrigger(baseDeps(), TRIGGER, {
      status: "ok",
    });

    expect(result).toEqual({
      instanceId: INTERCHANGE_RUN_ID,
      triggerAddress: INTERCHANGE_ADDRESS,
    });
    expect(prepareCalls).toHaveLength(1);
    expect(resolveRefCalls).toHaveLength(1);
    // isRoutable defaults true in this fixture, so the unreachable send
    // is retried once per `deliverWhenRoutable`'s contract before the
    // failure is reported.
    expect(routeMailCalls).toHaveLength(2);
  });

  // CL-7476: a freshly provisioned run's sidecar takes several seconds to
  // boot and register with the hub. The opening mail can land in that
  // gap and fail "agent is unreachable" even though the run deployed
  // fine — `deliverWhenRoutable` must retry once the address becomes
  // routable rather than dropping the mail for good.
  test("retries the opening mail once the freshly provisioned run becomes routable", async () => {
    resetLaunchSpies();
    isRoutableForTest = false;
    let sendAttempts = 0;
    routeMailImpl = () => {
      sendAttempts += 1;
      return sendAttempts !== 1;
    };

    const deps = baseDeps();
    const sendPromise = launchWebhookTrigger(deps, TRIGGER, { status: "ok" });

    await new Promise((resolve) => setTimeout(resolve, 10));
    isRoutableForTest = true;

    const result = await sendPromise;

    expect(result).toEqual({
      instanceId: INTERCHANGE_RUN_ID,
      triggerAddress: INTERCHANGE_ADDRESS,
    });
    expect(routeMailCalls).toHaveLength(2);
    expect(reportErrorCalls).toHaveLength(0);
  });

  test("reports the delivery failure with the run's context", async () => {
    resetLaunchSpies();
    routeMailImpl = () => false;

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
    expect(cause).toBeInstanceOf(Error);
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
    expect(routeMailCalls).toHaveLength(1);
    const call = routeMailCalls[0];
    if (call === undefined) {
      throw new Error("expected routeMail to be called");
    }
    const preparedArgs = prepareCalls[0];
    if (preparedArgs === undefined) {
      throw new Error("expected prepareProvisionedDeployment to be called");
    }
    expect(decodedContent(call)).toContain("deployed: ok");
    expect(call.authenticatedSender).toBe(`webhook-trigger:${TRIGGER.id}`);
    expect(call.address).toBe(INTERCHANGE_ADDRESS);
  });

  test("resolves the definition asset HEAD and prepares through Interchange", async () => {
    resetLaunchSpies();

    await launchWebhookTrigger(baseDeps(), TRIGGER, { status: "ok" });

    expect(resolveRefCalls).toEqual([
      [{ kind: "hub" }, { kind: "workflow", id: DEFINITION_ROW.assetId }, DEFAULT_ASSET_REF],
    ]);

    expect(prepareCalls).toHaveLength(1);
    expect(prepareCalls[0]).toMatchObject({
      tenantId: TRIGGER.tenantId,
      deploymentDomain: TENANT_ROW.domain,
      entry: WORKFLOW_SOURCE_ENTRY,
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

  // CL-6534 part 1: a webhook delivery is a one-off native run — the
  // native `workflow_run` row Interchange commits answers identity, so
  // launch provisions it and delivers the opening mail with no
  // `workbench_launch` mirror write (the deps surface no longer carries
  // `persistLaunch`/`recordLaunchSources` at all).
  test("provisions the native run with no workbench_launch mirror write", async () => {
    resetLaunchSpies();

    const result = await launchWebhookTrigger(baseDeps(), TRIGGER, {
      status: "ok",
    });

    expect(result.instanceId).toBe(INTERCHANGE_RUN_ID);
    expect(prepareCalls).toHaveLength(1);
    expect(routeMailCalls).toHaveLength(1);
    expect(cryptoGetKeys).toEqual([INTERCHANGE_RUN_ID]);
  });
});
