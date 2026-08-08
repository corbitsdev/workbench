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

async function postReply(
  deps: ChatOrchestratorDeps,
  agentAddress: string,
  content: string,
): Promise<void> {
  const run = await findFoldedRunByAddress(deps.db, agentAddress);
  if (run === undefined) {
    // Not every agent address on the event stream belongs to a chat
    // channel (an echo instance, say) — an address this package's own
    // launch machinery never produced is silently not this
    // orchestrator's concern.
    return;
  }
  const agentChannelId = run.id;

  const channels = await deps.store.listChannelSettings(run.tenantId);
  // An agent is invited to exactly one channel today by construction,
  // but this resolves defensively off the durable store rather than
  // assuming it: if more than one channel's participants carry this
  // address, post the reply into each rather than guessing which one
  // is "the" channel.
  const memberChannels = channels.filter((channel) =>
    parseParticipants(channel.settings["chat/participants"]).some(
      (participant) => participant.address === agentAddress,
    ),
  );
  if (memberChannels.length === 0) return;

  for (const channel of memberChannels) {
    await deps.platform.sendMail({
      tenantId: run.tenantId,
      channelId: channel.channelId,
      content: encodeParts([{ kind: "text", text: content }]),
      fromChannelId: agentChannelId,
    });
  }
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
