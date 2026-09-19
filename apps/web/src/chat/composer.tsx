// No Stop action: neither `threads-api.ts` nor the hub API expose a way to
// cancel a running turn yet.
import { useCommandPaletteNavigation } from "@corbits/react-ui";
import { ArrowUp, CircleNotch } from "@/lib/icons";
import { useRef, useState } from "react";

import { activeMention, applyMention, matchMentionQuery, type ActiveMention } from "./mentions";

export type ComposerMention = {
  readonly id: string;
  readonly name: string;
  /** Shown beside the name in the popover when the roster carries one. */
  readonly detail?: string;
};

export function Composer({
  placeholder,
  busy,
  disabled,
  mentionables = [],
  onSend,
}: {
  readonly placeholder: string;
  readonly busy: boolean;
  readonly disabled?: boolean;
  /** Agents an `@` token can address; empty disables the popover. */
  readonly mentionables?: readonly ComposerMention[];
  readonly onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const [mention, setMention] = useState<ActiveMention | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const canSend = text.trim() !== "" && !busy && !disabled;
  const matches = mention === null ? [] : matchMentionQuery(mention.query, mentionables);
  const open = mention !== null && matches.length > 0;

  const send = () => {
    const trimmed = text.trim();
    if (trimmed === "" || busy || disabled) return;
    setText("");
    setMention(null);
    onSend(trimmed);
  };

  const choose = (id: string) => {
    const picked = mentionables.find((candidate) => candidate.id === id);
    const input = inputRef.current;
    if (picked === undefined || mention === null || input === null) return;
    const next = applyMention(text, mention, picked.name, input.selectionStart);
    setText(next.text);
    setMention(null);
    // The caret belongs after the inserted token, which React's re-render
    // would otherwise put at the end of the text.
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(next.caret, next.caret);
    });
  };

  const navigation = useCommandPaletteNavigation({
    items: matches.map((candidate) => ({ id: candidate.id })),
    onSelect: choose,
    onClose: () => setMention(null),
  });

  const syncMention = (input: HTMLTextAreaElement) => {
    if (mentionables.length === 0) return;
    setMention(activeMention(input.value, input.selectionStart) ?? null);
  };

  return (
    <div className="chat-composer">
      {open ? (
        <ul className="chat-composer-mentions" role="listbox" aria-label="Mention an agent">
          {matches.map((candidate) => (
            <li key={candidate.id}>
              <button
                type="button"
                role="option"
                aria-selected={navigation.activeId === candidate.id}
                data-active={navigation.activeId === candidate.id ? "" : undefined}
                onMouseEnter={() => navigation.setActiveId(candidate.id)}
                onMouseDown={(event) => {
                  // Keeps focus in the textarea so the caret fix-up lands.
                  event.preventDefault();
                  choose(candidate.id);
                }}
              >
                <span className="chat-composer-mention-name">{candidate.name}</span>
                {candidate.detail === undefined ? null : (
                  <span className="chat-composer-mention-detail">{candidate.detail}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        className="chat-composer-input"
        ref={inputRef}
        value={text}
        rows={3}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={disabled}
        onChange={(event) => {
          setText(event.target.value);
          syncMention(event.target);
        }}
        onClick={(event) => syncMention(event.currentTarget)}
        onBlur={() => setMention(null)}
        onKeyDown={(event) => {
          if (open && ["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key)) {
            event.preventDefault();
            navigation.onKeyDown(event);
            return;
          }
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            // The caret moves after this handler, so read it next tick.
            requestAnimationFrame(() => {
              if (inputRef.current !== null) syncMention(inputRef.current);
            });
            return;
          }
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
