import { useEffect, useRef } from 'react';
import { cn } from '@workbench/ui';
import { type ChatMessage, type ChatActivity } from './types';
import { MessageBubble } from './MessageBubble';
import { TypingIndicator } from './TypingIndicator';

function formatActivityLabel(activity: ChatActivity, agentName: string): string {
  switch (activity.type) {
    case 'thinking':
      return `${agentName} is thinking`;
    case 'tool_call':
      return `${agentName} is calling ${activity.name}`;
    case 'tool_running':
      return `${agentName} is running ${activity.name}`;
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
      {messages.length === 0 && typing !== true && !hasActivity && emptyState}
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} />
      ))}
      {hasActivity && agentName !== undefined && (
        <div className="flex items-center gap-2 text-xs text-text-3" aria-live="polite">
          <span>{formatActivityLabel(activity, agentName)}</span>
        </div>
      )}
      {typing === true && !hasActivity && (
        <TypingIndicator {...(typingLabel !== undefined ? { label: typingLabel } : {})} />
      )}
    </div>
  );
}
