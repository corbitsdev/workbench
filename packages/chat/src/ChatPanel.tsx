import type React from "react";
import { cn } from "@workbench/ui";
import {
  type ChatAgentIdentity,
  type ChatDockState,
  type ChatMessage,
  type QuickReply,
  type ChatActivity,
} from "./types";
import {
  ChatThread,
  type ChatThreadProps,
  type ThreadInsert,
} from "./ChatThread";
import { QuickReplyChips } from "./QuickReplyChips";
import { ChatInput } from "./ChatInput";
import type { AttachmentPolicy, PendingAttachment } from "./attachments";
import type { UIBlock, UIResponse } from "@workbench/blocks";
import type { FeedbackSubjectKind } from "./feedback-types";

export interface ChatPanelProps {
  agent: ChatAgentIdentity;
  messages: ChatMessage[];
  /** Extra thread items (e.g. workflow-event bubbles) merged in by timestamp. */
  inserts?: ThreadInsert[];
  /** Committed message text (and any attachments) from the input bar. Host handles transport. */
  onSend: (
    text: string,
    attachments?: PendingAttachment[],
  ) => void | Promise<void>;
  typing?: boolean;
  /** What the agent is currently doing, shown as a contextual status label. */
  activity?: ChatActivity | null;
  quickReplies?: QuickReply[];
  onQuickReply?: (reply: QuickReply) => void;
  /** Current dock mode; controls header affordances only. */
  dockState?: ChatDockState;
  /** Toggle between floating and docked. */
  onToggleDock?: () => void;
  /** Whether the floating panel is expanded to near-full-screen. */
  expanded?: boolean;
  /** Toggle the floating panel between the small popup and near-full-screen. */
  onToggleExpand?: () => void;
  /** Close the panel (floating mode). */
  onClose?: () => void;
  inputDisabled?: boolean;
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
  /** Returns the server-fetched rating for a subject. Passed down to MessageFeedback. */
  getRating?: (
    subjectId: string,
    subjectKind: FeedbackSubjectKind,
  ) => 1 | -1 | null | undefined;
  /** Resolves a message attachment's blob to a displayable/downloadable URL. Attachments render only when provided. */
  resolveAttachmentUrl?: ChatThreadProps["resolveAttachmentUrl"];
  /** Hide individual tool calls from the narrative (e.g. an agent's private memory file ops). */
  hideToolCall?: ChatThreadProps["hideToolCall"];
  /** Host formatter turning a tool call into a friendly narrative summary line. */
  formatToolSummary?: ChatThreadProps["formatToolSummary"];
  /** Host formatter for settled tool outcomes (suppresses raw JSON dumps). */
  formatToolResult?: ChatThreadProps["formatToolResult"];
  /** Host formatter for the activity pill's tool name. */
  formatToolName?: ChatThreadProps["formatToolName"];
  /** When true, completed turns with many tool calls collapse to a summary line. */
  compactToolActivity?: ChatThreadProps["compactToolActivity"];
  /** Rolls a turn's tool calls into one summary line for the collapsed view. */
  summarizeToolCalls?: ChatThreadProps["summarizeToolCalls"];
  /** Platform-internal tools as quiet reasoning-style text (no tool chrome). */
  isQuietTool?: ChatThreadProps["isQuietTool"];
  className?: string;
  notice?: React.ReactNode;
  /**
   * Content for the left of the single header bar (e.g. a thread switcher). When
   * provided it replaces the default agent name/tagline block so the host can
   * collapse a separate switcher bar into this one header.
   */
  headerLeft?: React.ReactNode;
  /**
   * Run the composer edge-to-edge (left-aligned to the message column) instead
   * of the default centered, capped width. Set in the docked context so the
   * input's left edge aligns with the messages; left off for the wide full-page
   * and expanded surfaces where a centered prompt reads better.
   */
  composerFullWidth?: boolean;
  /** Rendered directly above the input (e.g. attached-context pills). */
  inputAccessory?: React.ReactNode;
  /** When present with a non-empty accepted set, enables file attachments in the composer. */
  attachmentPolicy?: AttachmentPolicy;
}

/**
 * The full chat surface: header, thread, optional quick-reply chips, input.
 * Stateless apart from the input's local draft. The host owns the message list
 * and all transport.
 */
export function ChatPanel({
  agent,
  messages,
  inserts,
  onSend,
  typing,
  activity,
  quickReplies,
  onQuickReply,
  dockState = "floating",
  onToggleDock,
  expanded,
  onToggleExpand,
  onClose,
  inputDisabled,
  onRespond,
  onAction,
  onRate,
  getRating,
  resolveAttachmentUrl,
  hideToolCall,
  formatToolSummary,
  formatToolResult,
  formatToolName,
  compactToolActivity,
  summarizeToolCalls,
  isQuietTool,
  className,
  notice,
  headerLeft,
  composerFullWidth,
  inputAccessory,
  attachmentPolicy,
}: ChatPanelProps) {
  const busy = typing === true || (activity !== undefined && activity !== null);

  return (
    <div
      className={cn(
        "flex h-full flex-col overflow-hidden bg-surface border-t-2 transition-colors",
        busy ? "border-orange" : "border-transparent",
        className,
      )}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2">
        <div className="min-w-0 flex-1">
          {headerLeft !== undefined ? (
            headerLeft
          ) : (
            <div className="flex flex-col">
              <span className="text-sm font-medium text-text">
                {agent.name}
              </span>
              {agent.tagline !== undefined && (
                <span className="text-xs text-text-3">{agent.tagline}</span>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onToggleExpand !== undefined && dockState !== "docked" && (
            <button
              type="button"
              onClick={onToggleExpand}
              aria-label={expanded === true ? "Collapse chat" : "Expand chat"}
              className="rounded-md px-2 py-1 text-xs text-text-2 hover:bg-surface-2 hover:text-text cursor-pointer"
            >
              {expanded === true ? "Collapse" : "Expand"}
            </button>
          )}
          {onToggleDock !== undefined && (
            <button
              type="button"
              onClick={onToggleDock}
              aria-label={dockState === "docked" ? "Float chat" : "Dock chat"}
              className="rounded-md px-2 py-1 text-xs text-text-2 hover:bg-surface-2 hover:text-text cursor-pointer"
            >
              {dockState === "docked" ? "Float" : "Dock"}
            </button>
          )}
          {onClose !== undefined && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close chat"
              className="rounded-md px-2 py-1 text-xs text-text-2 hover:bg-surface-2 hover:text-text cursor-pointer"
            >
              Close
            </button>
          )}
        </div>
      </header>

      {notice !== undefined && (
        <div
          role="status"
          aria-live="polite"
          className="shrink-0 border-b border-border px-4 py-3 text-[13px] text-text-2"
        >
          {notice}
        </div>
      )}

      <ChatThread
        messages={messages}
        {...(inserts !== undefined ? { inserts } : {})}
        {...(typing !== undefined ? { typing } : {})}
        {...(activity !== undefined ? { activity } : {})}
        agentName={agent.name}
        typingLabel={`${agent.name} is typing`}
        {...(onRespond !== undefined ? { onRespond } : {})}
        {...(onAction !== undefined ? { onAction } : {})}
        {...(onRate !== undefined ? { onRate } : {})}
        {...(getRating !== undefined ? { getRating } : {})}
        {...(resolveAttachmentUrl !== undefined
          ? { resolveAttachmentUrl }
          : {})}
        {...(hideToolCall !== undefined ? { hideToolCall } : {})}
        {...(formatToolSummary !== undefined ? { formatToolSummary } : {})}
        {...(formatToolResult !== undefined ? { formatToolResult } : {})}
        {...(formatToolName !== undefined ? { formatToolName } : {})}
        {...(compactToolActivity !== undefined ? { compactToolActivity } : {})}
        {...(summarizeToolCalls !== undefined ? { summarizeToolCalls } : {})}
        {...(isQuietTool !== undefined ? { isQuietTool } : {})}
      />

      {quickReplies !== undefined &&
        quickReplies.length > 0 &&
        onQuickReply !== undefined && (
          <div className="px-4 pb-2">
            <QuickReplyChips replies={quickReplies} onSelect={onQuickReply} />
          </div>
        )}

      {inputAccessory !== undefined && inputAccessory !== null && (
        <div className="px-4 pb-1">{inputAccessory}</div>
      )}

      <ChatInput
        onSend={onSend}
        placeholder={`Message ${agent.name}…`}
        busy={busy}
        {...(composerFullWidth === true ? { fullWidth: true } : {})}
        {...(inputDisabled !== undefined ? { disabled: inputDisabled } : {})}
        {...(attachmentPolicy !== undefined ? { attachmentPolicy } : {})}
      />
    </div>
  );
}
