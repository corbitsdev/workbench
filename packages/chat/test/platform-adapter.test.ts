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
import type { SessionService, SidecarRouter } from "@intx/hub-sessions";
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
}) {
  const inserted: { table: unknown; values: unknown }[] = [];

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
    async transaction(fn: (tx: unknown) => Promise<void>) {
      await fn({
        insert(table: unknown) {
          return { values: (values: unknown) => insertOn(table, values) };
        },
      });
    },
    inserted,
  };
  return fake;
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

function createFakeAssetService() {
  const createAssetCalls: unknown[] = [];
  return {
    createAssetCalls,
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
    async readAssetBlob() {
      return new Uint8Array();
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

    const platform = createHubChatPlatform({
      // Fake db, not a real drizzle instance.
      db: db as never,
      sessionService,
      assetService,
      sidecarRouter,
    });

    const launched = await platform.launchChannel({
      tenantId: "ten_1",
      creatorPrincipalId: "prin_creator",
      channelId: "ins_channel1",
      triggerAddress: "ins_channel1@ten1.workbench.test",
      definition: CHANNEL_WORKFLOW_JSON,
    });

    expect(launched.instanceId).toBe("ins_channel1");
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
