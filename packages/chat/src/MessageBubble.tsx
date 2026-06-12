import { Streamdown } from 'streamdown';
import { cn } from '@workbench/ui';
import { type ChatMessage } from './types';
import { ReasoningDisclosure } from './ReasoningDisclosure';
import { extractUIBlockFromText, type UIBlock, type UIResponse } from './ui-block';
import { UIBlockView } from './UIBlockView';

export interface MessageBubbleProps {
  message: ChatMessage;
  /** Forwarded to interactive UI blocks embedded in the agent's reply. */
  onRespond?: (response: UIResponse) => void;
  /** Forwarded to document UI blocks for copy / download / save-artifact. */
  onAction?: (action: 'copy' | 'download' | 'save-artifact', block: UIBlock) => void;
}

/**
 * A single chat bubble. User messages align right with the brand accent;
 * agent and system messages align left on a neutral surface.
 *
 * Agent and system messages are rendered as Markdown via Streamdown. When an
 * agent reply embeds a fenced ```ui block (the agent reformatting tool output
 * into generative UI), that block is lifted out and rendered through the
 * UIBlockView registry, with the surrounding prose still rendered as Markdown.
 * User messages are kept as plain text.
 */
export function MessageBubble({ message, onRespond, onAction }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isStreaming = message.status === 'sending';
  const hasReasoning = message.role === 'agent' && (message.reasoning ?? '').trim() !== '';

  // Nothing to show: no body, not streaming, and no reasoning to disclose.
  if (!message.content && message.status !== 'sending' && !hasReasoning) return null;

  // Only attempt block extraction on settled agent/system messages — a partial
  // stream may contain a half-written fence we should not try to parse yet.
  const extracted = !isUser && !isStreaming ? extractUIBlockFromText(message.content) : null;

  function renderBody() {
    if (isUser) return message.content;
    if (extracted !== null) {
      return (
        <div className="flex flex-col gap-2">
          {extracted.text !== '' && (
            <div className="chat-md">
              <Streamdown mode="static">{extracted.text}</Streamdown>
            </div>
          )}
          <UIBlockView
            block={extracted.block}
            {...(onRespond !== undefined ? { onRespond } : {})}
            {...(onAction !== undefined ? { onAction } : {})}
          />
        </div>
      );
    }
    return (
      <div className="chat-md">
        <Streamdown mode={isStreaming ? 'streaming' : 'static'}>{message.content}</Streamdown>
      </div>
    );
  }

  return (
    <div
      data-role={message.role}
      className={cn('flex w-full flex-col gap-2', isUser ? 'items-end' : 'items-start')}
    >
      {message.senderLabel !== undefined && message.senderLabel !== '' && (
        <span className="text-xs text-text-3">From: {message.senderLabel}</span>
      )}
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
          {renderBody()}
        </div>
      )}
      {message.status === 'failed' && (
        <span className="text-xs text-orange-soft">Failed to send</span>
      )}
    </div>
  );
}
