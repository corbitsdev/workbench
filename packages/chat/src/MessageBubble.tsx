import { useState } from 'react';
import { Streamdown } from 'streamdown';
import { cn } from '@workbench/ui';
import { type ChatMessage, type ChatImage } from './types';
import { ReasoningDisclosure } from './ReasoningDisclosure';
import { extractUIBlockFromText, type UIBlock, type UIResponse } from './ui-block';
import { UIBlockView } from './UIBlockView';
import { MessageFeedback } from './MessageFeedback';
import type { FeedbackSubjectKind } from './feedback-types';

export interface MessageBubbleProps {
  message: ChatMessage;
  /** Forwarded to interactive UI blocks embedded in the agent's reply. */
  onRespond?: (response: UIResponse) => void;
  /** Forwarded to document UI blocks for copy / download / save-artifact. */
  onAction?: (action: 'copy' | 'download' | 'save-artifact', block: UIBlock) => void;
  /**
   * When provided, a thumbs up/down row is shown below settled agent messages.
   * The host supplies the save function so the chat package stays transport-free.
   */
  onRate?: (subjectId: string, subjectKind: FeedbackSubjectKind, rating: 1 | -1) => Promise<void>;
  /** Returns the server-fetched rating for a subject, if one is available. */
  getRating?: (subjectId: string, subjectKind: FeedbackSubjectKind) => 1 | -1 | null | undefined;
}

/**
 * A single chat bubble. User messages align right in the brand-accent bubble;
 * agent messages render as plain full-width prose on the panel background (no
 * card), and system messages align left on a neutral surface.
 *
 * Agent and system messages are rendered as Markdown via Streamdown. When an
 * agent reply embeds a fenced ```ui block (the agent reformatting tool output
 * into generative UI), that block is lifted out and rendered through the
 * UIBlockView registry, with the surrounding prose still rendered as Markdown.
 * User messages are kept as plain text.
 */

function InlineImage({ image }: { image: ChatImage }) {
  const [failed, setFailed] = useState(false);
  const src = `data:${image.mimeType};base64,${image.data}`;

  if (failed) {
    return (
      <div className="flex items-center justify-center rounded-lg bg-zinc-700 px-4 py-3 text-xs text-zinc-400 mt-2 max-w-[600px]">
        Image unavailable
      </div>
    );
  }

  return (
    <img
      src={src}
      alt=""
      className="max-w-[600px] w-full rounded-lg mt-2"
      onError={() => setFailed(true)}
    />
  );
}

export function MessageBubble({
  message,
  onRespond,
  onAction,
  onRate,
  getRating,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isStreaming = message.status === 'sending';
  const hasReasoning = message.role === 'agent' && (message.reasoning ?? '').trim() !== '';
  const hasImages = message.images !== undefined && message.images.length > 0;
  // Trimmed so a turn that commits as only whitespace ("\n\n") is treated as
  // empty rather than rendering a blank bubble.
  const hasBody = message.content.trim() !== '';

  // Nothing to show: no body, not streaming, no reasoning, and no images.
  if (!hasBody && message.status !== 'sending' && !hasReasoning && !hasImages) return null;

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
      {(hasBody || (message.status === 'sending' && !hasReasoning)) && (
        <div
          className={cn(
            'text-sm break-words',
            message.role === 'agent' ? 'w-full text-text' : 'max-w-[80%] rounded-lg px-3 py-2',
            isUser && 'bg-orange text-white whitespace-pre-wrap',
            isSystem && 'bg-surface-2 text-text-3 italic'
          )}
        >
          {renderBody()}
        </div>
      )}
      {hasImages &&
        message.images!.map((image, index) => <InlineImage key={index} image={image} />)}
      {message.role === 'agent' && message.status !== 'sending' && onRate !== undefined && (
        <MessageFeedback
          subjectId={message.id}
          subjectKind="turn_part"
          savedRating={
            getRating !== undefined ? (getRating(message.id, 'turn_part') ?? null) : null
          }
          onRate={onRate}
        />
      )}
      {message.status === 'failed' && (
        <span className="text-xs text-orange-soft">Failed to send</span>
      )}
    </div>
  );
}
