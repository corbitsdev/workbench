// The one composer surface for a chat thread and a workbench workbench alike:
// Enter sends, Shift+Enter inserts a newline, and a right-hand action rail
// carries Send. There is no Stop action — neither `threads-api.ts` nor the
// hub API expose a way to cancel a running turn, so cancellation is not
// wired up here; add it to this rail once that capability exists upstream.
import { ArrowUp, CircleNotch } from "@/lib/icons";
import { useState } from "react";

export function Composer({
  placeholder,
  busy,
  disabled,
  onSend,
}: {
  readonly placeholder: string;
  readonly busy: boolean;
  readonly disabled?: boolean;
  readonly onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const canSend = text.trim() !== "" && !busy && !disabled;
  const send = () => {
    const trimmed = text.trim();
    if (trimmed === "" || busy || disabled) return;
    setText("");
    onSend(trimmed);
  };
  return (
    <div className="chat-composer">
      <textarea
        className="chat-composer-input"
        value={text}
        rows={3}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          // Auto-repeat fires the same keydown many times while a key is
          // held; without this guard that means many sends (plain Enter)
          // or many newlines (Shift+Enter) from one keystroke.
          if (event.repeat) {
            event.preventDefault();
            return;
          }
          if (!event.shiftKey) {
            event.preventDefault();
            send();
          }
        }}
      />
      <div className="chat-composer-rail">
        <button
          type="button"
          className="chat-composer-send"
          disabled={!canSend}
          onClick={send}
          aria-label={busy ? "Sending…" : "Send"}
          title={busy ? "Sending…" : "Send"}
        >
          {busy ? (
            <CircleNotch className="chat-composer-send-spinner" aria-hidden="true" />
          ) : (
            <ArrowUp aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}
