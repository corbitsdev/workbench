// The hub-side `ChatPlatform` implementation, owned by this package
// rather than by `apps/hub` — "apps stay generic; packages own the
// domain" applies to the platform port exactly as it does to the rest
// of chat's behavior. `createHubChatPlatform` composes the port from
// `@corbits/folded-runs` (launch/wake/mail machinery for folded
// interactive runs, shared with any other host that launches them)
// plus the concerns that are chat's own: `workbench_launch` persistence,
// asset naming, invitable listing, and participant/fromWorkbenchId
// send semantics.
import { and, asc, count, desc, eq, gt, inArray, max, or } from "drizzle-orm";
import { createAgentLifecycle } from "@corbits/agent-lifecycle";
import {
  createCryptoProviderCache,
  domainOf,
  findFoldedRunByAddress,
  findFoldedRunById,
  mintFoldedRun,
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
import type { Selector } from "@intx/workflow";
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
import { workbenchLaunch } from "./schema";
import { summarizeWorkbenchActivity } from "./workbench-activity";
import { extractTextPreview } from "./codec";
import {
  workbenchHostAssetName,
  isWorkbenchHostDefinitionName,
} from "./workbench-host-naming";
import { ensureWorkflowDefinitionForAsset } from "@intx/hub-sessions";
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
  type ChatWorkbenchEvent,
  type ChatPlatform,
  type InvitableDefinition,
  type LaunchedWorkbench,
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
   * `@corbits/folded-runs`' `FoldedRunsDeps.credentialCipher`. A workbench
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
   * workbench-HOST launch and wake pins its `InferenceSource` here
   * instead of resolving against the tenant catalog: a workbench
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
   * Opt-in idle-sleep for every launched instance (workbench hosts and
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
   * `sendFoldedMailWithReclaimRetry`'s backoff between retries of a
   * mail send that failed with "agent is unreachable" (see
   * RECLAIM_RETRY_DELAYS_MS below). Injectable so tests exercise the
   * backoff in milliseconds instead of the production ~8s budget.
   */
  reclaimRetryDelaysMs?: readonly number[];
  /**
   * Same resolver `./routes.ts`'s `workbenchHostInferencePreferences` dep
   * takes (see its own doc), reused here for `launchInvite`: a
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
};

// Workbench-host asset naming lives in `./workbench-host-naming` — a
// browser-safe module shared with the UIs that filter anchor runs out
// of workflow listings — so the derivation and the predicate over the
// resulting names can never drift apart.

// The `InferenceSource.id`/`InferenceSource.model` a workbench-host pin
// carries — never read by anything (the noop endpoint ignores both),
// but `InferenceSource` requires non-empty strings, and a workbench
// host's `foldedBody.model` is `null` whenever no catalog source was
// ever resolved for it (see `buildWorkbenchHostWorkflow`'s
// `inferencePreferences` — empty when the hub has seeded none).
const NOOP_INFERENCE_SOURCE_ID = "noop";
const NOOP_INFERENCE_MODEL_FALLBACK = "noop";

/**
 * The `SourcesOverride` every workbench-HOST launch and wake pins
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
 * The workbench-host step's `input` selector. Every other folded run reads
 * its step's default `{ from: "trigger.payload" }` — the triggering
 * mail's real content, which an inference-driven agent needs. The
 * workbench host never does: it never replies, comments, or acts on
 * anything sent to it (see `workbench-workflow.ts`'s
 * `WORKBENCH_HOST_SYSTEM_PROMPT`), so its step
 * has no use for `trigger.payload` at all. Pinning a literal here — not
 * just leaving the field alone — matters because `trigger.payload` is
 * bare mail `content`, which is legitimately empty for attachments-only
 * mail (`@corbits/chat`'s `encodeParts` leaves `content` empty for an
 * event-only send, e.g. `workbench.agent-joined`); the default selector
 * would feed that empty string straight into `agent.send`, which throws
 * on it, killing the anchor before it ever opens (CL-6164). The exact
 * value is never read by anything — the anchor's whole job is holding
 * the mailbox, not processing input.
 */
const WORKBENCH_HOST_STEP_INPUT: Selector = {
  literal: "workbench-host anchor turn",
};

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

  // CL-6267: the sidecar's own park/wake handler now owns respawning a
  // parked-but-still-announced deployment the moment mail routes to it
  // — a routable address is never deployed or undeployed here, this
  // just proceeds so `sendFoldedMail` can deliver straight to it.
  // Redeploying over it would only trip the sidecar's "already
  // deployed" bookkeeping for a resident it never actually stopped.
  // Only a genuinely unroutable/unannounced address gets a real
  // deploy, and a rejection from that deploy propagates honestly.
  async function wakeByAddress(address: string): Promise<void> {
    if (isRoutable(address)) return;

    const run = await findFoldedRunByAddress(deps.db, address);
    if (run === undefined || run.address === null) {
      throw new Error(`No run found for address "${address}"`);
    }
    const launchRows = await deps.db
      .select()
      .from(workbenchLaunch)
      .where(eq(workbenchLaunch.instanceId, run.id))
      .limit(1);
    const launchRow = launchRows[0];
    if (launchRow === undefined) {
      throw new Error(
        `No workbench_launch row for instance "${run.id}"; instances ` +
          `launched before launch-body persistence existed cannot be woken`,
      );
    }
    const parsedFoldedBody = FoldedBodySchema(launchRow.foldedBody);
    if (parsedFoldedBody instanceof type.errors) {
      throw new Error(
        `workbench_launch row for instance "${run.id}" carries an invalid folded body: ${parsedFoldedBody.summary}`,
      );
    }
    // A definition that declares no model of its own resolves the same
    // catalog default here that `launchInvite` used to resolve at
    // launch time — every deploy of such a run now goes through this
    // wake path (launches mint only), and a slept one always did.
    const fallbackModel =
      !launchRow.noopInference && parsedFoldedBody.model === null
        ? ((await deps.workbenchHostInferencePreferences?.(
            launchRow.tenantId,
          )) ?? [])[0]?.model
        : undefined;
    const wakeParams = {
      tenantId: launchRow.tenantId,
      instanceId: run.id,
      triggerAddress: run.address,
      principalId: run.principalId,
      foldedBody: parsedFoldedBody,
    };
    await wakeFoldedRun(
      foldedRunsDeps,
      launchRow.noopInference
        ? {
            ...wakeParams,
            sources: noopSourcesOverride(
              deps.noopInferenceBaseUrl,
              parsedFoldedBody,
            ),
            stepInput: WORKBENCH_HOST_STEP_INPUT,
          }
        : {
            ...wakeParams,
            ...(fallbackModel !== undefined ? { fallbackModel } : {}),
          },
    );
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
    async launchWorkbench(input): Promise<LaunchedWorkbench> {
      // Validates the address shape early, mirroring every other path
      // here that reads a domain off an agent address.
      domainOf(input.triggerAddress);
      const asset = await deps.assetService.createAsset({
        tenantId: input.tenantId,
        kind: "workflow",
        name: workbenchHostAssetName(input.workbenchId),
        creatorPrincipalId: input.creatorPrincipalId,
      });
      let definitionJSON: unknown;
      try {
        definitionJSON = JSON.parse(input.definition);
      } catch (cause) {
        throw new Error("workbench definition is not valid JSON", { cause });
      }
      const wireHash = await computeWireDefinitionHash(definitionJSON);
      const { definitionId } = await ensureWorkflowDefinitionForAsset(deps.db, {
        assetId: asset.id,
        wireHash,
      });

      const foldedBody = readFoldedBody(definitionJSON);

      // Mint only — DB rows, no sidecar, no deploy. The host deploys
      // through `wakeByAddress` on its first traffic (the join event or
      // the canned greeting, moments later), so workbench creation
      // returns in database time instead of deploy time. The wake pins
      // the noop inference source per `noopInference: true` below: a
      // workbench host never replies — its mailbox is the timeline and
      // its system prompt forbids answering — so it never resolves
      // against the tenant catalog and launches with zero sources
      // seeded.
      await mintFoldedRun(foldedRunsDeps, {
        tenantId: input.tenantId,
        instanceId: input.workbenchId,
        triggerAddress: input.triggerAddress,
        definitionId,
        // The launch body is persisted with the mint itself, in the
        // same transaction, so a wake can rebuild the deploy config
        // without reaching for the definition's asset — a workbench
        // host's asset never holds a workflow.json, so this row is
        // the only wake-time source. Chat owns this table; folded-runs
        // never imports it. `noopInference: true` records this mint
        // as a host, so its wake pins the noop source rather than
        // re-deriving "is this a host" from anything else.
        persistExtra: async (tx) => {
          await tx.insert(workbenchLaunch).values({
            tenantId: input.tenantId,
            instanceId: input.workbenchId,
            foldedBody,
            createdAt: new Date(),
            noopInference: true,
          });
        },
      });

      return { instanceId: input.workbenchId };
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

      // Mint only — DB rows, no sidecar, no deploy. The agent deploys
      // through `wakeByAddress` on its first inbound mail (or an
      // explicit `ensureAwake` pre-warm), so an invite returns in
      // database time. Its inference sources — including the catalog
      // fallback a definition with no model of its own needs — resolve
      // fresh inside the wake, per `noopInference: false` below: an
      // invited agent's replies are real, so it resolves against the
      // tenant catalog on every deploy.
      await mintFoldedRun(foldedRunsDeps, {
        tenantId: input.tenantId,
        instanceId,
        triggerAddress,
        definitionId: input.definitionId,
        persistExtra: async (tx) => {
          await tx.insert(workbenchLaunch).values({
            tenantId: input.tenantId,
            instanceId,
            foldedBody,
            createdAt: new Date(),
            noopInference: false,
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
      return rows
        .filter((row) => !isWorkbenchHostDefinitionName(row.name))
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
      _workbenchId,
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
        .update(workbenchLaunch)
        .set({ foldedBody })
        .where(eq(workbenchLaunch.instanceId, run.id));
    },

    async sendMail(input): Promise<SentMail> {
      const run = await findFoldedRunById(deps.db, input.workbenchId);
      if (run === undefined) {
        throw new Error(`No workbench run for "${input.workbenchId}"`);
      }
      if (run.address === null) {
        throw new Error(`Workbench run "${input.workbenchId}" has no address`);
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
      // CL-6267: a parked deployment stays announced (routable), and
      // the sidecar's own park wake-handler wakes/respawns it the
      // moment mail routes to it — this adapter never deploys or
      // undeploys anything for a routable address, it just proceeds to
      // send. Only a genuinely unroutable address gets an explicit
      // wake here.
      if (lifecycle !== undefined) {
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
      if (input.fromWorkbenchId !== undefined) {
        const origin = await findFoldedRunById(deps.db, input.fromWorkbenchId);
        if (origin?.address == null) {
          throw new Error(
            `Origin workbench "${input.fromWorkbenchId}" has no address`,
          );
        }
        from = origin.address;
        originAddress = origin.address;
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
      const run = await findFoldedRunById(deps.db, input.workbenchId);
      if (run === undefined) {
        return { items: [] };
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
      const run = await findFoldedRunById(deps.db, input.workbenchId);
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

    async listWorkbenchActivity(input) {
      if (input.workbenches.length === 0) return {};

      // Bulk workbenchId -> sessionId, mirroring `resolveFoldedRunSessionId`'s
      // per-run resolution (run -> its principal's `agent_session`,
      // `includeEnded: true` so a workbench whose host session already ended
      // still reports its mail) but in two `inArray` round trips total
      // instead of one `findFoldedRunById` + `resolveRunSessionId` pair per
      // workbench.
      const workbenchIds = input.workbenches.map((c) => c.workbenchId);
      const runRows = await deps.db
        .select({ id: workflowRun.id, principalId: workflowRun.principalId })
        .from(workflowRun)
        .where(inArray(workflowRun.id, workbenchIds));

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

      const workbenchSessionIds = new Map<string, string>();
      for (const run of runRows) {
        if (run.principalId === null) continue;
        const sessionId = sessionIdByPrincipal.get(run.principalId);
        if (sessionId !== undefined) workbenchSessionIds.set(run.id, sessionId);
      }

      const sessionIds = [...new Set(workbenchSessionIds.values())];
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
      for (const workbench of input.workbenches) {
        const sessionId = workbenchSessionIds.get(workbench.workbenchId);
        if (sessionId === undefined) continue;
        cutoffBySessionId.set(
          sessionId,
          workbench.sinceCreatedAt ?? new Date(0).toISOString(),
        );
      }

      // One grouped COUNT, gated by each session's own cutoff via an
      // OR of per-session conditions rather than a query per workbench —
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
      // per-session conditions, the same bulk-not-per-workbench shape the
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

      return summarizeWorkbenchActivity(
        workbenchSessionIds,
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

    async fetchBlob(workbenchId, blobId): Promise<string | Uint8Array> {
      // Blobs are only readable when the mail row lives on this workbench's
      // session. Looking up by mail id alone let any authenticated caller
      // read another tenant's attachment by guessing a blob id.
      const run = await findFoldedRunById(deps.db, workbenchId);
      if (run === undefined) {
        throw new Error(`No workbench run for "${workbenchId}"`);
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

    subscribeToWorkbench(
      workbenchId: string,
      onEvent: (event: ChatWorkbenchEvent) => void,
    ): () => void {
      let cancelled = false;
      let unsubscribeAgent: (() => void) | undefined;

      void findFoldedRunById(deps.db, workbenchId)
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
      if (lifecycle !== undefined) {
        await lifecycle.ensureAwake(address);
        return;
      }
      if (isRoutable(address)) return;
      await wakeByAddress(address);
    },
  };

  return Object.assign(platform, {
    recordActivity: (address: string) => lifecycle?.recordActivity(address),
  });
}
