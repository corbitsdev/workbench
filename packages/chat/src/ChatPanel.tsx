import type React from 'react';
import { cn } from '@workbench/ui';
import {
  type ChatAgentIdentity,
  type ChatDockState,
  type ChatMessage,
  type QuickReply,
  type ChatActivity,
} from './types';
import { ChatThread } from './ChatThread';
import { QuickReplyChips } from './QuickReplyChips';
import { ChatInput } from './ChatInput';
import type { UIBlock, UIResponse } from './ui-block';
import type { FeedbackSubjectKind } from './feedback-types';

export interface ChatPanelProps {
  agent: ChatAgentIdentity;
  messages: ChatMessage[];
  /** Committed message text from the input bar. Host handles transport. */
  onSend: (text: string) => void;
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
  onAction?: (action: 'copy' | 'download' | 'save-artifact', block: UIBlock) => void;
  /** When provided, thumbs up/down buttons appear below settled agent messages. */
  onRate?: (subjectId: string, subjectKind: FeedbackSubjectKind, rating: 1 | -1) => Promise<void>;
  /** Returns the server-fetched rating for a subject. Passed down to MessageFeedback. */
  getRating?: (subjectId: string, subjectKind: FeedbackSubjectKind) => 1 | -1 | null | undefined;
  className?: string;
  notice?: React.ReactNode;
}

/**
 * The full chat surface: header, thread, optional quick-reply chips, input.
 * Stateless apart from the input's local draft. The host owns the message list
 * and all transport.
 */
export function ChatPanel({
  agent,
  messages,
  onSend,
  typing,
  activity,
  quickReplies,
  onQuickReply,
  dockState = 'floating',
  onToggleDock,
  expanded,
  onToggleExpand,
  onClose,
  inputDisabled,
  onRespond,
  onAction,
  onRate,
  getRating,
  className,
  notice,
}: ChatPanelProps) {
  const busy = typing === true || (activity !== undefined && activity !== null);

  return (
    <div
      className={cn(
        'flex h-full flex-col overflow-hidden bg-surface border-t-2 transition-colors',
        busy ? 'border-orange' : 'border-transparent',
        className
      )}
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex flex-col">
          <span className="text-sm font-medium text-text">{agent.name}</span>
          {agent.tagline !== undefined && (
            <span className="text-xs text-text-3">{agent.tagline}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {onToggleExpand !== undefined && dockState !== 'docked' && (
            <button
              type="button"
              onClick={onToggleExpand}
              aria-label={expanded === true ? 'Collapse chat' : 'Expand chat'}
              className="rounded-md px-2 py-1 text-xs text-text-2 hover:bg-surface-2 hover:text-text cursor-pointer"
            >
              {expanded === true ? 'Collapse' : 'Expand'}
            </button>
          )}
          {onToggleDock !== undefined && (
            <button
              type="button"
              onClick={onToggleDock}
              aria-label={dockState === 'docked' ? 'Float chat' : 'Dock chat'}
              className="rounded-md px-2 py-1 text-xs text-text-2 hover:bg-surface-2 hover:text-text cursor-pointer"
            >
              {dockState === 'docked' ? 'Float' : 'Dock'}
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
        <div className="border-b border-border px-4 py-3 text-[13px] text-text-2">{notice}</div>
      )}

      <ChatThread
        messages={messages}
        {...(typing !== undefined ? { typing } : {})}
        {...(activity !== undefined ? { activity } : {})}
        agentName={agent.name}
        typingLabel={`${agent.name} is typing`}
        {...(onRespond !== undefined ? { onRespond } : {})}
        {...(onAction !== undefined ? { onAction } : {})}
        {...(onRate !== undefined ? { onRate } : {})}
        {...(getRating !== undefined ? { getRating } : {})}
      />

      {quickReplies !== undefined && quickReplies.length > 0 && onQuickReply !== undefined && (
        <div className="px-4 pb-2">
          <QuickReplyChips replies={quickReplies} onSelect={onQuickReply} />
        </div>
      )}

      <ChatInput
        onSend={onSend}
        placeholder={`Message ${agent.name}…`}
        busy={busy}
        {...(inputDisabled !== undefined ? { disabled: inputDisabled } : {})}
      />
    </div>
  );
}
