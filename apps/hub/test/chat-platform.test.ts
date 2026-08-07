// Proves `createHubChatPlatform` maps each `ChatPlatform` port method
// onto the right in-process service call: `sessionService`/
// `assetService`/`sidecarRouter` are fakes recording their calls, and
// `db` is a minimal chainable stand-in for the drizzle query builder
// (no database involved) so the mapping is exercised without a real
// Postgres.

import { describe, expect, test } from "bun:test";
import {
  agentSession,
  asset,
  sessionMail,
  workflowDefinition,
  workflowDefinitionVersion,
} from "@intx/db/schema";
import type { SessionService, SidecarRouter } from "@intx/hub-sessions";
import { createHubChatPlatform } from "../src/chat-platform.ts";

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
 * `chat-platform.ts` and the `ensureWorkflowDefinitionForAsset` helper
 * it calls to run against, keyed by table identity so each select/
 * insert resolves the row set the test configures for it.
 */
function createFakeDb(opts: {
  assetRow: {
    tenantId: string;
    creatorPrincipalId: string | null;
    name: string;
    displayName: string | null;
  };
  definitionId: string;
  workflowRunRow?: { id: string; address: string | null } | undefined;
  sessionMailRow?: { id: string; raw: Uint8Array } | undefined;
}) {
  const inserted: { table: unknown; values: unknown }[] = [];

  return {
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
          return selectChain([]);
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: unknown) {
          inserted.push({ table, values });
          if (table === workflowDefinition) {
            return insertChain([{ id: opts.definitionId }]);
          }
          if (table === workflowDefinitionVersion) {
            return insertChain([]);
          }
          return insertChain([]);
        },
      };
    },
    inserted,
    // Only reached by the listMail path in a different test.
  };
}

function createFakeSessionService(): SessionService & {
  deployWorkflowDefinitionCalls: unknown[];
  sendUserMessageCalls: unknown[];
} {
  const deployWorkflowDefinitionCalls: unknown[] = [];
  const sendUserMessageCalls: unknown[] = [];
  return {
    deployWorkflowDefinitionCalls,
    sendUserMessageCalls,
    async stageWorkflowStep() {},
    async deployInstanceAtHead() {
      return { publicKey: "unused" };
    },
    async deploySingleStepAtHead() {
      return { publicKey: "unused" };
    },
    async deployWorkflowDefinition(params: {
      deploymentId: string;
      deploymentDomain: string;
    }) {
      deployWorkflowDefinitionCalls.push(params);
      return {
        deploymentId: params.deploymentId,
        deploymentAddress: `${params.deploymentId}@${params.deploymentDomain}`,
        publicKey: "test-public-key",
      };
    },
    async sendUserMessage(params: unknown) {
      sendUserMessageCalls.push(params);
      return new TextEncoder().encode("raw-mime-bytes");
    },
    async endSession() {},
  } as unknown as SessionService & {
    deployWorkflowDefinitionCalls: unknown[];
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

const CHANNEL_WORKFLOW_JSON = JSON.stringify({
  id: "wf_channel",
  steps: {},
});

describe("createHubChatPlatform", () => {
  test("launchChannel creates a workflow asset and deploys the definition in-process", async () => {
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
    expect(sessionService.deployWorkflowDefinitionCalls).toHaveLength(1);
    const deployed = sessionService.deployWorkflowDefinitionCalls[0] as {
      tenantId: string;
      deploymentId: string;
      deploymentDomain: string;
      definitionAssetId: string;
      config: { agentAddress: string; principalId: string };
    };
    expect(deployed.tenantId).toBe("ten_1");
    expect(deployed.deploymentId).toBe("ins_channel1");
    expect(deployed.deploymentDomain).toBe("ten1.workbench.test");
    expect(deployed.definitionAssetId).toBe("asst_channel1");
    expect(deployed.config.agentAddress).toBe(
      "ins_channel1@ten1.workbench.test",
    );
    expect(deployed.config.principalId).toBe("prin_creator");

    const agentSessionInsert = db.inserted.find(
      (row) => row.table === agentSession,
    );
    expect(agentSessionInsert?.values).toMatchObject({
      id: "session_ins_channel1",
      tenantId: "ten_1",
      agentId: "wfd_channel1",
      principalId: "prin_creator",
      status: "active",
    });
  });

  test("sendMail resolves the channel's run and delivers via sessionService", async () => {
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
    expect(call.sessionId).toBe("session_ins_channel1");

    const mailInsert = db.inserted.find((row) => row.table === sessionMail);
    expect(mailInsert?.values).toMatchObject({
      sessionId: "session_ins_channel1",
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
