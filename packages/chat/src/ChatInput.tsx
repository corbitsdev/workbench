import { type KeyboardEvent, useLayoutEffect, useRef, useState } from 'react';
import { Button, cn } from '@workbench/ui';

export interface ChatInputProps {
  /** Fired with the trimmed draft when the user submits a non-empty message. */
  onSend: (text: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** When true the agent is processing; submission is blocked and a visual indicator is shown. */
  busy?: boolean;
  className?: string;
}

/**
 * A minimal stateless input bar. It owns only presentational draft state; the
 * committed message is handed to the host via `onSend`. No transport here.
 */
export function ChatInput({ onSend, placeholder, disabled, busy, className }: ChatInputProps) {
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isBlocked = disabled === true || busy === true;

  useLayoutEffect(() => {
    if (textareaRef.current === null) return;
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
  }, [draft]);

  const submit = () => {
    const text = draft.trim();
    if (text.length === 0 || isBlocked) return;
    onSend(text);
    setDraft('');
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className={cn('flex items-end gap-2 border-t border-border p-3', className)}>
      <textarea
        ref={textareaRef}
        aria-label="Message"
        rows={1}
        value={draft}
        disabled={isBlocked}
        placeholder={placeholder ?? 'Message Ada…'}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        className="max-h-32 min-h-[2.5rem] flex-1 resize-none overflow-x-hidden overflow-y-auto rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-orange disabled:opacity-50"
      />
      <Button
        type="button"
        size="sm"
        aria-label={busy === true ? 'Waiting for agent' : 'Send'}
        onClick={submit}
        disabled={isBlocked || draft.trim().length === 0}
        className={cn(busy === true && 'opacity-60')}
      >
        {busy === true ? (
          <span className="flex items-center gap-1" aria-hidden="true">
            <span className="block h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
            <span className="block h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
            <span className="block h-1.5 w-1.5 animate-bounce rounded-full bg-current" />
          </span>
        ) : (
          'Send'
        )}
      </Button>
    </div>
  );
}
