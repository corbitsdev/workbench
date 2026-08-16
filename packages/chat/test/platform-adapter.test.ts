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
import { channelLaunch } from "../src/schema";
import { foldedRun } from "@corbits/folded-runs";
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
const actualDrizzleOrm = await import("drizzle-orm");

// `listMail`'s keyset pagination builds its next-page predicate with
// real `lt`/`or`/`and`/`eq` calls (proven against a real Postgres in
// integration, not here). This wrapper still delegates to the real
// `lt` -- the fake `sessionMail` chain below has no SQL engine of its
// own to evaluate the resulting condition against, so it reads the
// cursor values straight off this spy instead, then filters/sorts a
// synthetic in-memory row set the same way the real predicate would.
const realLt = actualDrizzleOrm.lt;
const ltCalls: { value: unknown }[] = [];
mock.module("drizzle-orm", () => ({
  ...actualDrizzleOrm,
  // Pinning `realLt` to the function object captured above matters:
  // calling `actualDrizzleOrm.lt(...)` here instead would resolve
  // through the live module namespace binding, which `mock.module`
  // has by then repointed at this very wrapper -- an infinite loop
  // disguised as a hang, not a stack overflow.
  lt: (column: unknown, value: unknown) => {
    ltCalls.push({ value });
    return realLt(
      column as Parameters<typeof actualDrizzleOrm.lt>[0],
      value as never,
    );
  },
}));

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

/**
 * `listMail`'s own `sessionMail` chain: `.where()` reads the cursor
 * straight off `ltCalls` (the last two `lt(...)` calls the real
 * `listMail` made to build its condition -- `createdAt` then `id`,
 * per its `or(lt(createdAt, ...), and(eq(createdAt, ...), lt(id,
 * ...)))` shape) rather than interpreting the opaque SQL condition
 * object itself, then filters/sorts/limits a synthetic newest-first
 * row set the same way the real predicate would.
 */
function sessionMailSelectChain(rows: { id: string; createdAt: Date }[]) {
  let filtered = rows;
  const chain = {
    where(..._args: unknown[]) {
      if (ltCalls.length >= 2) {
        const createdAtCursor = ltCalls[ltCalls.length - 2]?.value as Date;
        const idCursor = ltCalls[ltCalls.length - 1]?.value as string;
        filtered = rows.filter(
          (row) =>
            row.createdAt.getTime() < createdAtCursor.getTime() ||
            (row.createdAt.getTime() === createdAtCursor.getTime() &&
              row.id < idCursor),
        );
      } else {
        filtered = rows;
      }
      return chain;
    },
    orderBy(..._args: unknown[]) {
      filtered = [...filtered].sort((a, b) => {
        const byDate = b.createdAt.getTime() - a.createdAt.getTime();
        if (byDate !== 0) return byDate;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
      return chain;
    },
    limit(n?: number) {
      return Promise.resolve(n === undefined ? filtered : filtered.slice(0, n));
    },
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
    | {
        id: string;
        address: string | null;
        principalId: string | null;
        definitionId?: string;
      }
    | undefined;
  sessionMailRow?: { id: string; raw: Uint8Array } | undefined;
  /**
   * A full synthetic `session_mail` table, newest-first, for
   * `listMail`'s keyset-pagination tests. `select().from(sessionMail)`
   * filters it using the cursor values `ltCalls` captures off the real
   * `lt` calls `listMail` makes, then re-sorts/limits -- the same
   * predicate the real SQL condition encodes, evaluated in JS since
   * this fake has no SQL engine of its own.
   */
  sessionMailRows?:
    { id: string; createdAt: Date; raw: Uint8Array }[] | undefined;
  workflowDefinitionRow?:
    | { id: string; tenantId: string; status: string; assetId: string | null }
    | undefined;
  workflowDefinitionRows?:
    | {
        id: string;
        tenantId: string;
        status: string;
        name: string;
        description?: string;
      }[]
    | undefined;
  tenantRow?: { id: string; domain: string } | undefined;
  channelLaunchRow?:
    | {
        tenantId: string;
        instanceId: string;
        foldedBody: unknown;
        noopInference?: boolean;
      }
    | undefined;
}) {
  const inserted: { table: unknown; values: unknown }[] = [];
  const updated: { table: unknown; values: unknown }[] = [];
  const deleted: { table: unknown }[] = [];

  function updateOn(table: unknown): UpdateChain {
    return {
      set(values: unknown) {
        updated.push({ table, values });
        // `channelLaunchRow` backs every subsequent `select().from(channelLaunch)`
        // by reference (see below) — mutating it in place here is what lets a
        // test prove a write is actually visible to a later read, not just that
        // `update` was called with the right shape.
        if (table === channelLaunch && opts.channelLaunchRow !== undefined) {
          Object.assign(opts.channelLaunchRow, values as object);
        }
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
          if (table === channelLaunch) {
            return selectChain(
              opts.channelLaunchRow !== undefined
                ? [opts.channelLaunchRow]
                : [],
            );
          }
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
          if (table === sessionMail) {
            return sessionMailSelectChain(opts.sessionMailRows ?? []);
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

function createFakeEventCollectors(
  opts: { busyAddresses?: Set<string> } = {},
): EventCollectorRegistry & {
  createCalls: unknown[];
  abandonCalls: string[];
} {
  const createCalls: unknown[] = [];
  const abandonCalls: string[] = [];
  const busyAddresses = opts.busyAddresses ?? new Set<string>();
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
    getCurrentTurnId: (address: string) =>
      busyAddresses.has(address) ? "turn_1" : null,
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

function createFakeSidecarRouter(
  opts: { routableAddresses?: string[] } = {},
): SidecarRouter & {
  subscribeAgentCalls: { address: string }[];
  dispatchAgentEventCalls: { address: string; event: unknown }[];
  sendAgentUndeployCalls: { address: string; reason: string }[];
  routableAddresses: string[];
  agentCallbacks: Map<string, (event: unknown) => void>;
} {
  const subscribeAgentCalls: { address: string }[] = [];
  const dispatchAgentEventCalls: { address: string; event: unknown }[] = [];
  const sendAgentUndeployCalls: { address: string; reason: string }[] = [];
  // Existing tests never exercise wake-on-mail and predate
  // `getRoutableAddresses` entirely; defaulting to "everything is
  // routable" (rather than an empty list) keeps them passing without
  // every one of them having to name its own address as routable.
  // Tests that specifically exercise the idle-sleep/wake behavior pass
  // `routableAddresses` explicitly.
  const routableAll = opts.routableAddresses === undefined;
  const routableAddresses = opts.routableAddresses ?? [];
  const agentCallbacks = new Map<string, (event: unknown) => void>();
  return {
    subscribeAgentCalls,
    dispatchAgentEventCalls,
    sendAgentUndeployCalls,
    routableAddresses,
    agentCallbacks,
    subscribeAgent(address: string, cb: (event: unknown) => void) {
      subscribeAgentCalls.push({ address });
      agentCallbacks.set(address, cb);
      return () => undefined;
    },
    dispatchAgentEvent(address: string, event: unknown) {
      dispatchAgentEventCalls.push({ address, event });
    },
    async sendAgentUndeploy(address: string, reason: string) {
      sendAgentUndeployCalls.push({ address, reason });
    },
    getRoutableAddresses() {
      return routableAll
        ? ({ includes: () => true } as unknown as string[])
        : routableAddresses;
    },
  } as unknown as SidecarRouter & {
    subscribeAgentCalls: { address: string }[];
    dispatchAgentEventCalls: { address: string; event: unknown }[];
    sendAgentUndeployCalls: { address: string; reason: string }[];
    routableAddresses: string[];
    agentCallbacks: Map<string, (event: unknown) => void>;
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
  test("launchChannel extracts the folded body, pins the noop inference source, and deploys via deployInstanceAtHead without touching the catalog", async () => {
    resolveDefinitionSourcesCalls.length = 0;
    // Deliberately left `ok: false`: a host launch must never reach
    // `resolveDefinitionSources` at all, so this stub result — which
    // would fail the launch if it were ever consulted — proves the
    // catalog path was skipped, not merely that it happened to
    // succeed.
    resolveDefinitionSourcesResult = {
      ok: false,
      message: "the catalog must not be consulted for a channel host",
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
      noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
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

    // The catalog was never consulted — the noop pin is used verbatim.
    expect(resolveDefinitionSourcesCalls).toHaveLength(0);

    // The folded launch path, never the native workflow-deploy path.
    expect(sessionService.deployInstanceAtHeadCalls).toHaveLength(1);
    const deployed = sessionService.deployInstanceAtHeadCalls[0] as {
      agentAddress: string;
      agentId: string;
      runId: string;
      config: {
        systemPrompt: string;
        sources: {
          id: string;
          provider: string;
          baseURL: string;
          apiKey: string;
          model: string;
        }[];
        defaultSource: string;
        agentAddress: string;
        tenantId: string;
      };
    };
    expect(deployed.agentAddress).toBe("ins_channel1@ten1.workbench.test");
    expect(deployed.agentId).toBe("ins_channel1");
    expect(deployed.runId).toBe("ins_channel1");
    expect(deployed.config.systemPrompt.length).toBeGreaterThan(0);
    expect(deployed.config.sources).toEqual([
      {
        id: "noop",
        provider: "anthropic",
        baseURL: "https://hub.invalid/api/chat/noop-inference",
        apiKey: "noop",
        model: "claude-sonnet-5",
      },
    ]);
    expect(deployed.config.defaultSource).toBe("noop");
    expect(deployed.config.tenantId).toBe("ten_1");

    // The launch row records this as a host launch, so a later wake
    // pins the same noop source rather than resolving against the
    // catalog.
    const channelLaunchInsert = db.inserted.find(
      (row) => row.table === channelLaunch,
    );
    expect(channelLaunchInsert?.values).toMatchObject({
      noopInference: true,
    });

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
      anchorRunId: "ins_channel1",
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
      noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
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

    // The run row and its `@corbits/folded-runs`-owned folded-run
    // marker (see `launchFoldedRun`'s own doc comment) are rolled back
    // together.
    expect(db.deleted).toEqual([{ table: workflowRun }, { table: foldedRun }]);

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
      noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
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

  // A channel host's noop pin is a deliberate improvement over the
  // pre-existing behavior: launching a channel no longer needs any
  // catalog source seeded at all (see the primary launchChannel test
  // above, which proves this with `resolveDefinitionSourcesResult`
  // forced to `ok: false`). An invited agent's launch is unaffected —
  // its replies are real, so it still fails loud without a catalog
  // source; proven alongside `launchInvite`'s other tests below.

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
      noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
      sessionService,
      assetService: createFakeAssetService(),
      sidecarRouter,
      eventCollectors: createFakeEventCollectors(),
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
      noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
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

    expect(launched.instanceId).toMatch(/^run_/);
    expect(launched.address).toBe(`${launched.instanceId}@ten1.workbench.test`);

    expect(assetService.readAssetBlobCalls).toEqual([
      { assetId: "asst_echo", path: "workflow.json" },
    ]);

    expect(sessionService.deployInstanceAtHeadCalls).toHaveLength(1);
    const deployed = sessionService.deployInstanceAtHeadCalls[0] as {
      agentAddress: string;
      runId: string;
    };
    expect(deployed.agentAddress).toBe(launched.address);
    expect(deployed.runId).toBe(launched.instanceId);

    const runInsert = db.inserted.find((row) => row.table === workflowRun);
    expect(runInsert?.values).toMatchObject({
      id: launched.instanceId,
      definitionId: "wfd_echo",
      anchorRunId: launched.instanceId,
      tenantId: "ten_1",
      address: launched.address,
      status: "running",
    });

    // Sources were resolved against the tenant catalog, not pinned to
    // the noop endpoint — only a channel host gets that pin.
    expect(resolveDefinitionSourcesCalls).toHaveLength(1);

    // The launch row records this as not a host, so a later wake
    // resolves against the catalog rather than pinning the noop
    // source.
    const channelLaunchInsert = db.inserted.find(
      (row) => row.table === channelLaunch,
    );
    expect(channelLaunchInsert?.values).toMatchObject({
      noopInference: false,
    });
  });

  // An invited agent's credential secret must be decrypted with the same
  // real cipher the composition root's credential-write route encrypts it
  // with. `createHubChatPlatform`'s own `credentialCipher` dep must reach
  // `resolveDefinitionSources` on every launch, or the raw stored secret
  // (ciphertext, if it was ever encrypted) gets handed to the provider as
  // its API key instead of the decrypted plaintext.
  test("launchInvite threads credentialCipher through to resolveDefinitionSources", async () => {
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
    const credentialCipher = {
      encrypt: async (plaintext: string) => plaintext,
      decrypt: async (blob: string) => blob,
    };

    const platform = createHubChatPlatform({
      db: db as never,
      noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
      sessionService,
      assetService,
      sidecarRouter,
      eventCollectors,
      credentialCipher,
    });

    await platform.launchInvite({
      tenantId: "ten_1",
      creatorPrincipalId: "prin_creator",
      definitionId: "wfd_echo",
    });

    expect(resolveDefinitionSourcesCalls).toHaveLength(1);
    expect(resolveDefinitionSourcesCalls[0]).toMatchObject({
      tenantId: "ten_1",
      credentialCipher,
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
      noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
      sessionService: createFakeSessionService(),
      assetService: createFakeAssetService(),
      sidecarRouter: createFakeSidecarRouter(),
      eventCollectors: createFakeEventCollectors(),
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
      noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
      sessionService: createFakeSessionService(),
      assetService: createFakeAssetService(),
      sidecarRouter: createFakeSidecarRouter(),
      eventCollectors: createFakeEventCollectors(),
    });

    await expect(
      platform.launchInvite({
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        definitionId: "wfd_missing",
      }),
    ).rejects.toThrow(/No definition/);
  });

  // Unlike a channel host, an invited agent's replies are real: its
  // launch still resolves against the tenant catalog and still fails
  // loud when the catalog has no launchable source — the noop pin
  // never applies here.
  test("launchInvite fails loud when the tenant catalog has no launchable source", async () => {
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
      workflowDefinitionRow: {
        id: "wfd_echo",
        tenantId: "ten_1",
        status: "deployed",
        assetId: "asst_echo",
      },
      tenantRow: { id: "ten_1", domain: "ten1.workbench.test" },
    });
    const platform = createHubChatPlatform({
      db: db as never,
      noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
      sessionService: createFakeSessionService(),
      assetService: createFakeAssetService({
        assetBlob: new TextEncoder().encode(CHANNEL_WORKFLOW_JSON),
      }),
      sidecarRouter: createFakeSidecarRouter(),
      eventCollectors: createFakeEventCollectors(),
    });

    await expect(
      platform.launchInvite({
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        definitionId: "wfd_echo",
      }),
    ).rejects.toThrow(/seed a tenant catalog source/);
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
        {
          id: "wfd_echo",
          tenantId: "ten_1",
          status: "deployed",
          name: "echo",
          description: "Echo",
        },
        {
          id: "wfd_host1",
          tenantId: "ten_1",
          status: "deployed",
          name: "ins-0f1e2d3c4b5a69788796a5b4c3d2e1f0",
        },
        {
          id: "wfd_host2",
          tenantId: "ten_1",
          status: "deployed",
          name: "run-682bf127e22124c01b4b0996aabaab5f",
        },
      ],
    });
    const platform = createHubChatPlatform({
      db: db as never,
      noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
      sessionService: createFakeSessionService(),
      assetService: createFakeAssetService(),
      sidecarRouter: createFakeSidecarRouter(),
      eventCollectors: createFakeEventCollectors(),
    });

    const items = await platform.listInvitableDefinitions("ten_1");
    expect(items).toEqual([
      { id: "wfd_echo", name: "echo", description: "Echo" },
    ]);
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
      noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
      sessionService,
      assetService,
      sidecarRouter,
      eventCollectors: createFakeEventCollectors(),
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

  describe("listMail", () => {
    test("walks three pages via keyset pagination, with a stable order across a createdAt tie", async () => {
      const RAW_MIME = new TextEncoder().encode(
        "Content-Type: text/plain\r\n\r\nhello",
      );
      const totalRows = 105;
      const baseTime = new Date("2024-01-01T00:00:00Z").getTime();
      const sessionMailRows: {
        id: string;
        createdAt: Date;
        raw: Uint8Array;
      }[] = [];
      for (let i = 0; i < totalRows; i++) {
        sessionMailRows.push({
          id: `mail_${String(999 - i).padStart(4, "0")}`,
          createdAt: new Date(baseTime - i * 1_000),
          raw: RAW_MIME,
        });
      }
      // Force a tie: the two oldest rows share one createdAt, so only
      // the id tiebreak (descending) can order them -- proving the
      // cursor comparison is `(createdAt, id) < (cursor.createdAt,
      // cursor.id)`, not `createdAt` alone.
      const oldest = sessionMailRows[totalRows - 1];
      const secondOldest = sessionMailRows[totalRows - 2];
      if (oldest === undefined || secondOldest === undefined) {
        throw new Error("unreachable: totalRows >= 2");
      }
      oldest.createdAt = secondOldest.createdAt;

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
        sessionMailRows,
      });
      db.inserted.push({
        table: agentSession,
        values: { id: "ses_run1", principalId: "prin_run1" },
      });

      const platform = createHubChatPlatform({
        db: db as never,
        noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
        sessionService: createFakeSessionService(),
        assetService: createFakeAssetService(),
        sidecarRouter: createFakeSidecarRouter(),
        eventCollectors: createFakeEventCollectors(),
      });

      const expectedIds = sessionMailRows.map((row) => row.id);

      ltCalls.length = 0;
      const page1 = await platform.listMail({
        tenantId: "ten_1",
        channelId: "ins_channel1",
      });
      expect(page1.items.map((item) => item.id)).toEqual(
        expectedIds.slice(0, 50),
      );
      expect(page1.nextCursor).toBeDefined();

      ltCalls.length = 0;
      const nextCursorAfterPage1 = page1.nextCursor;
      if (nextCursorAfterPage1 === undefined) {
        throw new Error("unreachable: asserted defined above");
      }
      const page2 = await platform.listMail({
        tenantId: "ten_1",
        channelId: "ins_channel1",
        cursor: nextCursorAfterPage1,
      });
      expect(page2.items.map((item) => item.id)).toEqual(
        expectedIds.slice(50, 100),
      );
      expect(page2.nextCursor).toBeDefined();

      ltCalls.length = 0;
      const nextCursorAfterPage2 = page2.nextCursor;
      if (nextCursorAfterPage2 === undefined) {
        throw new Error("unreachable: asserted defined above");
      }
      const page3 = await platform.listMail({
        tenantId: "ten_1",
        channelId: "ins_channel1",
        cursor: nextCursorAfterPage2,
      });
      // The last five rows, including the tie -- ordered by the id
      // tiebreak, not left in storage order or truncated to [].
      expect(page3.items.map((item) => item.id)).toEqual(
        expectedIds.slice(100, 105),
      );
      expect(page3.nextCursor).toBeUndefined();
    });
  });

  // The idle-sleep sweep's own gates (idle sleeps, active/busy/untracked
  // spared, first-sighting grace) and `ensureAwake`'s coalescing are
  // `@corbits/agent-lifecycle`'s own contract, proven in
  // `packages/agent-lifecycle/test/index.test.ts`, not re-proven here.
  // What belongs here is the wiring: that `createHubChatPlatform` only
  // builds a lifecycle (and only ever calls `ensureAwake`/`recordActivity`)
  // when `deps.lifecycle` is configured, and that `sendMail` actually
  // redeploys a non-routable target before sending.
  describe("lifecycle wiring", () => {
    test("sendMail wakes a non-routable channel by redeploying before sending, then sends", async () => {
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
          definitionId: "wfd_channel1",
        },
        workflowDefinitionRow: {
          id: "wfd_channel1",
          tenantId: "ten_1",
          status: "deployed",
          assetId: "asst_channel1",
        },
        channelLaunchRow: {
          tenantId: "ten_1",
          instanceId: "ins_channel1",
          foldedBody: {
            systemPrompt: "host prompt",
            model: "claude-sonnet-5",
            toolPackagePins: [],
            grantRequirements: [],
            credentialBindings: [],
          },
        },
      });
      db.inserted.push({
        table: agentSession,
        values: { id: "ses_run1", principalId: "prin_run1" },
      });

      const sessionService = createFakeSessionService();
      // Not in the sidecar's routable set: this channel is asleep (or
      // never came back after a restart) when the send arrives.
      const sidecarRouter = createFakeSidecarRouter({ routableAddresses: [] });
      const eventCollectors = createFakeEventCollectors();
      const assetService = createFakeAssetService({
        assetBlob: new TextEncoder().encode(CHANNEL_WORKFLOW_JSON),
      });

      const platform = createHubChatPlatform({
        db: db as never,
        noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
        sessionService,
        assetService,
        sidecarRouter,
        eventCollectors,
        lifecycle: { idleSleepMs: 60_000 },
      });

      const sent = await platform.sendMail({
        tenantId: "ten_1",
        channelId: "ins_channel1",
        principalId: "prin_sender",
        content: { content: "wake up" },
      });

      expect(sent.id).toBeTruthy();
      // The redeploy happened...
      expect(sessionService.deployInstanceAtHeadCalls).toHaveLength(1);
      const deployed = sessionService.deployInstanceAtHeadCalls[0] as {
        agentAddress: string;
        runId: string;
      };
      expect(deployed.agentAddress).toBe("ins_channel1@ten1.workbench.test");
      expect(deployed.runId).toBe("ins_channel1");
      // ...before the send.
      expect(sessionService.sendUserMessageCalls).toHaveLength(1);
    });

    test("waking a host launch pins the noop source again, never touching the catalog", async () => {
      resolveDefinitionSourcesCalls.length = 0;
      // Forced to fail if ever consulted, same posture as the
      // launchChannel test above: proves the wake path skips the
      // catalog entirely for a host launch, rather than merely
      // happening to succeed against it.
      resolveDefinitionSourcesResult = {
        ok: false,
        message: "the catalog must not be consulted for a host wake",
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
          definitionId: "wfd_channel1",
        },
        workflowDefinitionRow: {
          id: "wfd_channel1",
          tenantId: "ten_1",
          status: "deployed",
          assetId: "asst_channel1",
        },
        channelLaunchRow: {
          tenantId: "ten_1",
          instanceId: "ins_channel1",
          noopInference: true,
          foldedBody: {
            systemPrompt: "host prompt",
            model: "claude-sonnet-5",
            toolPackagePins: [],
            grantRequirements: [],
            credentialBindings: [],
          },
        },
      });
      db.inserted.push({
        table: agentSession,
        values: { id: "ses_run1", principalId: "prin_run1" },
      });

      const sessionService = createFakeSessionService();
      const sidecarRouter = createFakeSidecarRouter({ routableAddresses: [] });
      const eventCollectors = createFakeEventCollectors();
      const assetService = createFakeAssetService({
        assetBlob: new TextEncoder().encode(CHANNEL_WORKFLOW_JSON),
      });

      const platform = createHubChatPlatform({
        db: db as never,
        noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
        sessionService,
        assetService,
        sidecarRouter,
        eventCollectors,
        lifecycle: { idleSleepMs: 60_000 },
      });

      await platform.sendMail({
        tenantId: "ten_1",
        channelId: "ins_channel1",
        principalId: "prin_sender",
        content: { content: "wake up" },
      });

      expect(resolveDefinitionSourcesCalls).toHaveLength(0);
      expect(sessionService.deployInstanceAtHeadCalls).toHaveLength(1);
      const deployed = sessionService.deployInstanceAtHeadCalls[0] as {
        config: {
          sources: {
            id: string;
            provider: string;
            baseURL: string;
            apiKey: string;
            model: string;
          }[];
          defaultSource: string;
        };
      };
      expect(deployed.config.sources).toEqual([
        {
          id: "noop",
          provider: "anthropic",
          baseURL: "https://hub.invalid/api/chat/noop-inference",
          apiKey: "noop",
          model: "claude-sonnet-5",
        },
      ]);
      expect(deployed.config.defaultSource).toBe("noop");
    });

    test("the idle sweep never undeploys an address the event collector reports as busy", async () => {
      // The sweep's `setInterval` otherwise keeps the process's event
      // loop alive past this test; `unref` it exactly as the
      // sweep-interval tests below do.
      const originalSetInterval = globalThis.setInterval;
      globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
        const timer = originalSetInterval(...args);
        timer.unref?.();
        return timer;
      }) as typeof setInterval;

      const address = "ins_channel1@ten1.workbench.test";
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
          address,
          principalId: "prin_run1",
        },
      });
      db.inserted.push({
        table: agentSession,
        values: { id: "ses_run1", principalId: "prin_run1" },
      });

      const sidecarRouter = createFakeSidecarRouter({
        routableAddresses: [address],
      });
      // The registry reports a live turn for this address -- the
      // event-activity heuristic ("any event counts as activity") is
      // not the only thing standing between a mid-turn agent and the
      // idle sweep; `isBusy` must independently spare it too, and stay
      // spared even once `recordActivity`'s own clock goes stale.
      const eventCollectors = createFakeEventCollectors({
        busyAddresses: new Set([address]),
      });

      const platform = createHubChatPlatform({
        db: db as never,
        noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
        sessionService: createFakeSessionService(),
        assetService: createFakeAssetService(),
        sidecarRouter,
        eventCollectors,
        lifecycle: { idleSleepMs: 5, sweepIntervalMs: 5 },
      });

      // A single send tracks the address and records one activity
      // timestamp; nothing else touches it afterwards, so by the time
      // the sweep ticks past `idleSleepMs` the event-activity heuristic
      // alone would no longer spare it.
      await platform.sendMail({
        tenantId: "ten_1",
        channelId: "ins_channel1",
        principalId: "prin_sender",
        content: { content: "hello" },
      });

      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(sidecarRouter.sendAgentUndeployCalls).toEqual([]);
      globalThis.setInterval = originalSetInterval;
    });

    test("createHubChatPlatform installs no sweep interval when lifecycle is not configured", () => {
      const originalSetInterval = globalThis.setInterval;
      let setIntervalCalls = 0;
      globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
        setIntervalCalls += 1;
        return originalSetInterval(...args);
      }) as typeof setInterval;

      try {
        const db = createFakeDb({
          assetRow: {
            tenantId: "ten_1",
            creatorPrincipalId: "prin_creator",
            name: "channel-1",
            displayName: null,
          },
          definitionId: "wfd_channel1",
        });
        createHubChatPlatform({
          db: db as never,
          noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
          sessionService: createFakeSessionService(),
          assetService: createFakeAssetService(),
          sidecarRouter: createFakeSidecarRouter(),
          eventCollectors: createFakeEventCollectors(),
        });
        expect(setIntervalCalls).toBe(0);
      } finally {
        globalThis.setInterval = originalSetInterval;
      }
    });

    test("createHubChatPlatform installs a sweep interval when lifecycle is configured", () => {
      const originalSetInterval = globalThis.setInterval;
      let setIntervalCalls = 0;
      globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
        setIntervalCalls += 1;
        const timer = originalSetInterval(...args);
        timer.unref?.();
        return timer;
      }) as typeof setInterval;

      try {
        const db = createFakeDb({
          assetRow: {
            tenantId: "ten_1",
            creatorPrincipalId: "prin_creator",
            name: "channel-1",
            displayName: null,
          },
          definitionId: "wfd_channel1",
        });
        createHubChatPlatform({
          db: db as never,
          noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
          sessionService: createFakeSessionService(),
          assetService: createFakeAssetService(),
          sidecarRouter: createFakeSidecarRouter(),
          eventCollectors: createFakeEventCollectors(),
          lifecycle: { idleSleepMs: 60_000 },
        });
        expect(setIntervalCalls).toBe(1);
      } finally {
        globalThis.setInterval = originalSetInterval;
      }
    });
  });

  // Proves the actual lever an edited system prompt reaches a running
  // instance through: `wakeFoldedRun` (exercised via `sendMail`'s
  // wake-on-send path above) replays `channel_launch.foldedBody`
  // verbatim and never reads the definition's asset itself, so a
  // definition edit only reaches a running instance if something
  // recomputes that row from the definition's current asset content —
  // this is that something.
  describe("refreshAgentInstanceFromDefinition", () => {
    const NEW_WORKFLOW_JSON = JSON.stringify({
      id: "wf_agent1",
      stepOrder: ["agent"],
      steps: {
        agent: {
          kind: "step",
          agent: {
            systemPrompt: "You are now a blunt, no-nonsense assistant.",
            toolPackagePins: [],
            inference: { sources: [{ model: "claude-sonnet-5" }] },
          },
        },
      },
      grantRequirements: [],
      credentialBindings: [],
    });

    function buildRefreshableDb() {
      return createFakeDb({
        // Unused by this describe block's tests (no launch/asset-creation
        // path is exercised) — required only because `createFakeDb`'s
        // options type demands them for the launchChannel-shaped tests
        // above.
        assetRow: {
          tenantId: "ten_1",
          creatorPrincipalId: null,
          name: "unused",
          displayName: null,
        },
        definitionId: "wfd_unused",
        workflowRunRow: {
          id: "run_agent1",
          address: "agent1@ten1.workbench.test",
          principalId: "prin_agent1",
          definitionId: "wfd_agent1",
        },
        workflowDefinitionRow: {
          id: "wfd_agent1",
          tenantId: "ten_1",
          status: "deployed",
          assetId: "asst_agent1",
        },
        channelLaunchRow: {
          tenantId: "ten_1",
          instanceId: "run_agent1",
          foldedBody: {
            systemPrompt: "You are a careful research assistant.",
            model: "claude-sonnet-5",
            toolPackagePins: [],
            grantRequirements: [],
            credentialBindings: [],
          },
        },
      });
    }

    test("recomputes and persists the folded body from the definition's current asset", async () => {
      const db = buildRefreshableDb();
      const platform = createHubChatPlatform({
        db: db as never,
        noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
        sessionService: createFakeSessionService(),
        assetService: createFakeAssetService({
          assetBlob: new TextEncoder().encode(NEW_WORKFLOW_JSON),
        }),
        sidecarRouter: createFakeSidecarRouter(),
        eventCollectors: createFakeEventCollectors(),
      });

      await platform.refreshAgentInstanceFromDefinition(
        "ten_1",
        "ch_1",
        "agent1@ten1.workbench.test",
      );

      const launchUpdate = db.updated.find(
        (row) => row.table === channelLaunch,
      );
      expect(
        (launchUpdate?.values as { foldedBody: { systemPrompt: string } })
          .foldedBody.systemPrompt,
      ).toBe("You are now a blunt, no-nonsense assistant.");
    });

    test("a refreshed instance's next wake uses the new system prompt, not the one frozen at launch", async () => {
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

      const db = buildRefreshableDb();
      db.inserted.push({
        table: agentSession,
        values: { id: "ses_agent1", principalId: "prin_agent1" },
      });
      const sessionService = createFakeSessionService();
      const platform = createHubChatPlatform({
        db: db as never,
        noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
        sessionService,
        assetService: createFakeAssetService({
          assetBlob: new TextEncoder().encode(NEW_WORKFLOW_JSON),
        }),
        // Not in the sidecar's routable set: the instance is asleep, so
        // the next send must wake it — reading whatever
        // `channel_launch` holds at that moment.
        sidecarRouter: createFakeSidecarRouter({ routableAddresses: [] }),
        eventCollectors: createFakeEventCollectors(),
        lifecycle: { idleSleepMs: 60_000 },
      });

      await platform.refreshAgentInstanceFromDefinition(
        "ten_1",
        "ch_1",
        "agent1@ten1.workbench.test",
      );

      await platform.sendMail({
        tenantId: "ten_1",
        channelId: "run_agent1",
        principalId: "prin_sender",
        content: { content: "hello" },
      });

      expect(sessionService.deployInstanceAtHeadCalls).toHaveLength(1);
      const deployed = sessionService.deployInstanceAtHeadCalls[0] as {
        config: { systemPrompt: string };
      };
      expect(deployed.config.systemPrompt).toBe(
        "You are now a blunt, no-nonsense assistant.",
      );
    });
  });
});
