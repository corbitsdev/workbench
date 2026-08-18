// The hub-side `ChatPlatform` implementation, owned by this package
// rather than by `apps/hub` — "apps stay generic; packages own the
// domain" applies to the platform port exactly as it does to the rest
// of chat's behavior. `createHubChatPlatform` composes the port from
// `@corbits/folded-runs` (launch/wake/mail machinery for folded
// interactive runs, shared with any other host that launches them)
// plus the concerns that are chat's own: `channel_launch` persistence,
// asset naming, invitable listing, and participant/fromChannelId
// send semantics.
import { and, asc, count, desc, eq, gt, inArray, max, or } from "drizzle-orm";
import { createAgentLifecycle } from "@corbits/agent-lifecycle";
import {
  createCryptoProviderCache,
  domainOf,
  findFoldedRunByAddress,
  findFoldedRunById,
  isFoldedRunSettled,
  launchFoldedRun,
  listFoldedMail,
  readDefinitionJSON,
  readFoldedBody,
  resolveFoldedRunSessionId,
  sendFoldedMail,
  wakeFoldedRun,
  FoldedBodySchema,
  type FoldedRunsDeps,
  type SendFoldedMailParams,
  type SourcesOverride,
} from "@corbits/folded-runs";
import type { FoldedBody } from "@intx/workflow-deploy";
import type { DB } from "@intx/db";
import {
  agentSession,
  sessionMail,
  tenant as tenantTable,
  workflowDefinition,
  workflowRun,
} from "@intx/db/schema";
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import { extractPartByPath, parseMailToEmail } from "@intx/mime";
import { channelLaunch } from "./schema";
import { summarizeChannelActivity } from "./channel-activity";
import { extractTextPreview } from "./codec";
import {
  channelHostAssetName,
  isChannelHostDefinitionName,
} from "./channel-host-naming";
import {
  ensureWorkflowDefinitionForAsset,
  SessionLaunchError,
} from "@intx/hub-sessions";
import type {
  AssetService,
  EventCollectorRegistry,
  SessionService,
  SidecarRouter,
} from "@intx/hub-sessions";
import type { InferencePreference } from "@intx/agent";
import { formatRunAddress } from "@intx/types";
import { computeWireDefinitionHash } from "@intx/types/wire-definition-hash";
import { type } from "arktype";
import {
  AgentUnreachableError,
  type ChatChannelEvent,
  type ChatPlatform,
  type InvitableDefinition,
  type LaunchedChannel,
  type LaunchedInvite,
  type ListedMail,
  type ListedMailItem,
  type SentMail,
} from "./platform-port";

export type CreateHubChatPlatformDeps = {
  db: DB["db"];
  sessionService: SessionService;
  assetService: AssetService;
  sidecarRouter: SidecarRouter;
  /** See `FoldedRunsDeps.hubPublicKey`. */
  hubPublicKey: string;
  /** See `FoldedRunsDeps.toolGrantsForPins`. */
  toolGrantsForPins: FoldedRunsDeps["toolGrantsForPins"];
  /** See `FoldedRunsDeps.mcpCredentialBindingsFor`. */
  mcpCredentialBindingsFor?: FoldedRunsDeps["mcpCredentialBindingsFor"];
  /**
   * Decrypts credential secrets when an invited agent's launch resolves
   * inference sources against the tenant catalog — see
   * `@corbits/folded-runs`' `FoldedRunsDeps.credentialCipher`. A channel
   * host never needs it (its launch is pinned to `noopInferenceBaseUrl`,
   * never the catalog), but every invited-agent launch and wake does.
   * Omitted, `resolveDefinitionSources` falls back to a noop cipher and
   * hands the raw stored secret to the provider unchanged — correct only
   * when the credential was itself written unencrypted.
   */
  credentialCipher?: FoldedRunsDeps["credentialCipher"];
  /**
   * The hub's own noop-inference endpoint (see `./noop-inference.ts`),
   * reachable over HTTP from the sidecar — never the catalog. Every
   * channel-HOST launch and wake pins its `InferenceSource` here
   * instead of resolving against the tenant catalog: a channel
   * anchor's mailbox is the timeline and its system prompt forbids
   * replying, so the real inference turn the ordinary launch path
   * would otherwise run on every message is pure waste. Invited-agent
   * launches and wakes are unaffected — they still resolve against the
   * tenant catalog, since an invited agent's replies are real.
   */
  noopInferenceBaseUrl: string;
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
   * `sidecarRouter` and `@corbits/folded-runs`' `wakeFoldedRun` —
   * `@corbits/agent-lifecycle` itself never imports the hub or this
   * package. Its sweep tears down instances idle for `idleSleepMs` via
   * `sidecarRouter.sendAgentUndeploy`, and `sendMail` calls
   * `ensureAwake` to redeploy a non-routable target before sending.
   */
  lifecycle?: { idleSleepMs: number; sweepIntervalMs?: number };
  /**
   * The wake path's settle-window backoff (see RECLAIM_RETRY_DELAYS_MS
   * below). Injectable so tests exercise the window in milliseconds
   * instead of the production ~8s budget.
   */
  reclaimRetryDelaysMs?: readonly number[];
  /**
   * Same resolver `./routes.ts`'s `channelHostInferencePreferences` dep
   * takes (see its own doc), reused here for `launchInvite`: a
   * hand-authored definition that declares no model requirements of
   * its own (e.g. a `create_agent` definition created without a
   * `model` — see `@corbits/agent-directory`'s `createAgentDefinitionCore`)
   * would otherwise 409 as `not_launchable` even though the tenant has
   * a perfectly usable catalog default. Omitted, or a tenant with no
   * connected provider, that 409 is exactly what still happens — the
   * honest answer when there is truly nothing to launch against.
   */
  channelHostInferencePreferences?: (
    tenantId: string,
  ) => Promise<readonly InferencePreference[]>;
};

// Channel-host asset naming lives in `./channel-host-naming` — a
// browser-safe module shared with the UIs that filter anchor runs out
// of workflow listings — so the derivation and the predicate over the
// resulting names can never drift apart.

// The `InferenceSource.id`/`InferenceSource.model` a channel-host pin
// carries — never read by anything (the noop endpoint ignores both),
// but `InferenceSource` requires non-empty strings, and a channel
// host's `foldedBody.model` is `null` whenever no catalog source was
// ever resolved for it (see `buildChannelHostWorkflow`'s
// `inferencePreferences` — empty when the hub has seeded none).
const NOOP_INFERENCE_SOURCE_ID = "noop";
const NOOP_INFERENCE_MODEL_FALLBACK = "noop";

/**
 * The `SourcesOverride` every channel-HOST launch and wake pins
 * instead of resolving against the tenant catalog (see
 * `CreateHubChatPlatformDeps.noopInferenceBaseUrl`'s doc). Invited
 * agents never get this — they still resolve normally.
 */
function noopSourcesOverride(
  noopInferenceBaseUrl: string,
  foldedBody: FoldedBody,
): SourcesOverride {
  return {
    sources: [
      {
        id: NOOP_INFERENCE_SOURCE_ID,
        provider: "anthropic",
        baseURL: noopInferenceBaseUrl,
        apiKey: "noop",
        model: foldedBody.model ?? NOOP_INFERENCE_MODEL_FALLBACK,
      },
    ],
    defaultSource: NOOP_INFERENCE_SOURCE_ID,
  };
}

/**
 * The concrete object `createHubChatPlatform` returns: the `ChatPlatform`
 * port itself, plus a `recordActivity` hook the host wires into
 * `createChatOrchestrator` (see `chat-orchestrator.ts`) so an invited
 * agent's `connector.reply` traffic — observed on the orchestrator's
 * own event subscription, not this adapter's `sendMail` — still counts
 * as activity against the idle-sleep lifecycle built here. A no-op
 * when `deps.lifecycle` is unset, matching every other lifecycle hook
 * on this adapter.
 */
export type HubChatPlatform = ChatPlatform & {
  recordActivity(address: string): void;
};

/**
 * Composes the `ChatPlatform` port over the hub's real session
 * services and `@corbits/folded-runs`. One crypto provider is minted
 * per channel and cached for the adapter's lifetime.
 */
export function createHubChatPlatform(
  deps: CreateHubChatPlatformDeps,
): HubChatPlatform {
  const foldedRunsDeps: FoldedRunsDeps = {
    db: deps.db,
    sessionService: deps.sessionService,
    assetService: deps.assetService,
    sidecarRouter: deps.sidecarRouter,
    eventCollectors: deps.eventCollectors,
    hubPublicKey: deps.hubPublicKey,
    toolGrantsForPins: deps.toolGrantsForPins,
    ...(deps.credentialCipher !== undefined
      ? { credentialCipher: deps.credentialCipher }
      : {}),
    ...(deps.mcpCredentialBindingsFor !== undefined
      ? { mcpCredentialBindingsFor: deps.mcpCredentialBindingsFor }
      : {}),
  };

  const cryptoProviders = createCryptoProviderCache();
  const wakeLogger = getLogger(["chat", "wake"]);
  const SETTLED_UNDEPLOY_WAIT_MS = 5_000;

  // Built from `@corbits/agent-lifecycle` — the idle-sleep sweep and
  // wake-coalescing logic live entirely in that package, imported as a
  // published dependency rather than reimplemented here; this adapter
  // only wires its ports onto `sidecarRouter` (routability, undeploy),
  // `deps.eventCollectors` (busy detection), and `wakeByAddress` below
  // (a plain `function` declaration, so it is already hoisted by the
  // time this closure is called). `undefined` when `deps.lifecycle` is
  // unset, matching today's behavior exactly: nothing is tracked, no
  // sweep runs, `sendMail` never calls `ensureAwake`.
  function buildLifecycle(
    lifecycleDeps: NonNullable<CreateHubChatPlatformDeps["lifecycle"]>,
  ) {
    const base = {
      idleSleepMs: lifecycleDeps.idleSleepMs,
      isRoutable: (address: string) =>
        deps.sidecarRouter.getRoutableAddresses().includes(address),
      undeploy: (address: string, reason: string) =>
        deps.sidecarRouter.sendAgentUndeploy(address, reason),
      wake: wakeByAddress,
      isBusy: (address: string) =>
        typeof deps.eventCollectors.getCurrentTurnId(address) === "string",
      log: getLogger(["chat", "lifecycle"]),
    };
    return createAgentLifecycle(
      lifecycleDeps.sweepIntervalMs !== undefined
        ? { ...base, sweepIntervalMs: lifecycleDeps.sweepIntervalMs }
        : base,
    );
  }

  const lifecycle =
    deps.lifecycle !== undefined ? buildLifecycle(deps.lifecycle) : undefined;

  // Bounded backoff for a wake racing the sidecar's own post-restart
  // reclaim, and separately for a mail delivery racing the same
  // window: 250ms, 500ms, 1s, 2s, 4s — a ~7.75s budget, long enough
  // for a normal reconnect challenge to settle without leaving a
  // sender stuck for much longer than that.
  const RECLAIM_RETRY_DELAYS_MS = deps.reclaimRetryDelaysMs ?? [
    250, 500, 1000, 2000, 4000,
  ];

  function sleep(ms: number): Promise<void> {
    return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
  }

  function isAgentUnreachable(err: unknown): boolean {
    return err instanceof Error && err.message.includes("agent is unreachable");
  }

  // `sendAgentUndeploy` rejects with this exact text
  // (`vendor/intx/hub-sessions/src/ws/sidecar-handler.ts`) when the
  // address has no WS entry in `addressIndex` at all — nothing to tear
  // down. A settled folded-run occurrence (CL-6147) can reach the
  // forced-undeploy fallback below with its WS entry already gone: the
  // underlying run ended on its own between the caller's routability
  // check and this wake actually running, with no `sendAgentUndeploy`
  // ever called for it. Treated as "already undeployed", not an error.
  function isNoSidecarConnected(err: unknown): boolean {
    return (
      err instanceof Error &&
      err.message.includes("No sidecar connected for agent")
    );
  }

  // A hub restart empties this process's own routable-address index
  // (`sidecarRouter.getRoutableAddresses()`, backed by the same
  // `addressIndex` `routeMail` delivers against — see
  // `vendor/intx/hub-sessions/src/ws/sidecar-handler.ts`) before the
  // sidecar's reconnect challenge (Interchange's own reclaim protocol)
  // has had a chance to repopulate it. A wake racing ahead of that
  // reclaim hits this exact provision-phase rejection ("is already
  // deployed") from the still-live agent.
  function isPostRestartReclaimRace(err: unknown): boolean {
    return (
      err instanceof SessionLaunchError &&
      err.phase === "provision" &&
      err.message.includes("is already deployed")
    );
  }

  function isRoutable(address: string): boolean {
    return deps.sidecarRouter.getRoutableAddresses().includes(address);
  }

  /**
   * Polls the *same* routability predicate `routeMail` delivers
   * against — never the error text alone — so "no redeploy needed" is
   * falsifiable: an "is already deployed" rejection is only proof of
   * liveness once the address actually shows up as routable. One INFO
   * line opens the settle window and one closes it, regardless of how
   * many polls it took.
   */
  async function waitForReclaimToSettle(address: string): Promise<boolean> {
    wakeLogger.info`wake for ${address} raced the sidecar's own post-restart reclaim; waiting up to ~8s for the address to become routable before redeploying`;
    for (const delay of RECLAIM_RETRY_DELAYS_MS) {
      if (isRoutable(address)) {
        wakeLogger.info`wake for ${address}: post-restart reclaim settled, address is live, no redeploy needed`;
        return true;
      }
      await sleep(delay);
    }
    const settled = isRoutable(address);
    wakeLogger.info`wake for ${address}: settle window elapsed, address is ${settled ? "now routable, no redeploy needed" : "still unroutable; forcing a redeploy"}`;
    return settled;
  }

  // Concurrent callers already coalesce onto one in-flight wake at
  // `@corbits/agent-lifecycle`'s `ensureAwake` (see its own doc) — this
  // function itself only needs to make each *individual* wake episode
  // self-sufficient. Before this fix, a single "is already deployed"
  // rejection was trusted as proof of liveness and swallowed
  // immediately, so a stack restart's mail-retry loop
  // (`sendFoldedMailWithReclaimRetry` below) re-entered `deployAtHead`
  // — and its unconditional `eventCollectors.create` — on every one of
  // its own retry attempts, each producing its own "Collector already
  // exists, replacing" churn. Now one call either waits out the
  // reclaim or performs the one genuine redeploy the address needs, so
  // the address is actually routable by the time this resolves and the
  // outer retry loop's next `sendFoldedMail` succeeds without calling
  // this again.
  async function wakeByAddress(address: string): Promise<void> {
    const run = await findFoldedRunByAddress(deps.db, address);
    if (run === undefined || run.address === null) {
      throw new Error(`No run found for address "${address}"`);
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
    const wakeParams = {
      tenantId: launchRow.tenantId,
      instanceId: run.id,
      triggerAddress: run.address,
      principalId: run.principalId,
      foldedBody: parsedFoldedBody,
    };
    // CL-6203: a "running" run that merely is not routable at this
    // instant is more often a live process behind a routability blip
    // (a WS reconnect, the sidecar's own post-restart reclaim) than a
    // dead one. Redeploying OVER a live process moves the run's
    // deployment anchor out from under it: the survivor's pack pushes
    // are rejected from then on ("no live deployment anchor" /
    // path_violation), its mail acks are withheld into a redelivery
    // storm, and the next wake dies on signature_invalid — the channel
    // is bricked. So a running run first gets the settle window; only
    // when the address never comes back is the redeploy real — and
    // then the possibly-live resident is stopped BEFORE the anchor
    // moves, so nothing survives to push against it.
    if (run.status === "running" && !isRoutable(address)) {
      if (await waitForReclaimToSettle(address)) return;
      try {
        await deps.sidecarRouter.sendAgentUndeploy(
          address,
          "wake is redeploying this run; stopping the resident instance " +
            "so it cannot push against the moved deployment anchor",
        );
      } catch (undeployErr) {
        if (!isNoSidecarConnected(undeployErr)) throw undeployErr;
      }
    }

    const deploy = () =>
      wakeFoldedRun(
        foldedRunsDeps,
        launchRow.noopInference
          ? {
              ...wakeParams,
              sources: noopSourcesOverride(
                deps.noopInferenceBaseUrl,
                parsedFoldedBody,
              ),
            }
          : wakeParams,
      );
    try {
      await deploy();
    } catch (err) {
      if (!isPostRestartReclaimRace(err)) throw err;
      // The rejection text alone is not proof of liveness — only
      // `isRoutable` (the same predicate `routeMail` uses) is. If the
      // reclaim never settles within the budget, this is not a
      // self-healing race after all; redeploy for real instead of
      // throwing.
      if (await waitForReclaimToSettle(address)) return;
      try {
        await deps.sidecarRouter.sendAgentUndeploy(
          address,
          "post-restart reclaim did not settle within the wake's retry budget",
        );
      } catch (undeployErr) {
        // Nothing to tear down — the address already has no WS entry
        // in `addressIndex` (see `isNoSidecarConnected`'s own doc). The
        // redeploy below is what actually recovers it.
        if (!isNoSidecarConnected(undeployErr)) throw undeployErr;
      }
      await deploy();
    }
  }

  /**
   * `sendFoldedMail` delivers synchronously against the sidecar's
   * current routable set — the same in-memory index `isRoutable` reads
   * — so a send that lands in the same post-restart reclaim window
   * `wakeByAddress` above tolerates can still fail with "agent is
   * unreachable" even right after a successful (or no-op) wake. Each
   * retry forces a fresh wake first: if the earlier reclaim tore the
   * agent down, this becomes the genuine redeploy that recovers it; if
   * the reclaim is still in flight, the wake itself waits it out (or
   * redeploys once its own budget is exhausted) and the delay gives it
   * more time regardless. Exhausting every delay means the condition
   * is not transient and the caller gets a clean `AgentUnreachableError`
   * rather than an unhandled 500.
   */
  async function sendFoldedMailWithReclaimRetry(
    params: SendFoldedMailParams,
  ): Promise<Awaited<ReturnType<typeof sendFoldedMail>>> {
    let loggedRetryStart = false;
    for (let attempt = 0; ; attempt++) {
      try {
        return await sendFoldedMail(foldedRunsDeps, params);
      } catch (err) {
        const delay = RECLAIM_RETRY_DELAYS_MS[attempt];
        if (!isAgentUnreachable(err) || delay === undefined) {
          if (loggedRetryStart) {
            wakeLogger.info`mail to ${params.agentAddress} exhausted every reclaim retry; giving up`;
          }
          if (isAgentUnreachable(err)) {
            throw new AgentUnreachableError(params.agentAddress, {
              cause: err,
            });
          }
          throw err;
        }
        if (!loggedRetryStart) {
          wakeLogger.info`mail to ${params.agentAddress} hit "agent is unreachable"; retrying with backoff while the post-restart reclaim settles`;
          loggedRetryStart = true;
        }
        await sleep(delay);
        await wakeByAddress(params.agentAddress);
      }
    }
  }

  const platform: ChatPlatform = {
    async launchChannel(input): Promise<LaunchedChannel> {
      // Validates the address shape early, mirroring every other path
      // here that reads a domain off an agent address.
      domainOf(input.triggerAddress);
      const asset = await deps.assetService.createAsset({
        tenantId: input.tenantId,
        kind: "workflow",
        name: channelHostAssetName(input.channelId),
        creatorPrincipalId: input.creatorPrincipalId,
      });
      let definitionJSON: unknown;
      try {
        definitionJSON = JSON.parse(input.definition);
      } catch (cause) {
        throw new Error("channel definition is not valid JSON", { cause });
      }
      const wireHash = await computeWireDefinitionHash(definitionJSON);
      const { definitionId } = await ensureWorkflowDefinitionForAsset(deps.db, {
        assetId: asset.id,
        wireHash,
      });

      const foldedBody = readFoldedBody(definitionJSON);

      await launchFoldedRun(foldedRunsDeps, {
        tenantId: input.tenantId,
        instanceId: input.channelId,
        triggerAddress: input.triggerAddress,
        definitionId,
        foldedBody,
        launchLabel: "the channel host",
        // A channel host never replies — its mailbox is the
        // timeline and its system prompt forbids answering — so its
        // launch is pinned to the hub's own noop endpoint rather than
        // resolved against the tenant catalog. This is what lets a
        // channel launch (and, per `noopInference` below, every wake
        // of it) succeed with zero catalog sources seeded.
        sources: noopSourcesOverride(deps.noopInferenceBaseUrl, foldedBody),
        // The launch body is persisted with the launch itself, in the
        // same transaction, so a wake can rebuild the deploy config
        // without reaching for the definition's asset — a channel
        // host's asset never holds a workflow.json, so this row is
        // the only wake-time source. Chat owns this table; folded-runs
        // never imports it. `noopInference: true` records this launch
        // as a host, so its wake pins the same noop source rather than
        // re-deriving "is this a host" from anything else.
        persistExtra: async (tx) => {
          await tx.insert(channelLaunch).values({
            tenantId: input.tenantId,
            instanceId: input.channelId,
            foldedBody,
            createdAt: new Date(),
            noopInference: true,
          });
        },
      });

      lifecycle?.track(input.triggerAddress);
      lifecycle?.recordActivity(input.triggerAddress);

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

      const instanceId = generateId("workflowRun");
      const triggerAddress = formatRunAddress(instanceId, tenantRow.domain);

      // A definition that declares no model requirements of its own
      // (`foldedBody.model === null`) would otherwise 409 as
      // `not_launchable` — resolve the same catalog default a fresh
      // channel host gets instead of failing loud. Only consulted when
      // the definition truly names nothing; a definition with its own
      // model is never second-guessed.
      const fallbackModel =
        foldedBody.model === null
          ? (
              (await deps.channelHostInferencePreferences?.(
                input.tenantId,
              )) ?? []
            )[0]?.model
          : undefined;

      await launchFoldedRun(foldedRunsDeps, {
        tenantId: input.tenantId,
        instanceId,
        triggerAddress,
        definitionId: input.definitionId,
        foldedBody,
        launchLabel: "the invited agent",
        ...(fallbackModel !== undefined ? { fallbackModel } : {}),
        // Unchanged from before this pin existed: an invited agent's
        // replies are real, so its inference sources still resolve
        // against the tenant catalog. `noopInference: false` (matching
        // the column's own default) records this launch as not a
        // host, so its wake resolves against the catalog too.
        persistExtra: async (tx) => {
          await tx.insert(channelLaunch).values({
            tenantId: input.tenantId,
            instanceId,
            foldedBody,
            createdAt: new Date(),
            noopInference: false,
          });
        },
      });

      lifecycle?.track(triggerAddress);
      lifecycle?.recordActivity(triggerAddress);

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
        .filter((row) => !isChannelHostDefinitionName(row.name))
        .map((row) => {
          const base = { id: row.id, name: row.name };
          return typeof row.description === "string" && row.description !== ""
            ? { ...base, description: row.description }
            : base;
        });
    },

    async resolveDefinitionIdByAddress(address): Promise<string | undefined> {
      const run = await findFoldedRunByAddress(deps.db, address);
      return run?.definitionId ?? undefined;
    },

    async refreshAgentInstanceFromDefinition(
      tenantId,
      _channelId,
      address,
    ): Promise<void> {
      const run = await findFoldedRunByAddress(deps.db, address);
      if (run === undefined || run.definitionId === null) return;

      const definitionRow = await deps.db.query.workflowDefinition.findFirst({
        where: and(
          eq(workflowDefinition.id, run.definitionId),
          eq(workflowDefinition.tenantId, tenantId),
        ),
      });
      if (definitionRow === undefined || definitionRow.assetId === null) {
        return;
      }

      const definitionJSON = await readDefinitionJSON(
        deps.assetService,
        definitionRow.assetId,
      );
      const foldedBody = readFoldedBody(definitionJSON);

      await deps.db
        .update(channelLaunch)
        .set({ foldedBody })
        .where(eq(channelLaunch.instanceId, run.id));
    },

    async sendMail(input): Promise<SentMail> {
      const run = await findFoldedRunById(deps.db, input.channelId);
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
      //
      // Routability alone is not enough for a folded run: it settles
      // to `workflow_run.status === "completed"` after every handled
      // mail (idle until its next message — see
      // `@corbits/folded-runs`' `isFoldedRunSettled` doc), but stays
      // resident on the sidecar (still routable) until the idle-sleep
      // sweep tears it down. `lifecycle.ensureAwake` no-ops on a
      // routable address, so without this check every message sent
      // inside that window reaches a terminal occurrence, which
      // `vendor/intx/workflow-host/src/supervisor/supervisor.ts`
      // permanently rejects (`workflow_run_terminal`) — the hub then
      // redelivers into the same terminal occurrence forever, since
      // nothing else ever redeploys it.
      //
      // Redeploying a settled-but-still-routable address straight from
      // here (skipping an explicit undeploy) reliably trips the
      // sidecar's own "is already deployed" bookkeeping — confirmed
      // empirically against a live sidecar. Only a clean, explicit
      // `sendAgentUndeploy` round trip through the *current* connection
      // — not a redeploy attempt's implicit one — reliably clears it.
      // So: undeploy first (tolerating "no WS entry", which just means
      // it is already gone), then let the ordinary not-routable wake
      // path below do the actual redeploy — the same path that already
      // works for every idle-sweep-triggered wake (see the "sendMail
      // wakes a non-routable channel" test).
      //
      // [Intx gap] CL-6147: even with the clean undeploy-first sequence
      // above, redeploying (waking) a folded run's instance id a
      // *second* time still fails once the workflow carries any
      // attached asset pack (in practice every workflow, via the
      // shared `corbits-tools` package registry every launch resolves)
      // — confirmed against a live sidecar + Postgres. The failure is
      // `session_asset_instance_id_mount_path_pk` in Postgres:
      // `sendAttachmentPack`'s "ordinary launch" branch
      // (`vendor/intx/hub-sessions/src/session-service.ts`) does a bare
      // `INSERT INTO session_asset` with no conflict handling, on the
      // documented assumption that an ordinary (non-`allocationTarget`)
      // launch never reuses an instance id — an assumption
      // `@corbits/folded-runs`' whole wake design (redeploy the *same*
      // instance id to resume a folded run) breaks by construction. The
      // `allocationTarget` branch right next to it already tolerates an
      // identical re-insert via `onConflictDoNothing`, so the fix likely
      // belongs there — extending that same tolerance to the ordinary
      // path — but that is vendor code this package must not edit.
      // Nothing before this PR's live-Ollama second-turn coverage ever
      // exercised a real redeploy-by-address against a live sidecar
      // with an attached asset pack, so this has apparently never fired
      // before. Tracked upstream; not fixable from `@corbits/chat`.
      // A "failed" folded run with its address still routable is the
      // CL-6203 wreck: the anchored-out survivor of a redeploy-over-live,
      // holding a WS route while every push it makes is rejected. It
      // recovers exactly like a settled occurrence — undeploy the
      // zombie, then wake a fresh one.
      const residentNeedsReplacing =
        ((await isFoldedRunSettled(deps.db, run)) ||
          run.status === "failed") &&
        isRoutable(run.address);
      if (residentNeedsReplacing) {
        wakeLogger.info`${run.address} has a ${run.status === "failed" ? "failed run's zombie" : "settled occurrence"} still resident; undeploying it so this message wakes a fresh one`;
        try {
          await deps.sidecarRouter.sendAgentUndeploy(
            run.address,
            "folded run occurrence settled; undeploying so the next " +
              "message redeploys a fresh occurrence",
          );
        } catch (undeployErr) {
          if (!isNoSidecarConnected(undeployErr)) throw undeployErr;
        }
        // The undeploy is a fire-and-forget frame to the sidecar; the
        // router only drops the address once the sidecar confirms. Wait
        // for that (bounded) so the wake below sees an unroutable
        // address instead of no-op'ing onto the dead occurrence.
        const undeployDeadline = Date.now() + SETTLED_UNDEPLOY_WAIT_MS;
        while (isRoutable(run.address) && Date.now() < undeployDeadline) {
          await sleep(100);
        }
        if (isRoutable(run.address)) {
          wakeLogger.warn`${run.address} stayed routable ${SETTLED_UNDEPLOY_WAIT_MS}ms after undeploy; waking anyway`;
        }
        await wakeByAddress(run.address);
      } else if (lifecycle !== undefined) {
        await lifecycle.ensureAwake(run.address);
      } else if (!isRoutable(run.address)) {
        await wakeByAddress(run.address);
      }
      // Tracking here (not only at launch) brings instances that were
      // already resident before this hub process started — restored by
      // a sidecar reconnect, launched by an earlier run — under the
      // idle sweep the moment they see traffic.
      lifecycle?.track(run.address);

      const sessionId = await resolveFoldedRunSessionId(deps.db, run);
      const domain = domainOf(run.address);
      let from: string;
      let originAddress: string | undefined;
      if (input.fromChannelId !== undefined) {
        const origin = await findFoldedRunById(deps.db, input.fromChannelId);
        if (origin?.address == null) {
          throw new Error(
            `Origin channel "${input.fromChannelId}" has no address`,
          );
        }
        from = origin.address;
        originAddress = origin.address;
      } else if (input.principalId !== undefined) {
        from = `${input.principalId}@${domain}`;
      } else {
        throw new Error(
          "sendMail requires either principalId or fromChannelId",
        );
      }
      const cryptoProvider = await cryptoProviders.get(input.channelId);

      const attachments = input.content.attachments?.map(
        (attachment, index) => ({
          name: attachment.name ?? `attachment-${index}`,
          contentType: attachment.mimeType,
          data: new Uint8Array(Buffer.from(attachment.data, "base64")),
        }),
      );

      const sendMailBase = {
        tenantId: input.tenantId,
        sessionId,
        agentAddress: run.address,
        from,
        domain,
        content: input.content.content,
        cryptoProvider,
      };
      const withAttachments =
        attachments !== undefined
          ? { ...sendMailBase, attachments }
          : sendMailBase;
      const sent = await sendFoldedMailWithReclaimRetry(
        input.content.replyTo !== undefined
          ? { ...withAttachments, replyTo: input.content.replyTo }
          : withAttachments,
      );

      lifecycle?.recordActivity(run.address);
      if (originAddress !== undefined) lifecycle?.recordActivity(originAddress);

      return sent;
    },

    async listMail(input): Promise<ListedMail> {
      const run = await findFoldedRunById(deps.db, input.channelId);
      if (run === undefined) {
        throw new Error(`No channel run for "${input.channelId}"`);
      }
      const sessionId = await resolveFoldedRunSessionId(deps.db, run);
      const listMailBase = { tenantId: input.tenantId, sessionId };
      return listFoldedMail(
        foldedRunsDeps,
        input.cursor !== undefined
          ? { ...listMailBase, cursor: input.cursor }
          : listMailBase,
      );
    },

    async getMail(input): Promise<ListedMailItem | undefined> {
      const run = await findFoldedRunById(deps.db, input.channelId);
      if (run === undefined) return undefined;
      const sessionId = await resolveFoldedRunSessionId(deps.db, run);

      // Same `findFirst` by id + session scope `fetchBlob` uses for its
      // blob-owning mail row, rather than `listMail`'s keyset page: a
      // single-message lookup by id must resolve regardless of how far
      // back that message sits, not just when it happens to land on
      // page one.
      const mailRow = await deps.db.query.sessionMail.findFirst({
        where: and(
          eq(sessionMail.id, input.messageId),
          eq(sessionMail.tenantId, input.tenantId),
          eq(sessionMail.sessionId, sessionId),
        ),
      });
      if (mailRow === undefined) return undefined;
      return {
        id: mailRow.id,
        createdAt: mailRow.createdAt.toISOString(),
        mail: parseMailToEmail(mailRow.raw, mailRow.id),
      };
    },

    async listChannelActivity(input) {
      if (input.channels.length === 0) return {};

      // Bulk channelId -> sessionId, mirroring `resolveFoldedRunSessionId`'s
      // per-run resolution (run -> its principal's `agent_session`,
      // `includeEnded: true` so a channel whose host session already ended
      // still reports its mail) but in two `inArray` round trips total
      // instead of one `findFoldedRunById` + `resolveRunSessionId` pair per
      // channel.
      const channelIds = input.channels.map((c) => c.channelId);
      const runRows = await deps.db
        .select({ id: workflowRun.id, principalId: workflowRun.principalId })
        .from(workflowRun)
        .where(inArray(workflowRun.id, channelIds));

      const principalIds = runRows
        .map((row) => row.principalId)
        .filter((id): id is string => id !== null);
      const sessionRows =
        principalIds.length === 0
          ? []
          : await deps.db
              .select({
                id: agentSession.id,
                principalId: agentSession.principalId,
              })
              .from(agentSession)
              .where(inArray(agentSession.principalId, principalIds))
              .orderBy(asc(agentSession.createdAt));

      // "One session per run principal" is the same invariant
      // `resolveRunSessionId` documents; the ordered scan plus
      // set-if-absent below is the bulk form of its own asc + limit(1).
      const sessionIdByPrincipal = new Map<string, string>();
      for (const row of sessionRows) {
        if (!sessionIdByPrincipal.has(row.principalId)) {
          sessionIdByPrincipal.set(row.principalId, row.id);
        }
      }

      const channelSessionIds = new Map<string, string>();
      for (const run of runRows) {
        if (run.principalId === null) continue;
        const sessionId = sessionIdByPrincipal.get(run.principalId);
        if (sessionId !== undefined) channelSessionIds.set(run.id, sessionId);
      }

      const sessionIds = [...new Set(channelSessionIds.values())];
      if (sessionIds.length === 0) return {};

      const latestBySession = await deps.db
        .select({
          sessionId: sessionMail.sessionId,
          lastActivityAt: max(sessionMail.createdAt),
        })
        .from(sessionMail)
        .where(inArray(sessionMail.sessionId, sessionIds))
        .groupBy(sessionMail.sessionId);

      const cutoffBySessionId = new Map<string, string>();
      for (const channel of input.channels) {
        const sessionId = channelSessionIds.get(channel.channelId);
        if (sessionId === undefined) continue;
        cutoffBySessionId.set(
          sessionId,
          channel.sinceCreatedAt ?? new Date(0).toISOString(),
        );
      }

      // One grouped COUNT, gated by each session's own cutoff via an
      // OR of per-session conditions rather than a query per channel —
      // the composite `session_mail_session_id_created_at_idx` backs
      // every branch.
      const unreadConditions = [...cutoffBySessionId].map(
        ([sessionId, cutoff]) =>
          and(
            eq(sessionMail.sessionId, sessionId),
            gt(sessionMail.createdAt, new Date(cutoff)),
          ),
      );
      const unreadBySession =
        unreadConditions.length === 0
          ? []
          : await deps.db
              .select({
                sessionId: sessionMail.sessionId,
                unreadCount: count(),
              })
              .from(sessionMail)
              .where(or(...unreadConditions))
              .groupBy(sessionMail.sessionId);

      const latestRows = latestBySession.filter(
        (row): row is { sessionId: string; lastActivityAt: Date } =>
          row.lastActivityAt !== null,
      );

      // The newest message's own row, fetched by the exact
      // (sessionId, createdAt) pair `max()` just resolved — an OR of
      // per-session conditions, the same bulk-not-per-channel shape the
      // unread count above uses — so the preview snippet below reads
      // the real latest message rather than an arbitrary row sharing
      // its session.
      const latestMailConditions = latestRows.map((row) =>
        and(
          eq(sessionMail.sessionId, row.sessionId),
          eq(sessionMail.createdAt, row.lastActivityAt),
        ),
      );
      const latestMailBySession =
        latestMailConditions.length === 0
          ? []
          : await deps.db
              .select({
                id: sessionMail.id,
                sessionId: sessionMail.sessionId,
                raw: sessionMail.raw,
              })
              .from(sessionMail)
              .where(or(...latestMailConditions));
      const previewBySessionId = new Map(
        latestMailBySession.map((row) => [
          row.sessionId,
          extractTextPreview(parseMailToEmail(row.raw, row.id)),
        ]),
      );

      return summarizeChannelActivity(
        channelSessionIds,
        latestRows.map((row) => {
          const preview = previewBySessionId.get(row.sessionId);
          return preview === undefined
            ? {
                sessionId: row.sessionId,
                lastActivityAt: row.lastActivityAt.toISOString(),
              }
            : {
                sessionId: row.sessionId,
                lastActivityAt: row.lastActivityAt.toISOString(),
                preview,
              };
        }),
        unreadBySession,
      );
    },

    async fetchBlob(channelId, blobId): Promise<string | Uint8Array> {
      // Blobs are only readable when the mail row lives on this channel's
      // session. Looking up by mail id alone let any authenticated caller
      // read another tenant's attachment by guessing a blob id.
      const run = await findFoldedRunById(deps.db, channelId);
      if (run === undefined) {
        throw new Error(`No channel run for "${channelId}"`);
      }
      const sessionId = await resolveFoldedRunSessionId(deps.db, run);

      const match = /^blob_(.+?)_(\d[\d.]*)$/.exec(blobId);
      if (match === null) {
        throw new Error(`Invalid blob id "${blobId}"`);
      }
      const [, mailId, partPath] = match;
      if (mailId === undefined || partPath === undefined) {
        throw new Error(`Invalid blob id "${blobId}"`);
      }
      const mailRow = await deps.db.query.sessionMail.findFirst({
        where: and(
          eq(sessionMail.id, mailId),
          eq(sessionMail.sessionId, sessionId),
        ),
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

      void findFoldedRunById(deps.db, channelId)
        .then((run) => {
          if (cancelled || run === undefined || run.address === null) return;
          unsubscribeAgent = deps.sidecarRouter.subscribeAgent(
            run.address,
            (event) => {
              onEvent({ type: "chat.agent", data: event });
            },
          );
        })
        .catch((cause: unknown) => {
          getLogger(["chat", "platform-adapter"])
            .error`subscribeToChannel: failed to resolve folded run for ${channelId}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`;
        });

      return () => {
        cancelled = true;
        unsubscribeAgent?.();
      };
    },
  };
  return Object.assign(platform, {
    recordActivity: (address: string) => lifecycle?.recordActivity(address),
  });
}
