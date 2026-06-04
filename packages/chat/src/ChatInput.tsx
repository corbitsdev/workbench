import { type KeyboardEvent, useState } from 'react';
import { Button, cn } from '@workbench/ui';

export interface ChatInputProps {
  /** Fired with the trimmed draft when the user submits a non-empty message. */
  onSend: (text: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * A minimal stateless input bar. It owns only presentational draft state; the
 * committed message is handed to the host via `onSend`. No transport here.
 */
export function ChatInput({ onSend, placeholder, disabled, className }: ChatInputProps) {
  const [draft, setDraft] = useState('');

  const submit = () => {
    const text = draft.trim();
    if (text.length === 0 || disabled === true) return;
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
        aria-label="Message"
        rows={1}
        value={draft}
        disabled={disabled}
        placeholder={placeholder ?? 'Message Ada…'}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        className="max-h-32 min-h-[2.5rem] flex-1 resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-orange disabled:opacity-50"
      />
      <Button
        type="button"
        size="sm"
        onClick={submit}
        disabled={disabled === true || draft.trim().length === 0}
      >
        Send
      </Button>
    </div>
  );
}
