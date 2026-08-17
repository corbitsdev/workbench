// Turns an invited agent's `connector.reply` events into channel
// messages, and a run's `reactor.gate.blocked` approval parks into an
// in-chat approve block — built once by the host and subscribed for the
// process's lifetime, mirroring `vendor/intx/hub-sessions/src/hub-session-orchestrator.ts`'s
// shape rather than the restart-race-prone per-agent bridge the reply
// side replaces (armed at invite, re-armed lazily on every channel read,
// re-armed again before every fan-out delivery — three places that
// could each miss a beat across a host restart).
//
// Subscribes once to `SidecarRouter.events`' `"agent.event"` stream —
// the single surface that carries every agent's events, `connector.reply`
// and `reactor.gate.blocked` included, regardless of which address
// emitted them (see `vendor/intx/hub-sessions/src/ws/sidecar-handler.ts`'s
// `"agent.event"` frame case, which both re-emits onto this stream and
// dispatches to per-address subscribers) — rather than a per-address
// `subscribeAgent` call per invited agent.
//
// The approve block itself carries only a platform-minted `approvalId`
// (see `./blocks.ts`'s `ApproveBlockData`) — this orchestrator never
// mints one, only reads the row the hub's own IPC register co-write
// already wrote (`ApprovalStore.findByCorrelationId`), matching the
// gen-UI design's "agents can never mint these" rule.
import { headlineFor } from "@corbits/approvals";
import {
  connectorReplyContent,
  findFoldedRunByAddress,
  messageRunEnded,
  messageRunStarted,
} from "@corbits/folded-runs";
import type { Memory } from "@corbits/memory";
import {
  persistedArtifactsForFinalizedTurn,
  type FinalizedTurnToolCall,
} from "@corbits/turn-artifacts";
import type { ApprovalStore, DB } from "@intx/db";
import type { SidecarEventEmitter } from "@intx/hub-sessions";
import { getLogger } from "@intx/log";
import {
  isClassifiedInferenceFailure,
  type ClassifiedInferenceFailureCategory,
  type ProviderHealthPort,
} from "@workbench/connections/provider-health";
import { artifactPartsForFinalizedTurn } from "./artifact-delivery";
import type { ApproveBlockData } from "./blocks";
import { encodeParts } from "./codec";
import type { ConnectedProviderLister } from "./inference-preferences";
import { mentionedParticipants } from "./mentions";
import { localPartOf } from "./agent-address";
import { parseParticipants, type ParticipantRecord } from "./participants";
import type { ChatPlatform } from "./platform-port";
import type { ChatStore } from "./store";
import type { ThreadStore } from "./threads";
import type { WriteClaimStore } from "./write-claims";

const log = getLogger(["chat", "orchestrator"]);

export type ChatOrchestratorDeps = {
  db: DB["db"];
  store: Pick<ChatStore, "listChannelSettings">;
  platform: Pick<ChatPlatform, "sendMail">;
  events: SidecarEventEmitter;
  /**
   * Resolves a gate-blocked event's `correlationId` to the approval row the
   * hub's IPC register co-write already wrote — the same read the "needs
   * you" list and the approve/reject routes key off. Only `findByCorrelationId`
   * is needed: this orchestrator never creates or resolves an approval, only
   * reads one to describe it in a channel message.
   */
  approvals: Pick<ApprovalStore, "findByCorrelationId">;
  /**
   * Bumps the idle-sleep lifecycle's activity clock for an address.
   * Absent when no lifecycle is configured, matching
   * `createHubChatPlatform`'s own opt-in shape — this orchestrator
   * never builds a lifecycle of its own.
   */
  recordActivity?: (address: string) => void;
  /**
   * The mounted memory plane's in-process handle (`apps/hub/src/memory-mount.ts`'s
   * `MemoryMountHandle.memory`) — undefined when the plane isn't mounted
   * (no `EMBED_BASE_URL`), matching that mount's own optional contract.
   * Two explicit, bounded call sites use it (CL-5852), never a generic
   * event bus: `postFinalizedTurnMemoryEntries` records one entry per
   * persisted artifact, and `postDailyTranscriptDigest` records at most
   * one entry per channel per UTC day. Both derive `tenantId`/`principalId`
   * from `resolveMemberChannels`' own resolved run scope, never from
   * anything a model supplied.
   */
  memory?: Pick<Memory, "add">;
  /**
   * Durable redelivery-dedup for the three finalized-turn write surfaces
   * below (CL-6039) — see `WriteClaimStore`'s own doc comment in
   * `./write-claims.ts`. Required (unlike `memory`, which is absent when
   * the plane isn't mounted): every one of those surfaces claims before
   * writing regardless of whether `memory` is configured, since
   * `postFinalizedTurnArtifacts` claims too and has no `memory`
   * dependency at all.
   */
  claims: WriteClaimStore;
  /**
   * Reports a classified runtime inference failure (CL-6092) — a
   * credential or quota error, never any other `InferenceError` category
   * — so `apps/hub` can surface it as a provider-health "needs attention"
   * signal. Absent when no health store is mounted, matching `memory`'s
   * own optional shape; every call site below is a no-op when this is
   * undefined. This orchestrator never marks a provider healthy — only a
   * passing credential re-test does that, and that write happens in
   * `@workbench/connections`'s own routes, not here.
   */
  providerHealth?: ProviderHealthPort;
  /**
   * The same `ConnectedProviderLister` `./inference-preferences.ts`'s
   * `createChannelHostInferencePreferencesResolver` takes — reused here
   * (rather than reaching for `deps.db` directly) so a test can inject a
   * plain in-memory list and so this file never grows its own
   * `@intx/db`-querying logic. Required alongside `providerHealth`: a
   * health port with no way to resolve which provider a turn used could
   * never conservatively attribute a failure to one.
   */
  listConnectedProviders?: ConnectedProviderLister;
  /**
   * Threads a delegated specialist's reply under the message that
   * delegated to it (CL-5879) — the same `openReplyThread`/`assignMessage`
   * pair `routes.ts`'s human-send path already uses. Absent when no
   * thread store is mounted, matching `memory`'s own optional shape: a
   * deploy that never wires threads keeps every reply on the root feed
   * exactly as before this landed.
   */
  threads?: Pick<ThreadStore, "openReplyThread" | "assignMessage">;
};

export type ChatOrchestrator = {
  /** Unsubscribes from the event stream. The host's own process
   * lifetime is this orchestrator's natural lifetime, but tests need
   * to tear one down between cases. */
  dispose(): void;
};

/**
 * A `reactor.gate.blocked` event whose gate is an approval ask, carrying the
 * correlation the hub's IPC register co-write keyed the approval row on.
 * Every other gate reason (`payment`, `credential`, `budget`,
 * `child_completion`, `message_response`) is not an in-chat approve card's
 * concern and is filtered out here. A missing `correlationId` means the
 * register co-write never ran (or hasn't landed yet) — nothing to look an
 * approval up by, so this is treated the same as "not an approval gate".
 */
function gateBlockedCorrelationId(event: unknown): string | undefined {
  if (
    typeof event !== "object" ||
    event === null ||
    (event as { type?: unknown }).type !== "reactor.gate.blocked"
  ) {
    return undefined;
  }
  const data = (
    event as { data?: { reason?: unknown; correlationId?: unknown } }
  ).data;
  if (data?.reason !== "approval") return undefined;
  return typeof data.correlationId === "string"
    ? data.correlationId
    : undefined;
}

/**
 * Resolves an agent address on the event stream to every chat channel it is
 * a member of, per the durable `channel_settings` store. Shared by every
 * poster below rather than assuming "exactly one channel": an agent is
 * invited to exactly one channel today by construction, but this resolves
 * defensively so a store that ever showed more than one still gets every
 * member channel, not a guess at "the" one.
 */
async function resolveMemberChannels(
  deps: ChatOrchestratorDeps,
  agentAddress: string,
): Promise<
  | {
      tenantId: string;
      /**
       * The run's own principal, when it has one — null for an
       * internal, workflow-spawned run (`workflow_run.principal_id` is
       * nullable by design). Memory-ingest call sites treat a null
       * principal as "nothing to attribute this to" and skip, rather
       * than guessing an owner.
       */
      principalId: string | null;
      agentChannelId: string;
      channelIds: string[];
      /**
       * Each member channel's own participant records, keyed by
       * channel id — `postReply` needs these to run the same
       * @mention fan-out human sends get, delegating the host's
       * reply to whichever specialists it @mentions.
       */
      participantsByChannelId: Map<string, ParticipantRecord[]>;
    }
  | undefined
> {
  const run = await findFoldedRunByAddress(deps.db, agentAddress);
  if (run === undefined) {
    // Not every agent address on the event stream belongs to a chat
    // channel (an echo instance, say) — an address this package's own
    // launch machinery never produced is silently not this
    // orchestrator's concern.
    return undefined;
  }

  const channels = await deps.store.listChannelSettings(run.tenantId);
  const memberChannels = channels.filter((channel) =>
    parseParticipants(channel.settings["chat/participants"]).some(
      (participant) => participant.address === agentAddress,
    ),
  );
  if (memberChannels.length === 0) return undefined;

  return {
    tenantId: run.tenantId,
    principalId: run.principalId,
    agentChannelId: run.id,
    channelIds: memberChannels.map((channel) => channel.channelId),
    participantsByChannelId: new Map(
      memberChannels.map((channel) => [
        channel.channelId,
        parseParticipants(channel.settings["chat/participants"]),
      ]),
    ),
  };
}

/**
 * The delegating message a mentioned specialist's *next* reply should
 * thread under (CL-5879) — set the moment `postReply`'s own mention
 * fan-out below wakes that specialist, read (and cleared) the moment
 * that specialist's own `postReply` call posts into the same channel.
 * Keyed by the specialist's run id (`localPartOf` its agent address,
 * the same id `resolveMemberChannels` calls `agentChannelId`): that id
 * is stable across the fan-out send and the specialist's own later
 * reply, unlike a channel id, which the specialist's reply shares with
 * the host's (see the module's own postReply doc below) but arrives
 * once per member channel rather than once per specialist.
 *
 * Only the specialist's first reply after being delegated to is
 * threaded — the entry is deleted on read, matching this package's
 * "thread machinery that already exists" scope for CL-5879 rather than
 * tracking an open-ended delegation session. A specialist mentioned
 * again gets a fresh entry from that later delegating message.
 */
type PendingDelegationThread = {
  readonly tenantId: string;
  readonly channelId: string;
  readonly messageId: string;
};

async function threadDelegatedReply(
  deps: ChatOrchestratorDeps,
  pendingDelegationThreads: Map<string, PendingDelegationThread>,
  agentAddress: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  if (deps.threads === undefined) return;
  const runId = localPartOf(agentAddress);
  const pending = pendingDelegationThreads.get(runId);
  if (pending === undefined || pending.channelId !== channelId) return;
  pendingDelegationThreads.delete(runId);

  const reply = await deps.threads.openReplyThread({
    tenantId: pending.tenantId,
    channelId: pending.channelId,
    parentMessageId: pending.messageId,
  });
  await deps.threads.assignMessage({
    tenantId: pending.tenantId,
    channelId: pending.channelId,
    threadId: reply.id,
    messageId,
  });
}

async function postReply(
  deps: ChatOrchestratorDeps,
  pendingDelegationThreads: Map<string, PendingDelegationThread>,
  agentAddress: string,
  content: string,
): Promise<void> {
  const resolved = await resolveMemberChannels(deps, agentAddress);
  if (resolved === undefined) return;

  for (const channelId of resolved.channelIds) {
    const sent = await deps.platform.sendMail({
      tenantId: resolved.tenantId,
      channelId,
      content: encodeParts([{ kind: "text", text: content }]),
      fromChannelId: resolved.agentChannelId,
    });

    await threadDelegatedReply(
      deps,
      pendingDelegationThreads,
      agentAddress,
      channelId,
      sent.id,
    );

    // The delegation hop: when the host's reply @mentions other agent
    // teammates, they must receive it exactly as they would a human's
    // @mention — otherwise a handoff only reaches the human side of
    // the channel and the mentioned specialist never wakes up.
    const participants =
      resolved.participantsByChannelId.get(channelId) ?? [];
    const mentioned = mentionedParticipants(
      [{ kind: "text", text: content }],
      participants,
    ).filter(
      (address) => localPartOf(address) !== localPartOf(agentAddress),
    );
    for (const recipient of mentioned) {
      await deps.platform.sendMail({
        tenantId: resolved.tenantId,
        channelId: localPartOf(recipient),
        content: encodeParts([{ kind: "text", text: content }], {
          replyTo: channelId,
        }),
        fromChannelId: channelId,
      });
      // The delegating host's own replies stay in main (never
      // recorded here for its own address) — only the mentioned
      // specialist's *next* reply threads, under this exact message.
      pendingDelegationThreads.set(localPartOf(recipient), {
        tenantId: resolved.tenantId,
        channelId,
        messageId: sent.id,
      });
    }
  }
}

/**
 * Posts the platform-minted approve block for a gate-blocked run into every
 * channel the parked agent is a member of. `postedApprovalIds` is the
 * process-local idempotency guard against a redelivered `agent.event`
 * (sidecar reconnect, wire-layer replay — see the module header): a second
 * delivery for an approval already carded is a no-op, and an approval this
 * process has never carded but that resolved before the event was handled
 * (a race with `POST .../resolve`, or a *very* stale replay) is a no-op
 * too, since a card for an already-resolved approval would render terminal
 * state a human never got to act on — nothing to add to the channel.
 */
async function postApproveBlock(
  deps: ChatOrchestratorDeps,
  agentAddress: string,
  correlationId: string,
  postedApprovalIds: Set<string>,
): Promise<void> {
  const approval = await deps.approvals.findByCorrelationId(correlationId);
  if (approval === null || approval.status !== "pending") return;
  if (postedApprovalIds.has(approval.id)) return;
  // Marked before the awaits below: two redelivered events racing this
  // function must not both pass the guard while the first resolves
  // channels.
  postedApprovalIds.add(approval.id);

  const resolved = await resolveMemberChannels(deps, agentAddress);
  if (resolved === undefined) return;

  const data: ApproveBlockData = {
    approvalId: approval.id,
    title: headlineFor(approval.toolDefinition, approval.toolArguments),
  };
  const content = encodeParts([
    { kind: "block", block: { type: "approve", data } },
  ]);

  for (const channelId of resolved.channelIds) {
    await deps.platform.sendMail({
      tenantId: resolved.tenantId,
      channelId,
      content,
      fromChannelId: resolved.agentChannelId,
    });
  }
}

/**
 * Posts a finalized turn's persisted-artifact tool-call results as chat
 * `FilePart`s (CL-6000) — the delivery-side half of the sanctioned
 * workflow-artifact path: a finalize tool persists via the
 * workflow-artifacts HTTP surface and returns the artifact's id/title/kind
 * in its result; this turns that into the file chip the channel sees.
 * A turn whose tool calls name no persisted artifact sends nothing.
 *
 * Claims `(tenantId, "artifact", "${turnId}:${channelId}")` in the durable
 * `finalized_turn_write_claim` table (CL-6039) before each channel's
 * send, one claim per channel rather than one for the whole turn: a
 * claim means "won the right to attempt this send", not "this send
 * succeeded", so a send that throws releases its own claim (in the
 * `catch` below) before this function's own log-and-drop catch in
 * `createArtifactDeliveryHandler` runs — a redelivery then retries only
 * the channel that never got its message, not every channel again. A
 * turn-wide claim would have made that choice for us: the first channel
 * to succeed would have no way to keep its claim while a later channel's
 * failure released the whole turn's, so a redelivery would either skip
 * an already-delivered channel forever (claim never released) or resend
 * to it (claim released) — this per-channel key sidesteps that
 * trade-off entirely, at the cost of nothing this loop wasn't already
 * paying (one channel-scoped `sendMail` call).
 */
async function postFinalizedTurnArtifacts(
  deps: ChatOrchestratorDeps,
  agentAddress: string,
  turnId: string,
  toolCalls: readonly FinalizedTurnToolCall[],
): Promise<void> {
  const parts = artifactPartsForFinalizedTurn(toolCalls);
  if (parts.length === 0) return;

  const resolved = await resolveMemberChannels(deps, agentAddress);
  if (resolved === undefined) return;

  for (const channelId of resolved.channelIds) {
    const claim = {
      tenantId: resolved.tenantId,
      surface: "artifact" as const,
      claimKey: `${turnId}:${channelId}`,
    };
    const claimed = await deps.claims.tryClaim(claim);
    if (!claimed) continue;

    try {
      await deps.platform.sendMail({
        tenantId: resolved.tenantId,
        channelId,
        content: encodeParts([...parts]),
        fromChannelId: resolved.agentChannelId,
      });
    } catch (error) {
      await deps.claims.release(claim);
      throw error;
    }
  }
}

/**
 * Records one firm-memory entry per persisted artifact a finalized turn's
 * tool calls named (CL-5852 M3a) — the same recognized shape
 * `postFinalizedTurnArtifacts` above turns into file-part chips, reused
 * here rather than re-parsed. Writes through the in-process plane handle
 * (`deps.memory`), never the plane's tenant-session HTTP routes: this
 * runs in the hub process, which already holds the handle `mountMemory`
 * returned. A no-op when `deps.memory` is absent (plane not mounted) or
 * the run has no principal to attribute the entry to — this never
 * guesses an owner. The entry records only the artifact's own
 * (id, title, kind) facts, never anything a model separately claimed.
 *
 * Claims `(tenantId, "memory", "${turnId}:${artifact.id}")` in the
 * durable `finalized_turn_write_claim` table (CL-6039) before each
 * artifact's `memory.add`, one claim per artifact rather than one for
 * the whole turn — same reasoning as `postFinalizedTurnArtifacts`'s
 * per-channel claim: a claim means "won the right to attempt this add",
 * not "this add succeeded", so an add that throws releases its own
 * claim (in the `catch` below) before this function's own log-and-drop
 * catch in `createArtifactDeliveryHandler` runs. A turn-wide claim would
 * force a choice between losing an already-recorded artifact forever
 * (claim never released after a later artifact's failure) or
 * re-recording it (claim released for the whole turn) on redelivery;
 * per-artifact keys give exactly-once per artifact with neither.
 */
async function postFinalizedTurnMemoryEntries(
  deps: ChatOrchestratorDeps,
  agentAddress: string,
  turnId: string,
  toolCalls: readonly FinalizedTurnToolCall[],
): Promise<void> {
  if (deps.memory === undefined) return;
  const artifacts = persistedArtifactsForFinalizedTurn(toolCalls);
  if (artifacts.length === 0) return;

  const resolved = await resolveMemberChannels(deps, agentAddress);
  if (resolved === undefined || resolved.principalId === null) return;

  for (const artifact of artifacts) {
    const claim = {
      tenantId: resolved.tenantId,
      surface: "memory" as const,
      claimKey: `${turnId}:${artifact.id}`,
    };
    const claimed = await deps.claims.tryClaim(claim);
    if (!claimed) continue;

    try {
      await deps.memory.add({
        tenantId: resolved.tenantId,
        principalId: resolved.principalId,
        kind: "artifact",
        content: {
          title: artifact.title,
          text: `Library artifact "${artifact.title}" (${artifact.kind}) was created.`,
        },
        attributes: { artifactId: artifact.id },
      });
    } catch (error) {
      await deps.claims.release(claim);
      throw error;
    }
  }
}

/**
 * Bounded daily-channel-digest transcript ingestion (CL-5852 M3b): at
 * most one firm-memory entry per channel per UTC day, recording that
 * day's first reply as an honest, lightweight digest of channel
 * activity — never a fabricated summary. Chosen over an "on thread
 * completion" trigger because this repo's single-step conversational
 * workflows (`workflows/assistant`) keep one warm agent address across
 * an entire channel's lifetime (see that package's header comment): a
 * "thread" never observably completes here, so there is no cheap event
 * to hook without inventing one. A once-per-channel-per-day bound is
 * the cheapest trigger already implied by an existing, honest concept
 * (`workflows/channel-digest`) rather than a new event bus. The bound is
 * enforced by claiming `(tenantId, "digest", "${channelId}:${date}")` in
 * the same durable `finalized_turn_write_claim` table the two posters
 * above claim into (CL-6039) — folded in from a process-local `Set` that
 * reset on restart (and so could double-ingest a day's first reply after
 * every restart) into the one durable claim table every finalized-turn
 * write surface now shares. Already one claim per channel-day (there was
 * never a turn-wide version of this bound to narrow), but still needs
 * the same release-on-failure `postFinalizedTurnMemoryEntries` uses: an
 * add that throws releases its own claim before the caller's log-and-drop
 * catch runs, so a channel whose digest add failed gets a real retry on
 * the next reply rather than staying claimed with no digest ever
 * written.
 */
async function postDailyTranscriptDigest(
  deps: ChatOrchestratorDeps,
  agentAddress: string,
  content: string,
): Promise<void> {
  if (deps.memory === undefined) return;

  const resolved = await resolveMemberChannels(deps, agentAddress);
  if (resolved === undefined || resolved.principalId === null) return;

  const today = new Date().toISOString().slice(0, 10);
  for (const channelId of resolved.channelIds) {
    const claim = {
      tenantId: resolved.tenantId,
      surface: "digest" as const,
      claimKey: `${channelId}:${today}`,
    };
    const claimed = await deps.claims.tryClaim(claim);
    if (!claimed) continue;

    try {
      await deps.memory.add({
        tenantId: resolved.tenantId,
        principalId: resolved.principalId,
        kind: "transcript-digest",
        content: {
          title: `Channel digest — ${today}`,
          text: content,
        },
        attributes: { channelId },
      });
    } catch (error) {
      await deps.claims.release(claim);
      throw error;
    }
  }
}

/**
 * Picks the first classified (`credential_failure`/`quota_exhausted`)
 * error out of a turn's `errors`, narrowed to `ClassifiedInferenceFailureCategory`
 * — a plain `Array.prototype.find` call can't narrow a field nested inside
 * the element it tests, so this loop does the narrowing `isClassifiedInferenceFailure`
 * already proves, once, in one place.
 */
function firstClassifiedError(
  errors: readonly { category: string; message: string }[],
): { category: ClassifiedInferenceFailureCategory } | undefined {
  for (const error of errors) {
    if (isClassifiedInferenceFailure(error.category)) {
      return { category: error.category };
    }
  }
  return undefined;
}

/**
 * Reports a finalized turn's classified inference failure — if it has
 * one — to `deps.providerHealth` (CL-6092). Fires on the *first*
 * `credential_failure`/`quota_exhausted` error a turn accumulated (see
 * `isClassifiedInferenceFailure`); every other category (`retryable`,
 * `context_overflow`, `fatal`, `aborted`, `timeout`,
 * `protocol_mismatch`) is an ordinary error this never reports on — a
 * turn with, say, only a `retryable` error is indistinguishable from one
 * with none at all here. Reports the error's `category` alone, never its
 * `message` — a provider's own error prose is never durable-stored, only
 * read back to a browser-facing route later (see `provider-health.ts`'s
 * own header for why).
 *
 * A turn's `errors` carry a category and message, never which provider
 * served the turn (`vendor/intx/hub-sessions/src/event-collector.ts`'s
 * `TurnFinalized` has no provider field). This resolves the provider the
 * same way a channel host's own inference preferences are derived
 * (`deps.listConnectedProviders`) and only reports when the tenant has
 * exactly one connected provider — with more than one connected, this
 * never guesses which one the turn actually used, matching the
 * "conservative classification" rule: silence, not a wrong attribution.
 *
 * That "exactly one connected provider" read happens here, at finalize
 * time — not at the moment the turn actually ran. A tenant that
 * disconnects a second provider between the turn running and this read
 * (or connects a new one) can, in that narrow window, have this attribute
 * the failure to a provider that never served the turn. Accepted as the
 * cheapest correct-enough behavior for a UI nudge, not an audit trail;
 * `postProviderHealthSignal` still never guesses across more than one
 * *currently* connected provider, which is the property that actually
 * matters here.
 */
async function postProviderHealthSignal(
  deps: ChatOrchestratorDeps,
  agentAddress: string,
  errors: readonly { category: string; message: string }[],
): Promise<void> {
  if (deps.providerHealth === undefined) return;
  if (deps.listConnectedProviders === undefined) return;
  const classified = firstClassifiedError(errors);
  if (classified === undefined) return;

  const resolved = await resolveMemberChannels(deps, agentAddress);
  if (resolved === undefined) return;

  const connected = await deps.listConnectedProviders(resolved.tenantId);
  if (connected.length !== 1) return;
  const [provider] = connected;
  if (provider === undefined) return;

  deps.providerHealth.reportInferenceFailure({
    tenantId: resolved.tenantId,
    provider,
    category: classified.category,
  });
}

/**
 * Builds the `onTurnFinalized` callback `createEventCollectorRegistry`
 * accepts (`(agentAddress, turn) => void`, see
 * `vendor/intx/hub-sessions/src/event-collector-registry.ts`). Kept as a
 * plain function of `ChatOrchestratorDeps` rather than folded into
 * `createChatOrchestrator` itself: the two subscribe to different event
 * sources (the `SidecarEventEmitter`'s live `agent.event` stream vs. the
 * event-collector registry's once-per-turn finalize callback) and the
 * host wires them separately.
 */
export function createArtifactDeliveryHandler(deps: ChatOrchestratorDeps): (
  agentAddress: string,
  turn: {
    turnId: string;
    toolCalls: FinalizedTurnToolCall[];
    // Non-optional: `TurnFinalized.errors` upstream
    // (`vendor/intx/hub-sessions/src/event-collector.ts`) is always an
    // array, even when empty — never absent — so this type stays
    // non-optional too rather than widening it into a shape the real
    // caller never produces.
    errors: readonly { category: string; message: string }[];
  },
) => void {
  return (agentAddress, turn) => {
    void postFinalizedTurnArtifacts(
      deps,
      agentAddress,
      turn.turnId,
      turn.toolCalls,
    ).catch((cause: unknown) => {
      log.error`chat orchestrator: failed to post ${agentAddress}'s finalized-turn artifacts: ${
        cause instanceof Error ? cause.message : String(cause)
      }`;
    });
    void postFinalizedTurnMemoryEntries(
      deps,
      agentAddress,
      turn.turnId,
      turn.toolCalls,
    ).catch((cause: unknown) => {
      log.error`chat orchestrator: failed to record ${agentAddress}'s finalized-turn memory entries: ${
        cause instanceof Error ? cause.message : String(cause)
      }`;
    });
    void postProviderHealthSignal(deps, agentAddress, turn.errors).catch(
      (cause: unknown) => {
        log.error`chat orchestrator: failed to report ${agentAddress}'s provider health signal: ${
          cause instanceof Error ? cause.message : String(cause)
        }`;
      },
    );
  };
}

export function createChatOrchestrator(
  deps: ChatOrchestratorDeps,
): ChatOrchestrator {
  // Process-lifetime idempotency guard for `postApproveBlock` — see its own
  // doc comment for what this does and doesn't cover.
  const postedApprovalIds = new Set<string>();

  // Every address with a `connector.reply` pending delivery for its
  // current turn — added the moment reply content is seen, cleared the
  // moment that turn's own `message.run.ended` bracket closes (see
  // below). Mirrors `@corbits/tasks`' `orchestrator.ts` `lastReplyByAddress`
  // bookkeeping, keyed the same way (per address, not per message —
  // this stream carries no messageId to correlate on more precisely),
  // but chat only needs a presence bit, never the reply text itself.
  const repliedAddresses = new Set<string>();

  // Process-lifetime idempotency guard for the turn-drop notice below,
  // keyed the same coarse way as `repliedAddresses` (this stream carries
  // no turnId to key a redelivered `message.run.ended` on more
  // precisely): set the moment a notice is posted for an address's
  // silent turn, cleared the moment that address's next `connector.reply`
  // arrives OR the next `message.run.started` opens so a genuinely new
  // turn is never suppressed by a stale entry. The `message.run.started`
  // clear matters independently of a reply landing: two turns in a row
  // can each end with zero `connector.reply` (an inference turn that
  // produced no text is not rare under load — see the notice's own
  // wording below), and without re-arming on every turn's OPEN, the
  // second silent turn's own notice would be swallowed by the guard
  // still set from the first, leaving the user staring at a thread that
  // looks permanently dead with no trace anywhere it ever tried again.
  const notifiedDropAddresses = new Set<string>();

  // See `PendingDelegationThread`'s own doc comment above `postReply`.
  const pendingDelegationThreads = new Map<string, PendingDelegationThread>();

  const unsubscribe = deps.events.on(
    "agent.event",
    ({ agentAddress, event }) => {
      // Any event at all counts as activity, not just `connector.reply`
      // below — an agent mid-inference must never be undeployed out
      // from under itself by the idle sweep just because it hasn't
      // replied yet.
      deps.recordActivity?.(agentAddress);

      if (messageRunStarted(event)) {
        notifiedDropAddresses.delete(agentAddress);
        return;
      }

      const content = connectorReplyContent(event);
      if (content !== undefined) {
        repliedAddresses.add(agentAddress);
        notifiedDropAddresses.delete(agentAddress);
        void postReply(
          deps,
          pendingDelegationThreads,
          agentAddress,
          content,
        ).catch((cause: unknown) => {
          log.error`chat orchestrator: failed to post ${agentAddress}'s reply: ${
            cause instanceof Error ? cause.message : String(cause)
          }`;
        });
        void postDailyTranscriptDigest(deps, agentAddress, content).catch(
          (cause: unknown) => {
            log.error`chat orchestrator: failed to record ${agentAddress}'s daily transcript digest: ${
              cause instanceof Error ? cause.message : String(cause)
            }`;
          },
        );
        return;
      }

      // A turn that ends with no `connector.reply` this process ever
      // saw is otherwise invisible: nothing posts to any channel and
      // nothing logs, so an agent that silently produced zero visible
      // text (a first-turn tool call with no accompanying text, an
      // inference failure `default-director` doesn't fold into a
      // reportable reply) reads to a human as "the room stayed empty"
      // with no trace anywhere. This is exactly the shape CL-6126's
      // kickoff-triggered greeting can fail in on a real, working
      // credential (CL-6137) — the kickoff's own `sendMail` already
      // logs loudly when *dispatch* itself fails
      // (`dispatchGreetingKickoff` in `channel-service.ts`), but had no
      // counterpart for "dispatched fine, the turn ran, nothing ever
      // came back out." Beyond the error log, an honest notice now goes
      // into the channel itself — a human staring at a stalled thread
      // during saturated inference (stress round 3) must never see
      // nothing at all — guarded by `notifiedDropAddresses` so a
      // redelivered `message.run.ended` (sidecar reconnect, wire-layer
      // replay) posts the notice once, not once per delivery.
      const ended = messageRunEnded(event);
      if (ended !== undefined) {
        const hadReply = repliedAddresses.delete(agentAddress);
        if (!hadReply) {
          const errorMessage = ended.errorMessage ?? "no error reported";
          log.error`chat orchestrator: agent ${agentAddress}'s turn ended (${ended.status}) with no reply ever posted to any channel: ${errorMessage}`;

          if (!notifiedDropAddresses.has(agentAddress)) {
            notifiedDropAddresses.add(agentAddress);
            const noticeContent =
              ended.status === "failed"
                ? errorMessage
                : "I didn't manage to answer that one — say it again and I'll pick it up.";
            void postReply(
              deps,
              pendingDelegationThreads,
              agentAddress,
              noticeContent,
            ).catch(
              (cause: unknown) => {
                log.error`chat orchestrator: failed to post ${agentAddress}'s turn-drop notice: ${
                  cause instanceof Error ? cause.message : String(cause)
                }`;
              },
            );
          }
        }
        return;
      }

      const correlationId = gateBlockedCorrelationId(event);
      if (correlationId === undefined) return;

      void postApproveBlock(
        deps,
        agentAddress,
        correlationId,
        postedApprovalIds,
      ).catch((cause: unknown) => {
        log.error`chat orchestrator: failed to post ${agentAddress}'s approve block: ${
          cause instanceof Error ? cause.message : String(cause)
        }`;
      });
    },
  );

  return {
    dispose() {
      unsubscribe();
    },
  };
}
