// What the room is told when the teammate it was talking to had to be
// replaced (see `agent-binding.ts` for why a relaunch mints a fresh run
// rather than resurrecting the dead one).
//
// A relaunch is invisible by construction: the run that died mid-turn
// never sends the `message.run.ended` event `chat-orchestrator.ts`'s
// turn-drop notice hangs off, so without this the reader's message was
// accepted and then silently swallowed. The notice closes that hole
// from the other side — it is posted by whoever performs the relaunch,
// whether the boot sweep found the dead run or the next send did.
//
// The port is a ref rather than a plain callback because the platform
// adapter is constructed before the room-message store it needs to
// post through; `apps/hub` arms it once both exist. Unarmed, every
// relaunch is silent — which is exactly the behavior before this
// existed, not a fallback beside a live path.

import { getLogger } from "@intx/log";
import { localPartOf } from "./agent-address";
import { parseParticipants } from "./participants";
import { postRoomMessage, type RoomMessageStore } from "./room-messages";
import type { ChatStore } from "./store";
import type { WorkbenchSubscriberRegistry } from "./workbench-events";

const log = getLogger(["chat", "relaunch-notice"]);

/** The relaunch a room is being told about. */
export type RelaunchNotice = {
  readonly tenantId: string;
  /** The stable participant address the room knows this agent by. */
  readonly roomAddress: string;
  readonly deadRunId: string;
  /** The dead run's own terminal `workflow_run.status`. */
  readonly deadRunStatus: string;
  readonly newRunId: string;
};

export type RelaunchNoticePort = {
  current?: (notice: RelaunchNotice) => void;
};

/**
 * The line the agent says in its own voice, in the reader's language
 * rather than the system's — never "run", "terminal", or "relaunch".
 * Cause-aware, because the three ways a turn can be lost read
 * differently to the person who was waiting on it: a crash cut the
 * answer off, a cancel stopped it, and anything else simply ended
 * before it was done.
 */
export function relaunchNoticeText(deadRunStatus: string): string {
  const cause =
    deadRunStatus === "failed"
      ? "I got cut off partway through that last one and never finished it."
      : deadRunStatus === "cancelled" || deadRunStatus === "canceled"
        ? "That last one was stopped before I finished it."
        : "I shut down before I finished that last one.";
  return `${cause} I'm back now — send it again and I'll pick it up.`;
}

/**
 * Posts each relaunch notice into every room the replaced participant
 * belongs to, in that participant's own voice and under the stable
 * address the room has always known it by — so the notice lands in the
 * same conversation thread as the message it is apologizing for, not
 * as a message from a stranger.
 *
 * Returns the synchronous port shape `createHubChatPlatform` calls:
 * a relaunch must never be held up (or undone) by a timeline write, so
 * a failed post is logged and the fresh run still goes on serving.
 */
export function createRelaunchNoticePoster(deps: {
  readonly store: Pick<ChatStore, "listWorkbenchSettings">;
  readonly roomMessages: RoomMessageStore;
  readonly publish: WorkbenchSubscriberRegistry["publish"];
}): (notice: RelaunchNotice) => void {
  async function post(notice: RelaunchNotice): Promise<void> {
    const workbenches = await deps.store.listWorkbenchSettings(notice.tenantId);
    const rooms = workbenches.filter((workbench) =>
      parseParticipants(workbench.settings["chat/participants"]).some(
        (participant) => participant.address === notice.roomAddress,
      ),
    );
    for (const room of rooms) {
      await postRoomMessage(deps, {
        tenantId: notice.tenantId,
        workbenchId: room.workbenchId,
        sender: { name: null, address: notice.roomAddress },
        parts: [
          { kind: "text", text: relaunchNoticeText(notice.deadRunStatus) },
        ],
        runId: localPartOf(notice.roomAddress),
      });
    }
  }

  return (notice) => {
    void post(notice).catch((cause: unknown) => {
      log.error`failed to post ${notice.roomAddress}'s relaunch notice (run ${notice.deadRunId} -> ${notice.newRunId}): ${
        cause instanceof Error ? cause.message : String(cause)
      }`;
    });
  };
}
