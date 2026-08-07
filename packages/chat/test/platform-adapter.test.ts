// Proves `createHubChatPlatform` maps each `ChatPlatform` port method
// onto the right in-process service call. `launchChannel` in
// particular proves the folded interactive-instance shape: it extracts
// the folded body, resolves inference sources against the tenant
// catalog, writes the same principal/session/run rows a folded launch
// writes (never a deployment-shaped run), and deploys via
// `sessionService.deployInstanceAtHead` — never
// `deployWorkflowDefinition`.
//
// `resolveDefinitionSources` is real catalog resolution (joins across
// several tables via `@intx/db`), which a plain chainable fake `db`
// cannot answer without reimplementing that join. Rather than fake the
// join, this file replaces just that one export of `@intx/hub-api`
// with a controllable stub — spreading through every other export
// unchanged — so a real tenant catalog is never required to prove
// `launchChannel`'s own wiring. `resolveDefinitionSources` itself is
// `@intx/hub-api`'s own contract, not this package's, and is not
// re-proven here.
//
// `sessionService`/`assetService`/`sidecarRouter` are fakes recording
// their calls, and `db` is a minimal chainable stand-in for the
// drizzle query builder (no database involved) so the mapping is
// exercised without a real Postgres.

import { describe, expect, mock, test } from "bun:test";
import {
  agentSession,
  asset,
  principal,
  sessionMail,
  workflowDefinition,
  workflowDefinitionVersion,
  workflowRun,
} from "@intx/db/schema";
import { SessionLaunchError } from "@intx/hub-sessions";
import type {
  EventCollectorRegistry,
  SessionService,
  SidecarRouter,
} from "@intx/hub-sessions";
import type { DefinitionSourceResolution } from "@intx/hub-api";
import {
  buildChannelHostWorkflow,
  serializeChannelHostWorkflow,
} from "../src/channel-workflow";

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

const { createHubChatPlatform } = await import("../src/platform-adapter");

type SelectChain = {
  where(...args: unknown[]): SelectChain;
  orderBy(...args: unknown[]): SelectChain;
  limit(n?: number): Promise<unknown[]>;
};

function selectChain(rows: unknown[]): SelectChain {
  const chain: SelectChain = {
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return chain;
}

type InsertChain = {
  onConflictDoNothing(...args: unknown[]): InsertChain;
  returning(...args: unknown[]): Promise<unknown[]>;
};

function insertChain(returningRows: unknown[]): InsertChain {
  const chain: InsertChain = {
    onConflictDoNothing: () => chain,
    returning: () => Promise.resolve(returningRows),
  };
  return chain;
}

/**
 * A fake database: enough of the drizzle fluent surface for
 * `platform-adapter.ts`, `ensureWorkflowDefinitionForAsset`, and
 * `resolveRunSessionId` to run against, keyed by table identity so
 * each select/insert resolves the row set the test configures for it.
 * `transaction` runs its callback against the same fake, recording
 * inserts into the same `inserted` list as a top-level `insert` would.
 */
type UpdateChain = {
  set(values: unknown): { where(...args: unknown[]): Promise<void> };
};

type DeleteChain = {
  where(...args: unknown[]): Promise<void>;
};

function createFakeDb(opts: {
  assetRow: {
    tenantId: string;
    creatorPrincipalId: string | null;
    name: string;
    displayName: string | null;
  };
  definitionId: string;
  workflowRunRow?:
    | { id: string; address: string | null; principalId: string | null }
    | undefined;
  sessionMailRow?: { id: string; raw: Uint8Array } | undefined;
  workflowDefinitionRow?:
    | { id: string; tenantId: string; status: string; assetId: string | null }
    | undefined;
  workflowDefinitionRows?:
    | { id: string; tenantId: string; status: string; name: string }[]
    | undefined;
  tenantRow?: { id: string; domain: string } | undefined;
}) {
  const inserted: { table: unknown; values: unknown }[] = [];
  const updated: { table: unknown; values: unknown }[] = [];
  const deleted: { table: unknown }[] = [];

  function updateOn(table: unknown): UpdateChain {
    return {
      set(values: unknown) {
        updated.push({ table, values });
        return { where: async () => undefined };
      },
    };
  }

  function deleteOn(table: unknown): DeleteChain {
    deleted.push({ table });
    return { where: async () => undefined };
  }

  function insertOn(table: unknown, values: unknown): InsertChain {
    inserted.push({ table, values });
    if (table === workflowDefinition) {
      return insertChain([{ id: opts.definitionId }]);
    }
    if (table === workflowDefinitionVersion) {
      return insertChain([]);
    }
    return insertChain([]);
  }

  const fake = {
    query: {
      workflowRun: {
        findFirst: async () => opts.workflowRunRow,
      },
      sessionMail: {
        findFirst: async () => opts.sessionMailRow,
      },
      workflowDefinition: {
        findFirst: async () => opts.workflowDefinitionRow,
        findMany: async () => opts.workflowDefinitionRows ?? [],
      },
      tenant: {
        findFirst: async () => opts.tenantRow,
      },
    },
    select(..._cols: unknown[]) {
      return {
        from(table: unknown) {
          if (table === asset) return selectChain([opts.assetRow]);
          if (table === agentSession) {
            // `resolveRunSessionId` selects `{ id }` filtered by
            // principalId; this fake ignores the filter and returns
            // every agentSession insert recorded so far, matching the
            // one-session-per-test-run shape every test here uses.
            const sessions = inserted
              .filter((row) => row.table === agentSession)
              .map((row) => ({ id: (row.values as { id: string }).id }));
            return selectChain(sessions);
          }
          return selectChain([]);
        },
      };
    },
    insert(table: unknown) {
      return { values: (values: unknown) => insertOn(table, values) };
    },
    update(table: unknown) {
      return updateOn(table);
    },
    delete(table: unknown) {
      return deleteOn(table);
    },
    async transaction(fn: (tx: unknown) => Promise<void>) {
      await fn({
        insert(table: unknown) {
          return { values: (values: unknown) => insertOn(table, values) };
        },
      });
    },
    inserted,
    updated,
    deleted,
  };
  return fake;
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
    getCurrentTurnId: () => undefined,
    getLastTurnId: () => undefined,
    dispatch: () => undefined,
  } as unknown as EventCollectorRegistry & {
    createCalls: unknown[];
    abandonCalls: string[];
  };
}

function createFakeSessionService(): SessionService & {
  deployInstanceAtHeadCalls: unknown[];
  sendUserMessageCalls: unknown[];
} {
  const deployInstanceAtHeadCalls: unknown[] = [];
  const sendUserMessageCalls: unknown[] = [];
  return {
    deployInstanceAtHeadCalls,
    sendUserMessageCalls,
    async stageWorkflowStep() {},
    async deployInstanceAtHead(params: unknown) {
      deployInstanceAtHeadCalls.push(params);
      return { publicKey: "test-public-key" };
    },
    async deploySingleStepAtHead() {
      return { publicKey: "unused" };
    },
    async deployWorkflowDefinition() {
      throw new Error(
        "deployWorkflowDefinition must not be called: launchChannel " +
          "launches a folded instance via deployInstanceAtHead",
      );
    },
    async sendUserMessage(params: unknown) {
      sendUserMessageCalls.push(params);
      return new TextEncoder().encode("raw-mime-bytes");
    },
    async endSession() {},
  } as unknown as SessionService & {
    deployInstanceAtHeadCalls: unknown[];
    sendUserMessageCalls: unknown[];
  };
}

function createFakeAssetService(opts: { assetBlob?: Uint8Array } = {}) {
  const createAssetCalls: unknown[] = [];
  const readAssetBlobCalls: unknown[] = [];
  return {
    createAssetCalls,
    readAssetBlobCalls,
    async createAsset(params: unknown) {
      createAssetCalls.push(params);
      return {
        id: "asst_channel1",
        tenantId: "ten_1",
        kind: "workflow" as const,
        name: "channel",
        displayName: null,
        creatorPrincipalId: "prin_creator",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
    async populateAsset() {
      return { commitSha: "unused" };
    },
    async readAssetBlob(params: unknown) {
      readAssetBlobCalls.push(params);
      return opts.assetBlob ?? new Uint8Array();
    },
    async listAssetBlobs() {
      return [];
    },
  };
}

function createFakeSidecarRouter(): SidecarRouter & {
  subscribeAgentCalls: { address: string }[];
  dispatchAgentEventCalls: { address: string; event: unknown }[];
} {
  const subscribeAgentCalls: { address: string }[] = [];
  const dispatchAgentEventCalls: { address: string; event: unknown }[] = [];
  return {
    subscribeAgentCalls,
    dispatchAgentEventCalls,
    subscribeAgent(address: string, _cb: (event: unknown) => void) {
      subscribeAgentCalls.push({ address });
      return () => undefined;
    },
    dispatchAgentEvent(address: string, event: unknown) {
      dispatchAgentEventCalls.push({ address, event });
    },
  } as unknown as SidecarRouter & {
    subscribeAgentCalls: { address: string }[];
    dispatchAgentEventCalls: { address: string; event: unknown }[];
  };
}

const CHANNEL_WORKFLOW_JSON = serializeChannelHostWorkflow(
  buildChannelHostWorkflow({
    triggerAddress: "ins_channel1@ten1.workbench.test",
    inferencePreferences: [{ provider: "anthropic", model: "claude-sonnet-5" }],
    turnTimeoutMs: 60_000,
  }),
);

describe("createHubChatPlatform", () => {
  test("launchChannel extracts the folded body, resolves sources, and deploys via deployInstanceAtHead", async () => {
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

    const db = createFakeDb({
      assetRow: {
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        name: "channel-1",
        displayName: null,
      },
      definitionId: "wfd_channel1",
    });
    const sessionService = createFakeSessionService();
    const assetService = createFakeAssetService();
    const sidecarRouter = createFakeSidecarRouter();
    const eventCollectors = createFakeEventCollectors();

    const platform = createHubChatPlatform({
      // Fake db, not a real drizzle instance.
      db: db as never,
      sessionService,
      assetService,
      sidecarRouter,
      eventCollectors,
    });

    const launched = await platform.launchChannel({
      tenantId: "ten_1",
      creatorPrincipalId: "prin_creator",
      channelId: "ins_channel1",
      triggerAddress: "ins_channel1@ten1.workbench.test",
      definition: CHANNEL_WORKFLOW_JSON,
    });

    expect(launched.instanceId).toBe("ins_channel1");

    // The anchor's event collector is opened before the deploy call, so
    // its runtime status/readiness (health, SSE replay) is never
    // permanently "not_ready".
    expect(eventCollectors.createCalls).toEqual([
      [
        "ins_channel1@ten1.workbench.test",
        "ten_1",
        expect.any(String),
        "ins_channel1",
      ],
    ]);
    expect(eventCollectors.abandonCalls).toEqual([]);

    expect(assetService.createAssetCalls).toEqual([
      {
        tenantId: "ten_1",
        kind: "workflow",
        name: "ins-channel1",
        creatorPrincipalId: "prin_creator",
      },
    ]);

    // Sources were resolved against the tenant catalog, not fabricated.
    expect(resolveDefinitionSourcesCalls).toHaveLength(1);
    expect(resolveDefinitionSourcesCalls[0]).toMatchObject({
      tenantId: "ten_1",
      fallbackModel: "claude-sonnet-5",
    });

    // The folded launch path, never the native workflow-deploy path.
    expect(sessionService.deployInstanceAtHeadCalls).toHaveLength(1);
    const deployed = sessionService.deployInstanceAtHeadCalls[0] as {
      agentAddress: string;
      agentId: string;
      instanceId: string;
      config: {
        systemPrompt: string;
        sources: unknown[];
        defaultSource: string;
        agentAddress: string;
        tenantId: string;
      };
    };
    expect(deployed.agentAddress).toBe("ins_channel1@ten1.workbench.test");
    expect(deployed.agentId).toBe("ins_channel1");
    expect(deployed.instanceId).toBe("ins_channel1");
    expect(deployed.config.systemPrompt.length).toBeGreaterThan(0);
    expect(deployed.config.sources).toEqual(
      resolveDefinitionSourcesResult.ok
        ? resolveDefinitionSourcesResult.sources
        : [],
    );
    expect(deployed.config.defaultSource).toBe("off_1");
    expect(deployed.config.tenantId).toBe("ten_1");

    // The run is written in the folded shape: no deploymentId, a real
    // principal, and a session keyed off that shared principal --
    // never a manual `session_<channelId>` insert.
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
      deploymentId: null,
      tenantId: "ten_1",
      address: "ins_channel1@ten1.workbench.test",
      status: "running",
    });

    const sessionInsert = db.inserted.find((row) => row.table === agentSession);
    const principalId = (principalInsert?.values as { id: string }).id;
    expect(sessionInsert?.values).toMatchObject({
      tenantId: "ten_1",
      agentId: "wfd_channel1",
      principalId,
      status: "active",
    });
    expect((runInsert?.values as { principalId: string }).principalId).toBe(
      principalId,
    );
  });

  test("launchChannel rolls back the committed rows and abandons the collector when the deploy fails", async () => {
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

    const db = createFakeDb({
      assetRow: {
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        name: "channel-1",
        displayName: null,
      },
      definitionId: "wfd_channel1",
    });
    const sessionService = createFakeSessionService();
    const deployError = new Error("sidecar unreachable");
    sessionService.deployInstanceAtHead = async () => {
      throw deployError;
    };
    const assetService = createFakeAssetService();
    const sidecarRouter = createFakeSidecarRouter();
    const eventCollectors = createFakeEventCollectors();

    const platform = createHubChatPlatform({
      db: db as never,
      sessionService,
      assetService,
      sidecarRouter,
      eventCollectors,
    });

    await expect(
      platform.launchChannel({
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        channelId: "ins_channel1",
        triggerAddress: "ins_channel1@ten1.workbench.test",
        definition: CHANNEL_WORKFLOW_JSON,
      }),
    ).rejects.toThrow(deployError);

    // The collector opened before the deploy attempt is abandoned, not
    // left registered against an address nothing will ever deploy to.
    expect(eventCollectors.abandonCalls).toEqual([
      "ins_channel1@ten1.workbench.test",
    ]);

    // The committed session is ended, and -- since this error is not a
    // SessionLaunchError with leakedAgent, i.e. no child was left
    // running on the sidecar -- the run is rolled back entirely rather
    // than left "running" as a permanently unlistenable ghost, and the
    // instance principal is deactivated.
    const sessionUpdate = db.updated.find((row) => row.table === agentSession);
    expect(sessionUpdate?.values).toMatchObject({ status: "ended" });

    expect(db.deleted).toEqual([{ table: workflowRun }]);

    const principalUpdate = db.updated.find((row) => row.table === principal);
    expect(principalUpdate?.values).toMatchObject({ status: "deactivated" });
  });

  test("launchChannel marks the run failed (not deleted) when the deploy leaks a running child", async () => {
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

    const db = createFakeDb({
      assetRow: {
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        name: "channel-1",
        displayName: null,
      },
      definitionId: "wfd_channel1",
    });
    const sessionService = createFakeSessionService();
    sessionService.deployInstanceAtHead = async () => {
      throw new SessionLaunchError("start", new Error("ack timeout"), true);
    };
    const assetService = createFakeAssetService();
    const sidecarRouter = createFakeSidecarRouter();
    const eventCollectors = createFakeEventCollectors();

    const platform = createHubChatPlatform({
      db: db as never,
      sessionService,
      assetService,
      sidecarRouter,
      eventCollectors,
    });

    await expect(
      platform.launchChannel({
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        channelId: "ins_channel1",
        triggerAddress: "ins_channel1@ten1.workbench.test",
        definition: CHANNEL_WORKFLOW_JSON,
      }),
    ).rejects.toThrow(SessionLaunchError);

    expect(db.deleted).toEqual([]);
    const runUpdate = db.updated.find((row) => row.table === workflowRun);
    expect(runUpdate?.values).toEqual({ status: "failed" });
  });

  test("launchChannel fails loud when the tenant catalog has no launchable source", async () => {
    resolveDefinitionSourcesResult = {
      ok: false,
      message: 'No launchable inference source for model "claude-sonnet-5"',
    };

    const db = createFakeDb({
      assetRow: {
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        name: "channel-1",
        displayName: null,
      },
      definitionId: "wfd_channel1",
    });
    const platform = createHubChatPlatform({
      db: db as never,
      sessionService: createFakeSessionService(),
      assetService: createFakeAssetService(),
      sidecarRouter: createFakeSidecarRouter(),
    });

    await expect(
      platform.launchChannel({
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        channelId: "ins_channel1",
        triggerAddress: "ins_channel1@ten1.workbench.test",
        definition: CHANNEL_WORKFLOW_JSON,
      }),
    ).rejects.toThrow(/seed a tenant catalog source/);
  });

  test("sendMail resolves the channel's run's session via the shared principal and delivers via sessionService", async () => {
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

    const db = createFakeDb({
      assetRow: {
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        name: "channel-1",
        displayName: null,
      },
      definitionId: "wfd_channel1",
      workflowRunRow: {
        id: "ins_channel1",
        address: "ins_channel1@ten1.workbench.test",
        principalId: "prin_run1",
      },
    });
    // Seed the session an earlier launchChannel would have written,
    // keyed to the run's principal.
    db.inserted.push({
      table: agentSession,
      values: { id: "ses_run1", principalId: "prin_run1" },
    });

    const sessionService = createFakeSessionService();
    const sidecarRouter = createFakeSidecarRouter();

    const platform = createHubChatPlatform({
      db: db as never,
      sessionService,
      assetService: createFakeAssetService(),
      sidecarRouter,
    });

    const sent = await platform.sendMail({
      tenantId: "ten_1",
      channelId: "ins_channel1",
      principalId: "prin_sender",
      content: { content: "hello channel" },
    });

    expect(sent.id).toBeTruthy();
    expect(sessionService.sendUserMessageCalls).toHaveLength(1);
    const call = sessionService.sendUserMessageCalls[0] as {
      agentAddress: string;
      content: string;
      sessionId: string;
    };
    expect(call.agentAddress).toBe("ins_channel1@ten1.workbench.test");
    expect(call.content).toBe("hello channel");
    expect(call.sessionId).toBe("ses_run1");

    const mailInsert = db.inserted.find((row) => row.table === sessionMail);
    expect(mailInsert?.values).toMatchObject({
      sessionId: "ses_run1",
      tenantId: "ten_1",
      direction: "inbound",
      status: "delivered",
    });

    expect(sidecarRouter.dispatchAgentEventCalls).toHaveLength(1);
    expect(sidecarRouter.dispatchAgentEventCalls[0]?.address).toBe(
      "ins_channel1@ten1.workbench.test",
    );
  });

  test("launchInvite hydrates the target definition's body from its asset and deploys via deployInstanceAtHead", async () => {
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

    const db = createFakeDb({
      assetRow: {
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        name: "channel-1",
        displayName: null,
      },
      definitionId: "wfd_channel1",
      workflowDefinitionRow: {
        id: "wfd_echo",
        tenantId: "ten_1",
        status: "deployed",
        assetId: "asst_echo",
      },
      tenantRow: { id: "ten_1", domain: "ten1.workbench.test" },
    });
    const sessionService = createFakeSessionService();
    const assetService = createFakeAssetService({
      assetBlob: new TextEncoder().encode(CHANNEL_WORKFLOW_JSON),
    });
    const sidecarRouter = createFakeSidecarRouter();
    const eventCollectors = createFakeEventCollectors();

    const platform = createHubChatPlatform({
      db: db as never,
      sessionService,
      assetService,
      sidecarRouter,
      eventCollectors,
    });

    const launched = await platform.launchInvite({
      tenantId: "ten_1",
      creatorPrincipalId: "prin_creator",
      definitionId: "wfd_echo",
    });

    expect(launched.instanceId).toMatch(/^ins_/);
    expect(launched.address).toBe(`${launched.instanceId}@ten1.workbench.test`);

    expect(assetService.readAssetBlobCalls).toEqual([
      { assetId: "asst_echo", path: "workflow.json" },
    ]);

    expect(sessionService.deployInstanceAtHeadCalls).toHaveLength(1);
    const deployed = sessionService.deployInstanceAtHeadCalls[0] as {
      agentAddress: string;
      instanceId: string;
    };
    expect(deployed.agentAddress).toBe(launched.address);
    expect(deployed.instanceId).toBe(launched.instanceId);

    const runInsert = db.inserted.find((row) => row.table === workflowRun);
    expect(runInsert?.values).toMatchObject({
      id: launched.instanceId,
      definitionId: "wfd_echo",
      deploymentId: null,
      tenantId: "ten_1",
      address: launched.address,
      status: "running",
    });
  });

  test("launchInvite fails loud when the definition is not deployed", async () => {
    const db = createFakeDb({
      assetRow: {
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        name: "channel-1",
        displayName: null,
      },
      definitionId: "wfd_channel1",
      workflowDefinitionRow: {
        id: "wfd_echo",
        tenantId: "ten_1",
        status: "stopped",
        assetId: "asst_echo",
      },
      tenantRow: { id: "ten_1", domain: "ten1.workbench.test" },
    });
    const platform = createHubChatPlatform({
      db: db as never,
      sessionService: createFakeSessionService(),
      assetService: createFakeAssetService(),
      sidecarRouter: createFakeSidecarRouter(),
    });

    await expect(
      platform.launchInvite({
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        definitionId: "wfd_echo",
      }),
    ).rejects.toThrow(/not in a launchable state/);
  });

  test("launchInvite fails loud when no such definition exists for the tenant", async () => {
    const db = createFakeDb({
      assetRow: {
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        name: "channel-1",
        displayName: null,
      },
      definitionId: "wfd_channel1",
      workflowDefinitionRow: undefined,
      tenantRow: { id: "ten_1", domain: "ten1.workbench.test" },
    });
    const platform = createHubChatPlatform({
      db: db as never,
      sessionService: createFakeSessionService(),
      assetService: createFakeAssetService(),
      sidecarRouter: createFakeSidecarRouter(),
    });

    await expect(
      platform.launchInvite({
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        definitionId: "wfd_missing",
      }),
    ).rejects.toThrow(/no definition/);
  });

  test("listInvitableDefinitions lists deployed definitions, excluding channel hosts", async () => {
    const db = createFakeDb({
      assetRow: {
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        name: "channel-1",
        displayName: null,
      },
      definitionId: "wfd_channel1",
      workflowDefinitionRows: [
        { id: "wfd_echo", tenantId: "ten_1", status: "deployed", name: "echo" },
        {
          id: "wfd_host1",
          tenantId: "ten_1",
          status: "deployed",
          name: "ins-channel1",
        },
      ],
    });
    const platform = createHubChatPlatform({
      db: db as never,
      sessionService: createFakeSessionService(),
      assetService: createFakeAssetService(),
      sidecarRouter: createFakeSidecarRouter(),
    });

    const items = await platform.listInvitableDefinitions("ten_1");
    expect(items).toEqual([{ id: "wfd_echo", name: "echo" }]);
  });

  test("subscribeToChannel resolves the run's address and subscribes on the sidecar router", async () => {
    const db = createFakeDb({
      assetRow: {
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        name: "channel-1",
        displayName: null,
      },
      definitionId: "wfd_channel1",
      workflowRunRow: {
        id: "ins_channel1",
        address: "ins_channel1@ten1.workbench.test",
        principalId: "prin_run1",
      },
    });
    const sessionService = createFakeSessionService();
    const assetService = createFakeAssetService();
    const sidecarRouter = createFakeSidecarRouter();

    const platform = createHubChatPlatform({
      db: db as never,
      sessionService,
      assetService,
      sidecarRouter,
    });

    const events: unknown[] = [];
    const unsubscribe = platform.subscribeToChannel("ins_channel1", (event) => {
      events.push(event);
    });

    // The lookup is async (`findFirst` resolves, then `.then` runs);
    // yield past both hops of the microtask queue.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sidecarRouter.subscribeAgentCalls).toEqual([
      { address: "ins_channel1@ten1.workbench.test" },
    ]);

    unsubscribe();
  });
});
