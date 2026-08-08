// The hub-side `ChatPlatform` implementation, owned by this package
// rather than by `apps/hub` — "apps stay generic; packages own the
// domain" applies to the platform port exactly as it does to the rest
// of chat's behavior. `createHubChatPlatform` composes the port
// entirely from services a host already builds (`SessionService`,
// `AssetService`, `SidecarRouter`, `db`, and the grant store); every
// call here is in-process, and nothing self-calls the hub's own HTTP
// surface.
//
// `launchChannel` launches the channel host (see `channel-workflow.ts`)
// as a folded interactive instance — the same shape and the same
// address family `POST /workflows/runs` produces (see
// `vendor/intx/hub-api/src/routes/instances.ts`, this module's
// reference implementation) — rather than through the native
// `sessionService.deployWorkflowDefinition` path. A workflow-deploy
// anchor is a *deployment* run (`workflow_run.deploymentId` set, no
// `principalId`), which is a different address family than a folded
// run and is never resolved by the platform's own run-scoped mail
// surfaces; a folded run (`deploymentId: null`, `principalId` set,
// its session found by joining `agent_session` on that principal) is
// what makes the anchor's mailbox actually listable through the
// platform's sanctioned per-run surfaces. The definition needs no
// working model for its own replies (its system prompt forbids
// replying at all), but the folded launch path still resolves and
// pins a real inference source chain against the tenant catalog —
// that catalog seeding is a deploy-time precondition of this address
// family, not an inference requirement of the anchor.
import { and, desc, eq, lt, or } from "drizzle-orm";
import { createAgentLifecycle } from "@corbits/agent-lifecycle";
import type { DB } from "@intx/db";
import {
  agentSession,
  principal as principalTable,
  sessionMail,
  tenant as tenantTable,
  workflowDefinition,
  workflowRun,
} from "@intx/db/schema";
import { createEd25519Crypto, generateKeyPair } from "@intx/crypto";
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import { extractPartByPath, parseMailToEmail } from "@intx/mime";
import { encodeParts } from "./codec";
import { channelLaunch } from "./schema";
import {
  ensureWorkflowDefinitionForAsset,
  resolveRunSessionId,
  SessionLaunchError,
  WORKFLOW_JSON_PATH,
} from "@intx/hub-sessions";
import type {
  AssetService,
  EventCollectorRegistry,
  SessionService,
  SidecarRouter,
} from "@intx/hub-sessions";
import { resolveDefinitionSources } from "@intx/hub-api";
import type { FoldedBody } from "@intx/workflow-deploy";
import {
  formatAgentAddress,
  GrantRequirement,
  CredentialBinding,
} from "@intx/types";
import type { CryptoProvider } from "@intx/types/runtime";
import { ToolPackagePin } from "@intx/types/tool-packages";
import { type } from "arktype";
import type {
  ChatChannelEvent,
  ChatPlatform,
  InvitableDefinition,
  LaunchedChannel,
  LaunchedInvite,
  ListedMail,
  SentMail,
} from "./routes";

export type CreateHubChatPlatformDeps = {
  db: DB["db"];
  sessionService: SessionService;
  assetService: AssetService;
  sidecarRouter: SidecarRouter;
  /**
   * Every caller of `createHubChatPlatform` builds this via
   * `createEventCollectorRegistry` and passes it through — without it,
   * an anchor's runtime status/readiness (health, SSE replay) reads as
   * permanently "not_ready", and the idle-sweep's `isBusy` guard (see
   * the lifecycle construction below) has no signal at all.
   */
  eventCollectors: EventCollectorRegistry;
  /**
   * Opt-in idle-sleep for every launched instance (channel hosts and
   * invited agents alike): absent here, the adapter keeps today's
   * behavior exactly (nothing ever sleeps, no interval runs). When
   * present, this adapter builds a `@corbits/agent-lifecycle` instance
   * from it, wiring its `isRoutable`/`undeploy`/`wake` ports onto
   * `sidecarRouter` and this adapter's own redeploy-at-head closure —
   * `@corbits/agent-lifecycle` itself never imports the hub or this
   * package. Its sweep tears down instances idle for `idleSleepMs` via
   * `sidecarRouter.sendAgentUndeploy`, and `sendMail` calls
   * `ensureAwake` to redeploy a non-routable target before sending.
   */
  lifecycle?: { idleSleepMs: number; sweepIntervalMs?: number };
};

const BLOB_ID_PATTERN = /^blob_(.+?)_(\d[\d.]*)$/;
const MAIL_PAGE_SIZE = 50;

// Asset names are constrained to `^[a-z0-9]+(-[a-z0-9]+)*$`; a channel
// id (`generateId("instance")`) may carry characters outside that set,
// so this derives a compliant name deterministically rather than
// storing a second identifier.
function assetNameForChannel(channelId: string): string {
  return channelId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Every channel host's workflow asset is named via `assetNameForChannel`
// off a `generateId("instance")` id (`ins_<hex>`), which always yields
// this prefix once slugified — `listInvitableDefinitions` uses it to
// exclude channel hosts from the invitable set without needing a
// separate "is this a channel host" column.
const CHANNEL_HOST_ASSET_NAME_PREFIX = "ins-";

/**
 * Reads a workflow definition's raw JSON back out of its materialized
 * asset. Reimplemented here rather than imported from
 * `@intx/hub-api`'s `run-grant-materialization.ts` (the reference
 * `POST /workflows/runs` route's own helper): that module is
 * hub-api-internal, not part of its published surface, matching the
 * same module-privacy reason `channel-workflow.ts` reimplements
 * `assertJsonPortable` rather than reaching into another package's
 * internals.
 */
async function readDefinitionJSON(
  assetService: AssetService,
  assetId: string,
): Promise<unknown> {
  const raw = await assetService.readAssetBlob({
    assetId,
    path: WORKFLOW_JSON_PATH,
  });
  try {
    return JSON.parse(new TextDecoder().decode(raw));
  } catch (cause) {
    throw new Error(
      `workflow asset ${assetId} ${WORKFLOW_JSON_PATH} is not valid JSON`,
      { cause },
    );
  }
}

/**
 * The launch-relevant subset of a folded `WorkflowDefinition`'s single
 * `step` primitive: `AgentDefinition` itself is not JSON-portable (its
 * `toolFactories` are functions), so `@intx/workflow`'s real
 * `WorkflowDefinition` type is not something a parsed JSON blob can
 * ever honestly satisfy — narrowing to it with a cast would just
 * assert the untyped parts into existence. This schema instead
 * validates exactly the fields a folded definition's step carries that
 * `readFoldedBody` below reads.
 */
const FoldedWorkflowStepSchema = type({
  kind: "'step'",
  agent: {
    systemPrompt: "string",
    "toolPackagePins?": ToolPackagePin.array(),
    inference: {
      sources: type({ "model?": "string | null" }).array(),
    },
  },
});

/** The launch-relevant subset of a folded `WorkflowDefinition` itself. */
const FoldedWorkflowDefinitionSchema = type({
  id: "string",
  stepOrder: "string[]",
  steps: "Record<string, unknown>",
  "grantRequirements?": GrantRequirement.array(),
  "credentialBindings?": CredentialBinding.array(),
});

const FoldedBodySchema = type({
  systemPrompt: "string",
  toolPackagePins: ToolPackagePin.array(),
  grantRequirements: GrantRequirement.array(),
  credentialBindings: CredentialBinding.array(),
  model: "string | null",
});

/**
 * Reads the launch body back out of parsed workflow-definition JSON —
 * the same fields `@intx/workflow-deploy`'s `extractFoldedBody` reads
 * off a real `WorkflowDefinition`, reimplemented against the validated
 * JSON-portable subset above rather than casting a parsed blob into
 * that richer, function-bearing type.
 */
function readFoldedBody(raw: unknown): FoldedBody {
  const definition = FoldedWorkflowDefinitionSchema(raw);
  if (definition instanceof type.errors) {
    throw new Error(`folded definition is malformed: ${definition.summary}`);
  }
  const [stepId, ...rest] = definition.stepOrder;
  if (stepId === undefined || rest.length > 0) {
    throw new Error(
      `folded definition ${definition.id} is not single-step (${String(
        definition.stepOrder.length,
      )} steps)`,
    );
  }
  const step = FoldedWorkflowStepSchema(definition.steps[stepId]);
  if (step instanceof type.errors) {
    throw new Error(
      `folded definition ${definition.id} step ${stepId} is not a step primitive: ${step.summary}`,
    );
  }
  const foldedBody = FoldedBodySchema({
    systemPrompt: step.agent.systemPrompt,
    toolPackagePins: step.agent.toolPackagePins ?? [],
    grantRequirements: definition.grantRequirements ?? [],
    credentialBindings: definition.credentialBindings ?? [],
    model: step.agent.inference.sources[0]?.model ?? null,
  });
  if (foldedBody instanceof type.errors) {
    throw new Error(
      `folded definition ${definition.id} produced an invalid folded body: ${foldedBody.summary}`,
    );
  }
  return foldedBody;
}

/**
 * The deploy-only step shared by a fresh launch (`launchCore`) and a
 * wake (re-deploying an instance the sidecar no longer has resident):
 * resolve inference sources against the tenant catalog, (re)open the
 * event collector, and call `deployInstanceAtHead`. Callers that just
 * wrote new principal/session/run rows (`launchCore`) still own their
 * own failure-path rollback of those rows — this function only throws.
 */
async function deployAtHead(
  deps: Pick<
    CreateHubChatPlatformDeps,
    "db" | "sessionService" | "eventCollectors"
  >,
  params: {
    tenantId: string;
    instanceId: string;
    triggerAddress: string;
    principalId: string;
    sessionId: string;
    foldedBody: FoldedBody;
    /** Named in the "seed a tenant catalog source" error, e.g. "the channel host", "the invited agent", or "the woken instance". */
    launchLabel: string;
  },
): Promise<void> {
  const resolution = await resolveDefinitionSources({
    db: deps.db,
    tenantId: params.tenantId,
    modelRequirements: null,
    fallbackModel: params.foldedBody.model,
    invokerPreferences: {},
  });
  if (!resolution.ok) {
    throw new Error(
      `cannot resolve an inference source for ${params.launchLabel} ` +
        `(${resolution.message}); seed a tenant catalog source (provider, ` +
        `credential, catalog model/provider/offering) before launching`,
    );
  }

  // `create` replaces any collector already registered for this
  // address (see `EventCollectorRegistry.create`), so this is
  // idempotent whether this is a fresh launch or a wake of an instance
  // whose collector never got torn down.
  deps.eventCollectors.create(
    params.triggerAddress,
    params.tenantId,
    params.sessionId,
    params.instanceId,
  );

  await deps.sessionService.deployInstanceAtHead({
    agentAddress: params.triggerAddress,
    agentId: params.instanceId,
    instanceId: params.instanceId,
    config: {
      sessionId: params.sessionId,
      agentId: params.instanceId,
      tenantId: params.tenantId,
      principalId: params.principalId,
      agentAddress: params.triggerAddress,
      systemPrompt: params.foldedBody.systemPrompt,
      tools: [],
      grants: [],
      sources: resolution.sources,
      defaultSource: resolution.defaultSource,
    },
    deployContent: { systemPrompt: params.foldedBody.systemPrompt },
    toolPackagePins: params.foldedBody.toolPackagePins,
  });
}

function domainOf(address: string): string {
  const at = address.indexOf("@");
  if (at === -1) {
    throw new Error(`malformed agent address, missing "@": ${address}`);
  }
  return address.slice(at + 1);
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ createdAt: createdAt.toISOString(), id }),
  ).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const parsed = JSON.parse(
    Buffer.from(cursor, "base64url").toString("utf-8"),
  ) as {
    createdAt: string;
    id: string;
  };
  return { createdAt: new Date(parsed.createdAt), id: parsed.id };
}

/**
 * Composes the `ChatPlatform` port over the hub's real session
 * services. One crypto provider is minted per channel (mirroring the
 * per-instance signing-key cache the platform's own mail route keeps)
 * and cached for the adapter's lifetime.
 */
export function createHubChatPlatform(
  deps: CreateHubChatPlatformDeps,
): ChatPlatform {
  // Never evicted: undeploying a channel host's address (idle sleep, a
  // sweep) does not mean the channel itself is gone, so tearing this
  // down on that signal would rotate the channel's signing key on the
  // next wake for no reason. Grows only with the number of distinct
  // channels this process ever sends mail for, which is bounded by the
  // tenant's own channel count, not by traffic.
  const cryptoProviders = new Map<string, Promise<CryptoProvider>>();

  function cryptoProviderFor(channelId: string): Promise<CryptoProvider> {
    let pending = cryptoProviders.get(channelId);
    if (pending !== undefined) return pending;
    pending = generateKeyPair().then((keyPair) => createEd25519Crypto(keyPair));
    cryptoProviders.set(channelId, pending);
    return pending;
  }

  async function findChannelRun(channelId: string) {
    return deps.db.query.workflowRun.findFirst({
      where: eq(workflowRun.id, channelId),
    });
  }

  /**
   * Resolves a folded run's session id via the shared-principal bridge
   * (`resolveRunSessionId`) rather than any name derived from the
   * channel id — that bridge is what makes the run's mail listable
   * through the platform's own sanctioned per-run surfaces.
   */
  async function sessionIdForRun(run: {
    principalId: string | null;
  }): Promise<string> {
    const sessionId = await resolveRunSessionId(deps.db, run.principalId, {
      includeEnded: true,
    });
    if (sessionId === null) {
      throw new Error(
        "no agent_session found for this channel run's principal; " +
          "the folded launch may not have completed",
      );
    }
    return sessionId;
  }

  // Built from `@corbits/agent-lifecycle` — the idle-sleep sweep and
  // wake-coalescing logic live entirely in that package, imported as a
  // published dependency rather than reimplemented here; this adapter
  // only wires its ports onto `sidecarRouter` (routability, undeploy),
  // `deps.eventCollectors` (busy detection), and `wakeByAddress` (this
  // module's own redeploy-at-head closure, declared below — a plain
  // `function` declaration, so it is already hoisted by the time this
  // closure is called). `undefined` when `deps.lifecycle` is unset,
  // matching today's behavior exactly: nothing is tracked, no sweep
  // runs, `sendMail` never calls `ensureAwake`.
  const lifecycle =
    deps.lifecycle !== undefined
      ? createAgentLifecycle({
          idleSleepMs: deps.lifecycle.idleSleepMs,
          ...(deps.lifecycle.sweepIntervalMs !== undefined
            ? { sweepIntervalMs: deps.lifecycle.sweepIntervalMs }
            : {}),
          isRoutable: (address) =>
            deps.sidecarRouter.getRoutableAddresses().includes(address),
          undeploy: async (address, reason) => {
            await deps.sidecarRouter.sendAgentUndeploy(address, reason);
            // The only correct eviction hook for a reply bridge: an
            // undeployed address is never going to emit another
            // `connector.reply` until it is woken and re-armed, so drop
            // its bridge (and reverse-map entry) rather than leaving it
            // in `replyBridges` for the rest of the process's lifetime.
            for (const [
              agentChannelId,
              bridgeAddress,
            ] of replyBridgeAddresses) {
              if (bridgeAddress !== address) continue;
              replyBridges.get(agentChannelId)?.();
              replyBridges.delete(agentChannelId);
              replyBridgeAddresses.delete(agentChannelId);
            }
          },
          wake: wakeByAddress,
          isBusy: (address) =>
            typeof deps.eventCollectors.getCurrentTurnId(address) === "string",
          log: getLogger(["chat", "lifecycle"]),
        })
      : undefined;

  // Reply bridges: one live subscription per invited agent, translating
  // its connector.reply events into channel messages. The platform's
  // event stream is the ONLY place an agent's reply surfaces at this
  // Interchange version — replies never persist as session mail — so
  // without this bridge a mentioned agent answers into the void.
  // Keyed by agent run id; idempotent to arm, cheap to consult. The
  // reverse map (agent run id -> resolved address) exists only so the
  // lifecycle's `undeploy` port above can find and drop a bridge when
  // its agent sleeps; neither map is otherwise bounded by anything
  // except the number of distinct invited agents a process ever sees.
  const replyBridges = new Map<string, () => void>();
  const replyBridgeAddresses = new Map<string, string>();
  const bridgeLog = getLogger(["chat", "reply-bridge"]);

  /**
   * The launch core shared by `launchChannel` (host) and `launchInvite`
   * (invited agent): resolve inference sources against the tenant
   * catalog, write the folded run's principal/session/run rows, open
   * the event collector, and deploy via `deployInstanceAtHead` — with
   * the same failure-path cleanup either caller needs on a deploy
   * failure. Only how the launch body (`foldedBody`) and the instance's
   * identity (`instanceId`/`triggerAddress`/`definitionId`) are sourced
   * differs between the two callers; that sourcing stays in each of
   * them, not here.
   */
  async function launchCore(params: {
    tenantId: string;
    instanceId: string;
    triggerAddress: string;
    definitionId: string;
    foldedBody: FoldedBody;
    /** Named in the "seed a tenant catalog source" error, e.g. "the channel host" or "the invited agent". */
    launchLabel: string;
  }): Promise<void> {
    const instancePrincipalId = generateId("principal");
    const sessionId = generateId("session");
    const now = new Date();

    await deps.db.transaction(async (tx) => {
      // A folded run's principal is `workflow`-kind, converging on
      // the native run's principal shape; its `refId` is the
      // instance id, matching `POST /workflows/runs`.
      await tx.insert(principalTable).values({
        id: instancePrincipalId,
        tenantId: params.tenantId,
        kind: "workflow",
        refId: params.instanceId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });

      // The session is keyed to the folded definition (`agentId`)
      // and to the run's own principal — the shared-principal
      // bridge `resolveRunSessionId`/`resolveRunIdForSession` read.
      await tx.insert(agentSession).values({
        id: sessionId,
        tenantId: params.tenantId,
        agentId: params.definitionId,
        principalId: instancePrincipalId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });

      // The folded run IS the launched instance: `deploymentId` is
      // null (a folded run has no deployment), which is what puts
      // it in the address family the platform's run-scoped mail
      // surfaces actually resolve.
      await tx.insert(workflowRun).values({
        id: params.instanceId,
        definitionId: params.definitionId,
        deploymentId: null,
        tenantId: params.tenantId,
        principalId: instancePrincipalId,
        address: params.triggerAddress,
        status: "running",
        modelPreferences: null,
        createdAt: now,
      });

      // The launch body is persisted with the launch itself so a wake
      // can rebuild the deploy config without reaching for the
      // definition's asset — a channel host's asset never holds a
      // workflow.json, so this row is the only wake-time source.
      await tx.insert(channelLaunch).values({
        tenantId: params.tenantId,
        instanceId: params.instanceId,
        foldedBody: params.foldedBody,
        createdAt: now,
      });
    });

    try {
      // Opened/deployed via the shared `deployAtHead` step, mirroring
      // the reference route: the run's runtime status/readiness
      // (health, SSE replay) is read off the collector by address, and
      // a launch that never opens one reads as permanently "not_ready"
      // and leaks into the generic instance list with broken health.
      await deployAtHead(deps, {
        tenantId: params.tenantId,
        instanceId: params.instanceId,
        triggerAddress: params.triggerAddress,
        principalId: instancePrincipalId,
        sessionId,
        foldedBody: params.foldedBody,
        launchLabel: params.launchLabel,
      });
    } catch (err) {
      // Mirrors the reference route's failure-path cleanup: a deploy
      // failure must not leave the just-committed principal/session/run
      // rows behind as a permanently "running" ghost that nothing is
      // listening on.
      deps.eventCollectors.abandon(params.triggerAddress);

      const failedAt = new Date();

      await deps.db
        .update(agentSession)
        .set({ status: "ended", endedAt: failedAt, updatedAt: failedAt })
        .where(eq(agentSession.id, sessionId));

      const leaked = err instanceof SessionLaunchError && err.leakedAgent;

      // A leaked deploy left a running child; mark the run failed but
      // leave it routable (endedAt null) so the leaked child stays
      // reachable to inspect or clean up. Otherwise roll the run back
      // entirely.
      if (leaked) {
        await deps.db
          .update(workflowRun)
          .set({ status: "failed" })
          .where(eq(workflowRun.id, params.instanceId));
      } else {
        await deps.db
          .delete(workflowRun)
          .where(eq(workflowRun.id, params.instanceId));
      }

      await deps.db
        .update(principalTable)
        .set({ status: "deactivated", updatedAt: failedAt })
        .where(eq(principalTable.id, instancePrincipalId));

      throw err;
    }

    lifecycle?.track(params.triggerAddress);
    lifecycle?.recordActivity(params.triggerAddress);
  }

  async function findRunByAddress(address: string) {
    return deps.db.query.workflowRun.findFirst({
      where: eq(workflowRun.address, address),
    });
  }

  /**
   * Re-deploys an instance the sidecar no longer has resident —
   * either it slept (the lifecycle package's own sweep) or the stack
   * restarted and never relaunched it. Reads the launch body back off
   * the `channel_launch` row `launchCore` wrote in the launch
   * transaction (a channel host's asset never materializes a
   * workflow.json, so the definition's asset cannot be the wake
   * source) and reuses `deployAtHead` rather than the fresh-launch
   * row-writing path in `launchCore`: no new principal/session/run
   * rows are needed, only a redeploy against the ones already on
   * file. This closure — not `@corbits/agent-lifecycle` itself — is
   * where the redeploy logic lives; the lifecycle package only ever
   * calls it as an injected `wake` port and knows nothing about
   * definitions or launch bodies.
   */
  async function wakeInstance(run: {
    id: string;
    address: string;
    definitionId: string;
    principalId: string | null;
  }): Promise<void> {
    if (run.principalId === null) {
      throw new Error(`Run "${run.id}" has no principal`);
    }
    const launchRows = await deps.db
      .select()
      .from(channelLaunch)
      .where(eq(channelLaunch.instanceId, run.id))
      .limit(1);
    const launchRow = launchRows[0];
    if (launchRow === undefined) {
      throw new Error(
        `No channel_launch row for instance "${run.id}"; instances ` +
          `launched before launch-body persistence existed cannot be woken`,
      );
    }
    const parsedFoldedBody = FoldedBodySchema(launchRow.foldedBody);
    if (parsedFoldedBody instanceof type.errors) {
      throw new Error(
        `channel_launch row for instance "${run.id}" carries an invalid folded body: ${parsedFoldedBody.summary}`,
      );
    }
    const foldedBody = parsedFoldedBody;
    const sessionId = await sessionIdForRun(run);

    await deployAtHead(deps, {
      tenantId: launchRow.tenantId,
      instanceId: run.id,
      triggerAddress: run.address,
      principalId: run.principalId,
      sessionId,
      foldedBody,
      launchLabel: "the woken instance",
    });
  }

  async function wakeByAddress(address: string): Promise<void> {
    const run = await findRunByAddress(address);
    if (run === undefined || run.address === null) {
      throw new Error(`No run found for address "${address}"`);
    }
    await wakeInstance({
      id: run.id,
      address: run.address,
      definitionId: run.definitionId,
      principalId: run.principalId,
    });
  }

  const platform: ChatPlatform = {
    async launchChannel(input): Promise<LaunchedChannel> {
      // Validates the address shape early, mirroring every other path
      // here that reads a domain off an agent address.
      domainOf(input.triggerAddress);
      const asset = await deps.assetService.createAsset({
        tenantId: input.tenantId,
        kind: "workflow",
        name: assetNameForChannel(input.channelId),
        creatorPrincipalId: input.creatorPrincipalId,
      });
      const { definitionId } = await ensureWorkflowDefinitionForAsset(
        deps.db,
        asset.id,
      );

      let definitionJSON: unknown;
      try {
        definitionJSON = JSON.parse(input.definition);
      } catch (cause) {
        throw new Error("channel definition is not valid JSON", { cause });
      }
      const foldedBody = readFoldedBody(definitionJSON);

      await launchCore({
        tenantId: input.tenantId,
        instanceId: input.channelId,
        triggerAddress: input.triggerAddress,
        definitionId,
        foldedBody,
        launchLabel: "the channel host",
      });

      return { instanceId: input.channelId };
    },

    async launchInvite(input): Promise<LaunchedInvite> {
      const definitionRow = await deps.db.query.workflowDefinition.findFirst({
        where: and(
          eq(workflowDefinition.id, input.definitionId),
          eq(workflowDefinition.tenantId, input.tenantId),
        ),
      });
      if (definitionRow === undefined) {
        throw new Error(
          `No definition "${input.definitionId}" for this tenant`,
        );
      }
      if (definitionRow.status !== "deployed") {
        throw new Error(
          `Definition "${input.definitionId}" is not in a launchable ` +
            `state (status: ${definitionRow.status})`,
        );
      }
      if (definitionRow.assetId === null) {
        throw new Error(
          `Definition "${input.definitionId}" has not been materialized`,
        );
      }

      const tenantRow = await deps.db.query.tenant.findFirst({
        where: eq(tenantTable.id, input.tenantId),
      });
      if (tenantRow === undefined) {
        throw new Error(`No tenant "${input.tenantId}"`);
      }

      const definitionJSON = await readDefinitionJSON(
        deps.assetService,
        definitionRow.assetId,
      );
      const foldedBody = readFoldedBody(definitionJSON);
      if (foldedBody.systemPrompt === "") {
        throw new Error(
          `Definition "${input.definitionId}" cannot be launched without ` +
            `a system prompt configured`,
        );
      }

      const instanceId = generateId("instance");
      const triggerAddress = formatAgentAddress(instanceId, tenantRow.domain);

      await launchCore({
        tenantId: input.tenantId,
        instanceId,
        triggerAddress,
        definitionId: input.definitionId,
        foldedBody,
        launchLabel: "the invited agent",
      });

      return { instanceId, address: triggerAddress };
    },

    async listInvitableDefinitions(
      tenantId,
    ): Promise<readonly InvitableDefinition[]> {
      const rows = await deps.db.query.workflowDefinition.findMany({
        where: and(
          eq(workflowDefinition.tenantId, tenantId),
          eq(workflowDefinition.status, "deployed"),
        ),
        orderBy: desc(workflowDefinition.createdAt),
      });
      return rows
        .filter((row) => !row.name.startsWith(CHANNEL_HOST_ASSET_NAME_PREFIX))
        .map((row) => ({ id: row.id, name: row.name }));
    },

    async sendMail(input): Promise<SentMail> {
      const run = await findChannelRun(input.channelId);
      if (run === undefined) {
        throw new Error(`No channel run for "${input.channelId}"`);
      }
      if (run.address === null) {
        throw new Error(`Channel run "${input.channelId}" has no address`);
      }

      // Wake before send: a sleeping instance (the lifecycle package's
      // own sweep) or one that never came back up after a stack
      // restart is not in the sidecar's routable set. Re-deploying it
      // here — and letting a wake failure propagate — means the send
      // fails loud rather than vanishing into an agent nothing is
      // listening on. This is also how a mention fan-out copy reaches
      // a sleeping invited agent: every send, including fan-out
      // copies, goes through this one `sendMail` choke point.
      await lifecycle?.ensureAwake(run.address);
      // Tracking here (not only at launch) brings instances that were
      // already resident before this hub process started — restored by
      // a sidecar reconnect, launched by an earlier run — under the
      // idle sweep the moment they see traffic.
      lifecycle?.track(run.address);

      const sessionId = await sessionIdForRun(run);
      const mailId = crypto.randomUUID();
      // One clock read for both the MIME `Date` header and the
      // `session_mail` row's `createdAt` — two separate reads would let
      // the header and the row disagree by however long
      // `sendUserMessage` takes to sign and serialize the MIME.
      const now = new Date();
      const domain = domainOf(run.address);
      let from = `${input.principalId}@${domain}`;
      let originAddress: string | undefined;
      if (input.fromChannelId !== undefined) {
        const origin = await findChannelRun(input.fromChannelId);
        if (origin?.address == null) {
          throw new Error(
            `Origin channel "${input.fromChannelId}" has no address`,
          );
        }
        from = origin.address;
        originAddress = origin.address;
      }
      const cryptoProvider = await cryptoProviderFor(input.channelId);

      const attachments = input.content.attachments?.map(
        (attachment, index) => ({
          name: attachment.name ?? `attachment-${index}`,
          contentType: attachment.mimeType,
          data: new Uint8Array(Buffer.from(attachment.data, "base64")),
        }),
      );

      const rawMIME = await deps.sessionService.sendUserMessage({
        agentAddress: run.address,
        from,
        messageId: `<${mailId}@${domain}>`,
        date: now,
        content: input.content.content,
        ...(attachments !== undefined ? { attachments } : {}),
        ...(input.content.replyTo !== undefined
          ? { inReplyTo: input.content.replyTo }
          : {}),
        sessionId,
        tenantId: input.tenantId,
        cryptoProvider,
      });

      await deps.db.insert(sessionMail).values({
        id: mailId,
        sessionId,
        instanceId: null,
        tenantId: input.tenantId,
        direction: "inbound",
        status: "delivered",
        raw: rawMIME,
        createdAt: now,
      });

      deps.sidecarRouter.dispatchAgentEvent(run.address, {
        type: "mail.delivered",
        data: {
          id: mailId,
          direction: "inbound",
          receivedAt: now.toISOString(),
        },
      });

      lifecycle?.recordActivity(run.address);
      if (originAddress !== undefined) lifecycle?.recordActivity(originAddress);

      return { id: mailId, createdAt: now.toISOString() };
    },

    async listMail(input): Promise<ListedMail> {
      const run = await findChannelRun(input.channelId);
      if (run === undefined) {
        throw new Error(`No channel run for "${input.channelId}"`);
      }
      const sessionId = await sessionIdForRun(run);

      // Keyset pagination on the same `(createdAt, id)` key the
      // newest-first ordering sorts by: a cursor names the last row the
      // caller has already seen, and this walks strictly older than it
      // — `createdAt < cursor.createdAt`, or a tie broken by
      // `id < cursor.id` — rather than re-fetching the newest page and
      // searching for the cursor inside it, which only ever finds it on
      // page one.
      const scope = and(
        eq(sessionMail.tenantId, input.tenantId),
        eq(sessionMail.sessionId, sessionId),
      );
      const cursor =
        input.cursor === undefined ? undefined : decodeCursor(input.cursor);
      const where =
        cursor === undefined
          ? scope
          : and(
              scope,
              or(
                lt(sessionMail.createdAt, cursor.createdAt),
                and(
                  eq(sessionMail.createdAt, cursor.createdAt),
                  lt(sessionMail.id, cursor.id),
                ),
              ),
            );

      const rows = await deps.db
        .select()
        .from(sessionMail)
        .where(where)
        .orderBy(desc(sessionMail.createdAt), desc(sessionMail.id))
        .limit(MAIL_PAGE_SIZE + 1);

      const hasMore = rows.length > MAIL_PAGE_SIZE;
      const page = rows.slice(0, MAIL_PAGE_SIZE);
      const items = page.map((row) => ({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        mail: parseMailToEmail(row.raw, row.id),
      }));

      const last = page.length > 0 ? page[page.length - 1] : undefined;
      return {
        items,
        ...(hasMore && last !== undefined
          ? { nextCursor: encodeCursor(last.createdAt, last.id) }
          : {}),
      };
    },

    async fetchBlob(_channelId, blobId): Promise<string | Uint8Array> {
      const match = BLOB_ID_PATTERN.exec(blobId);
      if (match === null) {
        throw new Error(`Invalid blob id "${blobId}"`);
      }
      const [, mailId, partPath] = match;
      if (mailId === undefined || partPath === undefined) {
        throw new Error(`Invalid blob id "${blobId}"`);
      }
      const mailRow = await deps.db.query.sessionMail.findFirst({
        where: eq(sessionMail.id, mailId),
      });
      if (mailRow === undefined) {
        throw new Error(`No mail "${mailId}" for blob "${blobId}"`);
      }
      return extractPartByPath(mailRow.raw, partPath);
    },

    subscribeToChannel(
      channelId: string,
      onEvent: (event: ChatChannelEvent) => void,
    ): () => void {
      let cancelled = false;
      let unsubscribeAgent: (() => void) | undefined;

      void findChannelRun(channelId).then((run) => {
        if (cancelled || run === undefined || run.address === null) return;
        unsubscribeAgent = deps.sidecarRouter.subscribeAgent(
          run.address,
          (event) => {
            onEvent({ type: "chat.agent", data: event });
          },
        );
      });

      return () => {
        cancelled = true;
        unsubscribeAgent?.();
      };
    },

    ensureReplyBridge(input: {
      tenantId: string;
      channelId: string;
      agentChannelId: string;
    }): void {
      if (replyBridges.has(input.agentChannelId)) return;
      // Reserve the slot synchronously so concurrent calls stay idempotent;
      // the subscription attaches once the agent's address resolves.
      let unsubscribe: (() => void) | undefined;
      replyBridges.set(input.agentChannelId, () => unsubscribe?.());
      void findChannelRun(input.agentChannelId).then((run) => {
        if (run === undefined || run.address === null) {
          replyBridges.delete(input.agentChannelId);
          return;
        }
        const agentAddress = run.address;
        replyBridgeAddresses.set(input.agentChannelId, agentAddress);
        // Arming a bridge is proof this agent belongs to a live channel:
        // put it under the idle sweep even if it predates this hub
        // process and has not yet received mail through it.
        lifecycle?.track(agentAddress);
        unsubscribe = deps.sidecarRouter.subscribeAgent(
          agentAddress,
          (event) => {
            // Any event at all counts as activity, not just
            // `connector.reply` below — an agent mid-inference must
            // never be undeployed out from under itself by the idle
            // sweep just because it hasn't replied yet.
            lifecycle?.recordActivity(agentAddress);
            if (
              typeof event !== "object" ||
              event === null ||
              (event as { type?: unknown }).type !== "connector.reply"
            ) {
              return;
            }
            const data = (event as { data?: { content?: unknown } }).data;
            const content = data?.content;
            if (typeof content !== "string" || content === "") return;
            void platform
              .sendMail({
                tenantId: input.tenantId,
                channelId: input.channelId,
                principalId: input.agentChannelId,
                content: encodeParts([{ kind: "text", text: content }]),
                fromChannelId: input.agentChannelId,
              })
              .catch((cause: unknown) => {
                bridgeLog.error`reply bridge: failed to post ${agentAddress}'s reply into channel ${input.channelId}: ${
                  cause instanceof Error ? cause.message : String(cause)
                }`;
              });
          },
        );
      });
    },
  };
  return platform;
}
