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
import { findFoldedRunByAddress } from "@corbits/folded-runs";
import type { ApprovalStore, DB } from "@intx/db";
import type { SidecarEventEmitter } from "@intx/hub-sessions";
import { getLogger } from "@intx/log";
import {
  artifactPartsForFinalizedTurn,
  type FinalizedTurnToolCall,
} from "./artifact-delivery";
import type { ApproveBlockData } from "./blocks";
import { encodeParts } from "./codec";
import { parseParticipants } from "./participants";
import type { ChatPlatform } from "./platform-port";
import type { ChatStore } from "./store";

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
};

export type ChatOrchestrator = {
  /** Unsubscribes from the event stream. The host's own process
   * lifetime is this orchestrator's natural lifetime, but tests need
   * to tear one down between cases. */
  dispose(): void;
};

function connectorReplyContent(event: unknown): string | undefined {
  if (
    typeof event !== "object" ||
    event === null ||
    (event as { type?: unknown }).type !== "connector.reply"
  ) {
    return undefined;
  }
  const content = (event as { data?: { content?: unknown } }).data?.content;
  return typeof content === "string" && content !== "" ? content : undefined;
}

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
  { tenantId: string; agentChannelId: string; channelIds: string[] } | undefined
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
    agentChannelId: run.id,
    channelIds: memberChannels.map((channel) => channel.channelId),
  };
}

async function postReply(
  deps: ChatOrchestratorDeps,
  agentAddress: string,
  content: string,
): Promise<void> {
  const resolved = await resolveMemberChannels(deps, agentAddress);
  if (resolved === undefined) return;

  for (const channelId of resolved.channelIds) {
    await deps.platform.sendMail({
      tenantId: resolved.tenantId,
      channelId,
      content: encodeParts([{ kind: "text", text: content }]),
      fromChannelId: resolved.agentChannelId,
    });
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
 */
async function postFinalizedTurnArtifacts(
  deps: ChatOrchestratorDeps,
  agentAddress: string,
  toolCalls: readonly FinalizedTurnToolCall[],
): Promise<void> {
  const parts = artifactPartsForFinalizedTurn(toolCalls);
  if (parts.length === 0) return;

  const resolved = await resolveMemberChannels(deps, agentAddress);
  if (resolved === undefined) return;

  for (const channelId of resolved.channelIds) {
    await deps.platform.sendMail({
      tenantId: resolved.tenantId,
      channelId,
      content: encodeParts([...parts]),
      fromChannelId: resolved.agentChannelId,
    });
  }
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
export function createArtifactDeliveryHandler(
  deps: ChatOrchestratorDeps,
): (
  agentAddress: string,
  turn: { toolCalls: FinalizedTurnToolCall[] },
) => void {
  return (agentAddress, turn) => {
    void postFinalizedTurnArtifacts(deps, agentAddress, turn.toolCalls).catch(
      (cause: unknown) => {
        log.error`chat orchestrator: failed to post ${agentAddress}'s finalized-turn artifacts: ${
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

  const unsubscribe = deps.events.on(
    "agent.event",
    ({ agentAddress, event }) => {
      // Any event at all counts as activity, not just `connector.reply`
      // below — an agent mid-inference must never be undeployed out
      // from under itself by the idle sweep just because it hasn't
      // replied yet.
      deps.recordActivity?.(agentAddress);

      const content = connectorReplyContent(event);
      if (content !== undefined) {
        void postReply(deps, agentAddress, content).catch((cause: unknown) => {
          log.error`chat orchestrator: failed to post ${agentAddress}'s reply: ${
            cause instanceof Error ? cause.message : String(cause)
          }`;
        });
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
