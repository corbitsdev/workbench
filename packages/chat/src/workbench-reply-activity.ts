import type { AgentTurnStore } from "./agent-turns";
import type { RoomMessageStore } from "./room-messages";

export type WorkbenchReplyActivity = "idle" | "working" | "reply-ready";

export async function listWorkbenchReplyActivity(input: {
  readonly tenantId: string;
  readonly workbenchIds: readonly string[];
  readonly readCursors: ReadonlyMap<string, string>;
  readonly agentTurns: AgentTurnStore | undefined;
  readonly roomMessages: RoomMessageStore;
}): Promise<ReadonlyMap<string, WorkbenchReplyActivity>> {
  const activity = new Map<string, WorkbenchReplyActivity>(
    input.workbenchIds.map((id) => [id, "idle"]),
  );
  if (input.agentTurns === undefined) return activity;
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
      activity.set(turn.workbenchId, "working");
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
      activity.set(turn.workbenchId, "reply-ready");
    }
  }
  return activity;
}
