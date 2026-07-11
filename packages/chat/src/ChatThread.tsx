import { useEffect, useRef, type ReactNode } from "react";
import { cn, toHumanLabel } from "@workbench/ui";
import { type ChatMessage, type ChatActivity, type ToolCall } from "./types";
import { MessageBubble } from "./MessageBubble";
import { ActivityPulse, type ToolNarrativeProps } from "./ToolNarrative";
import { AgentTurn } from "./AgentTurn";
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
  isQuietTool?: (name: string) => boolean,
): string {
  switch (activity.type) {
    case "thinking":
      return `${agentName} is thinking`;
    case "tool_call":
    case "tool_running": {
      // Platform meta-tools stay quiet in the narrative — keep the pill generic
      // too so users never see "Myra is searching Workbench…" for plumbing.
      if (isQuietTool?.(activity.name) === true) {
        return `${agentName} is thinking`;
      }
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
  /** External integration tools get a bullet marker; internal tools render plain. */
  isExternalTool?: ToolNarrativeProps["isExternalTool"];
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
  isExternalTool,
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
  // One indicator covers the whole in-flight turn: a discrete activity labels
  // it precisely; plain typing falls back to a generic "thinking" line so a
  // running turn is never silent between activity events.
  const busy = hasActivity || typing === true;
  const busyLabel = hasActivity
    ? formatActivityLabel(
        activity,
        agentName ?? "Agent",
        formatToolName,
        isQuietTool,
      )
    : (typingLabel ??
      (agentName !== undefined ? `${agentName} is thinking` : "Thinking"));

  function renderMessage(message: ChatMessage): ReactNode {
    const isSettledAgent =
      message.role === "agent" && message.status !== "sending";
    const { cleanedText, urls } = isSettledAgent
      ? extractImageURLs(message.content)
      : { cleanedText: message.content, urls: [] };
    const displayMessage =
      urls.length > 0 ? { ...message, content: cleanedText } : message;

    if (message.role !== "agent") {
      return (
        <MessageBubble
          key={message.id}
          message={displayMessage}
          {...(onRespond !== undefined ? { onRespond } : {})}
          {...(onAction !== undefined ? { onAction } : {})}
          {...(resolveAttachmentUrl !== undefined
            ? { resolveAttachmentUrl }
            : {})}
        />
      );
    }

    const visibleToolCalls =
      hideToolCall === undefined
        ? message.toolCalls
        : message.toolCalls?.filter((c) => !hideToolCall(c));

    return (
      <AgentTurn
        key={message.id}
        message={displayMessage}
        {...(visibleToolCalls !== undefined ? { visibleToolCalls } : {})}
        trailing={urls.map((url) => (
          <UrlImageCard key={url} url={url} />
        ))}
        {...(formatToolSummary !== undefined ? { formatToolSummary } : {})}
        {...(formatToolResult !== undefined ? { formatToolResult } : {})}
        {...(compactToolActivity !== undefined ? { compactToolActivity } : {})}
        {...(summarizeToolCalls !== undefined ? { summarizeToolCalls } : {})}
        {...(isQuietTool !== undefined ? { isQuietTool } : {})}
        {...(isExternalTool !== undefined ? { isExternalTool } : {})}
        {...(onRespond !== undefined ? { onRespond } : {})}
        {...(onAction !== undefined ? { onAction } : {})}
        {...(onRate !== undefined ? { onRate } : {})}
        {...(getRating !== undefined ? { getRating } : {})}
        {...(resolveAttachmentUrl !== undefined
          ? { resolveAttachmentUrl }
          : {})}
      />
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
        // Inter-turn spacing only — visibly larger than any intra-turn gap
        // (AgentTurn owns those), so whitespace signals turn boundaries.
        "flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4",
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
      {busy && (
        <div
          className="flex items-start"
          aria-live="polite"
          data-testid="busy-indicator"
        >
          <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1.5 text-xs text-text-3">
            <ActivityPulse />
            {busyLabel}
          </span>
        </div>
      )}
    </div>
  );
}
