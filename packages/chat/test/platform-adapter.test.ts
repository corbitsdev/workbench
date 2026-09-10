// Proves `createHubChatPlatform` maps each `ChatPlatform` port method
// onto the right in-process service call. `launchWorkbench` in
// particular proves the invited-agent instance shape: it extracts
// the folded body, resolves inference sources against the tenant
// catalog, and provisions via Interchange
// `prepareProvisionedDeployment` — never `deployWorkflowDefinition`.
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
// `runTrigger`/`repoStore`/`sidecarRouter` are fakes recording
// their calls, and `db` is a minimal chainable stand-in for the
// drizzle query builder (no database involved) so the mapping is
// exercised without a real Postgres.

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { IDLE_HIBERNATE_UNDEPLOY_REASON } from "@corbits/agent-lifecycle";
import {
  DefinitionProjectionMissingError,
  WORKFLOW_SOURCE_ENTRY,
} from "@corbits/workflows";
import type { DefinitionSourceResolution } from "@intx/hub-api";
import {
  agentSession,
  asset,
  principal as principalTable,
  sessionMail,
  workflowDefinition,
  workflowDefinitionVersion,
  workflowRun,
} from "@intx/db/schema";
import { SessionLaunchError } from "@intx/hub-sessions";
import type { EventCollectorRegistry, SidecarRouter } from "@intx/hub-sessions";
import { workbenchLaunch } from "../src/schema";
import type { CreateHubChatPlatformDeps } from "../src/platform-adapter";
import { MODEL_UNAVAILABLE_CONSUMER_MESSAGE } from "../src/model-unavailable";
import type {
  RunTriggerClient,
  TriggerWorkflowRunMailInput,
} from "../src/run-trigger-client";
import {
  createCryptoProviderCache,
  type CryptoProviderCache,
} from "../src/crypto-cache";

const actualHubApi = await import("@intx/hub-api");

let resolveDefinitionSourcesResult: DefinitionSourceResolution = {
  ok: true,
  materials: [],
  sources: [
    {
      id: "off_1",
      provider: "anthropic",
      baseURL: "https://inference.invalid",
      credentialId: "cred_placeholder",
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
};
const buildCredentialDeliveryCalls: unknown[] = [];

// `provisionOnAsset` looks up `listVisibleOfferings` once per invite/wake/
// relaunch. The real implementation walks a drizzle `db.query` surface this
// file's minimal chainable fake `db` never implements, so the catalog is
// stubbed here. Tests that need an empty catalog assign `visibleOfferings = []`.
const DEFAULT_VISIBLE_OFFERINGS = [
  {
    offering: { id: "off_1", priority: 0 },
    model: { canonicalName: "claude-sonnet-5" },
    provider: { name: "anthropic" },
  },
];
let visibleOfferings: typeof DEFAULT_VISIBLE_OFFERINGS = [
  ...DEFAULT_VISIBLE_OFFERINGS,
];
const listVisibleOfferingsCalls: unknown[] = [];

mock.module("@intx/db", () => ({
  ...actualDb,
  buildCredentialDelivery: async (...args: unknown[]) => {
    buildCredentialDeliveryCalls.push(args[0]);
    return buildCredentialDeliveryResult;
  },
  listVisibleOfferings: async (...args: unknown[]) => {
    listVisibleOfferingsCalls.push(args);
    return visibleOfferings;
  },
}));

beforeEach(() => {
  visibleOfferings = [...DEFAULT_VISIBLE_OFFERINGS];
  listVisibleOfferingsCalls.length = 0;
});

const { createHubChatPlatform: buildHubChatPlatform } =
  await import("../src/platform-adapter");

const PASSTHROUGH_CIPHER = {
  encrypt: async (plaintext: string) => plaintext,
  decrypt: async (blob: string) => blob,
};

function createFakeWorkflowAllocationService(): {
  prepareCalls: unknown[];
  prepareProvisionedDeployment: (args: {
    anchorRunId: string;
    deploymentDomain: string;
  }) => Promise<{
    anchorRunId: string;
    deploymentAddress: string;
    allocationId: string;
    status: "pending";
  }>;
} {
  const prepareCalls: unknown[] = [];
  return {
    prepareCalls,
    async prepareProvisionedDeployment(args: {
      anchorRunId: string;
      deploymentDomain: string;
    }) {
      prepareCalls.push(args);
      return {
        anchorRunId: args.anchorRunId,
        deploymentAddress: `${args.anchorRunId}@${args.deploymentDomain}`,
        allocationId: `alloc_${args.anchorRunId}`,
        status: "pending" as const,
      };
    },
  };
}

type FakeWorkflowAllocationService = ReturnType<
  typeof createFakeWorkflowAllocationService
>;

let lastAllocationService: FakeWorkflowAllocationService =
  createFakeWorkflowAllocationService();

function createFakeRepoStore(sha: string | null = "sha_test") {
  const resolveRefCalls: unknown[] = [];
  return {
    resolveRefCalls,
    async resolveRef(...args: unknown[]) {
      resolveRefCalls.push(args);
      return sha;
    },
  };
}

function createHubChatPlatform(
  deps: Omit<
    CreateHubChatPlatformDeps,
    "cryptoProviders" | "workflowAllocationService" | "repoStore"
  > & {
    cryptoProviders?: CryptoProviderCache;
    workflowAllocationService?: FakeWorkflowAllocationService;
    repoStore?: CreateHubChatPlatformDeps["repoStore"];
  },
) {
  return buildHubChatPlatform({
    ...deps,
    repoStore: deps.repoStore ?? createFakeRepoStore(),
    cryptoProviders: deps.cryptoProviders ?? createCryptoProviderCache(),
    workflowAllocationService:
      deps.workflowAllocationService ?? createFakeWorkflowAllocationService(),
  });
}

function createPlatform(
  deps: Omit<
    Parameters<typeof createHubChatPlatform>[0],
    "credentialCipher"
  > & {
    credentialCipher?: Parameters<
      typeof createHubChatPlatform
    >[0]["credentialCipher"];
  },
) {
  lastAllocationService =
    deps.workflowAllocationService ?? createFakeWorkflowAllocationService();
  return createHubChatPlatform({
    ...deps,
    credentialCipher: deps.credentialCipher ?? PASSTHROUGH_CIPHER,
    workflowAllocationService: lastAllocationService,
  });
}

type SelectChain = PromiseLike<unknown[]> & {
  where(...args: unknown[]): SelectChain;
  orderBy(...args: unknown[]): SelectChain;
  limit(n?: number): Promise<unknown[]>;
};

function selectChain(rows: unknown[]): SelectChain {
  const result = Promise.resolve(rows);
  const chain: SelectChain = {
    where: () => chain,
    orderBy: () => chain,
    limit: () => result,
    then: (onFulfilled, onRejected) => result.then(onFulfilled, onRejected),
  };
  return chain;
}

/**
 * The string parameters bound into a drizzle SQL expression, in query
 * order: `eq(column, value)` wraps each value in a `Param` whose
 * `value` is the bound string, and `and(...)` nests sub-expressions
 * under `queryChunks` — column and operator chunks carry no bare
 * string `value`, so the walk collects exactly the bound parameters.
 */
function boundStringValues(expression: unknown, out: string[] = []): string[] {
  if (expression === null || typeof expression !== "object") return out;
  const chunk = expression as { value?: unknown; queryChunks?: unknown[] };
  if (typeof chunk.value === "string") out.push(chunk.value);
  if (Array.isArray(chunk.queryChunks)) {
    for (const nested of chunk.queryChunks) boundStringValues(nested, out);
  }
  return out;
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
  sessionMailRow?: { id: string; raw: Uint8Array } | undefined;
  workflowDefinitionRow?:
    | {
        id: string;
        tenantId: string;
        status: string;
        assetId: string | null;
        name?: string;
        origin?: "authored" | "run";
        grantRequirements?: unknown;
        wireHash?: string | null;
      }
    | undefined;
  workflowDefinitionRows?:
    | {
        id: string;
        tenantId: string;
        status: string;
        name: string;
        description?: string;
        assetId?: string | null;
        origin?: "authored" | "run";
        grantRequirements?: unknown;
        wireHash?: string | null;
      }[]
    | undefined;
  tenantRow?: { id: string; domain: string } | undefined;
  workbenchLaunchRow?:
    | {
        tenantId: string;
        instanceId: string;
        /**
         * The run the stable `instanceId` currently resolves to (see
         * `../src/agent-binding.ts`). Defaults to `instanceId` — the
         * identity mapping every room starts life with, before any
         * relaunch has re-pointed it.
         */
        currentRunId?: string;
        foldedBody: unknown;
        noopInference?: boolean;
        sourcesDigest?: string | null;
      }
    | undefined;
  /**
   * The frozen inert wire projection `loadFrozenWireProjection` (read
   * via `select().from(workflowDefinitionVersion)`) returns for each
   * definition id, keyed by id. An id with no entry (or an explicit
   * `null`) mirrors a pre-cutover row that carries no stored
   * projection. Lookups resolve by the definition id actually bound
   * into the query's `where`, so the record answers exactly the ids
   * production code asks for, in any order.
   */
  wireProjectionsByDefinitionId?: Record<string, unknown | null> | undefined;
  /**
   * The `workflow_run_launch_spec` row `resolveRunSessionIdOrThrow`
   * (CL-7481) reads by run id — the session id is fixed at provision
   * time, unlike the principal it used to be looked up by. Explicit
   * only where a test cares about an un-anchored run's session
   * resolving before its principal ever exists; every other test here
   * predates CL-7481 and seeds an `agentSession` row directly, so the
   * fallback below derives one from that instead of touching every
   * call site.
   */
  workflowRunLaunchSpecRow?:
    { anchorRunId: string; sessionId: string } | undefined;
}) {
  const inserted: { table: unknown; values: unknown }[] = [];
  const updated: { table: unknown; values: unknown }[] = [];
  const deleted: { table: unknown }[] = [];

  const wireProjectionCalls: string[] = [];

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
        findFirst: async (query?: { where?: unknown }) => {
          const [id] =
            query?.where !== undefined ? boundStringValues(query.where) : [];
          if (
            opts.workflowRunRow !== undefined &&
            (id === undefined || id === opts.workflowRunRow.id)
          ) {
            return {
              ...opts.workflowRunRow,
              definitionId:
                opts.workflowRunRow.definitionId ?? opts.definitionId,
            };
          }
          const insertedLaunch = inserted.findLast(
            (row) => row.table === workbenchLaunch,
          )?.values as
            | { currentRunId?: string; instanceId?: string; tenantId?: string }
            | undefined;
          const launch = (opts.workbenchLaunchRow ?? insertedLaunch) as
            | { currentRunId?: string; instanceId?: string; tenantId?: string }
            | undefined;
          const launchRunId = launch?.currentRunId ?? launch?.instanceId;
          if (launch !== undefined && id !== undefined && id === launchRunId) {
            const domain =
              opts.tenantRow?.domain ??
              opts.workflowRunRow?.address?.split("@")[1] ??
              "ten1.workbench.test";
            return {
              id: launchRunId,
              tenantId: launch.tenantId ?? "ten_1",
              definitionId:
                opts.workflowDefinitionRow?.id ??
                opts.workflowRunRow?.definitionId ??
                opts.definitionId,
              address: `${launchRunId}@${domain}`,
              principalId: opts.workflowRunRow?.principalId ?? null,
              status: "pending",
            };
          }
          const insertedRow = inserted.findLast(
            (row) => row.table === workflowRun,
          )?.values as typeof opts.workflowRunRow | undefined;
          if (insertedRow !== undefined) return insertedRow;
          // A run this fixture never configured: the freshly minted
          // `anchorRunId` a fake `prepareProvisionedDeployment` just
          // returned, which never wrote a `workflowRun` row into this
          // fake db (Interchange's own provisioning is entirely mocked
          // out here). `recordAgentSessionAtProvision` (CL-7481) reads
          // the run row it just "provisioned" immediately after — this
          // synthesizes the generic shape production code would see,
          // so that read succeeds without every test wiring one up.
          if (id === undefined) return undefined;
          const domain =
            opts.tenantRow?.domain ??
            opts.workflowRunRow?.address?.split("@")[1] ??
            "ten1.workbench.test";
          return {
            id,
            tenantId: opts.tenantRow?.id ?? "ten_1",
            definitionId: opts.definitionId,
            address: `${id}@${domain}`,
            principalId: null,
          };
        },
      },
      sessionMail: {
        findFirst: async () => opts.sessionMailRow,
      },
      agentSession: {
        findFirst: async (query?: { where?: unknown }) => {
          const [id] =
            query?.where !== undefined ? boundStringValues(query.where) : [];
          return inserted.findLast(
            (row) =>
              row.table === agentSession &&
              (id === undefined || (row.values as { id?: string }).id === id),
          )?.values as { id: string; principalId: string } | undefined;
        },
      },
      workflowRunLaunchSpec: {
        findFirst: async (query?: { where?: unknown }) => {
          const [id] =
            query?.where !== undefined ? boundStringValues(query.where) : [];
          if (opts.workflowRunLaunchSpecRow !== undefined) {
            return id === undefined ||
              id === opts.workflowRunLaunchSpecRow.anchorRunId
              ? opts.workflowRunLaunchSpecRow
              : undefined;
          }
          const seededSession = inserted.find(
            (row) => row.table === agentSession,
          )?.values as { id: string } | undefined;
          if (seededSession === undefined) return undefined;
          return { anchorRunId: id, sessionId: seededSession.id };
        },
      },
      workflowDefinition: {
        findFirst: async () =>
          opts.workflowDefinitionRow ??
          (opts.workflowRunRow !== undefined
            ? {
                id: opts.definitionId,
                tenantId: "ten_1",
                status: "deployed",
                assetId: "ast_definition1",
                name: "agent",
                origin: "authored" as const,
                grantRequirements: [],
                wireHash: "hash_1",
              }
            : undefined),
        // The requested definition row is itself a deployed row of its
        // asset, so the real asset-sibling query always returns at
        // least it — the single-row default mirrors that.
        findMany: async () =>
          opts.workflowDefinitionRows ??
          (opts.workflowDefinitionRow !== undefined
            ? [opts.workflowDefinitionRow]
            : []),
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
          // The run-trigger client's auth resolution
          // (`resolveTriggerAuthUserId` in `../src/platform-adapter.ts`)
          // looks up the better-auth user behind a principal id. No
          // test here cares which synthetic user a trigger call
          // authenticates as, only that it succeeds, so this answers
          // every lookup with the same fixed "user" principal.
          if (table === principalTable) {
            return selectChain([{ refId: "user_test", kind: "user" }]);
          }
          if (table === workflowDefinition) {
            return selectChain([
              {
                assetId:
                  opts.workflowDefinitionRow?.assetId ?? "ast_definition1",
              },
            ]);
          }
          if (table === workflowDefinitionVersion) {
            // `loadFrozenWireProjection` filters on
            // `and(eq(definitionId, id), eq(version, "1"))`; the first
            // bound string in that expression is the definition id.
            return {
              where: (expression: unknown) => {
                const [definitionId] = boundStringValues(expression);
                if (definitionId === undefined) return selectChain([]);
                wireProjectionCalls.push(definitionId);
                const projection =
                  opts.wireProjectionsByDefinitionId?.[definitionId] ?? null;
                return selectChain([{ wireProjection: projection }]);
              },
            };
          }
          if (table === workbenchLaunch) {
            const insertedLaunch = inserted.findLast(
              (row) => row.table === workbenchLaunch,
            )?.values;
            // Every run this package launches has a launch row, and
            // that row is now the address→run mapping every lookup
            // goes through — so a scenario that configures a run but
            // no launch row gets the identity mapping for it rather
            // than a hole no production run could be in.
            const row =
              opts.workbenchLaunchRow ??
              insertedLaunch ??
              (opts.workflowRunRow !== undefined
                ? {
                    tenantId: "ten_1",
                    instanceId: opts.workflowRunRow.id,
                    currentRunId: opts.workflowRunRow.id,
                    priorRunIds: [],
                    foldedBody: {
                      systemPrompt: "be helpful",
                      toolPackagePins: [],
                      grantRequirements: [],
                      credentialBindings: [],
                      model: null,
                    },
                    noopInference: false,
                  }
                : undefined);
            if (row === undefined) return selectChain([]);
            const withCurrent = row as {
              instanceId: string;
              currentRunId?: string;
              priorRunIds?: string[];
            };
            return selectChain([
              {
                ...withCurrent,
                currentRunId:
                  withCurrent.currentRunId ?? withCurrent.instanceId,
                priorRunIds: withCurrent.priorRunIds ?? [],
              },
            ]);
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
    wireProjectionCalls,
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

type FakeRunTrigger = RunTriggerClient & {
  triggerCalls: TriggerWorkflowRunMailInput[];
};

/**
 * Fakes `@corbits/chat`'s `RunTriggerClient` (CL-7490): the seam
 * `sendRunMail` now delivers every provisioned run's mail through,
 * replacing the old raw `runTrigger.triggerMail`. Each call
 * mints a fresh `messageId` (`<trigger_N@domain>`) the same shape
 * `vendor/intx/hub-api/src/workflow-run-trigger.ts`'s real route mints,
 * so `mailIdFromBracketMessageId` and reply-threading assertions behave
 * exactly as they would against the real route.
 */
function createFakeRunTrigger(): FakeRunTrigger {
  const triggerCalls: TriggerWorkflowRunMailInput[] = [];
  let counter = 0;
  const fake: FakeRunTrigger = {
    triggerCalls,
    async triggerMail(input: TriggerWorkflowRunMailInput) {
      triggerCalls.push(input);
      counter += 1;
      return {
        runId: input.anchorRunId,
        address: `${input.anchorRunId}@ten1.workbench.test`,
        messageId: `<trigger_${String(counter)}@ten1.workbench.test>`,
      };
    },
  };
  return fake;
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
    // fake `runTrigger` just acked, and that deploy is what makes the
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

/**
 * The frozen inert wire projection shape `loadFrozenWireProjection`
 * hands back — `agent.modelSources`, not the live `agent.inference.sources`
 * a serialized in-process definition carries. This is `launchInvite`'s
 * and `refreshAgentInstanceFromDefinition`'s launch-body source under
 * the `workflow.json` retirement.
 */
function inertProjection(
  overrides: {
    id?: string;
    systemPrompt?: string;
    model?: string | null;
    toolPackagePins?: unknown[];
    credentialBindings?: unknown[];
  } = {},
) {
  const {
    id = "wfd_echo",
    systemPrompt = "You are Echo, an invitable demo agent.",
    model = "claude-sonnet-5",
    toolPackagePins = [],
    credentialBindings = [],
  } = overrides;
  return {
    id,
    triggers: [],
    stepOrder: ["agent"],
    steps: {
      agent: {
        kind: "step",
        agent: {
          systemPrompt,
          toolPackagePins,
          modelSources:
            model === null ? [] : [{ provider: "anthropic", model }],
        },
      },
    },
    credentialBindings,
  };
}

describe("createHubChatPlatform", () => {
  test("a failed wake keeps the minted run retryable and abandons its collector", async () => {
    resolveDefinitionSourcesResult = {
      ok: true,
      materials: [],
      sources: [
        {
          id: "off_1",
          provider: "anthropic",
          baseURL: "https://inference.invalid",
          credentialId: "cred_placeholder",
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
      // CL-7490: `wakeByAddress` only ever redeploys a genuinely dead
      // run now — a merely not-yet-routable one is booting and is
      // waited on, never redeployed — so this run must be terminal for
      // the deploy failure below to actually be reached.
      workflowRunRow: {
        id: "ins_workbench1",
        address: "ins_workbench1@ten1.workbench.test",
        principalId: "prin_run1",
        status: "failed",
      },
      workbenchLaunchRow: {
        tenantId: "ten_1",
        instanceId: "ins_workbench1",
        foldedBody: {
          systemPrompt: "be helpful",
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
    const runTrigger = createFakeRunTrigger();
    const deployError = new Error("sidecar unreachable");
    const allocationService = createFakeWorkflowAllocationService();
    allocationService.prepareProvisionedDeployment = async () => {
      throw deployError;
    };
    const sidecarRouter = createFakeSidecarRouter({ routableAddresses: [] });
    const eventCollectors = createFakeEventCollectors();

    const platform = createPlatform({
      toolGrantsForPins: async () => [],
      db: db as never,
      runTrigger,
      sidecarRouter,
      eventCollectors,
      workflowAllocationService: allocationService,
    });

    await expect(
      platform.ensureAwake("ins_workbench1@ten1.workbench.test"),
    ).rejects.toThrow(deployError);

    // Interchange provisions on invite. The collector is Interchange's;
    // a failed prepare never opens one in chat.
    expect(eventCollectors.abandonCalls).toEqual([]);

    // A wake failure is recoverable on the next message, so it never
    // deactivates or deletes the already-durable run.
    expect(db.updated).toEqual([]);
    expect(db.deleted.some((row) => row.table === workflowRun)).toBe(false);
  });

  test("a failed wake keeps the run retryable even when a child leaked", async () => {
    resolveDefinitionSourcesResult = {
      ok: true,
      materials: [],
      sources: [
        {
          id: "off_1",
          provider: "anthropic",
          baseURL: "https://inference.invalid",
          credentialId: "cred_placeholder",
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
      // CL-7490: same reasoning as above — the run must be terminal for
      // `wakeByAddress` to attempt a redeploy at all.
      workflowRunRow: {
        id: "ins_workbench1",
        address: "ins_workbench1@ten1.workbench.test",
        principalId: "prin_run1",
        status: "failed",
      },
      workbenchLaunchRow: {
        tenantId: "ten_1",
        instanceId: "ins_workbench1",
        foldedBody: {
          systemPrompt: "be helpful",
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
    const runTrigger = createFakeRunTrigger();
    const allocationService = createFakeWorkflowAllocationService();
    allocationService.prepareProvisionedDeployment = async () => {
      throw new SessionLaunchError("start", new Error("ack timeout"), true);
    };
    const sidecarRouter = createFakeSidecarRouter({ routableAddresses: [] });
    const eventCollectors = createFakeEventCollectors();

    const platform = createPlatform({
      toolGrantsForPins: async () => [],
      db: db as never,
      runTrigger,
      sidecarRouter,
      eventCollectors,
      workflowAllocationService: allocationService,
    });

    await expect(
      platform.ensureAwake("ins_workbench1@ten1.workbench.test"),
    ).rejects.toThrow(SessionLaunchError);

    expect(db.deleted.some((row) => row.table === workflowRun)).toBe(false);
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

  test("sendMail resolves the workbench's run's session via the shared principal and delivers via runTrigger", async () => {
    resolveDefinitionSourcesResult = {
      ok: true,
      materials: [],
      sources: [
        {
          id: "off_1",
          provider: "anthropic",
          baseURL: "https://inference.invalid",
          credentialId: "cred_placeholder",
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

    const runTrigger = createFakeRunTrigger();
    const sidecarRouter = createFakeSidecarRouter();

    const platform = createPlatform({
      toolGrantsForPins: async () => [],
      db: db as never,
      runTrigger,
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
    expect(runTrigger.triggerCalls).toHaveLength(1);
    const call = runTrigger.triggerCalls[0];
    expect(call?.anchorRunId).toBe("ins_workbench1");
    expect(call?.content).toBe("hello workbench");

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

  test("sendMail on a freshly provisioned, un-anchored run resolves the launch-spec session id (CL-7481)", async () => {
    resolveDefinitionSourcesResult = {
      ok: true,
      materials: [],
      sources: [
        {
          id: "off_1",
          provider: "anthropic",
          baseURL: "https://inference.invalid",
          credentialId: "cred_placeholder",
          model: "claude-sonnet-5",
        },
      ],
      defaultSource: "off_1",
    };

    // No principal on the run yet — an invite sits un-triggered until
    // its first message. Before CL-7481, `resolveRunSessionIdOrThrow`
    // looked the session up by this (null) principal and found nothing;
    // now it reads the launch spec `recordAgentSessionAtProvision`
    // wrote at provision time, keyed by the run's own id instead.
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
        principalId: null,
      },
      workflowRunLaunchSpecRow: {
        anchorRunId: "ins_workbench1",
        sessionId: "ses_unanchored",
      },
    });

    const runTrigger = createFakeRunTrigger();
    const sidecarRouter = createFakeSidecarRouter();

    const platform = createPlatform({
      toolGrantsForPins: async () => [],
      db: db as never,
      runTrigger,
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
    const mailInsert = db.inserted.find((row) => row.table === sessionMail);
    expect(mailInsert?.values).toMatchObject({ sessionId: "ses_unanchored" });
  });

  test("sendMail signs with the injected crypto cache keyed by workbenchId", async () => {
    resolveDefinitionSourcesResult = {
      ok: true,
      materials: [],
      sources: [
        {
          id: "off_1",
          provider: "anthropic",
          baseURL: "https://inference.invalid",
          credentialId: "cred_placeholder",
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
    db.inserted.push({
      table: agentSession,
      values: { id: "ses_run1", principalId: "prin_run1" },
    });

    const runTrigger = createFakeRunTrigger();
    const getKeys: string[] = [];
    const injectedProvider = {
      getPublicKey: () => new Uint8Array([7, 2, 8, 4]),
      // Exercised for real now (CL-7490): `sendRunMail` signs its own
      // local `session_mail` copy directly rather than through a fake
      // `sessionService.sendUserMessage`.
      sign: async () => new Uint8Array(64),
    };
    const cryptoProviders: CryptoProviderCache = {
      get: async (key) => {
        getKeys.push(key);
        return injectedProvider as never;
      },
    };

    const platform = createPlatform({
      toolGrantsForPins: async () => [],
      db: db as never,
      runTrigger,
      sidecarRouter: createFakeSidecarRouter(),
      eventCollectors: createFakeEventCollectors(),
      cryptoProviders,
    });

    await platform.sendMail({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      principalId: "prin_sender",
      content: { content: "hello workbench" },
    });

    // The crypto cache is only consulted for the local `session_mail`
    // signing copy now (CL-7490) — delivery itself goes through the
    // run-trigger client, which signs its own copy independently.
    expect(getKeys).toEqual(["ins_workbench1"]);
    expect(runTrigger.triggerCalls).toHaveLength(1);
  });

  test("sendMail rejects within the mail-delivery deadline instead of hanging forever when delivery never settles (CL-6644)", async () => {
    resolveDefinitionSourcesResult = {
      ok: true,
      materials: [],
      sources: [
        {
          id: "off_1",
          provider: "anthropic",
          baseURL: "https://inference.invalid",
          credentialId: "cred_placeholder",
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
    db.inserted.push({
      table: agentSession,
      values: { id: "ses_run1", principalId: "prin_run1" },
    });

    const runTrigger = createFakeRunTrigger();
    // Models the observed CL-6644 symptom: the post-deploy delivery
    // step (`runTrigger.triggerMail`, reached through
    // `sendFoldedMail`) never resolves and never rejects -- a wedged
    // ack, not a thrown "agent is unreachable" the reclaim-retry loop
    // already knows how to handle. Before the fix, `sendMail`'s
    // returned promise stayed pending forever with nothing logged.
    runTrigger.triggerMail = () => new Promise<never>(() => {});
    const sidecarRouter = createFakeSidecarRouter();

    const platform = createPlatform({
      toolGrantsForPins: async () => [],
      db: db as never,
      runTrigger,
      sidecarRouter,
      eventCollectors: createFakeEventCollectors(),
      mailDeliveryTimeoutMs: 20,
    });

    await expect(
      platform.sendMail({
        tenantId: "ten_1",
        workbenchId: "ins_workbench1",
        principalId: "prin_sender",
        content: { content: "hello workbench" },
      }),
    ).rejects.toThrow(/did not settle within 20ms/);
  });

  test("launchInvite provisions via Interchange and records the returned ids", async () => {
    resolveDefinitionSourcesCalls.length = 0;
    resolveDefinitionSourcesResult = {
      ok: true,
      materials: [],
      sources: [
        {
          id: "off_1",
          provider: "anthropic",
          baseURL: "https://inference.invalid",
          credentialId: "cred_placeholder",
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
        origin: "authored",
        assetId: "asst_echo",
      },
      tenantRow: { id: "ten_1", domain: "ten1.workbench.test" },
      wireProjectionsByDefinitionId: {
        wfd_echo: inertProjection({ id: "wfd_echo" }),
      },
    });
    const runTrigger = createFakeRunTrigger();
    const sidecarRouter = createFakeSidecarRouter({ routableAddresses: [] });
    const eventCollectors = createFakeEventCollectors();

    const platform = createPlatform({
      toolGrantsForPins: async () => [],
      db: db as never,
      runTrigger,
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

    expect(db.wireProjectionCalls).toEqual(["wfd_echo"]);
    expect(lastAllocationService.prepareCalls).toHaveLength(1);
    const prepared = lastAllocationService.prepareCalls[0] as {
      anchorRunId: string;
      deploymentDomain: string;
    };
    expect(prepared.anchorRunId).toBe(launched.instanceId);
    expect(`${prepared.anchorRunId}@${prepared.deploymentDomain}`).toBe(
      launched.address,
    );
    expect(lastAllocationService.prepareCalls[0]).toMatchObject({
      entry: WORKFLOW_SOURCE_ENTRY,
      source: {
        kind: "asset",
        assetId: "asst_echo",
        package: { format: "source", commitSha: "sha_test" },
      },
    });

    expect(
      db.inserted.find((row) => row.table === workflowRun),
    ).toBeUndefined();
    const launchInsert = db.inserted.find(
      (row) => row.table === workbenchLaunch,
    );
    expect(launchInsert?.values).toMatchObject({
      instanceId: launched.instanceId,
      currentRunId: launched.instanceId,
      tenantId: "ten_1",
    });
  });

  test("launchInvite reuses the standing workbench_launch for the same definition", async () => {
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
        origin: "authored",
        assetId: "asst_echo",
      },
      tenantRow: { id: "ten_1", domain: "ten1.workbench.test" },
      wireProjectionsByDefinitionId: {
        wfd_echo: inertProjection({ id: "wfd_echo" }),
      },
    });
    const platform = createPlatform({
      toolGrantsForPins: async () => [],
      db: db as never,
      runTrigger: createFakeRunTrigger(),
      sidecarRouter: createFakeSidecarRouter({ routableAddresses: [] }),
      eventCollectors: createFakeEventCollectors(),
    });

    const first = await platform.launchInvite({
      tenantId: "ten_1",
      creatorPrincipalId: "prin_creator",
      definitionId: "wfd_echo",
    });
    const launchInsertsAfterFirst = db.inserted.filter(
      (row) => row.table === workbenchLaunch,
    ).length;
    const runInsertsAfterFirst = db.inserted.filter(
      (row) => row.table === workflowRun,
    ).length;
    expect(launchInsertsAfterFirst).toBe(1);
    expect(runInsertsAfterFirst).toBe(0);

    const second = await platform.launchInvite({
      tenantId: "ten_1",
      creatorPrincipalId: "prin_creator",
      definitionId: "wfd_echo",
    });

    expect(second.instanceId).toBe(first.instanceId);
    expect(second.address).toBe(first.address);
    expect(
      db.inserted.filter((row) => row.table === workbenchLaunch),
    ).toHaveLength(launchInsertsAfterFirst);
    expect(db.inserted.filter((row) => row.table === workflowRun)).toHaveLength(
      runInsertsAfterFirst,
    );
  });

  // An invited agent's credential secret must be decrypted with the same
  // real cipher the composition root's credential-write route encrypts it
  // with. `createHubChatPlatform`'s own `credentialCipher` dep must reach
  // `resolveDefinitionSources` on every launch, or the raw stored secret
  // (ciphertext, if it was ever encrypted) gets handed to the provider as
  // its API key instead of the decrypted plaintext.
  // Interchange takes catalog offering ids; chat does not decrypt
  // credentials. The cipher still has to be a real cipher because
  // `sendRunMail` signs outbound frames with it.
  test("launchInvite looks up catalog offerings and passes their ids to Interchange", async () => {
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
        origin: "authored",
        assetId: "asst_echo",
      },
      tenantRow: { id: "ten_1", domain: "ten1.workbench.test" },
      wireProjectionsByDefinitionId: {
        wfd_echo: inertProjection({ id: "wfd_echo" }),
      },
    });
    const platform = createPlatform({
      toolGrantsForPins: async () => [],
      db: db as never,
      runTrigger: createFakeRunTrigger(),
      sidecarRouter: createFakeSidecarRouter({ routableAddresses: [] }),
      eventCollectors: createFakeEventCollectors(),
    });

    await platform.launchInvite({
      tenantId: "ten_1",
      creatorPrincipalId: "prin_creator",
      definitionId: "wfd_echo",
    });

    expect(listVisibleOfferingsCalls).toHaveLength(1);
    expect(lastAllocationService.prepareCalls).toHaveLength(1);
    expect(lastAllocationService.prepareCalls[0]).toMatchObject({
      sourceOfferingIds: ["off_1"],
      defaultSourceOfferingId: "off_1",
    });
  });

  test("refuses to mint the platform when credentialCipher is missing", () => {
    expect(() =>
      createHubChatPlatform({
        toolGrantsForPins: async () => [],
        db: {} as never,
        runTrigger: {} as never,
        sidecarRouter: {} as never,
        eventCollectors: createFakeEventCollectors(),
        credentialCipher: undefined as never,
      }),
    ).toThrow(/missing or has the wrong shape/);
  });

  test("refuses to mint the platform when credentialCipher has the wrong shape", () => {
    expect(() =>
      createHubChatPlatform({
        toolGrantsForPins: async () => [],
        db: {} as never,
        runTrigger: {} as never,
        sidecarRouter: {} as never,
        eventCollectors: createFakeEventCollectors(),
        credentialCipher: {} as never,
      }),
    ).toThrow(/missing or has the wrong shape/);
  });

  // A mismatched cipher (right keys, wrong value types) must fail closed at
  // tag construction — launchInvite never starts, so ciphertext cannot reach
  // a provider as an API key.
  test("mismatched credentialCipher fails loudly before launchInvite", async () => {
    resolveDefinitionSourcesCalls.length = 0;
    await expect(
      (async () => {
        const platform = createHubChatPlatform({
          toolGrantsForPins: async () => [],
          db: {} as never,
          runTrigger: {} as never,
          sidecarRouter: {} as never,
          eventCollectors: createFakeEventCollectors(),
          credentialCipher: {
            encrypt: async () => "",
            decrypt: "not-a-function",
          } as never,
        });
        return platform.launchInvite({
          tenantId: "ten_1",
          creatorPrincipalId: "prin_creator",
          definitionId: "wfd_echo",
        });
      })(),
    ).rejects.toThrow(/missing or has the wrong shape/);
    expect(resolveDefinitionSourcesCalls).toHaveLength(0);
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
    const platform = createPlatform({
      toolGrantsForPins: async () => [],
      db: db as never,
      runTrigger: createFakeRunTrigger(),
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

  // A dev DB whose authored definition has drifted (no stored
  // projection) must answer a named error a caller can map to a 4xx,
  // never let the raw lookup failure escape as an unhandled 500 — and
  // never fall back to a run-deploy clone's frozen snapshot.
  test("launchInvite raises DefinitionProjectionMissingError, not a raw 500, when no sibling definition resolves", async () => {
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
        origin: "authored",
        assetId: "asst_dead",
      },
      workflowDefinitionRows: [
        {
          id: "wfd_dead",
          tenantId: "ten_1",
          status: "deployed",
          origin: "authored",
          name: "assistant",
          assetId: "asst_dead",
        },
      ],
      tenantRow: { id: "ten_1", domain: "ten1.workbench.test" },
      // No entry for "wfd_dead" — mirrors a definition with no stored
      // projection, and there is no other sibling to fall back to.
    });

    const platform = createPlatform({
      toolGrantsForPins: async () => [],
      db: db as never,
      runTrigger: createFakeRunTrigger(),
      sidecarRouter: createFakeSidecarRouter({ routableAddresses: [] }),
      eventCollectors: createFakeEventCollectors(),
    });

    await expect(
      platform.launchInvite({
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        definitionId: "wfd_dead",
      }),
    ).rejects.toThrow(DefinitionProjectionMissingError);
  });

  // CL-6452: every run deploy mints a same-named, same-asset sibling
  // definition row frozen with the projection current at that deploy.
  // A later invite must launch the hub-authored row's CURRENT
  // projection — the one a skill pin or instructions save refroze in
  // place — never a newer run clone's stale snapshot.
  test("launchInvite launches the hub-authored projection, not a newer run-deploy clone's stale one", async () => {
    const db = createFakeDb({
      assetRow: {
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        name: "fact-checker",
        displayName: null,
      },
      definitionId: "wfd_workbench1",
      workflowDefinitionRow: {
        id: "wfd_authored",
        tenantId: "ten_1",
        status: "deployed",
        assetId: "asst_agent",
        name: "fact-checker",
        origin: "authored",
      },
      workflowDefinitionRows: [
        // Newest first: the clone the last run deploy minted, frozen
        // before the skill pin landed.
        {
          id: "wfd_run_clone",
          tenantId: "ten_1",
          status: "deployed",
          name: "fact-checker",
          assetId: "asst_agent",
          origin: "run",
        },
        {
          id: "wfd_authored",
          tenantId: "ten_1",
          status: "deployed",
          name: "fact-checker",
          assetId: "asst_agent",
          origin: "authored",
        },
      ],
      tenantRow: { id: "ten_1", domain: "ten1.workbench.test" },
      wireProjectionsByDefinitionId: {
        wfd_run_clone: inertProjection({
          id: "wfd_run_clone",
          systemPrompt: "pre-pin instructions frozen at the run deploy",
        }),
        wfd_authored: inertProjection({
          id: "wfd_authored",
          systemPrompt: "post-pin instructions",
        }),
      },
    });

    const platform = createPlatform({
      toolGrantsForPins: async () => [],
      db: db as never,
      runTrigger: createFakeRunTrigger(),
      sidecarRouter: createFakeSidecarRouter({ routableAddresses: [] }),
      eventCollectors: createFakeEventCollectors(),
    });

    await platform.launchInvite({
      tenantId: "ten_1",
      creatorPrincipalId: "prin_creator",
      definitionId: "wfd_authored",
    });

    const launchInsert = db.inserted.find(
      (row) => row.table === workbenchLaunch,
    );
    expect(
      (launchInsert?.values as { foldedBody: { systemPrompt: string } })
        .foldedBody.systemPrompt,
    ).toBe("post-pin instructions");
  });

  // The candidate set a launch resolves over is the authored row alone:
  // N runs mint N clones, and none of them may ever be consulted.
  test("run-deploy clones never grow the authoritative candidate set", async () => {
    const cloneRows = Array.from({ length: 5 }, (_, index) => ({
      id: `wfd_run_${String(5 - index)}`,
      tenantId: "ten_1",
      status: "deployed",
      name: "fact-checker",
      assetId: "asst_agent",
      origin: "run" as const,
    }));
    const db = createFakeDb({
      assetRow: {
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        name: "fact-checker",
        displayName: null,
      },
      definitionId: "wfd_workbench1",
      workflowDefinitionRow: {
        id: "wfd_authored",
        tenantId: "ten_1",
        status: "deployed",
        assetId: "asst_agent",
        name: "fact-checker",
        origin: "authored",
      },
      workflowDefinitionRows: [
        ...cloneRows,
        {
          id: "wfd_authored",
          tenantId: "ten_1",
          status: "deployed",
          name: "fact-checker",
          assetId: "asst_agent",
          origin: "authored",
        },
      ],
      tenantRow: { id: "ten_1", domain: "ten1.workbench.test" },
      wireProjectionsByDefinitionId: {
        wfd_run_5: inertProjection({ id: "wfd_run_5" }),
        wfd_authored: inertProjection({ id: "wfd_authored" }),
      },
    });

    const platform = createPlatform({
      toolGrantsForPins: async () => [],
      db: db as never,
      runTrigger: createFakeRunTrigger(),
      sidecarRouter: createFakeSidecarRouter({ routableAddresses: [] }),
      eventCollectors: createFakeEventCollectors(),
    });

    await platform.launchInvite({
      tenantId: "ten_1",
      creatorPrincipalId: "prin_creator",
      definitionId: "wfd_authored",
    });

    expect(db.wireProjectionCalls).toEqual(["wfd_authored"]);
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
    const platform = createPlatform({
      toolGrantsForPins: async () => [],
      db: db as never,
      runTrigger: createFakeRunTrigger(),
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
    visibleOfferings = [];

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
        origin: "authored",
        assetId: "asst_echo",
      },
      tenantRow: { id: "ten_1", domain: "ten1.workbench.test" },
      wireProjectionsByDefinitionId: {
        wfd_echo: inertProjection({ id: "wfd_echo" }),
      },
    });
    const platform = createPlatform({
      toolGrantsForPins: async () => [],
      db: db as never,
      runTrigger: createFakeRunTrigger(),
      sidecarRouter: createFakeSidecarRouter({ routableAddresses: [] }),
      eventCollectors: createFakeEventCollectors(),
    });

    await expect(
      platform.launchInvite({
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        definitionId: "wfd_echo",
      }),
    ).rejects.toThrow(MODEL_UNAVAILABLE_CONSUMER_MESSAGE);
  });

  // A `create_agent`-minted definition with no `model` of its own
  // (`@corbits/agent-directory`'s `createAgentDefinitionCore`, absent
  // a `tenantDefaultModel` dep) projects with an empty `modelSources`
  // list — `foldedBody.model` reads back `null`. Without
  // `workbenchHostInferencePreferences`, that used to 409 as
  // `not_launchable`; this proves the fallback resolves and launches
  // instead, exactly mirroring the model a fresh workbench host would
  // get for this tenant.
  const NO_MODEL_PROJECTION = inertProjection({
    id: "wfd_echo",
    model: null,
  });

  test("launchInvite still launches a definition with no model requirements when the catalog has offerings", async () => {
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
        origin: "authored",
        assetId: "asst_echo",
      },
      tenantRow: { id: "ten_1", domain: "ten1.workbench.test" },
      wireProjectionsByDefinitionId: { wfd_echo: NO_MODEL_PROJECTION },
    });
    const platform = createPlatform({
      toolGrantsForPins: async () => [],
      db: db as never,
      runTrigger: createFakeRunTrigger(),
      sidecarRouter: createFakeSidecarRouter({ routableAddresses: [] }),
      eventCollectors: createFakeEventCollectors(),
    });

    const launched = await platform.launchInvite({
      tenantId: "ten_1",
      creatorPrincipalId: "prin_creator",
      definitionId: "wfd_echo",
    });

    expect(launched.instanceId).toMatch(/^run_/);
    expect(listVisibleOfferingsCalls).toHaveLength(1);
    expect(lastAllocationService.prepareCalls[0]).toMatchObject({
      sourceOfferingIds: ["off_1"],
    });
  });

  test("launchInvite still 409s honestly when the tenant has no connected providers to fall back to", async () => {
    visibleOfferings = [];

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
        origin: "authored",
        assetId: "asst_echo",
      },
      tenantRow: { id: "ten_1", domain: "ten1.workbench.test" },
      wireProjectionsByDefinitionId: { wfd_echo: NO_MODEL_PROJECTION },
    });
    const platform = createPlatform({
      toolGrantsForPins: async () => [],
      db: db as never,
      runTrigger: createFakeRunTrigger(),
      sidecarRouter: createFakeSidecarRouter({ routableAddresses: [] }),
      eventCollectors: createFakeEventCollectors(),
    });

    await expect(
      platform.launchInvite({
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        definitionId: "wfd_echo",
      }),
    ).rejects.toThrow(MODEL_UNAVAILABLE_CONSUMER_MESSAGE);
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
          origin: "authored",
          name: "echo",
          description: "Echo",
        },
        {
          id: "wfd_host1",
          tenantId: "ten_1",
          status: "deployed",
          origin: "authored",
          name: "ins-0f1e2d3c4b5a69788796a5b4c3d2e1f0",
        },
        {
          id: "wfd_host2",
          tenantId: "ten_1",
          status: "deployed",
          origin: "authored",
          name: "run-682bf127e22124c01b4b0996aabaab5f",
        },
      ],
    });
    const platform = createPlatform({
      toolGrantsForPins: async () => [],
      db: db as never,
      runTrigger: createFakeRunTrigger(),
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
    const runTrigger = createFakeRunTrigger();
    const sidecarRouter = createFakeSidecarRouter();

    const platform = createPlatform({
      toolGrantsForPins: async () => [],
      db: db as never,
      runTrigger,
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
    // CL-7490: a provisioned anchor stays "deployed" until its first
    // trigger, so a run mid-boot looks exactly like this — live, not yet
    // routable. `wakeByAddress` must not relaunch it; the run is waited
    // on (`deliverWhenRoutable`, via `sendRunMailWithReclaimRetry`) until
    // the sidecar finishes registering, then delivered once.
    test("sendMail waits on a deployed, not-yet-routable workbench and delivers once it becomes routable, without relaunching it", async () => {
      resolveDefinitionSourcesResult = {
        ok: true,
        materials: [],
        sources: [
          {
            id: "off_1",
            provider: "anthropic",
            baseURL: "https://inference.invalid",
            credentialId: "cred_placeholder",
            model: "claude-sonnet-5",
          },
        ],
        defaultSource: "off_1",
      };

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
          principalId: null,
          definitionId: "wfd_workbench1",
          status: "deployed",
        },
        workflowDefinitionRow: {
          id: "wfd_workbench1",
          tenantId: "ten_1",
          status: "deployed",
          origin: "authored",
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

      const runTrigger = createFakeRunTrigger();
      let sendAttempts = 0;
      const baseTriggerMail = runTrigger.triggerMail;
      runTrigger.triggerMail = async (input) => {
        sendAttempts += 1;
        // The first attempt lands while the sidecar is still booting.
        if (sendAttempts === 1) {
          runTrigger.triggerCalls.push(input);
          throw new Error("agent is unreachable");
        }
        return baseTriggerMail(input);
      };
      // Not routable yet — the sidecar is still finishing its boot;
      // it registers a moment later, on its own, with no redeploy.
      const sidecarRouter = createFakeSidecarRouter({ routableAddresses: [] });
      setTimeout(() => {
        sidecarRouter.routableAddresses.push(address);
      }, 10);
      const eventCollectors = createFakeEventCollectors();

      const platform = createPlatform({
        toolGrantsForPins: async () => [],
        db: db as never,
        runTrigger,
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
      // No relaunch: the booting run kept its own run id and address —
      // `wakeByAddress` never called `prepareProvisionedDeployment`.
      expect(lastAllocationService.prepareCalls).toHaveLength(0);
      expect(runTrigger.triggerCalls).toHaveLength(2);
    });

    // CL-6267: the sidecar's own park/wake handler now owns respawning
    // a parked-but-still-announced deployment the moment mail routes
    // to it, so `sendMail` never deploys or undeploys anything for a
    // routable address -- regardless of the underlying run's status --
    // it just proceeds straight to the send.
    test("sendMail never deploys or undeploys a routable workbench, even a completed folded run — the sidecar's park handler owns respawn", async () => {
      resolveDefinitionSourcesResult = {
        ok: true,
        materials: [],
        sources: [
          {
            id: "off_1",
            provider: "anthropic",
            baseURL: "https://inference.invalid",
            credentialId: "cred_placeholder",
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
          origin: "authored",
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

      const runTrigger = createFakeRunTrigger();
      const sidecarRouter = createFakeSidecarRouter({
        routableAddresses: ["ins_workbench1@ten1.workbench.test"],
      });
      const eventCollectors = createFakeEventCollectors();

      const platform = createPlatform({
        toolGrantsForPins: async () => [],
        db: db as never,
        runTrigger,
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
      expect(lastAllocationService.prepareCalls).toHaveLength(0);
      expect(sidecarRouter.sendAgentUndeployCalls).toHaveLength(0);
      expect(runTrigger.triggerCalls).toHaveLength(1);
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

      const platform = createPlatform({
        toolGrantsForPins: async () => [],
        db: db as never,
        runTrigger: createFakeRunTrigger(),
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

      const platform = createPlatform({
        toolGrantsForPins: async () => [],
        db: db as never,
        runTrigger: createFakeRunTrigger(),
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

      const platform = createPlatform({
        toolGrantsForPins: async () => [],
        db: db as never,
        runTrigger: createFakeRunTrigger(),
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
        createPlatform({
          toolGrantsForPins: async () => [],
          db: db as never,
          runTrigger: createFakeRunTrigger(),
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
        createPlatform({
          toolGrantsForPins: async () => [],
          db: db as never,
          runTrigger: createFakeRunTrigger(),
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
        // `ensureAwake` resolves the LIVE address through the mapping
        // before it asks whether anything is routable, so even the
        // no-op path needs the participant's binding to exist.
        workbenchLaunchRow: {
          tenantId: "ten_1",
          instanceId: "ins_workbench1",
          foldedBody: {
            systemPrompt: "be helpful",
            toolPackagePins: [],
            grantRequirements: [],
            credentialBindings: [],
            model: null,
          },
        },
      });
      const runTrigger = createFakeRunTrigger();
      const platform = createPlatform({
        toolGrantsForPins: async () => [],
        db: db as never,
        runTrigger,
        sidecarRouter: createFakeSidecarRouter({
          routableAddresses: [address],
        }),
        eventCollectors: createFakeEventCollectors(),
      });

      await platform.ensureAwake(address);

      expect(lastAllocationService.prepareCalls).toHaveLength(0);
    });

    // CL-7490: `ensureAwake` (via `wakeByAddress`) must not redeploy a
    // merely not-yet-routable run — only a genuinely terminal one. A
    // `deployed`/`running` run that has not yet registered is left alone
    // here (no unit test needed for that: `wakeByAddress` becomes a
    // pure no-op, nothing to assert beyond "did not call prepare", which
    // the failed-run tests below cover by contrast).
    test("relaunches a failed, non-routable address exactly once when lifecycle is configured", async () => {
      resolveDefinitionSourcesResult = {
        ok: true,
        materials: [],
        sources: [
          {
            id: "off_1",
            provider: "anthropic",
            baseURL: "https://inference.invalid",
            credentialId: "cred_placeholder",
            model: "claude-sonnet-5",
          },
        ],
        defaultSource: "off_1",
      };
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
          status: "failed",
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

      const runTrigger = createFakeRunTrigger();
      const platform = createPlatform({
        toolGrantsForPins: async () => [],
        db: db as never,
        runTrigger,
        sidecarRouter: createFakeSidecarRouter({ routableAddresses: [] }),
        eventCollectors: createFakeEventCollectors(),
        lifecycle: { idleSleepMs: 60_000 },
      });

      await platform.ensureAwake(address);

      expect(lastAllocationService.prepareCalls).toHaveLength(1);
    });

    test("relaunches a failed, non-routable address exactly once when lifecycle is not configured", async () => {
      resolveDefinitionSourcesResult = {
        ok: true,
        materials: [],
        sources: [
          {
            id: "off_1",
            provider: "anthropic",
            baseURL: "https://inference.invalid",
            credentialId: "cred_placeholder",
            model: "claude-sonnet-5",
          },
        ],
        defaultSource: "off_1",
      };
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
          status: "failed",
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

      const runTrigger = createFakeRunTrigger();
      const platform = createPlatform({
        toolGrantsForPins: async () => [],
        db: db as never,
        runTrigger,
        sidecarRouter: createFakeSidecarRouter({ routableAddresses: [] }),
        eventCollectors: createFakeEventCollectors(),
      });

      await platform.ensureAwake(address);

      expect(lastAllocationService.prepareCalls).toHaveLength(1);
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
      const platform = createPlatform({
        toolGrantsForPins: async () => [],
        db: db as never,
        runTrigger: createFakeRunTrigger(),
        sidecarRouter: createFakeSidecarRouter({ routableAddresses: [] }),
        eventCollectors: createFakeEventCollectors(),
      });

      await expect(
        platform.ensureAwake("ins_unknown@ten1.workbench.test"),
      ).rejects.toThrow();
    });
  });

  // CL-7214 proved `sendRunMailWithReclaimRetry`'s reclaim-retry wake and
  // an independent, concurrent `ensureAwake` call coalesced onto the same
  // in-flight redeploy rather than racing two `prepareProvisionedDeployment`
  // calls on the same `session_asset` primary key and git ref. That
  // redeploy is no longer wakeByAddress's behavior for a live, merely
  // not-yet-routable run (CL-7490) — the only thing left to redeploy is a
  // genuinely terminal run, and the coalescing that guards a concurrent
  // redeploy of it is `@corbits/agent-lifecycle`'s `pendingWakes` map,
  // proven directly in that package's own test suite (see the note above
  // `describe("lifecycle wiring", ...)`), not re-proven here.

  // CL-7486: `sendRunMailWithReclaimRetry` used to retry every attempt
  // against the address it started with, even after a wake in between
  // attempts relaunched the run. A run already one relaunch generation
  // in (`instanceId` stable, `currentRunId` already repointed once) that
  // dies again while this loop is retrying reproduces the production
  // failure exactly: a second relaunch repoints `currentRunId` again,
  // and the address this loop still holds is now neither the stable
  // `instanceId` nor the current `currentRunId` — invisible to
  // `readBindingByAddressAnyTenant`, so the next wake for it throws "No
  // workbench_launch binding" instead of finding the run that replaced
  // it.
  describe("sendRunMailWithReclaimRetry re-resolves the live address", () => {
    test("a relaunch between retries is chased to its new address, not retried against the one that died", async () => {
      resolveDefinitionSourcesResult = {
        ok: true,
        materials: [],
        sources: [
          {
            id: "off_1",
            provider: "anthropic",
            baseURL: "https://inference.invalid",
            credentialId: "cred_placeholder",
            model: "claude-sonnet-5",
          },
        ],
        defaultSource: "off_1",
      };

      const staleAddress = "run_gen1@ten1.workbench.test";
      const db = createFakeDb({
        assetRow: {
          tenantId: "ten_1",
          creatorPrincipalId: "prin_creator",
          name: "ins_room1",
          displayName: null,
        },
        definitionId: "wfd_room1",
        workflowRunRow: {
          id: "run_gen1",
          address: staleAddress,
          principalId: "prin_room1",
          definitionId: "wfd_room1",
          // Already dead by the time the reclaim retry's own wake reads
          // it — the run died again while this loop was mid-retry, not
          // at the top of `sendMail` (which would have relaunched it
          // before ever reaching this retry loop at all).
          status: "failed",
        },
        workflowDefinitionRow: {
          id: "wfd_room1",
          tenantId: "ten_1",
          status: "deployed",
          origin: "authored",
          assetId: "asst_room1",
        },
        workbenchLaunchRow: {
          tenantId: "ten_1",
          // `instanceId` is the room's own stable id, already distinct
          // from `currentRunId` — this participant has been relaunched
          // once before this test even starts.
          instanceId: "ins_room1",
          currentRunId: "run_gen1",
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
        values: { id: "ses_run1", principalId: "prin_room1" },
      });

      const staleRunId = "run_gen1";
      const runTrigger = createFakeRunTrigger();
      const baseTriggerMail = runTrigger.triggerMail;
      runTrigger.triggerMail = async (input) => {
        // The dead run never becomes reachable again — only a send to
        // whatever run the relaunch actually produced can succeed.
        if (input.anchorRunId === staleRunId) {
          runTrigger.triggerCalls.push(input);
          throw new Error("agent is unreachable");
        }
        return baseTriggerMail(input);
      };

      // Routable so `sendMail`'s own opening wake-before-send gate skips
      // waking it — the relaunch this test cares about must happen
      // inside the reclaim-retry loop below, not before it.
      const sidecarRouter = createFakeSidecarRouter({
        routableAddresses: [staleAddress],
      });

      // Models the sidecar registering the relaunch's fresh address the
      // moment its deploy actually completes — `sendRunMailWithReclaimRetry`
      // now waits on this routing-table transition (CL-7488) instead of a
      // fixed backoff, so the retried send needs it to flip before it can
      // see the run through.
      const allocationService = createFakeWorkflowAllocationService();
      const originalPrepare =
        allocationService.prepareProvisionedDeployment.bind(allocationService);
      allocationService.prepareProvisionedDeployment = async (
        params: Parameters<typeof originalPrepare>[0],
      ) => {
        const result = await originalPrepare(params);
        sidecarRouter.routableAddresses.push(result.deploymentAddress);
        return result;
      };

      const platform = createPlatform({
        toolGrantsForPins: async () => [],
        db: db as never,
        runTrigger,
        sidecarRouter,
        eventCollectors: createFakeEventCollectors(),
        workflowAllocationService: allocationService,
        routableWaitDeadlineMs: 5_000,
        mailDeliveryTimeoutMs: 5_000,
      });

      const sent = await platform.sendMail({
        tenantId: "ten_1",
        workbenchId: "ins_room1",
        principalId: "prin_sender",
        content: { content: "hello" },
      });

      expect(sent.id).toBeTruthy();
      expect(runTrigger.triggerCalls).toHaveLength(2);
      const [first, second] = runTrigger.triggerCalls;
      expect(first?.anchorRunId).toBe(staleRunId);
      // The retry that follows the relaunch targets the run that
      // replaced `run_gen1`, never the dead run the loop started with.
      expect(second?.anchorRunId).not.toBe(staleRunId);

      const repointed = db.updated.at(-1)?.values as {
        currentRunId: string;
        priorRunIds: string[];
      };
      expect(repointed.currentRunId).toBe(second?.anchorRunId ?? "");
      expect(repointed.priorRunIds).toEqual(["run_gen1"]);
    });
  });

  // Proves the actual lever an edited system prompt reaches a running
  // instance through: `wakeByAddress` (exercised via `sendMail`'s
  // wake-on-send path above) replays `workbench_launch.foldedBody`
  // verbatim and never reads the definition's asset itself, so a
  // definition edit only reaches a running instance if something
  // recomputes that row from the definition's current asset content —
  // this is that something.
  describe("refreshAgentInstanceFromDefinition", () => {
    const NEW_PROJECTION = inertProjection({
      id: "wfd_agent1",
      systemPrompt: "You are now a blunt, no-nonsense assistant.",
      model: "claude-sonnet-5",
    });

    function buildRefreshableDb(workflowRunStatus?: string) {
      return createFakeDb({
        assetRow: {
          tenantId: "ten_1",
          creatorPrincipalId: "prin_creator",
          name: "unused",
          displayName: null,
        },
        definitionId: "wfd_unused",
        workflowRunRow: {
          id: "run_agent1",
          address: "agent1@ten1.workbench.test",
          principalId: "prin_agent1",
          definitionId: "wfd_agent1",
          ...(workflowRunStatus !== undefined
            ? { status: workflowRunStatus }
            : {}),
        },
        workflowDefinitionRow: {
          id: "wfd_agent1",
          tenantId: "ten_1",
          status: "deployed",
          origin: "authored",
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
        wireProjectionsByDefinitionId: { wfd_agent1: NEW_PROJECTION },
      });
    }

    test("recomputes and persists the folded body from the definition's current projection", async () => {
      const db = buildRefreshableDb();
      const platform = createPlatform({
        toolGrantsForPins: async () => [],
        db: db as never,
        runTrigger: createFakeRunTrigger(),
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
        materials: [],
        sources: [
          {
            id: "off_1",
            provider: "anthropic",
            baseURL: "https://inference.invalid",
            credentialId: "cred_placeholder",
            model: "claude-sonnet-5",
          },
        ],
        defaultSource: "off_1",
      };

      // CL-7490: `wakeByAddress` no longer redeploys a merely
      // not-yet-routable run — only a genuinely dead one, so this run
      // must actually be terminal (not just offline) for `sendMail`'s
      // wake-on-send path to be the one that carries the refreshed
      // system prompt into a fresh deploy.
      const db = buildRefreshableDb("failed");
      db.inserted.push({
        table: agentSession,
        values: { id: "ses_agent1", principalId: "prin_agent1" },
      });
      const runTrigger = createFakeRunTrigger();
      const platform = createPlatform({
        toolGrantsForPins: async () => [],
        db: db as never,
        runTrigger,
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

      expect(lastAllocationService.prepareCalls).toHaveLength(1);
      expect(lastAllocationService.prepareCalls[0]).toMatchObject({
        entry: WORKFLOW_SOURCE_ENTRY,
        source: {
          kind: "asset",
          package: { format: "source", commitSha: "sha_test" },
        },
      });
    });

    // CL-6452: the deploy repoints `workflow_run.definitionId` at the
    // per-run clone it minted, so the run's own definition row carries
    // the projection frozen at that deploy — a refresh reading it would
    // replay the stale body forever. The refresh must recompute from
    // the hub-authored sibling of the run's asset instead.
    test("recomputes from the hub-authored definition, not the run's own deploy clone", async () => {
      const db = createFakeDb({
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
          definitionId: "wfd_run_clone",
        },
        workflowDefinitionRow: {
          id: "wfd_run_clone",
          tenantId: "ten_1",
          status: "deployed",
          assetId: "asst_agent1",
          name: "fact-checker",
          origin: "run",
        },
        workflowDefinitionRows: [
          {
            id: "wfd_run_clone",
            tenantId: "ten_1",
            status: "deployed",
            name: "fact-checker",
            assetId: "asst_agent1",
            origin: "run",
          },
          {
            id: "wfd_agent1",
            tenantId: "ten_1",
            status: "deployed",
            name: "fact-checker",
            assetId: "asst_agent1",
            origin: "authored",
          },
        ],
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
        wireProjectionsByDefinitionId: {
          wfd_run_clone: inertProjection({
            id: "wfd_run_clone",
            systemPrompt: "You are a careful research assistant.",
          }),
          wfd_agent1: NEW_PROJECTION,
        },
      });
      const platform = createPlatform({
        toolGrantsForPins: async () => [],
        db: db as never,
        runTrigger: createFakeRunTrigger(),
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
  });
});

// CL-6588: a launch renders `workflow_run.definitionId`/`workbench_launch`'s
// `foldedBody` once, and neither a wake nor a relaunch has ever re-read the
// definition's asset on its own -- only an explicit
// `refreshAgentInstanceFromDefinition` call (a human saving settings) did.
// A run that is routable but was deployed from a definition that has since
// changed for a reason nobody in the room caused (a platform code fix, a
// redeployed default agent package) stayed silently wrong forever. These
// prove the automatic reconciliation added ahead of `wakeByAddress`'s
// already-routable return and `sendMail`'s choke point.
describe("createHubChatPlatform stale-definition reconciliation", () => {
  const STALE_SYSTEM_PROMPT =
    "the openai adapter: invalid quirks: default must be removed";
  const FIXED_SYSTEM_PROMPT = "I am working in this workbench.";

  // CL-6452: every deploy freezes a per-run clone of the agent's
  // definition under a wire hash that bakes in per-run values
  // (`wf_<runId>`, the run's own trigger address) — so the clone's
  // hash is unique to the run BY DESIGN, even when its content is
  // byte-identical to what's authored today. The fixture's clone row
  // deliberately carries no `wireHash` field at all (undefined), and
  // the tests below prove staleness is decided on CONTENT
  // (`foldedBody`), never on that per-run-unique hash.
  function createDriftFixture(opts: {
    deployedSystemPrompt: string;
    authoredSystemPrompt: string;
    routable: boolean;
  }) {
    const db = createFakeDb({
      assetRow: {
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        name: "workbench-1",
        displayName: null,
      },
      definitionId: "wfd_unused",
      workflowRunRow: {
        id: "run_stale",
        address: "run_stale@ten1.workbench.test",
        principalId: "prin_room1",
        definitionId: "wfd_run_clone",
        status: "running",
      },
      workflowDefinitionRow: {
        id: "wfd_run_clone",
        tenantId: "ten_1",
        status: "deployed",
        assetId: "asst_myra",
        name: "myra",
        origin: "run",
      },
      workflowDefinitionRows: [
        {
          id: "wfd_run_clone",
          tenantId: "ten_1",
          status: "deployed",
          name: "myra",
          assetId: "asst_myra",
          origin: "run",
        },
        {
          id: "wfd_myra_authored",
          tenantId: "ten_1",
          status: "deployed",
          name: "myra",
          assetId: "asst_myra",
          origin: "authored",
        },
      ],
      workbenchLaunchRow: {
        tenantId: "ten_1",
        instanceId: "run_stale",
        currentRunId: "run_stale",
        foldedBody: {
          systemPrompt: opts.deployedSystemPrompt,
          toolPackagePins: [],
          grantRequirements: [],
          credentialBindings: [],
          model: null,
        },
      },
      wireProjectionsByDefinitionId: {
        // `model: null` matches `foldedBody.model` above -- `inertProjection`
        // defaults `model` to `"claude-sonnet-5"`, which would otherwise
        // read as content drift on its own and mask what these tests
        // are actually proving (system-prompt equality vs. difference).
        wfd_run_clone: inertProjection({
          id: "wfd_run_clone",
          systemPrompt: opts.deployedSystemPrompt,
          model: null,
        }),
        wfd_myra_authored: inertProjection({
          id: "wfd_myra_authored",
          systemPrompt: opts.authoredSystemPrompt,
          model: null,
        }),
      },
    });
    const sidecarRouter = createFakeSidecarRouter({
      routableAddresses: opts.routable ? ["run_stale@ten1.workbench.test"] : [],
    });
    const platform = createPlatform({
      toolGrantsForPins: async () => [],
      db: db as never,
      runTrigger: createFakeRunTrigger(),
      sidecarRouter,
      eventCollectors: createFakeEventCollectors(),
    });
    return { db, platform };
  }

  // A relaunch re-points `currentRunId`; the fixture's rows predate
  // CL-6687's digest column, so the first check also records a baseline
  // `sourcesDigest` — a write that is not a relaunch.
  function repointOf(db: ReturnType<typeof createFakeDb>) {
    return db.updated
      .filter((row) => row.table === workbenchLaunch)
      .map((row) => row.values as { currentRunId?: string })
      .find((values) => values.currentRunId !== undefined);
  }

  test("a routable run whose deployed content differs from the current authored content is relaunched, not served as-is", async () => {
    const { db, platform } = createDriftFixture({
      deployedSystemPrompt: STALE_SYSTEM_PROMPT,
      authoredSystemPrompt: FIXED_SYSTEM_PROMPT,
      routable: true,
    });

    await platform.ensureAwake("run_stale@ten1.workbench.test");

    const repointed = repointOf(db);
    expect(repointed?.currentRunId).toBeDefined();
    expect(repointed?.currentRunId).not.toBe("run_stale");
  });

  // The exact regression this test guards against: PR #298's first cut
  // compared the run's own clone's wire hash (always unique per run)
  // against the authored row's hash, so this fixture -- content
  // identical, hash necessarily different -- read as "drifted" on
  // every single call and relaunched a perfectly healthy run on every
  // wake/send, breaking three chat e2e tests that watched a run stay
  // alive across a turn.
  test("a routable run whose deployed content matches the current authored content is left alone, even though its per-run clone's wire hash is necessarily unrelated to the authored row's", async () => {
    const { db, platform } = createDriftFixture({
      deployedSystemPrompt: FIXED_SYSTEM_PROMPT,
      authoredSystemPrompt: FIXED_SYSTEM_PROMPT,
      routable: true,
    });

    await platform.ensureAwake("run_stale@ten1.workbench.test");

    expect(repointOf(db)).toBeUndefined();
  });

  test("sendMail redeploys an already-routable-but-drifted target before delivering — lifecycle.ensureAwake's routability check alone would have missed it", async () => {
    resolveDefinitionSourcesResult = {
      ok: true,
      materials: [],
      sources: [
        {
          id: "off_1",
          provider: "anthropic",
          baseURL: "https://inference.invalid",
          credentialId: "cred_placeholder",
          model: "claude-sonnet-5",
        },
      ],
      defaultSource: "off_1",
    };
    const { db } = createDriftFixture({
      deployedSystemPrompt: STALE_SYSTEM_PROMPT,
      authoredSystemPrompt: FIXED_SYSTEM_PROMPT,
      routable: true,
    });
    db.inserted.push({
      table: agentSession,
      values: { id: "ses_stale", principalId: "prin_room1" },
    });
    const runTrigger = createFakeRunTrigger();
    const platform = createPlatform({
      toolGrantsForPins: async () => [],
      db: db as never,
      runTrigger,
      sidecarRouter: createFakeSidecarRouter({
        routableAddresses: ["run_stale@ten1.workbench.test"],
      }),
      eventCollectors: createFakeEventCollectors(),
      lifecycle: { idleSleepMs: 60_000 },
    });

    await platform.sendMail({
      tenantId: "ten_1",
      workbenchId: "run_stale",
      principalId: "prin_sender",
      content: { content: "hello" },
    });

    expect(lastAllocationService.prepareCalls).toHaveLength(1);
    expect(lastAllocationService.prepareCalls[0]).toMatchObject({
      entry: WORKFLOW_SOURCE_ENTRY,
      source: {
        kind: "asset",
        package: { format: "source", commitSha: "sha_test" },
      },
    });
  });

  // The coordinator's explicit ask: "unknown" (no authored sibling this
  // adapter can resolve at all -- e.g. a standalone/section-mode run
  // whose asset carries no hub-authored candidate) must mean leave it
  // alone, never treat as drifted.
  test("a run whose asset has no resolvable authored sibling is left alone, not blocked or relaunched", async () => {
    const db = createFakeDb({
      assetRow: {
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        name: "workbench-1",
        displayName: null,
      },
      definitionId: "wfd_unused",
      workflowRunRow: {
        id: "run_standalone",
        address: "run_standalone@ten1.workbench.test",
        principalId: "prin_room1",
        definitionId: "wfd_standalone_clone",
        status: "running",
      },
      workflowDefinitionRow: {
        id: "wfd_standalone_clone",
        tenantId: "ten_1",
        status: "deployed",
        assetId: "asst_standalone",
        name: "standalone-agent",
        origin: "run",
      },
      // No "authored" sibling at all -- `resolveAuthoredProjectedDefinition`
      // finds no candidate and raises `DefinitionProjectionMissingError`.
      workflowDefinitionRows: [
        {
          id: "wfd_standalone_clone",
          tenantId: "ten_1",
          status: "deployed",
          name: "standalone-agent",
          assetId: "asst_standalone",
          origin: "run",
        },
      ],
      workbenchLaunchRow: {
        tenantId: "ten_1",
        instanceId: "run_standalone",
        currentRunId: "run_standalone",
        foldedBody: {
          systemPrompt: "be helpful",
          toolPackagePins: [],
          grantRequirements: [],
          credentialBindings: [],
          model: null,
        },
      },
      wireProjectionsByDefinitionId: {
        wfd_standalone_clone: inertProjection({
          id: "wfd_standalone_clone",
          systemPrompt: "be helpful",
        }),
      },
    });
    const platform = createPlatform({
      toolGrantsForPins: async () => [],
      db: db as never,
      runTrigger: createFakeRunTrigger(),
      sidecarRouter: createFakeSidecarRouter({
        routableAddresses: ["run_standalone@ten1.workbench.test"],
      }),
      eventCollectors: createFakeEventCollectors(),
    });

    await platform.ensureAwake("run_standalone@ten1.workbench.test");

    expect(
      db.updated.find((row) => row.table === workbenchLaunch),
    ).toBeUndefined();
  });
});

// CL-6365: the send-triggered relaunch only fires when somebody writes
// into the room. A room whose agent died in a crash has nobody writing
// into it — that is the whole failure — so the sweep is what makes the
// interrupted turn surface at all.
describe("createHubChatPlatform relaunch sweep", () => {
  const DEAD_ROOM_FOLDED_BODY = {
    systemPrompt: "be helpful",
    toolPackagePins: [],
    grantRequirements: [],
    credentialBindings: [],
    model: null,
  };

  function createSweepFixture(opts: {
    runStatus: string;
    /**
     * `false` builds the standalone/invited-agent shape (CL-6367): a
     * section-mode participant whose relaunch must deploy the same
     * `onTrigger` section it launched as, never the host's folded step.
     */
    noopInference?: boolean;
  }) {
    const db = createFakeDb({
      assetRow: {
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        name: "workbench-1",
        displayName: null,
      },
      definitionId: "wfd_room1",
      workflowRunRow: {
        id: "run_dead",
        address: "run_dead@ten1.workbench.test",
        principalId: "prin_room1",
        definitionId: "wfd_room1",
        status: opts.runStatus,
      },
      workbenchLaunchRow: {
        tenantId: "ten_1",
        instanceId: "ins_room1",
        currentRunId: "run_dead",
        foldedBody: DEAD_ROOM_FOLDED_BODY,
        noopInference: opts.noopInference ?? true,
      },
    });
    const runTrigger = createFakeRunTrigger();
    const notices: unknown[] = [];
    const platform = createPlatform({
      toolGrantsForPins: async () => [],
      db: db as never,
      runTrigger,
      // Routable, and dead anyway: that combination is exactly what the
      // wake path cannot fix — boot restore re-announced the address, so
      // nothing looks broken until the next message is dropped.
      sidecarRouter: createFakeSidecarRouter({
        routableAddresses: ["run_dead@ten1.workbench.test"],
      }),
      eventCollectors: createFakeEventCollectors(),
      relaunchNotice: { current: (notice) => notices.push(notice) },
    });
    return { db, platform, runTrigger, notices };
  }

  test("relaunches a routable-but-dead participant and tells the room", async () => {
    const { db, platform, notices } = createSweepFixture({
      runStatus: "failed",
    });

    const swept = await platform.sweepTerminalRuns();

    expect(swept).toEqual({ scanned: 1, relaunched: 1 });
    expect(lastAllocationService.prepareCalls).toHaveLength(1);

    // The fresh run keeps neither the dead run's id nor its address —
    // the platform derives one from the other — while the room's own
    // stable id never moves.
    const repointed = db.updated.at(-1)?.values as {
      currentRunId: string;
      priorRunIds: string[];
    };
    expect(repointed.currentRunId).not.toBe("run_dead");
    expect(repointed.priorRunIds).toEqual(["run_dead"]);

    expect(notices).toEqual([
      {
        tenantId: "ten_1",
        roomAddress: "ins_room1@ten1.workbench.test",
        deadRunId: "run_dead",
        deadRunStatus: "failed",
        newRunId: repointed.currentRunId,
      },
    ]);
  });

  // CL-6367: the section-shaped mirror of the relaunch case above. A
  // standalone (routine/webhook) or invited agent participant deploys as
  // an `onTrigger` section, and its relaunch must mint the same shape —
  // fresh run id, repointed mapping, the section's agent-bearing step in
  // the redeployed bytes, and the room told — never the host's folded
  // step.
  test("relaunches a dead section participant as a fresh onTrigger section", async () => {
    const { db, platform, notices } = createSweepFixture({
      runStatus: "failed",
      noopInference: false,
    });

    const swept = await platform.sweepTerminalRuns();

    expect(swept).toEqual({ scanned: 1, relaunched: 1 });
    expect(lastAllocationService.prepareCalls).toHaveLength(1);
    expect(lastAllocationService.prepareCalls[0]).toMatchObject({
      entry: WORKFLOW_SOURCE_ENTRY,
      source: {
        kind: "asset",
        package: { format: "source", commitSha: "sha_test" },
      },
    });

    const repointed = db.updated.at(-1)?.values as {
      currentRunId: string;
      priorRunIds: string[];
    };
    expect(repointed.currentRunId).not.toBe("run_dead");
    expect(repointed.priorRunIds).toEqual(["run_dead"]);

    expect(notices).toEqual([
      {
        tenantId: "ten_1",
        roomAddress: "ins_room1@ten1.workbench.test",
        deadRunId: "run_dead",
        deadRunStatus: "failed",
        newRunId: repointed.currentRunId,
      },
    ]);
  });

  test("relaunches a completed run — wake is a fresh provision", async () => {
    const { db, platform, notices } = createSweepFixture({
      runStatus: "completed",
    });

    const swept = await platform.sweepTerminalRuns();

    expect(swept).toEqual({ scanned: 1, relaunched: 1 });
    expect(lastAllocationService.prepareCalls).toHaveLength(1);
    expect(notices).toHaveLength(1);
    const repointed = db.updated.at(-1)?.values as {
      currentRunId: string;
    };
    expect(repointed.currentRunId).not.toBe("run_dead");
  });

  test("leaves a running participant alone", async () => {
    const { platform, notices } = createSweepFixture({
      runStatus: "running",
    });

    expect(await platform.sweepTerminalRuns()).toEqual({
      scanned: 0,
      relaunched: 0,
    });
    expect(lastAllocationService.prepareCalls).toHaveLength(0);
    expect(notices).toEqual([]);
  });
});

// CL-6687: inference sources — the decrypted API key included — are
// rendered into a run's deployed bytes at deploy time and never re-read.
// `foldedBody` comparison cannot see a rotated key, so a live agent kept
// sending the dead one after Settings said the new key was saved. The
// deploy now records a digest of the chain it pinned; a send (or a
// provider connect) compares it against today's resolution and relaunches
// on a mismatch.
describe("createHubChatPlatform inference-source rotation reconciliation", () => {
  const FOLDED_BODY = {
    systemPrompt: "be helpful",
    toolPackagePins: [],
    grantRequirements: [],
    credentialBindings: [],
    model: null,
  };

  function offeringsFor(ids: readonly string[]) {
    return ids.map((id, i) => ({
      offering: { id, priority: i },
      model: { canonicalName: "claude-sonnet-5" },
      provider: { name: "anthropic" },
    }));
  }

  function createRotationFixture(opts: {
    deployedOfferingIds: readonly string[] | null;
    catalogOfferingIds: readonly string[];
  }) {
    visibleOfferings = offeringsFor(opts.catalogOfferingIds);
    const db = createFakeDb({
      assetRow: {
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        name: "workbench-1",
        displayName: null,
      },
      definitionId: "wfd_unused",
      workflowRunRow: {
        id: "run_live",
        address: "run_live@ten1.workbench.test",
        principalId: "prin_room1",
        definitionId: "wfd_run_clone",
        status: "running",
      },
      workflowDefinitionRow: {
        id: "wfd_run_clone",
        tenantId: "ten_1",
        status: "deployed",
        assetId: "asst_myra",
        name: "myra",
        origin: "run",
      },
      workflowDefinitionRows: [
        {
          id: "wfd_run_clone",
          tenantId: "ten_1",
          status: "deployed",
          name: "myra",
          assetId: "asst_myra",
          origin: "run",
        },
        {
          id: "wfd_myra_authored",
          tenantId: "ten_1",
          status: "deployed",
          name: "myra",
          assetId: "asst_myra",
          origin: "authored",
        },
      ],
      workbenchLaunchRow: {
        tenantId: "ten_1",
        instanceId: "run_live",
        currentRunId: "run_live",
        foldedBody: FOLDED_BODY,
        sourcesDigest:
          opts.deployedOfferingIds === null
            ? null
            : opts.deployedOfferingIds.join("\0"),
      },
      wireProjectionsByDefinitionId: {
        wfd_run_clone: inertProjection({
          id: "wfd_run_clone",
          systemPrompt: FOLDED_BODY.systemPrompt,
          model: null,
        }),
        wfd_myra_authored: inertProjection({
          id: "wfd_myra_authored",
          systemPrompt: FOLDED_BODY.systemPrompt,
          model: null,
        }),
      },
    });
    const platform = createPlatform({
      toolGrantsForPins: async () => [],
      db: db as never,
      runTrigger: createFakeRunTrigger(),
      sidecarRouter: createFakeSidecarRouter({
        routableAddresses: ["run_live@ten1.workbench.test"],
      }),
      eventCollectors: createFakeEventCollectors(),
    });
    return { db, platform };
  }

  function repointedLaunch(db: ReturnType<typeof createFakeDb>) {
    return db.updated.find((row) => row.table === workbenchLaunch)?.values as
      { currentRunId: string; sourcesDigest: string } | undefined;
  }

  test("a routable run deployed with offerings the catalog has since rotated is relaunched on the new chain", async () => {
    const { db, platform } = createRotationFixture({
      deployedOfferingIds: ["off_expired"],
      catalogOfferingIds: ["off_fresh"],
    });

    await platform.ensureAwake("run_live@ten1.workbench.test");

    const repointed = repointedLaunch(db);
    expect(repointed?.currentRunId).toBeDefined();
    expect(repointed?.currentRunId).not.toBe("run_live");
    expect(repointed?.sourcesDigest).toBe("off_fresh");
  });

  test("re-saving the same offerings is not a rotation: the run is left alone", async () => {
    const { db, platform } = createRotationFixture({
      deployedOfferingIds: ["off_1"],
      catalogOfferingIds: ["off_1"],
    });

    await platform.ensureAwake("run_live@ten1.workbench.test");

    expect(repointedLaunch(db)).toBeUndefined();
  });

  test("a run that predates digest recording gets today's chain as its baseline and is left alone", async () => {
    const { db, platform } = createRotationFixture({
      deployedOfferingIds: null,
      catalogOfferingIds: ["off_fresh"],
    });

    await platform.ensureAwake("run_live@ten1.workbench.test");

    const launchWrites = db.updated.filter(
      (row) => row.table === workbenchLaunch,
    );
    expect(launchWrites).toHaveLength(1);
    expect(launchWrites[0]?.values).toEqual({
      sourcesDigest: "off_fresh",
    });
  });

  test("the per-send chain check is throttled: a second send inside the interval resolves nothing", async () => {
    const { platform } = createRotationFixture({
      deployedOfferingIds: ["off_1"],
      catalogOfferingIds: ["off_1"],
    });
    listVisibleOfferingsCalls.length = 0;

    await platform.ensureAwake("run_live@ten1.workbench.test");
    const afterFirst = listVisibleOfferingsCalls.length;
    await platform.ensureAwake("run_live@ten1.workbench.test");

    expect(afterFirst).toBeGreaterThan(0);
    expect(listVisibleOfferingsCalls).toHaveLength(afterFirst);
  });

  test("reconcileInferenceSources sweeps a tenant's live participants the moment a credential lands", async () => {
    const { db, platform } = createRotationFixture({
      deployedOfferingIds: ["off_expired"],
      catalogOfferingIds: ["off_fresh"],
    });

    const swept = await platform.reconcileInferenceSources("ten_1");

    expect(swept).toEqual({ scanned: 1, relaunched: 1 });
    expect(repointedLaunch(db)?.currentRunId).not.toBe("run_live");
  });

  test("connecting a provider then sending within the check interval relaunches onto the new chain", async () => {
    const { db, platform } = createRotationFixture({
      deployedOfferingIds: ["off_expired"],
      catalogOfferingIds: ["off_expired"],
    });

    await platform.ensureAwake("run_live@ten1.workbench.test");
    expect(repointedLaunch(db)).toBeUndefined();

    visibleOfferings = offeringsFor(["off_fresh"]);

    await platform.reconcileInferenceSources("ten_1");
    await platform.ensureAwake("run_live@ten1.workbench.test");

    const repointed = repointedLaunch(db);
    expect(repointed?.currentRunId).toBeDefined();
    expect(repointed?.currentRunId).not.toBe("run_live");
    expect(repointed?.sourcesDigest).toBe("off_fresh");
  });
});

// A live Myra launched at signup pins `@corbits/manus-tools` with no
// required binding. Connecting Manus later stores the credential but
// used to only `dispatchTurn` the existing run — the sidecar still
// resolved `manus` as not connected. Inference reconcile cannot see
// this: Manus is not an inference provider. The connect hook has to
// relaunch live runs whose pins include the connector's `feedsTools`
// packages so Interchange prepare picks up the pin on a fresh
// deployment of the same definition asset.
describe("createHubChatPlatform pinned-tool-package connect reconciliation", () => {
  const MANUS_PIN = { name: "@corbits/manus-tools", version: "*" };
  const CATALOG_SOURCES = {
    sources: [
      {
        id: "off_1",
        provider: "anthropic",
        baseURL: "https://inference.invalid",
        credentialId: "cred_anthropic",
        model: "claude-sonnet-5",
      },
    ],
    defaultSource: "off_1",
  };

  function createManusPinFixture(opts: {
    toolPackagePins: { name: string; version: string }[];
  }) {
    resolveDefinitionSourcesResult = {
      ok: true,
      materials: [],
      ...CATALOG_SOURCES,
    };
    buildCredentialDeliveryCalls.length = 0;
    buildCredentialDeliveryResult = {
      ok: true,
      delivery: {
        bindings: [
          {
            handle: "manus",
            credentialId: "cred_manus_1",
            consumer: "tool:@corbits/manus-tools",
          },
        ],
        materials: [
          {
            credentialId: "cred_manus_1",
            providerKey: "manus",
            origin: "https://api.manus.ai",
            secret: "n/a",
          },
        ],
      },
    };
    const foldedBody = {
      systemPrompt: "be helpful",
      toolPackagePins: opts.toolPackagePins,
      grantRequirements: [],
      credentialBindings: [],
      model: null,
    };
    const db = createFakeDb({
      assetRow: {
        tenantId: "ten_1",
        creatorPrincipalId: "prin_creator",
        name: "workbench-1",
        displayName: null,
      },
      definitionId: "wfd_unused",
      workflowRunRow: {
        id: "run_live",
        address: "run_live@ten1.workbench.test",
        principalId: "prin_room1",
        definitionId: "wfd_run_clone",
        status: "running",
      },
      workflowDefinitionRow: {
        id: "wfd_run_clone",
        tenantId: "ten_1",
        status: "deployed",
        assetId: "asst_myra",
        name: "myra",
        origin: "run",
      },
      workflowDefinitionRows: [
        {
          id: "wfd_run_clone",
          tenantId: "ten_1",
          status: "deployed",
          name: "myra",
          assetId: "asst_myra",
          origin: "run",
        },
        {
          id: "wfd_myra_authored",
          tenantId: "ten_1",
          status: "deployed",
          name: "myra",
          assetId: "asst_myra",
          origin: "authored",
        },
      ],
      workbenchLaunchRow: {
        tenantId: "ten_1",
        instanceId: "run_live",
        currentRunId: "run_live",
        foldedBody,
        sourcesDigest: "off_1",
      },
      wireProjectionsByDefinitionId: {
        wfd_run_clone: inertProjection({
          id: "wfd_run_clone",
          systemPrompt: foldedBody.systemPrompt,
          model: null,
          toolPackagePins: opts.toolPackagePins,
        }),
        wfd_myra_authored: inertProjection({
          id: "wfd_myra_authored",
          systemPrompt: foldedBody.systemPrompt,
          model: null,
          toolPackagePins: opts.toolPackagePins,
        }),
      },
    });
    const platform = createPlatform({
      toolGrantsForPins: async () => [],
      db: db as never,
      runTrigger: createFakeRunTrigger(),
      sidecarRouter: createFakeSidecarRouter({
        routableAddresses: ["run_live@ten1.workbench.test"],
      }),
      eventCollectors: createFakeEventCollectors(),
    });
    return { db, platform };
  }

  function repointedLaunch(db: ReturnType<typeof createFakeDb>) {
    return db.updated.find((row) => row.table === workbenchLaunch)?.values as
      { currentRunId: string } | undefined;
  }

  test("connecting manus after a live launch relaunches with the pin", async () => {
    const { db, platform } = createManusPinFixture({
      toolPackagePins: [MANUS_PIN],
    });

    await platform.ensureAwake("run_live@ten1.workbench.test");
    expect(repointedLaunch(db)).toBeUndefined();
    expect(lastAllocationService.prepareCalls).toHaveLength(0);

    const swept = await platform.reconcilePinnedToolPackages("ten_1", [
      "@corbits/manus-tools",
    ]);

    // Persist-only (stamp a pin onto the launch row and leave
    // `currentRunId` as `run_live`) is the bug: the sidecar keeps the
    // snapshot that cannot `resolve("manus")`. A passing result must
    // provision a fresh run of the same definition asset with the pin.
    expect(swept).toEqual({ scanned: 1, relaunched: 1 });
    expect(repointedLaunch(db)?.currentRunId).not.toBe("run_live");
    expect(lastAllocationService.prepareCalls).toHaveLength(1);
    expect(lastAllocationService.prepareCalls[0]).toMatchObject({
      definitionAssetId: "asst_myra",
      source: {
        kind: "asset",
        assetId: "asst_myra",
        package: { format: "source", commitSha: "sha_test" },
      },
      toolPackagePins: [MANUS_PIN],
    });
  });

  test("a live run that does not pin the connected package is left alone", async () => {
    const { db, platform } = createManusPinFixture({
      toolPackagePins: [],
    });

    const swept = await platform.reconcilePinnedToolPackages("ten_1", [
      "@corbits/manus-tools",
    ]);

    expect(swept).toEqual({ scanned: 1, relaunched: 0 });
    expect(repointedLaunch(db)).toBeUndefined();
    expect(lastAllocationService.prepareCalls).toHaveLength(0);
  });
});
