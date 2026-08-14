/**
 * Waits for the channel host's next reply after a message is posted
 * into a bound channel, so it can be relayed back to Slack via
 * `TagThread.post`.
 *
 * Mirrors `connectorReplyContent` in `packages/chat/src/chat-orchestrator.ts`
 * exactly (that function is not exported — this is the same recognized
 * shape, re-checked here rather than duplicated by accident): the chat
 * platform's `subscribeToChannel` (see `packages/chat/src/platform-adapter.ts`)
 * wraps every sidecar event for the channel's agent as
 * `{ type: "chat.agent", data: event }`, and a reply is the
 * `"connector.reply"` event carrying `data.content`. Every other event
 * on the stream (tool calls, gate-blocked, etc.) is ignored here — this
 * is a reply *wait*, not a general event bridge.
 */
import type { ChatChannelEvent } from "@corbits/chat";

export type SubscribeToChannel = (
  channelId: string,
  onEvent: (event: ChatChannelEvent) => void,
) => () => void;

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

function replyTextFrom(channelEvent: ChatChannelEvent): string | undefined {
  if (channelEvent.type !== "chat.agent") return undefined;
  return connectorReplyContent(channelEvent.data);
}

/**
 * Resolves with the first reply text observed on `channelId` within
 * `timeoutMs`, or `undefined` on timeout — a timeout is not an error:
 * the agent may still reply later through the channel's own normal
 * delivery, this call only owns relaying a reply back to Slack
 * synchronously with the mention that triggered it.
 */
export function waitForReply(
  subscribe: SubscribeToChannel,
  channelId: string,
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(result);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    const unsubscribe = subscribe(channelId, (event) => {
      const text = replyTextFrom(event);
      if (text !== undefined) finish(text);
    });
  });
}
