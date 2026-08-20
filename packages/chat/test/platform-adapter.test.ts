// Proves `createHubChatPlatform` maps each `ChatPlatform` port method
// onto the right in-process service call. `launchWorkbench` in
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
// `launchWorkbench`'s own wiring. `resolveDefinitionSources` itself is
// `@intx/hub-api`'s own contract, not this package's, and is not
// re-proven here.
//
// `sessionService`/`assetService`/`sidecarRouter` are fakes recording
// their calls, and `db` is a minimal chainable stand-in for the
// drizzle query builder (no database involved) so the mapping is
// exercised without a real Postgres.

import { describe, expect, mock, test } from "bun:test";
import type { FoldedRunsDeps } from "@corbits/folded-runs";
import {
  agentSession,
  asset,
  principal,
  sessionMail,
  workflowDefinition,
  workflowDefinitionVersion,
  workflowRun,
} from "@intx/db/schema";
import { workbenchLaunch } from "../src/schema";
import {
  foldedRun,
  DefinitionAssetUnresolvableError,
} from "@corbits/folded-runs";
import { IDLE_HIBERNATE_UNDEPLOY_REASON } from "@corbits/agent-lifecycle";
import { SessionLaunchError } from "@intx/hub-sessions";
import type { EventCollectorRegistry, SidecarRouter } from "@intx/hub-sessions";
import type { DefinitionSourceResolution } from "@intx/hub-api";
import {
  buildWorkbenchHostWorkflow,
  serializeWorkbenchHostWorkflow,
} from "../src/workbench-workflow";

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
    | {
        id: string;
        address: string | null;
        principalId: string | null;
        definitionId?: string;
        status?: string;
      }
    | undefined;
  /**
   * `select().from(foldedRun).where(eq(foldedRun.id, ...))` backing
   * `isFoldedRunSettled`'s marker check -- `true` (the default) means
   * the configured `workflowRunRow` is a folded run, matching every
   * run `createHubChatPlatform` itself ever launches; `false` proves
   * the predicate does not fire for a plain "completed" status alone.
   */
  foldedRunMarker?: boolean;
  sessionMailRow?: { id: string; raw: Uint8Array } | undefined;
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
        assetId?: string | null;
      }[]
    | undefined;
  tenantRow?: { id: string; domain: string } | undefined;
  workbenchLaunchRow?:
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
        // `workbenchLaunchRow` backs every subsequent `select().from(workbenchLaunch)`
        // by reference (see below) — mutating it in place here is what lets a
        // test prove a write is actually visible to a later read, not just that
        // `update` was called with the right shape.
        if (
          table === workbenchLaunch &&
          opts.workbenchLaunchRow !== undefined
        ) {
          Object.assign(opts.workbenchLaunchRow, values as object);
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
        findFirst: async () =>
          opts.workflowRunRow ??
          (inserted.findLast((row) => row.table === workflowRun)?.values as
            typeof opts.workflowRunRow | undefined),
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
          if (table === workflowRun) {
            // `deployAtHead` joins the run to its definition asset — the
            // asset its per-run workflow source tree is committed into.
            return {
              innerJoin: () => selectChain([{ assetId: "ast_definition1" }]),
            };
          }
          if (table === asset) return selectChain([opts.assetRow]);
          if (table === workbenchLaunch) {
            const insertedLaunch = inserted.findLast(
              (row) => row.table === workbenchLaunch,
            )?.values;
            return selectChain(
              opts.workbenchLaunchRow !== undefined
                ? [opts.workbenchLaunchRow]
                : insertedLaunch !== undefined
                  ? [insertedLaunch]
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
          if (table === foldedRun) {
            const marker = opts.foldedRunMarker ?? true;
            const runId =
              opts.workflowRunRow?.id ??
              (
                inserted.findLast((row) => row.table === foldedRun)?.values as
                  { id: string } | undefined
              )?.id;
            return selectChain(
              marker && runId !== undefined ? [{ id: runId }] : [],
            );
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
    // The rollback path (CL-6128) runs its update/delete statements inside
    // the transaction too, so the tx handle mirrors the outer surface.
    async transaction(fn: (tx: unknown) => Promise<void>) {
      await fn({
        insert(table: unknown) {
          return { values: (values: unknown) => insertOn(table, values) };
        },
        update(table: unknown) {
          return updateOn(table);
        },
        delete(table: unknown) {
          return deleteOn(table);
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

type AdoptedDeployCall = {
  anchorRunId: string;
  agentAddress: string;
};

type FakeSessionService = FoldedRunsDeps["sessionService"] & {
  adoptedDeployCalls: unknown[];
  sendUserMessageCalls: unknown[];
};

function createFakeSessionService(): FakeSessionService {
  const adoptedDeployCalls: unknown[] = [];
  const sendUserMessageCalls: unknown[] = [];
  return {
    adoptedDeployCalls,
    sendUserMessageCalls,
    async stageWorkflowStep() {},
    async deployInstanceAtHead() {
      throw new Error(
        "deployInstanceAtHead must not be called: a folded run deploys " +
          "its own rendered workflow source package",
      );
    },
    async deployAdoptedWorkflowFromSource(params: AdoptedDeployCall) {
      adoptedDeployCalls.push(params);
      return {
        anchorRunId: params.anchorRunId,
        deploymentAddress: params.agentAddress,
        publicKey: "test-public-key",
      };
    },
    async deployWorkflowDefinition() {
      throw new Error(
        "deployWorkflowDefinition must not be called: launchWorkbench " +
          "launches a folded run through the adopting code-sourced front",
      );
    },
    async sendUserMessage(params: unknown) {
      sendUserMessageCalls.push(params);
      return new TextEncoder().encode("raw-mime-bytes");
    },
    async endSession() {},
  } as unknown as FakeSessionService;
}

function createFakeAssetService(
  opts: {
    assetBlob?: Uint8Array;
    /**
     * Per-asset overrides for `readAssetBlob`: an unresolvable ref
     * (CL-6357) is a fake `Error`, a resolvable one a real blob. Falls
     * back to `assetBlob` (or an empty blob) for any assetId not
     * listed here, matching every pre-existing test's single-asset
     * shape.
     */
    blobsByAssetId?: Record<string, Uint8Array | "unresolvable">;
  } = {},
) {
  const createAssetCalls: unknown[] = [];
  const readAssetBlobCalls: unknown[] = [];
  return {
    createAssetCalls,
    readAssetBlobCalls,
    async createAsset(params: unknown) {
      createAssetCalls.push(params);
      return {
        id: "asst_workbench1",
        tenantId: "ten_1",
        kind: "workflow" as const,
        name: "workbench",
        displayName: null,
        creatorPrincipalId: "prin_creator",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
    async populateAsset() {
      return { commitSha: "unused" };
    },
    async readAssetBlob(params: { assetId: string; path: string }) {
      readAssetBlobCalls.push(params);
      const override = opts.blobsByAssetId?.[params.assetId];
      if (override === "unresolvable") {
        throw new Error(
          `readAssetBlob: asset ${params.assetId} refs/heads/main not resolvable`,
        );
      }
      return override ?? opts.assetBlob ?? new Uint8Array();
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
  sendRunGrantsCalls: { address: string; runId: string; stepGrants: unknown }[];
  routableAddresses: string[];
  agentCallbacks: Map<string, (event: unknown) => void>;
} {
  const subscribeAgentCalls: { address: string }[] = [];
  const dispatchAgentEventCalls: { address: string; event: unknown }[] = [];
  const sendAgentUndeployCalls: { address: string; reason: string }[] = [];
  const sendRunGrantsCalls: {
    address: string;
    runId: string;
    stepGrants: unknown;
  }[] = [];
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
    sendRunGrantsCalls,
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
      // Mirrors `removeAgentAddress`
      // (`vendor/intx/hub-sessions/src/ws/sidecar-handler.ts`): a real
      // undeploy always clears the address out of the routable set it
      // resolved through, regardless of success or failure.
      const index = routableAddresses.indexOf(address);
      if (index !== -1) routableAddresses.splice(index, 1);
    },
    getRoutableAddresses() {
      return routableAll
        ? ({ includes: () => true } as unknown as string[])
        : routableAddresses;
    },
    // Every launch and wake produces the run's `run.grants` frame before its
    // first mail. Always routable: the frame is sent after the deploy the
    // fake `sessionService` just acked, and that deploy is what makes the
    // address resident — `routableAddresses` models residency BEFORE the
    // wake (what `getRoutableAddresses` answers), not after it.
    sendRunGrants(address: string, runId: string, stepGrants: unknown) {
      sendRunGrantsCalls.push({ address, runId, stepGrants });
      return true;
    },
  } as unknown as SidecarRouter & {
    subscribeAgentCalls: { address: string }[];
    dispatchAgentEventCalls: { address: string; event: unknown }[];
    sendAgentUndeployCalls: { address: string; reason: string }[];
    sendRunGrantsCalls: {
      address: string;
      runId: string;
      stepGrants: unknown;
    }[];
    routableAddresses: string[];
    agentCallbacks: Map<string, (event: unknown) => void>;
  };
}

const WORKBENCH_WORKFLOW_JSON = serializeWorkbenchHostWorkflow(
  buildWorkbenchHostWorkflow({
    triggerAddress: "ins_workbench1@ten1.workbench.test",
    inferencePreferences: [{ provider: "anthropic", model: "claude-sonnet-5" }],
    turnTimeoutMs: 60_000,
  }),
);

describe("createHubChatPlatform", () => {
  test("launchWorkbench mints immediately and ensureAwake deploys with the noop source", async () => {
    resolveDefinitionSourcesCalls.length = 0;
    // Deliberately left `ok: false`: a host launch must never reach
    // `resolveDefinitionSources` at all, so this stub result — which
    // would fail the launch if it were ever consulted — proves the
    // catalog path was skipped, not merely that it happened to
    // succeed.
    resolveDefinitionSourcesResult = {
      ok: false,
      message: "the catalog must not be consulted for a workbench host",
    };

    const db = createFakeDb({
      assetRow: {
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        name: "workbench-1",
        displayName: null,
      },
      definitionId: "wfd_workbench1",
    });
    const sessionService = createFakeSessionService();
    const assetService = createFakeAssetService();
    const sidecarRouter = createFakeSidecarRouter({ routableAddresses: [] });
    const eventCollectors = createFakeEventCollectors();

    const platform = createHubChatPlatform({
      toolGrantsForPins: () => [],
      // Fake db, not a real drizzle instance.
      db: db as never,
      noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
      sessionService,
      assetService,
      sidecarRouter,
      eventCollectors,
    });

    const launched = await platform.launchWorkbench({
      tenantId: "ten_1",
      creatorPrincipalId: "prin_creator",
      workbenchId: "ins_workbench1",
      triggerAddress: "ins_workbench1@ten1.workbench.test",
      definition: WORKBENCH_WORKFLOW_JSON,
    });

    expect(launched.instanceId).toBe("ins_workbench1");

    expect(eventCollectors.createCalls).toEqual([]);
    expect(sessionService.adoptedDeployCalls).toHaveLength(0);
    expect(resolveDefinitionSourcesCalls).toHaveLength(0);

    await platform.ensureAwake("ins_workbench1@ten1.workbench.test");

    // The asynchronous wake opens the collector before deploying.
    expect(eventCollectors.createCalls).toEqual([
      [
        "ins_workbench1@ten1.workbench.test",
        "ten_1",
        expect.any(String),
        "ins_workbench1",
      ],
    ]);
    expect(eventCollectors.abandonCalls).toEqual([]);

    expect(assetService.createAssetCalls).toEqual([
      {
        tenantId: "ten_1",
        kind: "workflow",
        name: "ins-workbench1",
        creatorPrincipalId: "prin_creator",
      },
    ]);

    // The catalog was never consulted — the noop pin is used verbatim.
    expect(resolveDefinitionSourcesCalls).toHaveLength(0);

    // The folded launch path, never the native workflow-deploy path.
    expect(sessionService.adoptedDeployCalls).toHaveLength(1);
    const deployed = sessionService.adoptedDeployCalls[0] as {
      agentAddress: string;
      anchorRunId: string;
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
    expect(deployed.agentAddress).toBe("ins_workbench1@ten1.workbench.test");
    expect(deployed.anchorRunId).toBe("ins_workbench1");
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
    const workbenchLaunchInsert = db.inserted.find(
      (row) => row.table === workbenchLaunch,
    );
    expect(workbenchLaunchInsert?.values).toMatchObject({
      noopInference: true,
    });

    // The run is written in the folded shape: no deploymentId, a real
    // principal, and a session keyed off that shared principal --
    // never a manual `session_<workbenchId>` insert.
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
    const principalId = (principalInsert?.values as { id: string }).id;
    expect(sessionInsert?.values).toMatchObject({
      tenantId: "ten_1",
      agentId: "wfd_workbench1",
      principalId,
      status: "active",
    });
    expect((runInsert?.values as { principalId: string }).principalId).toBe(
      principalId,
    );
  });

  test("a failed host wake keeps the minted run retryable and abandons its collector", async () => {
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
        name: "workbench-1",
        displayName: null,
      },
      definitionId: "wfd_workbench1",
    });
    const sessionService = createFakeSessionService();
    const deployError = new Error("sidecar unreachable");
    sessionService.deployAdoptedWorkflowFromSource = async () => {
      throw deployError;
    };
    const assetService = createFakeAssetService();
    const sidecarRouter = createFakeSidecarRouter({ routableAddresses: [] });
    const eventCollectors = createFakeEventCollectors();

    const platform = createHubChatPlatform({
      toolGrantsForPins: () => [],
      db: db as never,
      noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
      sessionService,
      assetService,
      sidecarRouter,
      eventCollectors,
    });

    await platform.launchWorkbench({
      tenantId: "ten_1",
      creatorPrincipalId: "prin_creator",
      workbenchId: "ins_workbench1",
      triggerAddress: "ins_workbench1@ten1.workbench.test",
      definition: WORKBENCH_WORKFLOW_JSON,
    });
    await expect(
      platform.ensureAwake("ins_workbench1@ten1.workbench.test"),
    ).rejects.toThrow(deployError);

    // The collector opened before the deploy attempt is abandoned, not
    // left registered against an address nothing will ever deploy to.
    expect(eventCollectors.abandonCalls).toEqual([
      "ins_workbench1@ten1.workbench.test",
    ]);

    // A wake failure is recoverable on the next message, so it never
    // deactivates or deletes the already-durable run.
    expect(db.updated).toEqual([]);
    expect(db.deleted.some((row) => row.table === workflowRun)).toBe(false);
    expect(db.deleted.some((row) => row.table === foldedRun)).toBe(false);
  });

  test("a failed host wake keeps the run retryable even when a child leaked", async () => {
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
        name: "workbench-1",
        displayName: null,
      },
      definitionId: "wfd_workbench1",
    });
    const sessionService = createFakeSessionService();
    sessionService.deployAdoptedWorkflowFromSource = async () => {
      throw new SessionLaunchError("start", new Error("ack timeout"), true);
    };
    const assetService = createFakeAssetService();
    const sidecarRouter = createFakeSidecarRouter({ routableAddresses: [] });
    const eventCollectors = createFakeEventCollectors();

    const platform = createHubChatPlatform({
      toolGrantsForPins: () => [],
      db: db as never,
      noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
      sessionService,
      assetService,
      sidecarRouter,
      eventCollectors,
    });

    await platform.launchWorkbench({
      tenantId: "ten_1",
      creatorPrincipalId: "prin_creator",
      workbenchId: "ins_workbench1",
      triggerAddress: "ins_workbench1@ten1.workbench.test",
      definition: WORKBENCH_WORKFLOW_JSON,
    });
    await expect(
      platform.ensureAwake("ins_workbench1@ten1.workbench.test"),
    ).rejects.toThrow(SessionLaunchError);

    expect(db.deleted.some((row) => row.table === workflowRun)).toBe(false);
    expect(db.deleted.some((row) => row.table === foldedRun)).toBe(false);
    const runUpdate = db.updated.find((row) => row.table === workflowRun);
    expect(runUpdate).toBeUndefined();
  });

  // A workbench host's noop pin is a deliberate improvement over the
  // pre-existing behavior: launching a workbench no longer needs any
  // catalog source seeded at all (see the primary launchWorkbench test
  // above, which proves this with `resolveDefinitionSourcesResult`
  // forced to `ok: false`). An invited agent's launch is unaffected —
  // its replies are real, so it still fails loud without a catalog
  // source; proven alongside `launchInvite`'s other tests below.

  test("sendMail resolves the workbench's run's session via the shared principal and delivers via sessionService", async () => {
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
        name: "workbench-1",
        displayName: null,
      },
      definitionId: "wfd_workbench1",
      workflowRunRow: {
        id: "ins_workbench1",
        address: "ins_workbench1@ten1.workbench.test",
        principalId: "prin_run1",
      },
    });
    // Seed the session an earlier launchWorkbench would have written,
    // keyed to the run's principal.
    db.inserted.push({
      table: agentSession,
      values: { id: "ses_run1", principalId: "prin_run1" },
    });

    const sessionService = createFakeSessionService();
    const sidecarRouter = createFakeSidecarRouter();

    const platform = createHubChatPlatform({
      toolGrantsForPins: () => [],
      db: db as never,
      noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
      sessionService,
      assetService: createFakeAssetService(),
      sidecarRouter,
      eventCollectors: createFakeEventCollectors(),
    });

    const sent = await platform.sendMail({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      principalId: "prin_sender",
      content: { content: "hello workbench" },
    });

    expect(sent.id).toBeTruthy();
    expect(sessionService.sendUserMessageCalls).toHaveLength(1);
    const call = sessionService.sendUserMessageCalls[0] as {
      agentAddress: string;
      content: string;
      sessionId: string;
    };
    expect(call.agentAddress).toBe("ins_workbench1@ten1.workbench.test");
    expect(call.content).toBe("hello workbench");
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
      "ins_workbench1@ten1.workbench.test",
    );
  });

  test("launchInvite mints from the target definition and ensureAwake deploys it", async () => {
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
        name: "workbench-1",
        displayName: null,
      },
      definitionId: "wfd_workbench1",
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
      assetBlob: new TextEncoder().encode(WORKBENCH_WORKFLOW_JSON),
    });
    const sidecarRouter = createFakeSidecarRouter({ routableAddresses: [] });
    const eventCollectors = createFakeEventCollectors();

    const platform = createHubChatPlatform({
      toolGrantsForPins: () => [],
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

    expect(sessionService.adoptedDeployCalls).toHaveLength(0);
    expect(resolveDefinitionSourcesCalls).toHaveLength(0);
    await platform.ensureAwake(launched.address);

    expect(sessionService.adoptedDeployCalls).toHaveLength(1);
    const deployed = sessionService.adoptedDeployCalls[0] as AdoptedDeployCall;
    expect(deployed.agentAddress).toBe(launched.address);
    expect(deployed.anchorRunId).toBe(launched.instanceId);

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
    // the noop endpoint — only a workbench host gets that pin.
    expect(resolveDefinitionSourcesCalls).toHaveLength(1);

    // The launch row records this as not a host, so a later wake
    // resolves against the catalog rather than pinning the noop
    // source.
    const workbenchLaunchInsert = db.inserted.find(
      (row) => row.table === workbenchLaunch,
    );
    expect(workbenchLaunchInsert?.values).toMatchObject({
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
        name: "workbench-1",
        displayName: null,
      },
      definitionId: "wfd_workbench1",
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
      assetBlob: new TextEncoder().encode(WORKBENCH_WORKFLOW_JSON),
    });
    const sidecarRouter = createFakeSidecarRouter({ routableAddresses: [] });
    const eventCollectors = createFakeEventCollectors();
    const credentialCipher = {
      encrypt: async (plaintext: string) => plaintext,
      decrypt: async (blob: string) => blob,
    };

    const platform = createHubChatPlatform({
      toolGrantsForPins: () => [],
      db: db as never,
      noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
      sessionService,
      assetService,
      sidecarRouter,
      eventCollectors,
      credentialCipher,
    });

    const launched = await platform.launchInvite({
      tenantId: "ten_1",
      creatorPrincipalId: "prin_creator",
      definitionId: "wfd_echo",
    });
    await platform.ensureAwake(launched.address);

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
        name: "workbench-1",
        displayName: null,
      },
      definitionId: "wfd_workbench1",
      workflowDefinitionRow: {
        id: "wfd_echo",
        tenantId: "ten_1",
        status: "stopped",
        assetId: "asst_echo",
      },
      tenantRow: { id: "ten_1", domain: "ten1.workbench.test" },
    });
    const platform = createHubChatPlatform({
      toolGrantsForPins: () => [],
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

  // CL-6357: a long-lived dev DB can carry a definition row whose asset
  // repo has gone unresolvable (DB/blob drift) alongside a fresher,
  // healthy sibling under the same name — a re-seed, say. Resolution
  // must prefer that newest-healthy sibling rather than dying on the
  // specific (possibly stale) row the caller asked for.
  test("launchInvite resolves the newest healthy sibling asset over the requested definition's own stale one", async () => {
    const db = createFakeDb({
      assetRow: {
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        name: "workbench-1",
        displayName: null,
      },
      definitionId: "wfd_workbench1",
      workflowDefinitionRow: {
        id: "wfd_stale",
        tenantId: "ten_1",
        status: "deployed",
        assetId: "asst_stale",
      },
      workflowDefinitionRows: [
        // Newest first, matching `orderBy: desc(createdAt)`.
        {
          id: "wfd_fresh",
          tenantId: "ten_1",
          status: "deployed",
          name: "assistant",
          assetId: "asst_fresh",
        },
        {
          id: "wfd_stale",
          tenantId: "ten_1",
          status: "deployed",
          name: "assistant",
          assetId: "asst_stale",
        },
      ],
      tenantRow: { id: "ten_1", domain: "ten1.workbench.test" },
    });
    const assetService = createFakeAssetService({
      blobsByAssetId: {
        asst_stale: "unresolvable",
        asst_fresh: new TextEncoder().encode(WORKBENCH_WORKFLOW_JSON),
      },
    });

    const platform = createHubChatPlatform({
      hubPublicKey: "hub-key",
      toolGrantsForPins: () => [],
      db: db as never,
      noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
      sessionService: createFakeSessionService(),
      assetService,
      sidecarRouter: createFakeSidecarRouter({ routableAddresses: [] }),
      eventCollectors: createFakeEventCollectors(),
    });

    const launched = await platform.launchInvite({
      tenantId: "ten_1",
      creatorPrincipalId: "prin_creator",
      definitionId: "wfd_stale",
    });

    expect(launched.instanceId).toMatch(/^run_/);
    // The minted run's definitionId is the resolved healthy sibling,
    // not the stale requested id — every later wake reads the asset
    // through this row, so it must be one that actually resolves.
    const runInsert = db.inserted.find((row) => row.table === workflowRun);
    expect(runInsert?.values).toMatchObject({ definitionId: "wfd_fresh" });
  });

  // A dev DB whose asset rows have all drifted from `.data` (every
  // sibling under the name unresolvable) must answer a named error a
  // caller can map to a 4xx, never let the raw `readAssetBlob` failure
  // escape as an unhandled 500.
  test("launchInvite raises DefinitionAssetUnresolvableError, not a raw 500, when no sibling asset resolves", async () => {
    const db = createFakeDb({
      assetRow: {
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        name: "workbench-1",
        displayName: null,
      },
      definitionId: "wfd_workbench1",
      workflowDefinitionRow: {
        id: "wfd_dead",
        tenantId: "ten_1",
        status: "deployed",
        assetId: "asst_dead",
      },
      workflowDefinitionRows: [
        {
          id: "wfd_dead",
          tenantId: "ten_1",
          status: "deployed",
          name: "assistant",
          assetId: "asst_dead",
        },
      ],
      tenantRow: { id: "ten_1", domain: "ten1.workbench.test" },
    });
    const assetService = createFakeAssetService({
      blobsByAssetId: { asst_dead: "unresolvable" },
    });

    const platform = createHubChatPlatform({
      hubPublicKey: "hub-key",
      toolGrantsForPins: () => [],
      db: db as never,
      noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
      sessionService: createFakeSessionService(),
      assetService,
      sidecarRouter: createFakeSidecarRouter({ routableAddresses: [] }),
      eventCollectors: createFakeEventCollectors(),
    });

    await expect(
      platform.launchInvite({
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        definitionId: "wfd_dead",
      }),
    ).rejects.toThrow(DefinitionAssetUnresolvableError);
  });

  test("launchInvite fails loud when no such definition exists for the tenant", async () => {
    const db = createFakeDb({
      assetRow: {
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        name: "workbench-1",
        displayName: null,
      },
      definitionId: "wfd_workbench1",
      workflowDefinitionRow: undefined,
      tenantRow: { id: "ten_1", domain: "ten1.workbench.test" },
    });
    const platform = createHubChatPlatform({
      toolGrantsForPins: () => [],
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

  // Unlike a workbench host, an invited agent's replies are real: its
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
        name: "workbench-1",
        displayName: null,
      },
      definitionId: "wfd_workbench1",
      workflowDefinitionRow: {
        id: "wfd_echo",
        tenantId: "ten_1",
        status: "deployed",
        assetId: "asst_echo",
      },
      tenantRow: { id: "ten_1", domain: "ten1.workbench.test" },
    });
    const platform = createHubChatPlatform({
      toolGrantsForPins: () => [],
      db: db as never,
      noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
      sessionService: createFakeSessionService(),
      assetService: createFakeAssetService({
        assetBlob: new TextEncoder().encode(WORKBENCH_WORKFLOW_JSON),
      }),
      sidecarRouter: createFakeSidecarRouter({ routableAddresses: [] }),
      eventCollectors: createFakeEventCollectors(),
    });

    const launched = await platform.launchInvite({
      tenantId: "ten_1",
      creatorPrincipalId: "prin_creator",
      definitionId: "wfd_echo",
    });
    await expect(platform.ensureAwake(launched.address)).rejects.toThrow(
      /seed a tenant catalog source/,
    );
  });

  // A `create_agent`-minted definition with no `model` of its own
  // (`@corbits/agent-directory`'s `createAgentDefinitionCore`, absent
  // a `tenantDefaultModel` dep) serializes with an empty
  // `inference.sources` list — `foldedBody.model` reads back `null`.
  // Without `workbenchHostInferencePreferences`, that used to 409 as
  // `not_launchable`; this proves the fallback resolves and launches
  // instead, exactly mirroring the model a fresh workbench host would
  // get for this tenant.
  const NO_MODEL_WORKFLOW_JSON = serializeWorkbenchHostWorkflow(
    buildWorkbenchHostWorkflow({
      triggerAddress: "ins_workbench1@ten1.workbench.test",
      inferencePreferences: [],
      turnTimeoutMs: 60_000,
    }),
  );

  test("launchInvite falls back to the workbench-host inference preferences when the definition declares no model requirements", async () => {
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
        name: "workbench-1",
        displayName: null,
      },
      definitionId: "wfd_workbench1",
      workflowDefinitionRow: {
        id: "wfd_echo",
        tenantId: "ten_1",
        status: "deployed",
        assetId: "asst_echo",
      },
      tenantRow: { id: "ten_1", domain: "ten1.workbench.test" },
    });
    const platform = createHubChatPlatform({
      toolGrantsForPins: () => [],
      db: db as never,
      noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
      sessionService: createFakeSessionService(),
      assetService: createFakeAssetService({
        assetBlob: new TextEncoder().encode(NO_MODEL_WORKFLOW_JSON),
      }),
      sidecarRouter: createFakeSidecarRouter({ routableAddresses: [] }),
      eventCollectors: createFakeEventCollectors(),
      workbenchHostInferencePreferences: async (tenantId) =>
        tenantId === "ten_1"
          ? [{ provider: "anthropic", model: "claude-sonnet-5" }]
          : [],
    });

    const launched = await platform.launchInvite({
      tenantId: "ten_1",
      creatorPrincipalId: "prin_creator",
      definitionId: "wfd_echo",
    });
    await platform.ensureAwake(launched.address);

    expect(launched.instanceId).toMatch(/^run_/);
    expect(resolveDefinitionSourcesCalls).toHaveLength(1);
    expect(resolveDefinitionSourcesCalls[0]).toMatchObject({
      tenantId: "ten_1",
      fallbackModel: "claude-sonnet-5",
    });
  });

  test("launchInvite still 409s honestly when the tenant has no connected providers to fall back to", async () => {
    resolveDefinitionSourcesCalls.length = 0;
    resolveDefinitionSourcesResult = {
      ok: false,
      message:
        "This definition declares no model requirements; cannot resolve any inference sources",
    };

    const db = createFakeDb({
      assetRow: {
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        name: "workbench-1",
        displayName: null,
      },
      definitionId: "wfd_workbench1",
      workflowDefinitionRow: {
        id: "wfd_echo",
        tenantId: "ten_1",
        status: "deployed",
        assetId: "asst_echo",
      },
      tenantRow: { id: "ten_1", domain: "ten1.workbench.test" },
    });
    const platform = createHubChatPlatform({
      toolGrantsForPins: () => [],
      db: db as never,
      noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
      sessionService: createFakeSessionService(),
      assetService: createFakeAssetService({
        assetBlob: new TextEncoder().encode(NO_MODEL_WORKFLOW_JSON),
      }),
      sidecarRouter: createFakeSidecarRouter({ routableAddresses: [] }),
      eventCollectors: createFakeEventCollectors(),
      workbenchHostInferencePreferences: async () => [],
    });

    const launched = await platform.launchInvite({
      tenantId: "ten_1",
      creatorPrincipalId: "prin_creator",
      definitionId: "wfd_echo",
    });
    await expect(platform.ensureAwake(launched.address)).rejects.toThrow(
      /seed a tenant catalog source/,
    );

    expect(resolveDefinitionSourcesCalls).toHaveLength(1);
    expect(resolveDefinitionSourcesCalls[0]).toMatchObject({
      tenantId: "ten_1",
      fallbackModel: null,
    });
  });

  test("listInvitableDefinitions lists deployed definitions, excluding workbench hosts", async () => {
    const db = createFakeDb({
      assetRow: {
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        name: "workbench-1",
        displayName: null,
      },
      definitionId: "wfd_workbench1",
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
      toolGrantsForPins: () => [],
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

  test("subscribeToWorkbench resolves the run's address and subscribes on the sidecar router", async () => {
    const db = createFakeDb({
      assetRow: {
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        name: "workbench-1",
        displayName: null,
      },
      definitionId: "wfd_workbench1",
      workflowRunRow: {
        id: "ins_workbench1",
        address: "ins_workbench1@ten1.workbench.test",
        principalId: "prin_run1",
      },
    });
    const sessionService = createFakeSessionService();
    const assetService = createFakeAssetService();
    const sidecarRouter = createFakeSidecarRouter();

    const platform = createHubChatPlatform({
      toolGrantsForPins: () => [],
      db: db as never,
      noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
      sessionService,
      assetService,
      sidecarRouter,
      eventCollectors: createFakeEventCollectors(),
    });

    const events: unknown[] = [];
    const unsubscribe = platform.subscribeToWorkbench(
      "ins_workbench1",
      (event) => {
        events.push(event);
      },
    );

    // The lookup is async (`findFirst` resolves, then `.then` runs);
    // yield past both hops of the microtask queue.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sidecarRouter.subscribeAgentCalls).toEqual([
      { address: "ins_workbench1@ten1.workbench.test" },
    ]);

    unsubscribe();
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
    test("sendMail wakes a non-routable workbench by redeploying before sending, then sends", async () => {
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
          name: "workbench-1",
          displayName: null,
        },
        definitionId: "wfd_workbench1",
        workflowRunRow: {
          id: "ins_workbench1",
          address: "ins_workbench1@ten1.workbench.test",
          principalId: "prin_run1",
          definitionId: "wfd_workbench1",
        },
        workflowDefinitionRow: {
          id: "wfd_workbench1",
          tenantId: "ten_1",
          status: "deployed",
          assetId: "asst_workbench1",
        },
        workbenchLaunchRow: {
          tenantId: "ten_1",
          instanceId: "ins_workbench1",
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
      // Not in the sidecar's routable set: this workbench is asleep (or
      // never came back after a restart) when the send arrives.
      const sidecarRouter = createFakeSidecarRouter({ routableAddresses: [] });
      const eventCollectors = createFakeEventCollectors();
      const assetService = createFakeAssetService({
        assetBlob: new TextEncoder().encode(WORKBENCH_WORKFLOW_JSON),
      });

      const platform = createHubChatPlatform({
        toolGrantsForPins: () => [],
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
        workbenchId: "ins_workbench1",
        principalId: "prin_sender",
        content: { content: "wake up" },
      });

      expect(sent.id).toBeTruthy();
      // The redeploy happened...
      expect(sessionService.adoptedDeployCalls).toHaveLength(1);
      const deployed = sessionService
        .adoptedDeployCalls[0] as AdoptedDeployCall;
      expect(deployed.agentAddress).toBe("ins_workbench1@ten1.workbench.test");
      expect(deployed.anchorRunId).toBe("ins_workbench1");
      // ...before the send.
      expect(sessionService.sendUserMessageCalls).toHaveLength(1);
    });

    // CL-6267: the sidecar's own park/wake handler now owns respawning
    // a parked-but-still-announced deployment the moment mail routes
    // to it, so `sendMail` never deploys or undeploys anything for a
    // routable address -- regardless of the underlying run's status --
    // it just proceeds straight to the send.
    test("sendMail never deploys or undeploys a routable workbench, even a completed folded run — the sidecar's park handler owns respawn", async () => {
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
          name: "workbench-1",
          displayName: null,
        },
        definitionId: "wfd_workbench1",
        workflowRunRow: {
          id: "ins_workbench1",
          address: "ins_workbench1@ten1.workbench.test",
          principalId: "prin_run1",
          definitionId: "wfd_workbench1",
          status: "completed",
        },
        workflowDefinitionRow: {
          id: "wfd_workbench1",
          tenantId: "ten_1",
          status: "deployed",
          assetId: "asst_workbench1",
        },
        workbenchLaunchRow: {
          tenantId: "ten_1",
          instanceId: "ins_workbench1",
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
      const sidecarRouter = createFakeSidecarRouter({
        routableAddresses: ["ins_workbench1@ten1.workbench.test"],
      });
      const eventCollectors = createFakeEventCollectors();
      const assetService = createFakeAssetService({
        assetBlob: new TextEncoder().encode(WORKBENCH_WORKFLOW_JSON),
      });

      const platform = createHubChatPlatform({
        toolGrantsForPins: () => [],
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
        workbenchId: "ins_workbench1",
        principalId: "prin_sender",
        content: { content: "hi" },
      });

      expect(sent.id).toBeTruthy();
      expect(sessionService.adoptedDeployCalls).toHaveLength(0);
      expect(sidecarRouter.sendAgentUndeployCalls).toHaveLength(0);
      expect(sessionService.sendUserMessageCalls).toHaveLength(1);
    });

    test("waking a host launch pins the noop source again, never touching the catalog", async () => {
      resolveDefinitionSourcesCalls.length = 0;
      // Forced to fail if ever consulted, same posture as the
      // launchWorkbench test above: proves the wake path skips the
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
          name: "workbench-1",
          displayName: null,
        },
        definitionId: "wfd_workbench1",
        workflowRunRow: {
          id: "ins_workbench1",
          address: "ins_workbench1@ten1.workbench.test",
          principalId: "prin_run1",
          definitionId: "wfd_workbench1",
        },
        workflowDefinitionRow: {
          id: "wfd_workbench1",
          tenantId: "ten_1",
          status: "deployed",
          assetId: "asst_workbench1",
        },
        workbenchLaunchRow: {
          tenantId: "ten_1",
          instanceId: "ins_workbench1",
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
        assetBlob: new TextEncoder().encode(WORKBENCH_WORKFLOW_JSON),
      });

      const platform = createHubChatPlatform({
        toolGrantsForPins: () => [],
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
        workbenchId: "ins_workbench1",
        principalId: "prin_sender",
        content: { content: "wake up" },
      });

      expect(resolveDefinitionSourcesCalls).toHaveLength(0);
      expect(sessionService.adoptedDeployCalls).toHaveLength(1);
      const deployed = sessionService.adoptedDeployCalls[0] as {
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

      const address = "ins_workbench1@ten1.workbench.test";
      const db = createFakeDb({
        assetRow: {
          tenantId: "ten_1",
          creatorPrincipalId: "prin_creator",
          name: "workbench-1",
          displayName: null,
        },
        definitionId: "wfd_workbench1",
        workflowRunRow: {
          id: "ins_workbench1",
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
        toolGrantsForPins: () => [],
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
        workbenchId: "ins_workbench1",
        principalId: "prin_sender",
        content: { content: "hello" },
      });

      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(sidecarRouter.sendAgentUndeployCalls).toEqual([]);
      globalThis.setInterval = originalSetInterval;
    });

    test("the idle sweep reaps a genuinely idle address with the state-preserving reason", async () => {
      const originalSetInterval = globalThis.setInterval;
      globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
        const timer = originalSetInterval(...args);
        timer.unref?.();
        return timer;
      }) as typeof setInterval;

      const address = "ins_workbench1@ten1.workbench.test";
      const db = createFakeDb({
        assetRow: {
          tenantId: "ten_1",
          creatorPrincipalId: "prin_creator",
          name: "workbench-1",
          displayName: null,
        },
        definitionId: "wfd_workbench1",
        workflowRunRow: {
          id: "ins_workbench1",
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
      // No open turn on this address -- unlike the busy-guard test above,
      // nothing spares it once its recorded activity goes stale past
      // `idleSleepMs`.
      const eventCollectors = createFakeEventCollectors({
        busyAddresses: new Set(),
      });

      const platform = createHubChatPlatform({
        toolGrantsForPins: () => [],
        db: db as never,
        noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
        sessionService: createFakeSessionService(),
        assetService: createFakeAssetService(),
        sidecarRouter,
        eventCollectors,
        lifecycle: { idleSleepMs: 5, sweepIntervalMs: 5 },
      });

      await platform.sendMail({
        tenantId: "ten_1",
        workbenchId: "ins_workbench1",
        principalId: "prin_sender",
        content: { content: "hello" },
      });

      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(sidecarRouter.sendAgentUndeployCalls).toEqual([
        { address, reason: IDLE_HIBERNATE_UNDEPLOY_REASON },
      ]);
      globalThis.setInterval = originalSetInterval;
    });

    // CL-6164 regression pin: the anchor's `workflow_run` row must stay
    // "running" (never end/un-anchor) across an idle-reap-then-relaunch
    // cycle. Reap is a sidecar-local `sendAgentUndeploy` call -- it never
    // touches `workflow_run` at all -- and `wakeByAddress` only reads the
    // run, never updates its `status`/`endedAt`. This test pins that
    // invariant against a regression, not against a bug this lane found:
    // see the final report for the file/line evidence.
    test("idle-reap-then-relaunch never updates workflow_run's status or endedAt", async () => {
      const originalSetInterval = globalThis.setInterval;
      globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
        const timer = originalSetInterval(...args);
        timer.unref?.();
        return timer;
      }) as typeof setInterval;

      const address = "ins_workbench1@ten1.workbench.test";
      const db = createFakeDb({
        assetRow: {
          tenantId: "ten_1",
          creatorPrincipalId: "prin_creator",
          name: "workbench-1",
          displayName: null,
        },
        definitionId: "wfd_workbench1",
        workflowRunRow: {
          id: "ins_workbench1",
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
      const eventCollectors = createFakeEventCollectors({
        busyAddresses: new Set(),
      });

      const platform = createHubChatPlatform({
        toolGrantsForPins: () => [],
        db: db as never,
        noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
        sessionService: createFakeSessionService(),
        assetService: createFakeAssetService(),
        sidecarRouter,
        eventCollectors,
        lifecycle: { idleSleepMs: 5, sweepIntervalMs: 5 },
      });

      await platform.sendMail({
        tenantId: "ten_1",
        workbenchId: "ins_workbench1",
        principalId: "prin_sender",
        content: { content: "hello" },
      });

      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(sidecarRouter.sendAgentUndeployCalls).toEqual([
        { address, reason: IDLE_HIBERNATE_UNDEPLOY_REASON },
      ]);
      expect(db.updated.some((call) => call.table === workflowRun)).toBe(false);
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
            name: "workbench-1",
            displayName: null,
          },
          definitionId: "wfd_workbench1",
        });
        createHubChatPlatform({
          toolGrantsForPins: () => [],
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
            name: "workbench-1",
            displayName: null,
          },
          definitionId: "wfd_workbench1",
        });
        createHubChatPlatform({
          toolGrantsForPins: () => [],
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

  // `ensureAwake` is the primitive a caller outside this adapter (the
  // hub's `mail.outbound.undelivered` handler) uses to wake a chat
  // resident before re-attempting delivery itself, over both
  // lifecycle configurations `sendMail` itself branches on.
  describe("ensureAwake", () => {
    test("no-ops for an already-routable address", async () => {
      const address = "ins_workbench1@ten1.workbench.test";
      const db = createFakeDb({
        assetRow: {
          tenantId: "ten_1",
          creatorPrincipalId: "prin_creator",
          name: "workbench-1",
          displayName: null,
        },
        definitionId: "wfd_workbench1",
      });
      const sessionService = createFakeSessionService();
      const platform = createHubChatPlatform({
        toolGrantsForPins: () => [],
        db: db as never,
        noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
        sessionService,
        assetService: createFakeAssetService(),
        sidecarRouter: createFakeSidecarRouter({
          routableAddresses: [address],
        }),
        eventCollectors: createFakeEventCollectors(),
      });

      await platform.ensureAwake(address);

      expect(sessionService.adoptedDeployCalls).toHaveLength(0);
    });

    test("redeploys a non-routable address when lifecycle is configured", async () => {
      const address = "ins_workbench1@ten1.workbench.test";
      const db = createFakeDb({
        assetRow: {
          tenantId: "ten_1",
          creatorPrincipalId: "prin_creator",
          name: "workbench-1",
          displayName: null,
        },
        definitionId: "wfd_workbench1",
        workflowRunRow: {
          id: "ins_workbench1",
          address,
          principalId: "prin_run1",
        },
        workbenchLaunchRow: {
          tenantId: "ten_1",
          instanceId: "ins_workbench1",
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
      const platform = createHubChatPlatform({
        toolGrantsForPins: () => [],
        db: db as never,
        noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
        sessionService,
        assetService: createFakeAssetService(),
        sidecarRouter: createFakeSidecarRouter({ routableAddresses: [] }),
        eventCollectors: createFakeEventCollectors(),
        lifecycle: { idleSleepMs: 60_000 },
      });

      await platform.ensureAwake(address);

      expect(sessionService.adoptedDeployCalls).toHaveLength(1);
    });

    test("redeploys a non-routable address when lifecycle is not configured", async () => {
      const address = "ins_workbench1@ten1.workbench.test";
      const db = createFakeDb({
        assetRow: {
          tenantId: "ten_1",
          creatorPrincipalId: "prin_creator",
          name: "workbench-1",
          displayName: null,
        },
        definitionId: "wfd_workbench1",
        workflowRunRow: {
          id: "ins_workbench1",
          address,
          principalId: "prin_run1",
        },
        workbenchLaunchRow: {
          tenantId: "ten_1",
          instanceId: "ins_workbench1",
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
      const platform = createHubChatPlatform({
        toolGrantsForPins: () => [],
        db: db as never,
        noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
        sessionService,
        assetService: createFakeAssetService(),
        sidecarRouter: createFakeSidecarRouter({ routableAddresses: [] }),
        eventCollectors: createFakeEventCollectors(),
      });

      await platform.ensureAwake(address);

      expect(sessionService.adoptedDeployCalls).toHaveLength(1);
    });

    test("rejects for an address this adapter has no folded run for", async () => {
      const db = createFakeDb({
        assetRow: {
          tenantId: "ten_1",
          creatorPrincipalId: "prin_creator",
          name: "workbench-1",
          displayName: null,
        },
        definitionId: "wfd_workbench1",
      });
      const platform = createHubChatPlatform({
        toolGrantsForPins: () => [],
        db: db as never,
        noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
        sessionService: createFakeSessionService(),
        assetService: createFakeAssetService(),
        sidecarRouter: createFakeSidecarRouter({ routableAddresses: [] }),
        eventCollectors: createFakeEventCollectors(),
      });

      await expect(
        platform.ensureAwake("ins_unknown@ten1.workbench.test"),
      ).rejects.toThrow();
    });
  });

  // Proves the actual lever an edited system prompt reaches a running
  // instance through: `wakeFoldedRun` (exercised via `sendMail`'s
  // wake-on-send path above) replays `workbench_launch.foldedBody`
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
        // options type demands them for the launchWorkbench-shaped tests
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
        workbenchLaunchRow: {
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
        toolGrantsForPins: () => [],
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
        (row) => row.table === workbenchLaunch,
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
        toolGrantsForPins: () => [],
        db: db as never,
        noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
        sessionService,
        assetService: createFakeAssetService({
          assetBlob: new TextEncoder().encode(NEW_WORKFLOW_JSON),
        }),
        // Not in the sidecar's routable set: the instance is asleep, so
        // the next send must wake it — reading whatever
        // `workbench_launch` holds at that moment.
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
        workbenchId: "run_agent1",
        principalId: "prin_sender",
        content: { content: "hello" },
      });

      expect(sessionService.adoptedDeployCalls).toHaveLength(1);
      const deployed = sessionService.adoptedDeployCalls[0] as {
        config: { systemPrompt: string };
      };
      expect(deployed.config.systemPrompt).toBe(
        "You are now a blunt, no-nonsense assistant.",
      );
    });
  });
});
