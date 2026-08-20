// Recognizers for the sidecar `agent.event` frames every folded-run
// observer keys off. Both process-wide orchestrators — `@corbits/chat`'s
// (replies into workbenches) and `@corbits/tasks`' (terminal results into
// the Inbox) — subscribe to the same stream and need the same two
// readings, so the parsing lives here, in the package both already
// build on, rather than duplicated in each: this module is about
// folded-run agents' events exactly as much as launch/wake/mail are
// about their lifecycle, and it depends on nothing but the event
// shapes (`@intx/types`' `AgentEvent` union documents them; these
// readers stay structural since the stream's payload arrives as
// `unknown`).

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

/** A `message.run.started` bracket open — the harness's own per-message
 * start signal, minted fresh (`messageRunId`) for every dequeued
 * message, including a redelivery of the same `messageId` — or
 * undefined for any other event. Chat's orchestrator uses this to
 * re-arm its silent-turn notice per turn rather than only on a real
 * reply (see `chat-orchestrator.ts`'s `notifiedDropAddresses`). */
export function messageRunStarted(event: unknown): boolean {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as { type?: unknown }).type === "message.run.started"
  );
}

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
  const data = (
    event as { data?: { status?: unknown; error?: { message?: unknown } } }
  ).data;
  if (data?.status !== "completed" && data?.status !== "failed") {
    return undefined;
  }
  const errorMessage =
    typeof data.error?.message === "string" ? data.error.message : undefined;
  return { status: data.status, errorMessage };
}
