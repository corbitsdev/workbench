import { Streamdown } from 'streamdown';
import { cn } from '@workbench/ui';
import { type ChatMessage } from './types';
import { ReasoningDisclosure } from './ReasoningDisclosure';

export interface MessageBubbleProps {
  message: ChatMessage;
}

/**
 * A single chat bubble. User messages align right with the brand accent;
 * agent and system messages align left on a neutral surface.
 *
 * Agent and system messages are rendered as Markdown via Streamdown so that
 * headings, lists, code blocks and inline formatting are handled correctly.
 * User messages are kept as plain text.
 */
export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isStreaming = message.status === 'sending';
  const hasReasoning = message.role === 'agent' && (message.reasoning ?? '').trim() !== '';

  // Nothing to show: no body, not streaming, and no reasoning to disclose.
  if (!message.content && message.status !== 'sending' && !hasReasoning) return null;

  return (
    <div
      data-role={message.role}
      className={cn('flex w-full flex-col gap-2', isUser ? 'items-end' : 'items-start')}
    >
      {hasReasoning && (
        <ReasoningDisclosure
          reasoning={message.reasoning ?? ''}
          streaming={isStreaming && message.content === ''}
        />
      )}
      {(message.content !== '' || (message.status === 'sending' && !hasReasoning)) && (
        <div
          className={cn(
            'max-w-[80%] rounded-lg px-3 py-2 text-sm break-words',
            isUser && 'bg-orange text-white whitespace-pre-wrap',
            message.role === 'agent' && 'border border-border bg-surface-2 text-text',
            isSystem && 'bg-surface-2 text-text-3 italic'
          )}
        >
          {isUser ? (
            message.content
          ) : (
            <div className="chat-md">
              <Streamdown mode={isStreaming ? 'streaming' : 'static'}>{message.content}</Streamdown>
            </div>
          )}
        </div>
      )}
      {message.status === 'failed' && (
        <span className="text-xs text-orange-soft">Failed to send</span>
      )}
    </div>
  );
}
