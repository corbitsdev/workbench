import type { AgentTurnStore } from "./agent-turns";
import type { RoomMessageStore } from "./room-messages";

export type WorkbenchLiveState = "idle" | "working" | "reply-ready";

export async function listWorkbenchLiveState(input: {
  readonly tenantId: string;
  readonly workbenchIds: readonly string[];
  readonly readCursors: ReadonlyMap<string, string>;
  readonly agentTurns: AgentTurnStore | undefined;
  readonly roomMessages: RoomMessageStore;
}): Promise<ReadonlyMap<string, WorkbenchLiveState>> {
  const live = new Map<string, WorkbenchLiveState>(
    input.workbenchIds.map((id) => [id, "idle"]),
  );
  if (input.agentTurns === undefined) return live;
  const turns = await input.agentTurns.listWorkbenchTurns(input);
  const replies = await input.roomMessages.getMessages({
    tenantId: input.tenantId,
    messageIds: turns.flatMap((turn) =>
      turn.status === "completed" && turn.replyMessageId !== null
        ? [turn.replyMessageId]
        : [],
    ),
  });
  const byId = new Map(replies.map((reply) => [reply.id, reply]));
  for (const turn of turns) {
    if (turn.status === "running") {
      live.set(turn.workbenchId, "working");
      continue;
    }
    if (turn.status !== "completed" || turn.replyMessageId === null) continue;
    const reply = byId.get(turn.replyMessageId);
    const cursor = input.readCursors.get(turn.workbenchId);
    if (
      reply !== undefined &&
      reply.workbenchId === turn.workbenchId &&
      reply.senderPrincipalId === null &&
      reply.sender.address === turn.agentAddress &&
      (cursor === undefined || reply.createdAt > cursor)
    ) {
      live.set(turn.workbenchId, "reply-ready");
    }
  }
  return live;
}
