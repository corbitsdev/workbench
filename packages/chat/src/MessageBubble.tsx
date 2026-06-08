import { Streamdown } from 'streamdown';
import { cn } from '@workbench/ui';
import { type ChatMessage } from './types';

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

  const hasToolCalls = (message.toolCalls?.length ?? 0) > 0;

  // Suppress transitional LLM prose when tool calls are present — the
  // ToolNarrative rendered by ChatThread carries the signal for that turn.
  if (!message.content && message.status !== 'sending') return null;
  if (isUser === false && !isSystem && hasToolCalls) return null;

  return (
    <div
      data-role={message.role}
      className={cn('flex w-full flex-col gap-1', isUser ? 'items-end' : 'items-start')}
    >
      <div
        className={cn(
          'max-w-[80%] rounded-lg px-3 py-2 text-sm break-words',
          isUser && 'bg-orange text-white whitespace-pre-wrap',
          message.role === 'agent' && 'bg-surface-2 text-text',
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
      {message.status === 'failed' && (
        <span className="text-xs text-orange-soft">Failed to send</span>
      )}
    </div>
  );
}
