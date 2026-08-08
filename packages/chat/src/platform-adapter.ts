// The hub-side `ChatPlatform` implementation, owned by this package
// rather than by `apps/hub` — "apps stay generic; packages own the
// domain" applies to the platform port exactly as it does to the rest
// of chat's behavior. `createHubChatPlatform` composes the port from
// `@corbits/folded-runs` (launch/wake/mail machinery for folded
// interactive runs, shared with any other host that launches them)
// plus the concerns that are chat's own: `channel_launch` persistence,
// asset naming, invitable listing, and participant/fromChannelId
// send semantics.
import { and, desc, eq } from "drizzle-orm";
import { createAgentLifecycle } from "@corbits/agent-lifecycle";
import {
  createCryptoProviderCache,
  domainOf,
  findFoldedRunByAddress,
  findFoldedRunById,
  launchFoldedRun,
  listFoldedMail,
  readDefinitionJSON,
  readFoldedBody,
  resolveFoldedRunSessionId,
  sendFoldedMail,
  wakeFoldedRun,
  FoldedBodySchema,
  type FoldedRunsDeps,
  type SourcesOverride,
} from "@corbits/folded-runs";
import type { FoldedBody } from "@intx/workflow-deploy";
import type { DB } from "@intx/db";
import {
  sessionMail,
  tenant as tenantTable,
  workflowDefinition,
} from "@intx/db/schema";
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import { extractPartByPath } from "@intx/mime";
import { channelLaunch } from "./schema";
import { ensureWorkflowDefinitionForAsset } from "@intx/hub-sessions";
import type {
  AssetService,
  EventCollectorRegistry,
  SessionService,
  SidecarRouter,
} from "@intx/hub-sessions";
import { formatAgentAddress } from "@intx/types";
import { type } from "arktype";
import type {
  ChatChannelEvent,
  ChatPlatform,
  InvitableDefinition,
  LaunchedChannel,
  LaunchedInvite,
  ListedMail,
  SentMail,
} from "./platform-port";

export type CreateHubChatPlatformDeps = {
  db: DB["db"];
  sessionService: SessionService;
  assetService: AssetService;
  sidecarRouter: SidecarRouter;
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
};

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
  };

  const cryptoProviders = createCryptoProviderCache();

  // Built from `@corbits/agent-lifecycle` — the idle-sleep sweep and
  // wake-coalescing logic live entirely in that package, imported as a
  // published dependency rather than reimplemented here; this adapter
  // only wires its ports onto `sidecarRouter` (routability, undeploy),
  // `deps.eventCollectors` (busy detection), and `wakeByAddress` below
  // (a plain `function` declaration, so it is already hoisted by the
  // time this closure is called). `undefined` when `deps.lifecycle` is
  // unset, matching today's behavior exactly: nothing is tracked, no
  // sweep runs, `sendMail` never calls `ensureAwake`.
  const lifecycle =
    deps.lifecycle !== undefined
      ? createAgentLifecycle({
          idleSleepMs: deps.lifecycle.idleSleepMs,
          ...(deps.lifecycle.sweepIntervalMs !== undefined
            ? { sweepIntervalMs: deps.lifecycle.sweepIntervalMs }
            : {}),
          isRoutable: (address) =>
            deps.sidecarRouter.getRoutableAddresses().includes(address),
          undeploy: (address, reason) =>
            deps.sidecarRouter.sendAgentUndeploy(address, reason),
          wake: wakeByAddress,
          isBusy: (address) =>
            typeof deps.eventCollectors.getCurrentTurnId(address) === "string",
          log: getLogger(["chat", "lifecycle"]),
        })
      : undefined;

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
    await wakeFoldedRun(foldedRunsDeps, {
      tenantId: launchRow.tenantId,
      instanceId: run.id,
      triggerAddress: run.address,
      principalId: run.principalId,
      foldedBody: parsedFoldedBody,
      ...(launchRow.noopInference
        ? {
            sources: noopSourcesOverride(
              deps.noopInferenceBaseUrl,
              parsedFoldedBody,
            ),
          }
        : {}),
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

      const instanceId = generateId("instance");
      const triggerAddress = formatAgentAddress(instanceId, tenantRow.domain);

      await launchFoldedRun(foldedRunsDeps, {
        tenantId: input.tenantId,
        instanceId,
        triggerAddress,
        definitionId: input.definitionId,
        foldedBody,
        launchLabel: "the invited agent",
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
        .filter((row) => !row.name.startsWith(CHANNEL_HOST_ASSET_NAME_PREFIX))
        .map((row) => ({ id: row.id, name: row.name }));
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
      await lifecycle?.ensureAwake(run.address);
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

      const sent = await sendFoldedMail(foldedRunsDeps, {
        tenantId: input.tenantId,
        sessionId,
        agentAddress: run.address,
        from,
        domain,
        content: input.content.content,
        ...(attachments !== undefined ? { attachments } : {}),
        ...(input.content.replyTo !== undefined
          ? { replyTo: input.content.replyTo }
          : {}),
        cryptoProvider,
      });

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
      return listFoldedMail(foldedRunsDeps, {
        tenantId: input.tenantId,
        sessionId,
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      });
    },

    async fetchBlob(_channelId, blobId): Promise<string | Uint8Array> {
      const match = /^blob_(.+?)_(\d[\d.]*)$/.exec(blobId);
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

      void findFoldedRunById(deps.db, channelId).then((run) => {
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
  };
  return Object.assign(platform, {
    recordActivity: (address: string) => lifecycle?.recordActivity(address),
  });
}
