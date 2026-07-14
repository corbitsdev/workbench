import type { ReactNode } from "react";
import { cn } from "@workbench/ui";
import type { ChatMessage } from "./types";
import { MessageBubble } from "./MessageBubble";
import { ActivityBlock } from "./ActivityBlock";
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
  const hasReasoning = (message.reasoning ?? "").trim() !== "";
  const toolCalls = visibleToolCalls ?? message.toolCalls;
  const hasTools = toolCalls !== undefined && toolCalls.length > 0;
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
          reasoning={message.reasoning ?? ""}
          toolCalls={toolCalls ?? []}
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
