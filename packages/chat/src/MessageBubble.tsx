import { cn } from '@workbench/ui';
import { type ChatMessage } from './types';

export interface MessageBubbleProps {
  message: ChatMessage;
}

/**
 * A single chat bubble. User messages align right with the brand accent;
 * agent and system messages align left on a neutral surface.
 */
export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  return (
    <div
      data-role={message.role}
      className={cn('flex w-full', isUser ? 'justify-end' : 'justify-start')}
    >
      <div
        className={cn(
          'max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words',
          isUser && 'bg-orange text-white',
          message.role === 'agent' && 'bg-surface-2 text-text',
          isSystem && 'bg-surface-2 text-text-3 italic'
        )}
      >
        {message.content}
        {message.status === 'failed' && (
          <span className="mt-1 block text-xs text-orange-soft">Failed to send</span>
        )}
      </div>
    </div>
  );
}
