import { useEffect, useRef } from 'react';
import { cn, toHumanLabel } from '@workbench/ui';
import { type ChatMessage, type ChatActivity } from './types';
import { MessageBubble } from './MessageBubble';
import { ToolNarrative, type ToolNarrativeProps } from './ToolNarrative';
import { TypingIndicator } from './TypingIndicator';
import type { UIBlock, UIResponse } from './ui-block';
import { extractImageURLs } from './url-image';
import { UrlImageCard } from './UrlImageCard';

function formatActivityLabel(activity: ChatActivity, agentName: string): string {
  switch (activity.type) {
    case 'thinking':
      return `${agentName} is thinking`;
    case 'tool_call':
      return `${agentName} is calling ${toHumanLabel(activity.name)}`;
    case 'tool_running':
      return `${agentName} is running ${toHumanLabel(activity.name)}`;
    case 'rate_limited':
      return `${agentName} is rate-limited, retrying in ${Math.ceil(activity.retryAfterMs / 1000)}s`;
  }
}

export interface ChatThreadProps {
  messages: ChatMessage[];
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
   * raw tool names and results into readable summary lines.
   */
  formatToolSummary?: ToolNarrativeProps['formatSummary'];
  /** Wired to send an interactive UI block's response back to the agent. */
  onRespond?: (response: UIResponse) => void;
  /** Wired to document UI block actions (copy / download / save-artifact). */
  onAction?: (action: 'copy' | 'download' | 'save-artifact', block: UIBlock) => void;
  className?: string;
}

/** The scrollable list of message bubbles. */
export function ChatThread({
  messages,
  typing,
  activity,
  agentName,
  typingLabel,
  emptyState,
  formatToolSummary,
  onRespond,
  onAction,
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

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinnedRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
      }}
      role="log"
      aria-label="Chat messages"
      className={cn('flex flex-1 flex-col gap-3 overflow-y-auto p-4', className)}
    >
      {messages.length === 0 &&
        typing !== true &&
        !hasActivity &&
        (emptyState ?? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-text-3">Send a message to get started.</p>
          </div>
        ))}
      {messages.map((message) => {
        const isSettledAgent = message.role === 'agent' && message.status !== 'sending';
        const { cleanedText, urls } = isSettledAgent
          ? extractImageURLs(message.content)
          : { cleanedText: message.content, urls: [] };
        const displayMessage = urls.length > 0 ? { ...message, content: cleanedText } : message;

        return (
          <div key={message.id} className="flex flex-col gap-1.5">
            <MessageBubble
              message={displayMessage}
              {...(onRespond !== undefined ? { onRespond } : {})}
              {...(onAction !== undefined ? { onAction } : {})}
            />
            {urls.map((url) => (
              <UrlImageCard key={url} url={url} />
            ))}
            {message.role === 'agent' &&
              message.toolCalls !== undefined &&
              message.toolCalls.length > 0 && (
                <ToolNarrative
                  toolCalls={message.toolCalls}
                  {...(formatToolSummary !== undefined ? { formatSummary: formatToolSummary } : {})}
                  {...(onRespond !== undefined ? { onRespond } : {})}
                  {...(onAction !== undefined ? { onAction } : {})}
                  className="pl-1"
                />
              )}
          </div>
        );
      })}
      {hasActivity && agentName !== undefined && (
        <div className="flex items-start" aria-live="polite">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1.5 text-xs text-text-3">
            <span className="block h-1.5 w-1.5 animate-pulse rounded-full bg-orange" />
            {formatActivityLabel(activity, agentName)}
          </span>
        </div>
      )}
      {typing === true && !hasActivity && (
        <TypingIndicator {...(typingLabel !== undefined ? { label: typingLabel } : {})} />
      )}
    </div>
  );
}
