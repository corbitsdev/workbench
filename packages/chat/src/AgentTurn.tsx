import type { ReactNode } from "react";
import { cn } from "@workbench/ui";
import type { ChatMessage } from "./types";
import { MessageBubble } from "./MessageBubble";
import { ReasoningDisclosure } from "./ReasoningDisclosure";
import { ToolNarrative, type ToolNarrativeProps } from "./ToolNarrative";
import { MessageFeedback } from "./MessageFeedback";
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
}

/**
 * One agent turn, rendered with intentional hierarchy: the process trace
 * (reasoning, then tool activity, chronologically) sits above the answer;
 * rich trailing content follows; the feedback footer closes the turn. This
 * component owns all intra-turn spacing — ChatThread owns only the (larger)
 * inter-turn spacing.
 */
export function AgentTurn({
  message,
  trailing,
  visibleToolCalls,
  formatToolSummary,
  formatToolResult,
  compactToolActivity,
  summarizeToolCalls,
  isQuietTool,
  isExternalTool,
  renderToolMarker,
  onRespond,
  onAction,
  onRate,
  getRating,
  resolveAttachmentUrl,
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
      className="group flex w-full flex-col gap-2"
      data-role="agent"
      data-testid="agent-turn"
    >
      {senderLabel !== undefined && senderLabel !== "" && (
        <span className="text-xs text-text-3">From: {senderLabel}</span>
      )}
      {(hasReasoning || hasTools) && (
        <div
          className={cn("flex flex-col gap-2 pl-1")}
          data-testid="agent-trace"
        >
          {hasReasoning && (
            <ReasoningDisclosure
              reasoning={message.reasoning ?? ""}
              streaming={isStreaming && message.content === ""}
            />
          )}
          {hasTools && (
            <ToolNarrative
              toolCalls={toolCalls}
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
              {...(isExternalTool !== undefined ? { isExternalTool } : {})}
              {...(renderToolMarker !== undefined ? { renderToolMarker } : {})}
              {...(onRespond !== undefined ? { onRespond } : {})}
              {...(onAction !== undefined ? { onAction } : {})}
            />
          )}
        </div>
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
