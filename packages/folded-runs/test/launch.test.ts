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
  SidecarRouter,
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

const {
  launchFoldedRun,
  mintFoldedRun,
  deployAtHead,
  InferenceResolutionError,
} = await import("../src/launch");
const { wakeFoldedRun } = await import("../src/wake");
const { sessionAsset } = await import("@intx/db/schema");

// The hub-grant plane is exercised on its own (`run-hub-grants` and the
// real-DB suite); these doubles only care about launch mechanics.
const noopRunHubGrants = {
  prepare: async () => async () => undefined,
  revoke: async () => undefined,
};

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

type RunGrantsCall = {
  agentAddress: string;
  runId: string;
  stepGrants: readonly unknown[];
};

/**
 * Records the `run.grants` frames `deployAtHead` produces. `routable`
 * mirrors the real router's return: `false` means the deployment address is
 * not routable, which the launch must treat as a hard failure rather than
 * starting a run with no grants file.
 */
function createFakeSidecarRouter(routable = true): SidecarRouter & {
  runGrantsCalls: RunGrantsCall[];
} {
  const runGrantsCalls: RunGrantsCall[] = [];
  return {
    runGrantsCalls,
    sendRunGrants(
      agentAddress: string,
      runId: string,
      stepGrants: readonly unknown[],
    ) {
      runGrantsCalls.push({ agentAddress, runId, stepGrants });
      return routable;
    },
  } as unknown as SidecarRouter & { runGrantsCalls: RunGrantsCall[] };
}

const FOLDED_BODY: FoldedBody = {
  systemPrompt: "you are a workbench host",
  toolPackagePins: [],
  grantRequirements: [],
  credentialBindings: [],
  model: "claude-sonnet-5",
};

describe("mintFoldedRun", () => {
  test("writes the folded run rows and deploys nothing", async () => {
    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    const eventCollectors = createFakeEventCollectors();
    const persistExtraCalls: unknown[] = [];

    const result = await mintFoldedRun(
      { db: db as never, runHubGrants: noopRunHubGrants },
      {
        tenantId: "ten_1",
        instanceId: "ins_workbench1",
        triggerAddress: "ins_workbench1@ten1.workbench.test",
        definitionId: "wfd_workbench1",
        invokerPrincipalId: "prn_invoker",
        toolPackagePins: [],
        persistExtra: async (tx) => {
          persistExtraCalls.push(tx);
        },
      },
    );

    expect(result.sessionId).toBeTruthy();
    expect(result.instancePrincipalId).toBeTruthy();
    // The caller's own row commits inside the same transaction as the
    // principal/session/run inserts, exactly as it does on a launch.
    expect(persistExtraCalls).toHaveLength(1);
    expect(db.inserted.map((row) => row.table)).toEqual([
      principal,
      agentSession,
      workflowRun,
      foldedRun,
    ]);

    // The whole point of a mint: an addressable run with no sidecar
    // traffic and no collector — the first mail wakes it instead.
    expect(sessionService.deployInstanceAtHeadCalls).toEqual([]);
    expect(eventCollectors.createCalls).toEqual([]);
  });

  // Mint is the only moment a run's hub-side authority can be computed: a
  // mint-only caller deploys later, at wake, and the invoker is gone by
  // then. It runs inside the same transaction, so a run can never be
  // addressable while holding authority nobody granted it.
  test("mints the run's hub-side authority from its invoker, inside the mint transaction", async () => {
    const db = createFakeDb();
    const prepareCalls: {
      runTenantId: string;
      runPrincipalId: string;
      invokerPrincipalId: string;
      toolPackagePins: readonly { name: string }[];
    }[] = [];
    const writtenWith: unknown[] = [];
    const pins = [{ name: "@corbits/memory-tools", version: "^1" }];

    const result = await mintFoldedRun(
      {
        db: db as never,
        runHubGrants: {
          prepare: async (params) => {
            prepareCalls.push(params as never);
            return async (tx) => {
              writtenWith.push(tx);
            };
          },
          revoke: async () => undefined,
        },
      },
      {
        tenantId: "ten_1",
        instanceId: "ins_workbench1",
        triggerAddress: "ins_workbench1@ten1.workbench.test",
        definitionId: "wfd_workbench1",
        invokerPrincipalId: "prn_alice",
        toolPackagePins: pins,
      },
    );

    expect(prepareCalls).toHaveLength(1);
    const prepared = prepareCalls[0];
    expect(prepared?.runTenantId).toBe("ten_1");
    expect(prepared?.runPrincipalId).toBe(result.instancePrincipalId);
    expect(prepared?.invokerPrincipalId).toBe("prn_alice");
    expect(prepared?.toolPackagePins).toEqual(pins);
    // Resolved outside the transaction, written inside it.
    expect(writtenWith).toHaveLength(1);
    expect(writtenWith[0]).toBeDefined();
  });
});

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
        sidecarRouter: createFakeSidecarRouter(),
        hubPublicKey: "hub-key",
        toolGrantsForPins: () => [],
        runHubGrants: noopRunHubGrants,
        eventCollectors,
      },
      {
        tenantId: "ten_1",
        instanceId: "ins_workbench1",
        triggerAddress: "ins_workbench1@ten1.workbench.test",
        definitionId: "wfd_workbench1",
        invokerPrincipalId: "prn_invoker",
        foldedBody: FOLDED_BODY,
        launchLabel: "the workbench host",
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
        "ins_workbench1@ten1.workbench.test",
        "ten_1",
        result.sessionId,
        "ins_workbench1",
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
    expect(deployed.agentAddress).toBe("ins_workbench1@ten1.workbench.test");
    expect(deployed.config.defaultSource).toBe("off_1");
    expect(deployed.config.tenantId).toBe("ten_1");

    const principalInsert = db.inserted.find((row) => row.table === principal);
    expect(principalInsert?.values).toMatchObject({
      tenantId: "ten_1",
      kind: "workflow",
      refId: "ins_workbench1",
      status: "active",
    });

    const runInsert = db.inserted.find((row) => row.table === workflowRun);
    expect(runInsert?.values).toMatchObject({
      id: "ins_workbench1",
      definitionId: "wfd_workbench1",
      anchorRunId: "ins_workbench1",
      tenantId: "ten_1",
      address: "ins_workbench1@ten1.workbench.test",
      status: "running",
    });

    const sessionInsert = db.inserted.find((row) => row.table === agentSession);
    expect(sessionInsert?.values).toMatchObject({
      tenantId: "ten_1",
      agentId: "wfd_workbench1",
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
      id: "ins_workbench1",
      tenantId: "ten_1",
    });
  });

  // CL-6164: the step's default input selector (`{ from:
  // "trigger.payload" }`) reads the triggering mail's bare `content`
  // verbatim and feeds it straight into `agent.send`, which throws on an
  // empty string — and `content` is legitimately empty for
  // attachments-only mail. A caller that knows its run never reads its
  // input (the workbench host) must be able to pin a literal instead, so
  // an attachments-only first mail cannot crash the run before it opens.
  test("stepInput overrides the step's default trigger.payload selector", async () => {
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

    const sessionService = createFakeSessionService();

    await launchFoldedRun(
      {
        db: createFakeDb() as never,
        sessionService,
        assetService: {} as never,
        sidecarRouter: createFakeSidecarRouter(),
        hubPublicKey: "hub-key",
        toolGrantsForPins: () => [],
        runHubGrants: noopRunHubGrants,
        eventCollectors: createFakeEventCollectors(),
      },
      {
        tenantId: "ten_1",
        instanceId: "ins_workbench1",
        triggerAddress: "ins_workbench1@ten1.workbench.test",
        definitionId: "wfd_workbench1",
        invokerPrincipalId: "prn_invoker",
        foldedBody: FOLDED_BODY,
        launchLabel: "the workbench host",
        stepInput: { literal: "workbench-host anchor turn" },
      },
    );

    const deployed = sessionService.deployInstanceAtHeadCalls[0] as {
      definition: { steps: Record<string, { input?: unknown }> };
    };
    expect(Object.values(deployed.definition.steps)[0]?.input).toEqual({
      literal: "workbench-host anchor turn",
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
      toolPackagePins: [{ name: "@corbits/routines-tools", version: "0.0.2" }],
    };

    const result = await launchFoldedRun(
      {
        db: db as never,
        sessionService,
        assetService: {} as never,
        sidecarRouter: createFakeSidecarRouter(),
        hubPublicKey: "hub-key",
        runHubGrants: noopRunHubGrants,
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
        instanceId: "ins_workbench1",
        triggerAddress: "ins_workbench1@ten1.workbench.test",
        definitionId: "wfd_workbench1",
        invokerPrincipalId: "prn_invoker",
        foldedBody: pinnedFoldedBody,
        launchLabel: "the workbench host",
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
        sidecarRouter: createFakeSidecarRouter(),
        hubPublicKey: "hub-key",
        toolGrantsForPins: () => [],
        runHubGrants: noopRunHubGrants,
        eventCollectors,
        credentialCipher,
      },
      {
        tenantId: "ten_1",
        instanceId: "ins_invited1",
        triggerAddress: "ins_invited1@ten1.workbench.test",
        definitionId: "wfd_invited1",
        invokerPrincipalId: "prn_invoker",
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
          sidecarRouter: createFakeSidecarRouter(),
          hubPublicKey: "hub-key",
          toolGrantsForPins: () => [],
          runHubGrants: noopRunHubGrants,
          eventCollectors,
        },
        {
          tenantId: "ten_1",
          instanceId: "ins_workbench1",
          triggerAddress: "ins_workbench1@ten1.workbench.test",
          definitionId: "wfd_workbench1",
          invokerPrincipalId: "prn_invoker",
          foldedBody: FOLDED_BODY,
          launchLabel: "the workbench host",
        },
      ),
    ).rejects.toThrow(deployError);

    expect(eventCollectors.abandonCalls).toEqual([
      "ins_workbench1@ten1.workbench.test",
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

  // The principal is deactivated rather than deleted, so its grant rows
  // never cascade away on their own. A run that never started holds no
  // authority, so the rollback revokes it explicitly.
  test("revokes the run's hub-side authority when the deploy fails", async () => {
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
      throw new Error("sidecar unreachable");
    };
    const revoked: { runPrincipalId: string }[] = [];
    let mintedPrincipalId = "";

    await expect(
      launchFoldedRun(
        {
          db: db as never,
          sessionService,
          assetService: {} as never,
          sidecarRouter: createFakeSidecarRouter(),
          hubPublicKey: "hub-key",
          toolGrantsForPins: () => [],
          runHubGrants: {
            prepare: async (params: { runPrincipalId: string }) => {
              mintedPrincipalId = params.runPrincipalId;
              return async () => undefined;
            },
            revoke: async (params: { runPrincipalId: string }) => {
              revoked.push(params);
            },
          },
          eventCollectors: createFakeEventCollectors(),
        } as never,
        {
          tenantId: "ten_1",
          instanceId: "ins_workbench1",
          triggerAddress: "ins_workbench1@ten1.workbench.test",
          definitionId: "wfd_workbench1",
          invokerPrincipalId: "prn_invoker",
          foldedBody: FOLDED_BODY,
          launchLabel: "the workbench host",
        },
      ),
    ).rejects.toThrow(/sidecar unreachable/);

    expect(revoked).toEqual([{ runPrincipalId: mintedPrincipalId }]);
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
          sidecarRouter: createFakeSidecarRouter(),
          hubPublicKey: "hub-key",
          toolGrantsForPins: () => [],
          runHubGrants: noopRunHubGrants,
          eventCollectors,
        },
        {
          tenantId: "ten_1",
          instanceId: "ins_workbench1",
          triggerAddress: "ins_workbench1@ten1.workbench.test",
          definitionId: "wfd_workbench1",
          invokerPrincipalId: "prn_invoker",
          foldedBody: FOLDED_BODY,
          launchLabel: "the workbench host",
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
          sidecarRouter: createFakeSidecarRouter(),
          hubPublicKey: "hub-key",
          toolGrantsForPins: () => [],
          runHubGrants: noopRunHubGrants,
          eventCollectors: createFakeEventCollectors(),
        },
        {
          tenantId: "ten_1",
          instanceId: "ins_workbench1",
          triggerAddress: "ins_workbench1@ten1.workbench.test",
          definitionId: "wfd_workbench1",
          invokerPrincipalId: "prn_invoker",
          foldedBody: FOLDED_BODY,
          launchLabel: "the workbench host",
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
    expect(err.message).toMatch(/the workbench host/);
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
        sidecarRouter: createFakeSidecarRouter(),
        hubPublicKey: "hub-key",
        toolGrantsForPins: () => [],
        runHubGrants: noopRunHubGrants,
        eventCollectors,
      },
      {
        tenantId: "ten_1",
        instanceId: "ins_workbench1",
        triggerAddress: "ins_workbench1@ten1.workbench.test",
        definitionId: "wfd_workbench1",
        invokerPrincipalId: "prn_invoker",
        foldedBody: FOLDED_BODY,
        launchLabel: "the workbench host",
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
          sidecarRouter: createFakeSidecarRouter(),
          hubPublicKey: "hub-key",
          toolGrantsForPins: () => [],
          runHubGrants: noopRunHubGrants,
          eventCollectors,
        },
        {
          tenantId: "ten_1",
          instanceId: "ins_workbench1",
          triggerAddress: "ins_workbench1@ten1.workbench.test",
          definitionId: "wfd_workbench1",
          invokerPrincipalId: "prn_invoker",
          foldedBody: FOLDED_BODY,
          launchLabel: "the workbench host",
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
        sidecarRouter: createFakeSidecarRouter(),
        eventCollectors: createFakeEventCollectors(),
        credentialCipher: {} as never,
        toolGrantsForPins: () => [],
        runHubGrants: noopRunHubGrants,
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
          {
            handle: "mcp:exa",
            credentialId: "cred_1",
            consumer: "tool:@corbits/mcp-tools",
          },
        ],
        materials: [
          {
            credentialId: "cred_1",
            providerKey: "mcp",
            origin: "https://mcp.exa.ai/mcp",
            secret: "n/a",
          },
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
        sidecarRouter: createFakeSidecarRouter(),
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
    expect(deployed.credentials).toEqual(
      buildCredentialDeliveryResult.delivery,
    );
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
        sidecarRouter: createFakeSidecarRouter(),
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

describe("deployAtHead — run.grants production", () => {
  const SOURCES = {
    ok: true as const,
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

  const PIN = {
    name: "@corbits/mcp-tools",
    version: "1.0.0",
    integrity: "sha512-deadbeef",
    registry: "https://registry.invalid",
  };

  function makeDeps(sidecarRouter: ReturnType<typeof createFakeSidecarRouter>) {
    return {
      db: createFakeDb() as never,
      sessionService: createFakeSessionService(),
      sidecarRouter,
      eventCollectors: createFakeEventCollectors(),
      hubPublicKey: "hub-key",
      toolGrantsForPins: () => [
        {
          resource: "tool:@corbits/mcp-tools:search",
          action: "invoke" as const,
          effect: "allow" as const,
        },
      ],
      runHubGrants: noopRunHubGrants,
    };
  }

  const PARAMS = {
    tenantId: "ten_1",
    instanceId: "run_grants1",
    triggerAddress: "run_grants1@ten1.workbench.test",
    principalId: "prn_1",
    sessionId: "ses_1",
    foldedBody: { ...FOLDED_BODY, toolPackagePins: [PIN] },
    launchLabel: "the workbench host",
  };

  test("sends the run's grants frame for its own self-anchored run id", async () => {
    resolveDefinitionSourcesResult = SOURCES;
    const sidecarRouter = createFakeSidecarRouter();

    await deployAtHead(makeDeps(sidecarRouter), PARAMS);

    expect(sidecarRouter.runGrantsCalls).toHaveLength(1);
    const [call] = sidecarRouter.runGrantsCalls;
    expect(call?.agentAddress).toBe(PARAMS.triggerAddress);
    // A folded run is self-anchored: its run id IS its deployment id.
    expect(call?.runId).toBe(PARAMS.instanceId);
    expect(call?.stepGrants).toEqual([
      expect.objectContaining({
        resource: "tool:@corbits/mcp-tools:search",
        action: "invoke",
        effect: "allow",
        principalId: PARAMS.principalId,
      }),
    ]);
  });

  test("ships the same grant set the deploy carries as config.grants", async () => {
    resolveDefinitionSourcesResult = SOURCES;
    const sidecarRouter = createFakeSidecarRouter();
    const deps = makeDeps(sidecarRouter);

    await deployAtHead(deps, PARAMS);

    const deployed = deps.sessionService.deployInstanceAtHeadCalls[0] as {
      config: { grants: unknown[] };
    };
    expect(sidecarRouter.runGrantsCalls[0]?.stepGrants).toEqual(
      deployed.config.grants,
    );
  });

  test("throws when the deployment address is not routable for the frame", async () => {
    resolveDefinitionSourcesResult = SOURCES;
    const sidecarRouter = createFakeSidecarRouter(false);

    await expect(deployAtHead(makeDeps(sidecarRouter), PARAMS)).rejects.toThrow(
      /is not routable for run run_grants1/,
    );
  });
});
