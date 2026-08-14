// Turns an invited agent's `connector.reply` events into channel
// messages — built once by the host and subscribed for the process's
// lifetime, mirroring `vendor/intx/hub-sessions/src/hub-session-orchestrator.ts`'s
// shape rather than the restart-race-prone per-agent bridge it
// replaces (armed at invite, re-armed lazily on every channel read,
// re-armed again before every fan-out delivery — three places that
// could each miss a beat across a host restart).
//
// Subscribes once to `SidecarRouter.events`' `"agent.event"` stream —
// the single surface that carries every agent's events, `connector.reply`
// included, regardless of which address emitted them (see
// `vendor/intx/hub-sessions/src/ws/sidecar-handler.ts`'s `"agent.event"`
// frame case, which both re-emits onto this stream and dispatches to
// per-address subscribers) — rather than a per-address
// `subscribeAgent` call per invited agent.
import { findFoldedRunByAddress } from "@corbits/folded-runs";
import type { DB } from "@intx/db";
import type { SidecarEventEmitter } from "@intx/hub-sessions";
import { getLogger } from "@intx/log";
import {
  artifactPartsForFinalizedTurn,
  type FinalizedTurnToolCall,
} from "./artifact-delivery";
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
 * Resolves an agent address to its folded run and every channel it is a
 * member of. Shared by `postReply` and `postFinalizedTurnArtifacts`, both
 * of which need "who is this address, and which channel(s) does its
 * reply belong in" before they differ on what content to send.
 */
async function resolveDeliveryTarget(
  deps: Pick<ChatOrchestratorDeps, "db" | "store">,
  agentAddress: string,
): Promise<
  | { run: { id: string; tenantId: string }; channelIds: readonly string[] }
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
  // An agent is invited to exactly one channel today by construction,
  // but this resolves defensively off the durable store rather than
  // assuming it: if more than one channel's participants carry this
  // address, deliver into each rather than guessing which one is "the"
  // channel.
  const memberChannels = channels.filter((channel) =>
    parseParticipants(channel.settings["chat/participants"]).some(
      (participant) => participant.address === agentAddress,
    ),
  );
  if (memberChannels.length === 0) return undefined;

  return {
    run,
    channelIds: memberChannels.map((channel) => channel.channelId),
  };
}

async function postReply(
  deps: ChatOrchestratorDeps,
  agentAddress: string,
  content: string,
): Promise<void> {
  const target = await resolveDeliveryTarget(deps, agentAddress);
  if (target === undefined) return;

  for (const channelId of target.channelIds) {
    await deps.platform.sendMail({
      tenantId: target.run.tenantId,
      channelId,
      content: encodeParts([{ kind: "text", text: content }]),
      fromChannelId: target.run.id,
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

  const target = await resolveDeliveryTarget(deps, agentAddress);
  if (target === undefined) return;

  for (const channelId of target.channelIds) {
    await deps.platform.sendMail({
      tenantId: target.run.tenantId,
      channelId,
      content: encodeParts([...parts]),
      fromChannelId: target.run.id,
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
  const unsubscribe = deps.events.on(
    "agent.event",
    ({ agentAddress, event }) => {
      // Any event at all counts as activity, not just `connector.reply`
      // below — an agent mid-inference must never be undeployed out
      // from under itself by the idle sweep just because it hasn't
      // replied yet.
      deps.recordActivity?.(agentAddress);

      const content = connectorReplyContent(event);
      if (content === undefined) return;

      void postReply(deps, agentAddress, content).catch((cause: unknown) => {
        log.error`chat orchestrator: failed to post ${agentAddress}'s reply: ${
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
