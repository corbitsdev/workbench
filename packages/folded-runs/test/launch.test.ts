// Proves `launchFoldedRun`'s own folded-run shape: it resolves
// inference sources against the tenant catalog, writes the same
// principal/session/run rows a folded launch writes (never a
// deployment-shaped run), deploys via `sessionService.deployInstanceAtHead`
// — never `deployWorkflowDefinition` — and rolls the just-committed rows
// back (or marks the run failed-but-routable on a leaked deploy) when the
// deploy fails. `persistExtra` is proven to run inside the same
// transaction as the principal/session/run inserts.
//
// `resolveDefinitionSources` is real catalog resolution (joins across
// several tables via `@intx/db`), which a plain chainable fake `db`
// cannot answer without reimplementing that join. Rather than fake the
// join, this file replaces just that one export of `@intx/hub-api` with
// a controllable stub — spreading through every other export unchanged
// — so a real tenant catalog is never required to prove the wiring.
import { describe, expect, mock, test } from "bun:test";
import { agentSession, principal, workflowRun } from "@intx/db/schema";
import { foldedRun } from "../src/schema";
import { SessionLaunchError } from "@intx/hub-sessions";
import type {
  EventCollectorRegistry,
  SessionService,
} from "@intx/hub-sessions";
import type { DefinitionSourceResolution } from "@intx/hub-api";
import type { FoldedBody } from "@intx/workflow-deploy";

const actualHubApi = await import("@intx/hub-api");

let resolveDefinitionSourcesResult: DefinitionSourceResolution = {
  ok: true,
  sources: [
    {
      id: "off_1",
      provider: "anthropic",
      baseURL: "https://inference.invalid",
      apiKey: "placeholder",
      model: "claude-sonnet-5",
    },
  ],
  defaultSource: "off_1",
};
const resolveDefinitionSourcesCalls: unknown[] = [];

mock.module("@intx/hub-api", () => ({
  ...actualHubApi,
  resolveDefinitionSources: async (...args: unknown[]) => {
    resolveDefinitionSourcesCalls.push(args[0]);
    return resolveDefinitionSourcesResult;
  },
}));

const actualDb = await import("@intx/db");

type BuildCredentialDeliveryResult = Awaited<
  ReturnType<typeof actualDb.buildCredentialDelivery>
>;

let buildCredentialDeliveryResult: BuildCredentialDeliveryResult = {
  ok: true,
  delivery: undefined,
  bindingGrants: [],
};
const buildCredentialDeliveryCalls: unknown[] = [];

mock.module("@intx/db", () => ({
  ...actualDb,
  buildCredentialDelivery: async (...args: unknown[]) => {
    buildCredentialDeliveryCalls.push(args[0]);
    return buildCredentialDeliveryResult;
  },
}));

const { launchFoldedRun, deployAtHead, InferenceResolutionError } =
  await import("../src/launch");
const { wakeFoldedRun } = await import("../src/wake");
const { sessionAsset } = await import("@intx/db/schema");

type InsertChain = {
  values(values: unknown): Promise<void>;
};

function createFakeDb() {
  const inserted: { table: unknown; values: unknown }[] = [];
  const updated: { table: unknown; values: unknown }[] = [];
  const deleted: { table: unknown }[] = [];

  function insertOn(table: unknown): InsertChain {
    return {
      values: async (values: unknown) => {
        inserted.push({ table, values });
      },
    };
  }

  return {
    insert(table: unknown) {
      return insertOn(table);
    },
    update(table: unknown) {
      return {
        set(values: unknown) {
          updated.push({ table, values });
          return { where: async () => undefined };
        },
      };
    },
    delete(table: unknown) {
      deleted.push({ table });
      return { where: async () => undefined };
    },
    async transaction(fn: (tx: unknown) => Promise<void>) {
      await fn({
        insert(table: unknown) {
          return insertOn(table);
        },
        update(table: unknown) {
          return {
            set(values: unknown) {
              updated.push({ table, values });
              return { where: async () => undefined };
            },
          };
        },
        delete(table: unknown) {
          deleted.push({ table });
          return { where: async () => undefined };
        },
      });
    },
    inserted,
    updated,
    deleted,
  };
}

function createFakeEventCollectors(): EventCollectorRegistry & {
  createCalls: unknown[];
  abandonCalls: string[];
} {
  const createCalls: unknown[] = [];
  const abandonCalls: string[] = [];
  return {
    createCalls,
    abandonCalls,
    create(...args: unknown[]) {
      createCalls.push(args);
    },
    abandon(address: string) {
      abandonCalls.push(address);
    },
    has: () => false,
    getStatus: () => undefined,
    getAccumulatedText: () => undefined,
    getCurrentTurnId: () => null,
    getLastTurnId: () => undefined,
    dispatch: () => undefined,
  } as unknown as EventCollectorRegistry & {
    createCalls: unknown[];
    abandonCalls: string[];
  };
}

function createFakeSessionService(): SessionService & {
  deployInstanceAtHeadCalls: unknown[];
} {
  const deployInstanceAtHeadCalls: unknown[] = [];
  return {
    deployInstanceAtHeadCalls,
    async stageWorkflowStep() {},
    async deployInstanceAtHead() {
      throw new Error(
        "deployInstanceAtHead must not be called: a folded run deploys " +
          "an explicit unbounded single-step workflow via deploySingleStepAtHead",
      );
    },
    async deploySingleStepAtHead(params: unknown) {
      deployInstanceAtHeadCalls.push(params);
      return { publicKey: "test-public-key" };
    },
    async deployWorkflowDefinition() {
      throw new Error(
        "deployWorkflowDefinition must not be called: launchFoldedRun " +
          "launches a folded instance via deployInstanceAtHead",
      );
    },
    async sendUserMessage() {
      return new TextEncoder().encode("raw-mime-bytes");
    },
    async endSession() {},
  } as unknown as SessionService & { deployInstanceAtHeadCalls: unknown[] };
}

const FOLDED_BODY: FoldedBody = {
  systemPrompt: "you are a channel host",
  toolPackagePins: [],
  grantRequirements: [],
  credentialBindings: [],
  model: "claude-sonnet-5",
};

describe("launchFoldedRun", () => {
  test("resolves sources, writes the folded run rows, and deploys via deployInstanceAtHead", async () => {
    resolveDefinitionSourcesCalls.length = 0;
    resolveDefinitionSourcesResult = {
      ok: true,
      sources: [
        {
          id: "off_1",
          provider: "anthropic",
          baseURL: "https://inference.invalid",
          apiKey: "placeholder",
          model: "claude-sonnet-5",
        },
      ],
      defaultSource: "off_1",
    };

    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    const eventCollectors = createFakeEventCollectors();
    const persistExtraCalls: unknown[] = [];

    const result = await launchFoldedRun(
      {
        db: db as never,
        sessionService,
        assetService: {} as never,
        sidecarRouter: {} as never,
        hubPublicKey: "hub-key",
        toolGrantsForPins: () => [],
        eventCollectors,
      },
      {
        tenantId: "ten_1",
        instanceId: "ins_channel1",
        triggerAddress: "ins_channel1@ten1.workbench.test",
        definitionId: "wfd_channel1",
        foldedBody: FOLDED_BODY,
        launchLabel: "the channel host",
        persistExtra: async (tx) => {
          persistExtraCalls.push(tx);
        },
      },
    );

    expect(result.sessionId).toBeTruthy();
    expect(result.instancePrincipalId).toBeTruthy();

    // `persistExtra` ran inside the same transaction handle the
    // principal/session/run inserts used.
    expect(persistExtraCalls).toHaveLength(1);

    expect(eventCollectors.createCalls).toEqual([
      [
        "ins_channel1@ten1.workbench.test",
        "ten_1",
        result.sessionId,
        "ins_channel1",
      ],
    ]);
    expect(eventCollectors.abandonCalls).toEqual([]);

    expect(resolveDefinitionSourcesCalls).toHaveLength(1);
    expect(resolveDefinitionSourcesCalls[0]).toMatchObject({
      tenantId: "ten_1",
      fallbackModel: "claude-sonnet-5",
    });

    expect(sessionService.deployInstanceAtHeadCalls).toHaveLength(1);
    // The folded step must be unbounded: a conversation services every
    // mail as another turn; the platform default (1) ends the run after
    // the first reply and every later message is rejected as terminal.
    const deployedDefinition = sessionService.deployInstanceAtHeadCalls[0] as {
      definition: { steps: Record<string, { triggers?: unknown }> };
      hubPublicKey: string;
    };
    expect(
      Object.values(deployedDefinition.definition.steps)[0]?.triggers,
    ).toBe("unbounded");
    expect(deployedDefinition.hubPublicKey).toBe("hub-key");
    const deployed = sessionService.deployInstanceAtHeadCalls[0] as {
      agentAddress: string;
      agentId: string;
      instanceId: string;
      config: { sources: unknown[]; defaultSource: string; tenantId: string };
    };
    expect(deployed.agentAddress).toBe("ins_channel1@ten1.workbench.test");
    expect(deployed.config.defaultSource).toBe("off_1");
    expect(deployed.config.tenantId).toBe("ten_1");

    const principalInsert = db.inserted.find((row) => row.table === principal);
    expect(principalInsert?.values).toMatchObject({
      tenantId: "ten_1",
      kind: "workflow",
      refId: "ins_channel1",
      status: "active",
    });

    const runInsert = db.inserted.find((row) => row.table === workflowRun);
    expect(runInsert?.values).toMatchObject({
      id: "ins_channel1",
      definitionId: "wfd_channel1",
      anchorRunId: "ins_channel1",
      tenantId: "ten_1",
      address: "ins_channel1@ten1.workbench.test",
      status: "running",
    });

    const sessionInsert = db.inserted.find((row) => row.table === agentSession);
    expect(sessionInsert?.values).toMatchObject({
      tenantId: "ten_1",
      agentId: "wfd_channel1",
      principalId: result.instancePrincipalId,
      status: "active",
    });

    // The permanent folded-run marker (`./schema.ts`) is written
    // unconditionally, inside the same transaction, regardless of
    // whether the caller supplies `persistExtra` — this is what lets a
    // workbench-owned scoped run listing exclude every folded run with
    // no per-caller opt-in.
    const foldedRunInsert = db.inserted.find((row) => row.table === foldedRun);
    expect(foldedRunInsert?.values).toMatchObject({
      id: "ins_channel1",
      tenantId: "ten_1",
    });
  });

  // CL-6149: a pinned tool package's calls failed every call with
  // "No matching grants" because nothing derived `tool:` grants for
  // `toolPackagePins` — the deploy-time capability walk only covers
  // inline tool factories. `deployAtHead` must call `toolGrantsForPins`
  // with the launch's pins and fold the result into `config.grants` (the
  // array the sidecar writes verbatim to `state/grants.json`, the file
  // the spawned child's authz gate actually reads), minted against this
  // run's own principal.
  test("mints config.grants from toolGrantsForPins, scoped to this run's principal", async () => {
    resolveDefinitionSourcesResult = {
      ok: true,
      sources: [
        {
          id: "off_1",
          provider: "anthropic",
          baseURL: "https://inference.invalid",
          apiKey: "placeholder",
          model: "claude-sonnet-5",
        },
      ],
      defaultSource: "off_1",
    };

    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    const eventCollectors = createFakeEventCollectors();
    const toolGrantsForPinsCalls: unknown[] = [];

    const pinnedFoldedBody: FoldedBody = {
      ...FOLDED_BODY,
      toolPackagePins: [{ name: "@corbits/routines-tools", version: "0.0.1" }],
    };

    const result = await launchFoldedRun(
      {
        db: db as never,
        sessionService,
        assetService: {} as never,
        sidecarRouter: {} as never,
        hubPublicKey: "hub-key",
        toolGrantsForPins: (pins) => {
          toolGrantsForPinsCalls.push(pins);
          return [
            {
              resource: "tool:@corbits/routines-tools/routines:routine_create",
              action: "invoke",
              effect: "ask",
            },
            {
              resource: "tool:@corbits/routines-tools/routines:routine_list",
              action: "invoke",
              effect: "allow",
            },
          ];
        },
        eventCollectors,
      },
      {
        tenantId: "ten_1",
        instanceId: "ins_channel1",
        triggerAddress: "ins_channel1@ten1.workbench.test",
        definitionId: "wfd_channel1",
        foldedBody: pinnedFoldedBody,
        launchLabel: "the channel host",
      },
    );

    expect(toolGrantsForPinsCalls).toEqual([pinnedFoldedBody.toolPackagePins]);

    const deployed = sessionService.deployInstanceAtHeadCalls[0] as {
      config: { grants: unknown[]; principalId: string };
    };
    expect(deployed.config.principalId).toBe(result.instancePrincipalId);
    expect(deployed.config.grants).toEqual([
      {
        id: expect.any(String),
        resource: "tool:@corbits/routines-tools/routines:routine_create",
        action: "invoke",
        effect: "ask",
        origin: "system",
        conditions: null,
        expiresAt: null,
        roleId: null,
        principalId: result.instancePrincipalId,
      },
      {
        id: expect.any(String),
        resource: "tool:@corbits/routines-tools/routines:routine_list",
        action: "invoke",
        effect: "allow",
        origin: "system",
        conditions: null,
        expiresAt: null,
        roleId: null,
        principalId: result.instancePrincipalId,
      },
    ]);
  });

  // A caller-supplied `credentialCipher` must reach `resolveDefinitionSources`
  // on every launch, or an invited agent's credential secret is decrypted
  // (if at all) through the built-in noop fallback instead of the real
  // cipher the composition root writes secrets with — delivering the raw
  // stored value as the provider's API key instead of the plaintext secret.
  test("threads a caller-supplied credentialCipher through to resolveDefinitionSources", async () => {
    resolveDefinitionSourcesCalls.length = 0;
    resolveDefinitionSourcesResult = {
      ok: true,
      sources: [
        {
          id: "off_1",
          provider: "openai-compatible",
          baseURL: "https://openrouter.ai/api/v1",
          apiKey: "sk-or-v1-real-key",
          model: "anthropic/claude-sonnet-5",
        },
      ],
      defaultSource: "off_1",
    };

    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    const eventCollectors = createFakeEventCollectors();
    const credentialCipher = {
      encrypt: async (plaintext: string) => plaintext,
      decrypt: async (blob: string) => blob,
    };

    await launchFoldedRun(
      {
        db: db as never,
        sessionService,
        assetService: {} as never,
        sidecarRouter: {} as never,
        hubPublicKey: "hub-key",
        toolGrantsForPins: () => [],
        eventCollectors,
        credentialCipher,
      },
      {
        tenantId: "ten_1",
        instanceId: "ins_invited1",
        triggerAddress: "ins_invited1@ten1.workbench.test",
        definitionId: "wfd_invited1",
        foldedBody: FOLDED_BODY,
        launchLabel: "the invited agent",
      },
    );

    expect(resolveDefinitionSourcesCalls).toHaveLength(1);
    expect(resolveDefinitionSourcesCalls[0]).toMatchObject({
      tenantId: "ten_1",
      credentialCipher,
    });
  });

  test("rolls back the committed rows and abandons the collector when the deploy fails", async () => {
    resolveDefinitionSourcesResult = {
      ok: true,
      sources: [
        {
          id: "off_1",
          provider: "anthropic",
          baseURL: "https://inference.invalid",
          apiKey: "placeholder",
          model: "claude-sonnet-5",
        },
      ],
      defaultSource: "off_1",
    };

    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    const deployError = new Error("sidecar unreachable");
    sessionService.deploySingleStepAtHead = async () => {
      throw deployError;
    };
    const eventCollectors = createFakeEventCollectors();

    await expect(
      launchFoldedRun(
        {
          db: db as never,
          sessionService,
          assetService: {} as never,
          sidecarRouter: {} as never,
          hubPublicKey: "hub-key",
          toolGrantsForPins: () => [],
          eventCollectors,
        },
        {
          tenantId: "ten_1",
          instanceId: "ins_channel1",
          triggerAddress: "ins_channel1@ten1.workbench.test",
          definitionId: "wfd_channel1",
          foldedBody: FOLDED_BODY,
          launchLabel: "the channel host",
        },
      ),
    ).rejects.toThrow(deployError);

    expect(eventCollectors.abandonCalls).toEqual([
      "ins_channel1@ten1.workbench.test",
    ]);

    const sessionUpdate = db.updated.find((row) => row.table === agentSession);
    expect(sessionUpdate?.values).toMatchObject({ status: "ended" });

    // The run row and its folded-run marker are rolled back together —
    // a rolled-back launch must leave no marker behind for an id that
    // no longer names a real run.
    expect(db.deleted).toEqual([{ table: workflowRun }, { table: foldedRun }]);

    const principalUpdate = db.updated.find((row) => row.table === principal);
    expect(principalUpdate?.values).toMatchObject({ status: "deactivated" });
  });

  test("marks the run failed (not deleted) when the deploy leaks a running child", async () => {
    resolveDefinitionSourcesResult = {
      ok: true,
      sources: [
        {
          id: "off_1",
          provider: "anthropic",
          baseURL: "https://inference.invalid",
          apiKey: "placeholder",
          model: "claude-sonnet-5",
        },
      ],
      defaultSource: "off_1",
    };

    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    sessionService.deploySingleStepAtHead = async () => {
      throw new SessionLaunchError("start", new Error("ack timeout"), true);
    };
    const eventCollectors = createFakeEventCollectors();

    await expect(
      launchFoldedRun(
        {
          db: db as never,
          sessionService,
          assetService: {} as never,
          sidecarRouter: {} as never,
          hubPublicKey: "hub-key",
          toolGrantsForPins: () => [],
          eventCollectors,
        },
        {
          tenantId: "ten_1",
          instanceId: "ins_channel1",
          triggerAddress: "ins_channel1@ten1.workbench.test",
          definitionId: "wfd_channel1",
          foldedBody: FOLDED_BODY,
          launchLabel: "the channel host",
        },
      ),
    ).rejects.toThrow(SessionLaunchError);

    // Neither the run row nor its folded-run marker is deleted: the
    // leaked child is still real and still folded, so both rows must
    // stay.
    expect(db.deleted).toEqual([]);
    const runUpdate = db.updated.find((row) => row.table === workflowRun);
    expect(runUpdate?.values).toEqual({ status: "failed" });
  });

  test("throws InferenceResolutionError when the tenant catalog has no launchable source", async () => {
    resolveDefinitionSourcesResult = {
      ok: false,
      message: 'No launchable inference source for model "claude-sonnet-5"',
    };

    const db = createFakeDb();

    let caught: unknown;
    try {
      await launchFoldedRun(
        {
          db: db as never,
          sessionService: createFakeSessionService(),
          assetService: {} as never,
          sidecarRouter: {} as never,
          hubPublicKey: "hub-key",
          toolGrantsForPins: () => [],
          eventCollectors: createFakeEventCollectors(),
        },
        {
          tenantId: "ten_1",
          instanceId: "ins_channel1",
          triggerAddress: "ins_channel1@ten1.workbench.test",
          definitionId: "wfd_channel1",
          foldedBody: FOLDED_BODY,
          launchLabel: "the channel host",
        },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InferenceResolutionError);
    const err = caught as { resolutionMessage: string; message: string };
    expect(err.resolutionMessage).toBe(
      'No launchable inference source for model "claude-sonnet-5"',
    );
    expect(err.message).toMatch(/seed a tenant catalog source/);
    expect(err.message).toMatch(/the channel host/);
  });

  test("uses a caller-supplied sources override verbatim, never touching the catalog", async () => {
    resolveDefinitionSourcesCalls.length = 0;
    // Forced to fail if ever consulted: proves the override path skips
    // `resolveDefinitionSources` entirely, not merely that it happens
    // to succeed against it.
    resolveDefinitionSourcesResult = {
      ok: false,
      message: "the catalog must not be consulted when an override is given",
    };

    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    const eventCollectors = createFakeEventCollectors();

    const override = {
      sources: [
        {
          id: "noop",
          provider: "anthropic",
          baseURL: "https://hub.invalid/api/chat/noop-inference",
          apiKey: "noop",
          model: "noop",
        },
      ],
      defaultSource: "noop",
    };

    const result = await launchFoldedRun(
      {
        db: db as never,
        sessionService,
        assetService: {} as never,
        sidecarRouter: {} as never,
        hubPublicKey: "hub-key",
        toolGrantsForPins: () => [],
        eventCollectors,
      },
      {
        tenantId: "ten_1",
        instanceId: "ins_channel1",
        triggerAddress: "ins_channel1@ten1.workbench.test",
        definitionId: "wfd_channel1",
        foldedBody: FOLDED_BODY,
        launchLabel: "the channel host",
        sources: override,
      },
    );

    expect(result.sessionId).toBeTruthy();
    expect(resolveDefinitionSourcesCalls).toHaveLength(0);
    expect(sessionService.deployInstanceAtHeadCalls).toHaveLength(1);
    const deployed = sessionService.deployInstanceAtHeadCalls[0] as {
      config: { sources: unknown[]; defaultSource: string };
    };
    expect(deployed.config.sources).toEqual(override.sources);
    expect(deployed.config.defaultSource).toBe("noop");
  });

  test("fails loud on a malformed sources override rather than reaching deployInstanceAtHead", async () => {
    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    const eventCollectors = createFakeEventCollectors();

    await expect(
      launchFoldedRun(
        {
          db: db as never,
          sessionService,
          assetService: {} as never,
          sidecarRouter: {} as never,
          hubPublicKey: "hub-key",
          toolGrantsForPins: () => [],
          eventCollectors,
        },
        {
          tenantId: "ten_1",
          instanceId: "ins_channel1",
          triggerAddress: "ins_channel1@ten1.workbench.test",
          definitionId: "wfd_channel1",
          foldedBody: FOLDED_BODY,
          launchLabel: "the channel host",
          // Missing `apiKey`/`model` on the source: malformed.
          sources: {
            sources: [{ id: "noop", provider: "anthropic" }] as never,
            defaultSource: "noop",
          },
        },
      ),
    ).rejects.toThrow(/invalid inference sources override/);

    expect(sessionService.deployInstanceAtHeadCalls).toHaveLength(0);
  });
});

describe("wakeFoldedRun", () => {
  test("clears the instance's stale session_asset manifest rows before redeploying the same instance id", async () => {
    // A wake redeploys the SAME instance id; the platform's ordinary
    // launch reserves one session_asset row per (instance, mount path)
    // with no conflict handling, so the previous occurrence's rows must
    // go first or the redeploy dies on the primary key.
    const db = createFakeDb();
    const dbWithSelect = Object.assign(db, {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => Promise.resolve([{ id: "ses_1" }]),
            }),
          }),
        }),
      }),
    });
    const sessionService = createFakeSessionService();
    await wakeFoldedRun(
      {
        db: dbWithSelect as never,
        sessionService,
        eventCollectors: createFakeEventCollectors(),
        credentialCipher: {} as never,
        toolGrantsForPins: () => [],
      } as never,
      {
        tenantId: "ten_1",
        instanceId: "run_1",
        triggerAddress: "run_1@acme.test",
        principalId: "prn_1",
        foldedBody: FOLDED_BODY,
        sources: {
          sources: [
            {
              id: "off_1",
              provider: "anthropic",
              baseURL: "https://inference.invalid",
              apiKey: "placeholder",
              model: "claude-sonnet-5",
            },
          ],
          defaultSource: "off_1",
        },
      },
    );
    expect(db.deleted.map((d) => d.table)).toContain(sessionAsset);
    expect(sessionService.deployInstanceAtHeadCalls).toHaveLength(1);
  });
});

describe("deployAtHead — mcp credential bindings", () => {
  const MCP_BINDING = {
    package: "@corbits/mcp-tools",
    handle: "mcp:exa",
    provider: "mcp:exa",
    locator: "tenant" as const,
  };

  test("fetches and delivers the tenant's mcp bindings when @corbits/mcp-tools is pinned", async () => {
    resolveDefinitionSourcesCalls.length = 0;
    resolveDefinitionSourcesResult = {
      ok: true,
      sources: [
        {
          id: "off_1",
          provider: "anthropic",
          baseURL: "https://inference.invalid",
          apiKey: "placeholder",
          model: "claude-sonnet-5",
        },
      ],
      defaultSource: "off_1",
    };
    buildCredentialDeliveryCalls.length = 0;
    buildCredentialDeliveryResult = {
      ok: true,
      delivery: {
        bindings: [
          { handle: "mcp:exa", credentialId: "cred_1", consumer: "tool:@corbits/mcp-tools" },
        ],
        materials: [
          { credentialId: "cred_1", providerKey: "mcp", origin: "https://mcp.exa.ai/mcp", secret: "n/a" },
        ],
      },
      bindingGrants: [
        {
          resource: "credential:cred_1",
          conditions: { tool: "tool:@corbits/mcp-tools" },
        },
      ],
    };

    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    const eventCollectors = createFakeEventCollectors();
    const mcpCredentialBindingsForCalls: string[] = [];

    await deployAtHead(
      {
        db: db as never,
        sessionService,
        eventCollectors,
        credentialCipher: {} as never,
        hubPublicKey: "hub-key",
        toolGrantsForPins: () => [],
        mcpCredentialBindingsFor: async (tenantId: string) => {
          mcpCredentialBindingsForCalls.push(tenantId);
          return [MCP_BINDING];
        },
      },
      {
        tenantId: "ten_1",
        instanceId: "ins_1",
        triggerAddress: "ins_1@ten1.workbench.test",
        principalId: "prn_1",
        sessionId: "ses_1",
        foldedBody: {
          ...FOLDED_BODY,
          toolPackagePins: [{ name: "@corbits/mcp-tools", version: "*" }],
        },
        launchLabel: "myra",
      },
    );

    expect(mcpCredentialBindingsForCalls).toEqual(["ten_1"]);
    expect(buildCredentialDeliveryCalls).toHaveLength(1);
    expect(buildCredentialDeliveryCalls[0]).toMatchObject({
      tenantId: "ten_1",
      bindings: [MCP_BINDING],
    });

    const deployed = sessionService.deployInstanceAtHeadCalls[0] as {
      credentials: unknown;
      config: { grants: { resource: string; action: string }[] };
      definition: { credentialBindings?: readonly unknown[] };
    };
    expect(deployed.credentials).toEqual(buildCredentialDeliveryResult.delivery);
    expect(deployed.config.grants).toContainEqual(
      expect.objectContaining({
        resource: "credential:cred_1",
        action: "use",
        conditions: { tool: "tool:@corbits/mcp-tools" },
      }),
    );
    expect(deployed.definition.credentialBindings).toEqual([MCP_BINDING]);
  });

  test("never calls mcpCredentialBindingsFor when @corbits/mcp-tools is not pinned", async () => {
    resolveDefinitionSourcesCalls.length = 0;
    resolveDefinitionSourcesResult = {
      ok: true,
      sources: [
        {
          id: "off_1",
          provider: "anthropic",
          baseURL: "https://inference.invalid",
          apiKey: "placeholder",
          model: "claude-sonnet-5",
        },
      ],
      defaultSource: "off_1",
    };
    buildCredentialDeliveryCalls.length = 0;
    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    const eventCollectors = createFakeEventCollectors();
    let mcpCredentialBindingsForCallCount = 0;

    await deployAtHead(
      {
        db: db as never,
        sessionService,
        eventCollectors,
        credentialCipher: {} as never,
        hubPublicKey: "hub-key",
        toolGrantsForPins: () => [],
        mcpCredentialBindingsFor: async () => {
          mcpCredentialBindingsForCallCount += 1;
          return [MCP_BINDING];
        },
      },
      {
        tenantId: "ten_1",
        instanceId: "ins_2",
        triggerAddress: "ins_2@ten1.workbench.test",
        principalId: "prn_2",
        sessionId: "ses_2",
        foldedBody: FOLDED_BODY,
        launchLabel: "myra",
      },
    );

    expect(mcpCredentialBindingsForCallCount).toBe(0);
    expect(buildCredentialDeliveryCalls).toHaveLength(0);
    const deployed = sessionService.deployInstanceAtHeadCalls[0] as {
      credentials?: unknown;
    };
    expect(deployed.credentials).toBeUndefined();
  });
});
