// The hub-side `ChatPlatform` implementation, owned by this package
// rather than by `apps/hub` — "apps stay generic; packages own the
// domain" applies to the platform port exactly as it does to the rest
// of chat's behavior. `createHubChatPlatform` composes the port from
// `@corbits/folded-runs` (launch/wake/mail machinery for folded
// interactive runs, shared with any other host that launches them)
// plus the concerns that are chat's own: `workbench_launch` persistence,
// invitable listing, and participant/fromWorkbenchId send semantics.
// A workbench itself is data — only invited agents have runs here.
import { and, desc, eq } from "drizzle-orm";
import { createAgentLifecycle } from "@corbits/agent-lifecycle";
import {
  authoredDefinitionCandidates,
  createCryptoProviderCache,
  DefinitionProjectionMissingError,
  domainOf,
  launchFoldedRun,
  mintFoldedRun,
  readFoldedBody,
  resolveFoldedRunSessionId,
  resolveNewestProjectedDefinition,
  sendFoldedMail,
  wakeFoldedRun,
  type FoldedRunMode,
  type FoldedRunsDeps,
  type SendFoldedMailParams,
} from "@corbits/folded-runs";
import {
  isBeyondWake,
  listLaunchesBeyondWake,
  readBindingByAddress,
  readPriorRuns,
  repointBinding,
  resolveLiveAgent,
  resolveLiveByStableId,
  type AgentBinding,
  type LiveAgent,
} from "./agent-binding";
import type { RelaunchNoticePort } from "./relaunch-notice";
import { AGENT_SECTION_MODE } from "./standalone-launch";
import type { DB } from "@intx/db";
import {
  sessionMail,
  tenant as tenantTable,
  workflowDefinition,
} from "@intx/db/schema";
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import { extractPartByPath } from "@intx/mime";
import { workbenchLaunch } from "./schema";
import { isWorkbenchHostDefinitionName } from "./workbench-host-naming";
import type { EventCollectorRegistry, SidecarRouter } from "@intx/hub-sessions";
import type { InferencePreference } from "@intx/agent";
import { formatRunAddress } from "@intx/types";
import {
  AgentUnreachableError,
  type ChatWorkbenchEvent,
  type ChatPlatform,
  type InvitableDefinition,
  type LaunchedInvite,
  type SentMail,
} from "./platform-port";

export type CreateHubChatPlatformDeps = {
  db: DB["db"];
  sessionService: FoldedRunsDeps["sessionService"];
  assetService: FoldedRunsDeps["assetService"];
  sidecarRouter: SidecarRouter;
  /** See `FoldedRunsDeps.toolGrantsForPins`. */
  toolGrantsForPins: FoldedRunsDeps["toolGrantsForPins"];
  /** See `FoldedRunsDeps.mcpCredentialBindingsFor`. */
  mcpCredentialBindingsFor?: FoldedRunsDeps["mcpCredentialBindingsFor"];
  /**
   * Decrypts credential secrets when an invited agent's launch resolves
   * inference sources against the tenant catalog — see
   * `@corbits/folded-runs`' `FoldedRunsDeps.credentialCipher`; every
   * invited-agent launch and wake needs it.
   * Omitted, `resolveDefinitionSources` falls back to a noop cipher and
   * hands the raw stored secret to the provider unchanged — correct only
   * when the credential was itself written unencrypted.
   */
  credentialCipher?: FoldedRunsDeps["credentialCipher"];
  /**
   * Every caller of `createHubChatPlatform` builds this via
   * `createEventCollectorRegistry` and passes it through — without it,
   * an agent's runtime status/readiness (health, SSE replay) reads as
   * permanently "not_ready", and the idle-sweep's `isBusy` guard (see
   * the lifecycle construction below) has no signal at all.
   */
  eventCollectors: EventCollectorRegistry;
  /**
   * Opt-in idle-sleep for every launched instance: absent here, the adapter keeps today's
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
   * `sendFoldedMailWithReclaimRetry`'s backoff between retries of a
   * mail send that failed with "agent is unreachable" (see
   * RECLAIM_RETRY_DELAYS_MS below). Injectable so tests exercise the
   * backoff in milliseconds instead of the production ~8s budget.
   */
  reclaimRetryDelaysMs?: readonly number[];
  /**
   * The invite-launch model fallback (see `./inference-preferences.ts`'s
   * `createWorkbenchHostInferencePreferencesResolver`): a
   * hand-authored definition that declares no model requirements of
   * its own (e.g. a `create_agent` definition created without a
   * `model` — see `@corbits/agent-directory`'s `createAgentDefinitionCore`)
   * would otherwise 409 as `not_launchable` even though the tenant has
   * a perfectly usable catalog default. Omitted, or a tenant with no
   * connected provider, that 409 is exactly what still happens — the
   * honest answer when there is truly nothing to launch against.
   */
  workbenchHostInferencePreferences?: (
    tenantId: string,
  ) => Promise<readonly InferencePreference[]>;
  /**
   * Where a relaunch announces itself in the room — see
   * `./relaunch-notice.ts` for why this is a ref the host arms later
   * rather than a callback passed in here. Absent (or never armed), a
   * relaunch happens silently.
   */
  relaunchNotice?: RelaunchNoticePort;
};

/**
 * How many launch rows one relaunch sweep will look at. A sweep is a
 * best-effort recovery pass, and every relaunch it performs is a real
 * sidecar deploy — an unbounded one would turn a boot after a bad night
 * into a deploy storm. Rooms past the bound still recover the moment
 * somebody writes into them, through the same send-triggered path.
 */
const RELAUNCH_SWEEP_LIMIT = 100;

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
  /**
   * Redeploys `address` if it is not currently routable, otherwise
   * no-ops — the same wake path `sendMail` runs ahead of every send,
   * exposed here for a caller outside this adapter (the hub's
   * `mail.outbound.undelivered` handler) that needs to wake a chat
   * resident before re-attempting delivery itself. Rejects for an
   * address this adapter cannot resolve a folded run for — including
   * one that was never a chat resident at all — so a caller must
   * expect this to fail for a non-chat recipient and treat that as
   * "not mine to wake", not a bug.
   */
  ensureAwake(address: string): Promise<void>;
  /**
   * Relaunches every room participant whose run is beyond waking, and
   * posts each one's notice. The host runs this at boot and again
   * whenever the execution plane has come back, since a run that died
   * with its sidecar is only discoverable once the hub has ingested
   * that run's terminal event.
   */
  sweepTerminalRuns(): Promise<{ scanned: number; relaunched: number }>;
};

/**
 * Composes the `ChatPlatform` port over the hub's real session
 * services and `@corbits/folded-runs`. One crypto provider is minted
 * per workbench and cached for the adapter's lifetime.
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

  function isRoutable(address: string): boolean {
    return deps.sidecarRouter.getRoutableAddresses().includes(address);
  }

  /**
   * The tenant's current live default model — always resolved, whether
   * or not `binding.foldedBody.model` names one of its own. A
   * definition that declares no model resolves this same catalog
   * default at every deploy, exactly as `launchInvite` used to resolve
   * it at launch time (every deploy of such a run now goes through a
   * wake or a relaunch — launches mint only — and a slept one always
   * did). A definition that DOES name a model still needs this: it is
   * `deployAtHead`'s retry target when that pinned model no longer
   * resolves against the tenant's current catalog (a provider it was
   * pinned against got disconnected, or none was connected yet when it
   * was pinned) — so reconnecting a different provider heals an
   * already-invited agent, not only a freshly invited one.
   */
  async function resolveFallbackModel(
    binding: AgentBinding,
  ): Promise<string | undefined> {
    const preferences =
      (await deps.workbenchHostInferencePreferences?.(binding.tenantId)) ?? [];
    return preferences[0]?.model;
  }

  /**
   * The per-deploy pins a binding carries, identical for a wake and a
   * relaunch: an agent resolves the tenant catalog, with a fallback
   * model when its definition declares none.
   */
  async function deployShapeFor(
    binding: AgentBinding,
  ): Promise<{ mode: FoldedRunMode; fallbackModel?: string }> {
    const fallbackModel = await resolveFallbackModel(binding);
    return fallbackModel !== undefined
      ? { mode: AGENT_SECTION_MODE, fallbackModel }
      : { mode: AGENT_SECTION_MODE };
  }

  /**
   * Replaces a run that died terminally with a genuinely fresh one.
   *
   * The dead run's durable event log is never reclaimed or erased — it
   * stays on disk under its own address and readable through the
   * platform's run routes, which is the audit trail a resurrection
   * would have destroyed. What moves is the mapping: a new run id, a
   * new address (the platform derives one from the other, so a fresh
   * run cannot keep the old address), a new anchor row, and a new
   * event log; `repointBinding` then swings the room's stable
   * participant onto it. The room itself — timeline, settings,
   * threads, participant records — never moves, because none of it was
   * ever keyed on the run.
   */
  async function relaunchTerminalRun(live: LiveAgent): Promise<string> {
    const { binding, run } = live;
    if (run.definitionId === null) {
      throw new Error(
        `Cannot relaunch "${binding.stableId}": its run ${run.id} names no definition`,
      );
    }
    const newRunId = generateId("workflowRun");
    const newAddress = formatRunAddress(
      newRunId,
      domainOf(binding.roomAddress),
    );
    wakeLogger.info`relaunching ${binding.roomAddress}: run ${run.id} is terminal (${run.status}); minting fresh run ${newRunId}`;

    await launchFoldedRun(foldedRunsDeps, {
      tenantId: binding.tenantId,
      instanceId: newRunId,
      triggerAddress: newAddress,
      definitionId: run.definitionId,
      foldedBody: binding.foldedBody,
      launchLabel: "the relaunched instance",
      ...(await deployShapeFor(binding)),
    });

    // After the deploy, never inside its transaction: a repoint that
    // outlived a failed launch would leave the room addressing a run
    // `launchFoldedRun` had already rolled back, and the next message
    // would resolve nothing at all.
    await repointBinding(deps.db, binding, newRunId);
    lifecycle?.untrack(binding.liveAddress);
    lifecycle?.track(newAddress);

    // The turn that died with the old run never sent
    // `message.run.ended`, so the orchestrator's turn-drop notice can
    // never fire for it. This is the only thing that tells the reader
    // their message was not silently swallowed.
    deps.relaunchNotice?.current?.({
      tenantId: binding.tenantId,
      roomAddress: binding.roomAddress,
      deadRunId: run.id,
      deadRunStatus: run.status,
      newRunId,
    });
    return newAddress;
  }

  /**
   * Replaces every participant whose run died while nothing was
   * watching. A send-triggered relaunch only fires when somebody writes
   * into the room; a room whose agent died in a crash would otherwise
   * stay silently dead until then, with the interrupted turn never
   * surfacing at all.
   *
   * Best-effort and bounded: one failed relaunch is logged and the
   * sweep moves on, because a boot that aborts on the first
   * unrelaunchable room leaves every room after it dead too.
   */
  async function sweepTerminalRuns(): Promise<{
    scanned: number;
    relaunched: number;
  }> {
    const dead = await listLaunchesBeyondWake(deps.db, RELAUNCH_SWEEP_LIMIT);
    let relaunched = 0;
    for (const live of dead) {
      try {
        await relaunchTerminalRun(live);
        relaunched += 1;
      } catch (cause: unknown) {
        wakeLogger.error`relaunch sweep: could not relaunch ${live.binding.roomAddress} (run ${live.run.id} is ${live.run.status}): ${
          cause instanceof Error ? cause.message : String(cause)
        }`;
      }
    }
    if (dead.length > 0) {
      wakeLogger.info`relaunch sweep: ${String(relaunched)} of ${String(dead.length)} dead room participants relaunched`;
    }
    return { scanned: dead.length, relaunched };
  }

  /**
   * Brings the run behind `address` back to routable, whichever kind of
   * "not routable" it is in. `address` may be either side of the
   * mapping — the stable address the room holds, or the live deployment
   * address the sidecar reports.
   *
   * CL-6267: the sidecar's own park/wake handler owns respawning a
   * parked-but-still-announced deployment the moment mail routes to it,
   * so a routable address is never deployed or undeployed here.
   *
   * CL-6365: a run that is unroutable because it DIED — the hub's own
   * `workflow_run.status` is terminal and it is not merely a folded run
   * parked between messages — cannot be woken at all. Its address's
   * durable event log already carries the terminal event, so
   * redeploying it would come straight back as `workflow_run_terminal`
   * and the message would be dropped in silence. That case relaunches.
   */
  async function wakeByAddress(address: string): Promise<void> {
    const binding = await readBindingByAddress(deps.db, address);
    if (binding === undefined) {
      throw new Error(
        `No workbench_launch binding for address "${address}"; instances ` +
          `launched before launch-body persistence existed cannot be woken`,
      );
    }
    const live = await resolveLiveAgent(deps.db, binding);
    if (live === undefined || live.run.address === null) {
      throw new Error(
        `No run found for address "${address}" (binding names run "${binding.currentRunId}")`,
      );
    }
    if (await isBeyondWake(deps.db, live.run)) {
      await relaunchTerminalRun(live);
      return;
    }
    if (isRoutable(live.run.address)) return;

    const wakeParams = {
      tenantId: binding.tenantId,
      instanceId: live.run.id,
      triggerAddress: live.run.address,
      principalId: live.run.principalId,
      foldedBody: binding.foldedBody,
    };
    await wakeFoldedRun(foldedRunsDeps, {
      ...wakeParams,
      ...(await deployShapeFor(binding)),
    });
  }

  /**
   * The live run mail must actually be delivered to for a stable
   * participant id — not the room's own address, once anything has been
   * relaunched.
   */
  async function requireLive(stableId: string): Promise<LiveAgent> {
    const live = await resolveLiveByStableId(deps.db, stableId);
    if (live === undefined) {
      throw new Error(`No live workbench run for "${stableId}"`);
    }
    return live;
  }

  /**
   * The mail sessions this participant used to hold, newest first. A
   * retired run whose principal never got a session (a launch that
   * rolled back before one existed) has nothing to contribute and is
   * skipped — that is history with no mail in it, not a failure to
   * read the blob the caller asked for.
   */
  async function retiredSessionIds(binding: AgentBinding): Promise<string[]> {
    const sessionIds: string[] = [];
    for (const run of await readPriorRuns(deps.db, binding)) {
      try {
        sessionIds.push(await resolveFoldedRunSessionId(deps.db, run));
      } catch {
        continue;
      }
    }
    return sessionIds;
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

  // CL-6452: every run deploy ensures a same-named sibling definition
  // over the agent's asset under its per-run wire hash — a frozen
  // deploy record carrying whatever projection was current at that
  // deploy. Launch bodies resolve only from the hub-authored row(s) of
  // the asset, so a skill pin or instructions save (which refreezes
  // the authored row in place) reaches every later launch instead of
  // being shadowed by the newest clone. Raises the named
  // `DefinitionProjectionMissingError` — mapped to a 4xx at the route
  // boundary, never an unhandled 500 — when the asset has no authored
  // definition or none of its authored rows carries a projection.
  async function resolveAuthoredProjectedDefinition(
    tenantId: string,
    definitionAsset: { assetId: string; name: string },
  ) {
    const assetSiblingRows = await deps.db.query.workflowDefinition.findMany({
      where: and(
        eq(workflowDefinition.tenantId, tenantId),
        eq(workflowDefinition.assetId, definitionAsset.assetId),
        eq(workflowDefinition.status, "deployed"),
      ),
      orderBy: desc(workflowDefinition.createdAt),
    });
    const candidates = authoredDefinitionCandidates(assetSiblingRows);
    if (candidates.length === 0) {
      throw new DefinitionProjectionMissingError(definitionAsset.name);
    }
    const resolved = await resolveNewestProjectedDefinition(
      deps.db,
      candidates,
    );
    const row = candidates.find(
      (candidate) => candidate.id === resolved.definitionId,
    );
    if (row === undefined) {
      throw new Error(
        `resolved definition "${resolved.definitionId}" is not among the ` +
          `authored candidates for asset "${definitionAsset.assetId}"`,
      );
    }
    return { row, projection: resolved.projection };
  }

  const platform: ChatPlatform = {
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

      const { row: resolvedDefinitionRow, projection } =
        await resolveAuthoredProjectedDefinition(input.tenantId, {
          assetId: definitionRow.assetId,
          name: definitionRow.name,
        });

      const foldedBody = readFoldedBody(
        projection,
        resolvedDefinitionRow.grantRequirements,
      );
      if (foldedBody.systemPrompt === "") {
        throw new Error(
          `Definition "${input.definitionId}" cannot be launched without ` +
            `a system prompt configured`,
        );
      }

      const instanceId = generateId("workflowRun");
      const triggerAddress = formatRunAddress(instanceId, tenantRow.domain);

      // Mint only — DB rows, no sidecar, no deploy. The agent deploys
      // through `wakeByAddress` on its first inbound mail (or an
      // explicit `ensureAwake` pre-warm), so an invite returns in
      // database time. Its inference sources — including the catalog
      // fallback a definition with no model of its own needs — resolve
      // fresh inside the wake against the tenant catalog on every
      // deploy. The launch body is persisted with the mint itself, in
      // the same transaction, so a wake can rebuild the deploy config
      // without reaching for the definition's asset. Chat owns this
      // table; folded-runs never imports it.
      await mintFoldedRun(foldedRunsDeps, {
        tenantId: input.tenantId,
        instanceId,
        triggerAddress,
        // The resolved row, not necessarily `input.definitionId`: a
        // later wake reads the asset back through this id, so it must
        // always name a row whose asset actually resolves.
        definitionId: resolvedDefinitionRow.id,
        persistExtra: async (tx) => {
          await tx.insert(workbenchLaunch).values({
            tenantId: input.tenantId,
            instanceId,
            currentRunId: instanceId,
            foldedBody,
            createdAt: new Date(),
          });
        },
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
      // Only hub-authored definitions are invitable: the run-deploy
      // clones sharing an agent's name are deploy records, and listing
      // them would offer N stale copies of every agent that has run.
      return authoredDefinitionCandidates(rows)
        .filter((row) => !isWorkbenchHostDefinitionName(row.name))
        .map((row) => {
          const base = { id: row.id, name: row.name };
          return typeof row.description === "string" && row.description !== ""
            ? { ...base, description: row.description }
            : base;
        });
    },

    async resolveDefinitionIdByAddress(address): Promise<string | undefined> {
      const binding = await readBindingByAddress(deps.db, address);
      if (binding === undefined) return undefined;
      const live = await resolveLiveAgent(deps.db, binding);
      return live?.run.definitionId ?? undefined;
    },

    async resolveDefinitionAssetId(definitionId): Promise<string | undefined> {
      const row = await deps.db.query.workflowDefinition.findFirst({
        where: eq(workflowDefinition.id, definitionId),
      });
      return row?.assetId ?? undefined;
    },

    async resolveDefinitionNameSource(definitionId) {
      const row = await deps.db.query.workflowDefinition.findFirst({
        where: eq(workflowDefinition.id, definitionId),
      });
      if (row === undefined) return undefined;
      return typeof row.description === "string" && row.description !== ""
        ? { name: row.name, description: row.description }
        : { name: row.name };
    },

    async refreshAgentInstanceFromDefinition(
      tenantId,
      _workbenchId,
      address,
    ): Promise<void> {
      const binding = await readBindingByAddress(deps.db, address);
      if (binding === undefined) return;
      const live = await resolveLiveAgent(deps.db, binding);
      const definitionId = live?.run.definitionId;
      if (definitionId === undefined || definitionId === null) return;

      const definitionRow = await deps.db.query.workflowDefinition.findFirst({
        where: and(
          eq(workflowDefinition.id, definitionId),
          eq(workflowDefinition.tenantId, tenantId),
        ),
      });
      if (definitionRow === undefined || definitionRow.assetId === null) {
        return;
      }

      // The run's own definition row is the per-run clone the deploy
      // repointed it to; the refresh recomputes from the hub-authored
      // sibling so the saved edit — not the clone's frozen snapshot —
      // is what the next wake replays.
      const { row: authoredRow, projection } =
        await resolveAuthoredProjectedDefinition(tenantId, {
          assetId: definitionRow.assetId,
          name: definitionRow.name,
        });
      const foldedBody = readFoldedBody(
        projection,
        authoredRow.grantRequirements,
      );

      await deps.db
        .update(workbenchLaunch)
        .set({ foldedBody })
        .where(eq(workbenchLaunch.instanceId, binding.stableId));
    },

    async sendMail(input): Promise<SentMail> {
      // The stable id names the room's participant; the run it resolves
      // to is whichever one is alive right now, which is a different
      // run (and a different address) after every relaunch.
      const { binding } = await requireLive(input.workbenchId);
      const liveAddress = binding.liveAddress;

      // Wake before send: a sleeping instance (the lifecycle package's
      // own sweep) or one that never came back up after a stack
      // restart is not in the sidecar's routable set. Re-deploying it
      // here — and letting a wake failure propagate — means the send
      // fails loud rather than vanishing into an agent nothing is
      // listening on. This is also how a mention fan-out copy reaches
      // a sleeping invited agent: every send, including fan-out
      // copies, goes through this one `sendMail` choke point.
      //
      // CL-6267: a parked deployment stays announced (routable), and
      // the sidecar's own park wake-handler wakes/respawns it the
      // moment mail routes to it — this adapter never deploys or
      // undeploys anything for a routable address, it just proceeds to
      // send. Only a genuinely unroutable address gets an explicit
      // wake here.
      //
      // CL-6365: a relaunch can happen inside this wake, minting a
      // fresh run at a fresh address. Re-resolve afterwards so the
      // send that follows targets the run that is actually alive, not
      // the one that just died.
      if (lifecycle !== undefined) {
        await lifecycle.ensureAwake(liveAddress);
      } else if (!isRoutable(liveAddress)) {
        await wakeByAddress(liveAddress);
      }
      const delivery = await requireLive(input.workbenchId);
      const deliveryAddress = delivery.binding.liveAddress;
      // Tracking here (not only at launch) brings instances that were
      // already resident before this hub process started — restored by
      // a sidecar reconnect, launched by an earlier run — under the
      // idle sweep the moment they see traffic.
      lifecycle?.track(deliveryAddress);

      const sessionId = await resolveFoldedRunSessionId(deps.db, delivery.run);
      const domain = domainOf(deliveryAddress);
      // `fromWorkbenchId` names the room a dispatch speaks for. A room
      // is data — it has no run — so its address is derived, never
      // resolved: `<workbenchId>@<domain>`, the same shape every
      // participant address carries.
      let from: string;
      if (input.fromWorkbenchId !== undefined) {
        from = formatRunAddress(input.fromWorkbenchId, domain);
      } else if (input.principalId !== undefined) {
        from = `${input.principalId}@${domain}`;
      } else {
        throw new Error(
          "sendMail requires either principalId or fromWorkbenchId",
        );
      }
      const cryptoProvider = await cryptoProviders.get(input.workbenchId);

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
        agentAddress: deliveryAddress,
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

      lifecycle?.recordActivity(deliveryAddress);

      return sent;
    },

    async fetchBlob(workbenchId, blobId): Promise<string | Uint8Array> {
      const match = /^blob_(.+?)_(\d[\d.]*)$/.exec(blobId);
      if (match === null) {
        throw new Error(`Invalid blob id "${blobId}"`);
      }
      const [, mailId, partPath] = match;
      if (mailId === undefined || partPath === undefined) {
        throw new Error(`Invalid blob id "${blobId}"`);
      }

      // Blobs are only readable when the mail row lives on a session
      // this participant has actually held. Looking up by mail id alone
      // let any authenticated caller read another tenant's attachment
      // by guessing a blob id.
      //
      // "Held", not "holds": a relaunch mints a fresh run with a fresh
      // principal, and a folded run's mail session hangs off its
      // principal — so an attachment sent before the crash lives on a
      // session the live run has never seen. Walking the retired runs
      // newest-first is what keeps yesterday's attachment downloadable
      // after today's relaunch.
      const { binding, run } = await requireLive(workbenchId);
      const liveSessionId = await resolveFoldedRunSessionId(deps.db, run);
      const priorSessionIds = await retiredSessionIds(binding);
      for (const sessionId of [liveSessionId, ...priorSessionIds]) {
        const mailRow = await deps.db.query.sessionMail.findFirst({
          where: and(
            eq(sessionMail.id, mailId),
            eq(sessionMail.sessionId, sessionId),
          ),
        });
        if (mailRow !== undefined) {
          return extractPartByPath(mailRow.raw, partPath);
        }
      }
      throw new Error(`No mail "${mailId}" for blob "${blobId}"`);
    },

    subscribeToWorkbench(
      workbenchId: string,
      onEvent: (event: ChatWorkbenchEvent) => void,
    ): () => void {
      let cancelled = false;
      let unsubscribeAgent: (() => void) | undefined;

      void resolveLiveByStableId(deps.db, workbenchId)
        .then((live) => {
          if (cancelled || live === undefined) return;
          unsubscribeAgent = deps.sidecarRouter.subscribeAgent(
            live.binding.liveAddress,
            (event) => {
              onEvent({ type: "chat.agent", data: event });
            },
          );
        })
        .catch((cause: unknown) => {
          getLogger(["chat", "platform-adapter"])
            .error`subscribeToWorkbench: failed to resolve folded run for ${workbenchId}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`;
        });

      return () => {
        cancelled = true;
        unsubscribeAgent?.();
      };
    },

    async ensureAwake(address: string): Promise<void> {
      // The caller may hold either side of the mapping (the hub's
      // undelivered-mail handler holds whatever the envelope named), so
      // the lifecycle is driven on the LIVE address it resolves to —
      // that is the only address the sidecar ever announces.
      const binding = await readBindingByAddress(deps.db, address);
      if (binding === undefined) {
        throw new Error(`No workbench_launch binding for address "${address}"`);
      }
      if (lifecycle !== undefined) {
        await lifecycle.ensureAwake(binding.liveAddress);
        return;
      }
      if (isRoutable(binding.liveAddress)) return;
      await wakeByAddress(binding.liveAddress);
    },
  };

  return Object.assign(platform, {
    recordActivity: (address: string) => lifecycle?.recordActivity(address),
    sweepTerminalRuns,
  });
}
