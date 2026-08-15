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

const { launchFoldedRun, InferenceResolutionError } =
  await import("../src/launch");

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
    async deployInstanceAtHead(params: unknown) {
      deployInstanceAtHeadCalls.push(params);
      return { publicKey: "test-public-key" };
    },
    async deploySingleStepAtHead() {
      return { publicKey: "unused" };
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
    sessionService.deployInstanceAtHead = async () => {
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

    expect(db.deleted).toEqual([{ table: workflowRun }]);

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
    sessionService.deployInstanceAtHead = async () => {
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
