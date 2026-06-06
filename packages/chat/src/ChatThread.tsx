import { useEffect, useRef } from 'react';
import { cn } from '@workbench/ui';
import { type ChatMessage } from './types';
import { MessageBubble } from './MessageBubble';
import { TypingIndicator } from './TypingIndicator';

export interface ChatThreadProps {
  messages: ChatMessage[];
  /** Render a typing indicator after the last message when true. */
  typing?: boolean;
  typingLabel?: string;
  /** Shown when there are no messages yet. */
  emptyState?: React.ReactNode;
  className?: string;
}

/** The scrollable list of message bubbles. */
export function ChatThread({
  messages,
  typing,
  typingLabel,
  emptyState,
  className,
}: ChatThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [messages.length, typing]);

  return (
    <div
      role="log"
      aria-label="Chat messages"
      className={cn('flex flex-1 flex-col gap-3 overflow-y-auto p-4', className)}
    >
      {messages.length === 0 && typing !== true && emptyState}
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} />
      ))}
      {typing === true && (
        <TypingIndicator {...(typingLabel !== undefined ? { label: typingLabel } : {})} />
      )}
      <div ref={bottomRef} />
    </div>
  );
}
