import { useEffect, useRef, type ReactNode } from "react";
import { cn, toHumanLabel } from "@workbench/ui";
import { type ChatMessage, type ChatActivity, type ToolCall } from "./types";
import { MessageBubble } from "./MessageBubble";
import { ToolNarrative, type ToolNarrativeProps } from "./ToolNarrative";
import { TypingIndicator } from "./TypingIndicator";
import type { UIBlock, UIResponse } from "@workbench/blocks";
import type { FeedbackSubjectKind } from "./feedback-types";
import { extractImageURLs } from "./url-image";
import { UrlImageCard } from "./UrlImageCard";

function byTimestamp(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function lowerFirst(text: string): string {
  if (text.length === 0) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function formatActivityLabel(
  activity: ChatActivity,
  agentName: string,
  formatToolName?: (name: string) => string,
): string {
  switch (activity.type) {
    case "thinking":
      return `${agentName} is thinking`;
    case "tool_call":
    case "tool_running": {
      if (formatToolName !== undefined) {
        return `${agentName} is ${lowerFirst(formatToolName(activity.name))}`;
      }
      return `${agentName} is ${activity.type === "tool_call" ? "calling" : "running"} ${toHumanLabel(activity.name)}`;
    }
    case "rate_limited":
      return `${agentName} is rate-limited, retrying in ${Math.ceil(activity.retryAfterMs / 1000)}s`;
  }
}

/**
 * A host-supplied node interleaved into the thread by timestamp — e.g. a
 * run-addressed workflow-event bubble that is not part of the agent message
 * stream. Kept generic (no domain shape) so the chat package stays transport-
 * and domain-free; the host owns what `node` renders.
 */
export interface ThreadInsert {
  id: string;
  /** ISO instant used to order this insert against messages' `createdAt`. */
  at: string;
  node: ReactNode;
}

export interface ChatThreadProps {
  messages: ChatMessage[];
  /** Extra thread items (e.g. workflow events) merged in by timestamp. */
  inserts?: ThreadInsert[];
  /** Render a typing indicator after the last message when true. */
  typing?: boolean;
  /** What the agent is currently doing, shown as a contextual status label instead of the generic typing dots. */
  activity?: ChatActivity | null;
  /** Agent display name used for activity labels. */
  agentName?: string;
  typingLabel?: string;
  /** Shown when there are no messages yet. */
  emptyState?: React.ReactNode;
  /**
   * Optional formatter passed through to ToolNarrative. Supply this to turn
   * raw tool names into readable action phrases.
   */
  formatToolSummary?: ToolNarrativeProps["formatSummary"];
  /**
   * Optional formatter for settled tool outcomes. When set, ToolNarrative never
   * dumps raw JSON results — it shows the formatter's short human line instead.
   */
  formatToolResult?: ToolNarrativeProps["formatResult"];
  /**
   * Optional formatter for the activity pill's tool name (tool_call /
   * tool_running). When set, the pill reads e.g. "Myra is creating an Attio
   * record" instead of "Myra is calling Attio Create Record".
   */
  formatToolName?: (name: string) => string;
  /** When true, completed turns with many tool calls collapse to a summary line. */
  compactToolActivity?: ToolNarrativeProps["compact"];
  /** Rolls a turn's tool calls into one summary line for the collapsed view. */
  summarizeToolCalls?: ToolNarrativeProps["summarizeCalls"];
  /**
   * Platform-internal tools rendered as quiet reasoning-style text (no
   * checkmark / tool chrome) and excluded from the collapsed "N tools" count.
   */
  isQuietTool?: ToolNarrativeProps["isQuietTool"];
  /**
   * Predicate to hide individual tool calls from the narrative (the call still
   * runs; it is just not rendered). Used to abstract an agent's private
   * self-management — e.g. reads/writes of its own memory files.
   */
  hideToolCall?: (call: ToolCall) => boolean;
  /** Wired to send an interactive UI block's response back to the agent. */
  onRespond?: (response: UIResponse) => void;
  /** Wired to document UI block actions (copy / download / save-artifact). */
  onAction?: (
    action: "copy" | "download" | "save-artifact",
    block: UIBlock,
  ) => void;
  /** When provided, thumbs up/down buttons appear below settled agent messages. */
  onRate?: (
    subjectId: string,
    subjectKind: FeedbackSubjectKind,
    rating: 1 | -1,
  ) => Promise<void>;
  /** Returns the server-fetched rating for a subject. Passed to MessageBubble → MessageFeedback. */
  getRating?: (
    subjectId: string,
    subjectKind: FeedbackSubjectKind,
  ) => 1 | -1 | null | undefined;
  /** Resolves a message attachment's blob to a displayable/downloadable URL. */
  resolveAttachmentUrl?: (blobId: string) => Promise<string>;
  className?: string;
}

/** The scrollable list of message bubbles. */
export function ChatThread({
  messages,
  inserts,
  typing,
  activity,
  agentName,
  typingLabel,
  emptyState,
  formatToolSummary,
  formatToolResult,
  formatToolName,
  compactToolActivity,
  summarizeToolCalls,
  isQuietTool,
  hideToolCall,
  onRespond,
  onAction,
  onRate,
  getRating,
  resolveAttachmentUrl,
  className,
}: ChatThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  });

  const hasActivity = activity !== undefined && activity !== null;

  function renderMessage(message: ChatMessage): ReactNode {
    const isSettledAgent =
      message.role === "agent" && message.status !== "sending";
    const { cleanedText, urls } = isSettledAgent
      ? extractImageURLs(message.content)
      : { cleanedText: message.content, urls: [] };
    const displayMessage =
      urls.length > 0 ? { ...message, content: cleanedText } : message;

    return (
      <div key={message.id} className="flex flex-col gap-1.5">
        <MessageBubble
          message={displayMessage}
          {...(onRespond !== undefined ? { onRespond } : {})}
          {...(onAction !== undefined ? { onAction } : {})}
          {...(onRate !== undefined ? { onRate } : {})}
          {...(getRating !== undefined ? { getRating } : {})}
          {...(resolveAttachmentUrl !== undefined
            ? { resolveAttachmentUrl }
            : {})}
        />
        {urls.map((url) => (
          <UrlImageCard key={url} url={url} />
        ))}
        {message.role === "agent" &&
          (() => {
            const visibleToolCalls =
              hideToolCall === undefined
                ? message.toolCalls
                : message.toolCalls?.filter((c) => !hideToolCall(c));
            if (visibleToolCalls === undefined || visibleToolCalls.length === 0)
              return null;
            return (
              <ToolNarrative
                toolCalls={visibleToolCalls}
                {...(formatToolSummary !== undefined
                  ? { formatSummary: formatToolSummary }
                  : {})}
                {...(formatToolResult !== undefined
                  ? { formatResult: formatToolResult }
                  : {})}
                {...(compactToolActivity !== undefined
                  ? { compact: compactToolActivity }
                  : {})}
                {...(summarizeToolCalls !== undefined
                  ? { summarizeCalls: summarizeToolCalls }
                  : {})}
                {...(isQuietTool !== undefined ? { isQuietTool } : {})}
                {...(onRespond !== undefined ? { onRespond } : {})}
                {...(onAction !== undefined ? { onAction } : {})}
                className="pl-1"
              />
            );
          })()}
      </div>
    );
  }

  // Merge host inserts (e.g. workflow-event bubbles) into the message stream by
  // timestamp. A stable sort keeps same-timestamp order deterministic, so live
  // events land after the messages that preceded them without reordering the
  // conversation.
  const items: { key: string; at: string; node: ReactNode }[] = [
    ...messages.map((message) => ({
      key: `m:${message.id}`,
      at: message.createdAt,
      node: renderMessage(message),
    })),
    ...(inserts ?? []).map((insert) => ({
      key: `i:${insert.id}`,
      at: insert.at,
      node: insert.node,
    })),
  ];
  items.sort((a, b) => byTimestamp(a.at, b.at));

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinnedRef.current =
          el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
      }}
      role="log"
      aria-label="Chat messages"
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4",
        className,
      )}
    >
      {messages.length === 0 &&
        typing !== true &&
        !hasActivity &&
        (emptyState ?? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-text-3">
              Send a message to get started.
            </p>
          </div>
        ))}
      {items.map((item) => (
        <div key={item.key} className="contents">
          {item.node}
        </div>
      ))}
      {hasActivity && agentName !== undefined && (
        <div className="flex items-start" aria-live="polite">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1.5 text-xs text-text-3">
            <span className="block h-1.5 w-1.5 animate-pulse rounded-full bg-orange" />
            {formatActivityLabel(activity, agentName, formatToolName)}
          </span>
        </div>
      )}
      {typing === true && !hasActivity && (
        <TypingIndicator
          {...(typingLabel !== undefined ? { label: typingLabel } : {})}
        />
      )}
    </div>
  );
}
