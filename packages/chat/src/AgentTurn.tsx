import type { ReactNode } from "react";
import { cn } from "@workbench/ui";
import type { ChatMessage, ToolCall } from "./types";
import { MessageBubble } from "./MessageBubble";
import { ActivityBlock } from "./ActivityBlock";
import { liftToParts, toolPartToCall } from "./parts";
import { type ToolNarrativeProps } from "./ToolNarrative";
import { MessageFeedback } from "./MessageFeedback";
import { CHAT_META_TEXT, CHAT_TURN_STACK } from "./messageRhythm";
import type { FeedbackSubjectKind } from "./feedback-types";
import type { UIBlock, UIResponse } from "@workbench/blocks";

export interface AgentTurnProps {
  message: ChatMessage;
  /** Extra nodes rendered between the answer and the feedback footer (e.g. url image cards). */
  trailing?: ReactNode;
  /** Tool calls to render, already filtered by the host's hide predicate. */
  visibleToolCalls?: ChatMessage["toolCalls"];
  /**
   * Predicate to hide individual tool calls from the rendered turn. Applied
   * to tool PARTS as well as flat tool calls — a parts-native streaming
   * message carries no `toolCalls` array, so `visibleToolCalls` alone cannot
   * cover it (a hidden tool would otherwise leak mid-stream).
   */
  hideToolCall?: (call: ToolCall) => boolean;
  formatToolSummary?: ToolNarrativeProps["formatSummary"];
  formatToolResult?: ToolNarrativeProps["formatResult"];
  /**
   * Accepted for host wiring compatibility. The single collapsible activity
   * block (CL-3637) subsumes the old per-turn compact roll-up, so this flag no
   * longer changes rendering.
   */
  compactToolActivity?: ToolNarrativeProps["compact"];
  summarizeToolCalls?: ToolNarrativeProps["summarizeCalls"];
  isQuietTool?: ToolNarrativeProps["isQuietTool"];
  isExternalTool?: ToolNarrativeProps["isExternalTool"];
  renderToolMarker?: ToolNarrativeProps["renderToolMarker"];
  onRespond?: (response: UIResponse) => void;
  onAction?: (
    action: "copy" | "download" | "save-artifact",
    block: UIBlock,
  ) => void;
  onRate?: (
    subjectId: string,
    subjectKind: FeedbackSubjectKind,
    rating: 1 | -1,
  ) => Promise<void>;
  getRating?: (
    subjectId: string,
    subjectKind: FeedbackSubjectKind,
  ) => 1 | -1 | null | undefined;
  resolveAttachmentUrl?: (blobId: string) => Promise<string>;
  isReasoningExpanded?: (messageKey: string) => boolean;
  setReasoningExpanded?: (messageKey: string, expanded: boolean) => void;
}

/**
 * One agent turn, rendered with intentional hierarchy: a single collapsible
 * activity block (reasoning + tool calls) sits above the answer; rich trailing
 * content follows; the feedback footer, anchored to the response, closes the
 * turn. This component owns all intra-turn spacing — ChatThread owns only the
 * (larger) inter-turn spacing.
 */
export function AgentTurn({
  message,
  trailing,
  visibleToolCalls,
  hideToolCall,
  formatToolSummary,
  formatToolResult,
  summarizeToolCalls,
  isQuietTool,
  isExternalTool,
  renderToolMarker,
  onRespond,
  onAction,
  onRate,
  getRating,
  resolveAttachmentUrl,
  isReasoningExpanded,
  setReasoningExpanded,
}: AgentTurnProps) {
  const isStreaming = message.status === "sending";
  // The single lift call site (CL-3679): a parts-native message is walked
  // directly, a flat/hydrated message is lifted at read time.
  const parts = message.parts ?? liftToParts(message);
  // `visibleToolCalls` is the host's hide-predicate-filtered flat tool list;
  // `hideToolCall` is the predicate itself, applied to tool PARTS directly —
  // required for parts-native streaming messages, which carry no `toolCalls`
  // array for the flat filter to act on.
  const visibleToolCallIds =
    visibleToolCalls !== undefined
      ? new Set(visibleToolCalls.map((call) => call.id))
      : null;
  const activityParts = parts.filter((part) => {
    if (part.type === "text" || part.type === "file") return false;
    if (part.type === "tool") {
      if (hideToolCall !== undefined && hideToolCall(toolPartToCall(part))) {
        return false;
      }
      if (visibleToolCallIds !== null) {
        return visibleToolCallIds.has(part.toolCallId);
      }
    }
    return true;
  });
  const hasReasoning = activityParts.some(
    (part) => part.type === "reasoning" && part.text.trim() !== "",
  );
  const hasTools = activityParts.some((part) => part.type === "tool");
  // The turn header owns the sender label; strip it from the nested bubble so
  // it renders exactly once.
  const { senderLabel, ...bubbleMessage } = message;

  return (
    <div
      className={cn("group", CHAT_TURN_STACK)}
      data-role="agent"
      data-testid="agent-turn"
    >
      {senderLabel !== undefined && senderLabel !== "" && (
        <span className={CHAT_META_TEXT}>From: {senderLabel}</span>
      )}
      {(hasReasoning || hasTools) && (
        <ActivityBlock
          parts={activityParts}
          streaming={isStreaming}
          messageKey={message.feedbackId ?? message.id}
          {...(isReasoningExpanded !== undefined
            ? { isExpanded: isReasoningExpanded }
            : {})}
          {...(setReasoningExpanded !== undefined
            ? { setExpanded: setReasoningExpanded }
            : {})}
          {...(formatToolSummary !== undefined
            ? { formatSummary: formatToolSummary }
            : {})}
          {...(formatToolResult !== undefined
            ? { formatResult: formatToolResult }
            : {})}
          {...(summarizeToolCalls !== undefined
            ? { summarizeCalls: summarizeToolCalls }
            : {})}
          {...(isQuietTool !== undefined ? { isQuietTool } : {})}
          {...(isExternalTool !== undefined ? { isExternalTool } : {})}
          {...(renderToolMarker !== undefined ? { renderToolMarker } : {})}
          {...(onRespond !== undefined ? { onRespond } : {})}
          {...(onAction !== undefined ? { onAction } : {})}
        />
      )}
      <MessageBubble
        message={bubbleMessage}
        {...(onRespond !== undefined ? { onRespond } : {})}
        {...(onAction !== undefined ? { onAction } : {})}
        {...(resolveAttachmentUrl !== undefined
          ? { resolveAttachmentUrl }
          : {})}
      />
      {trailing}
      {!isStreaming && onRate !== undefined && (
        <MessageFeedback
          subjectId={message.feedbackId ?? message.id}
          subjectKind="turn_part"
          savedRating={
            getRating !== undefined
              ? (getRating(message.feedbackId ?? message.id, "turn_part") ??
                null)
              : null
          }
          onRate={onRate}
        />
      )}
    </div>
  );
}
