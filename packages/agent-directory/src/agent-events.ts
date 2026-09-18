// Recognizers for the sidecar `agent.event` frames `one-shot-prompt` keys
// off. These readers stay structural since the stream's payload arrives
// as `unknown`.

/** The reply text of a `connector.reply` event, or undefined for any
 * other event or an empty reply. */
export function connectorReplyContent(event: unknown): string | undefined {
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

export type MessageRunEnded = {
  readonly status: "completed" | "failed";
  readonly errorMessage: string | undefined;
};

/** A `message.run.ended` bracket close — the harness's own per-message
 * terminal signal (`status: "completed" | "failed"`) — or undefined for
 * any other event. */
export function messageRunEnded(event: unknown): MessageRunEnded | undefined {
  if (
    typeof event !== "object" ||
    event === null ||
    (event as { type?: unknown }).type !== "message.run.ended"
  ) {
    return undefined;
  }
  const data = (event as { data?: { status?: unknown; error?: { message?: unknown } } }).data;
  if (data?.status !== "completed" && data?.status !== "failed") {
    return undefined;
  }
  const errorMessage = typeof data.error?.message === "string" ? data.error.message : undefined;
  return { status: data.status, errorMessage };
}
