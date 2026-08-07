// The message composer: a plain textarea (Enter sends, Shift+Enter breaks
// the line), disabled while empty, with an @-mention popover listing the
// active channel's agent participants. Kept local and simple rather than adopting the
// library's `ChatInput` — that component is built around the agent-chat
// `ChatMessage` model (working/stop, attachments) this surface does not use,
// and its send affordance does not compose with an inline mention popover.

import { Button } from "@corbits/react-ui";
import { Send } from "lucide-react";
import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import {
  activeMentionQuery,
  filterMentionCandidates,
  insertMention,
} from "./mentions";
import type { MentionCandidate, MentionQuery } from "./mentions";
import { CHAT_STRINGS } from "./strings";

/**
 * The B2 fix, isolated as a pure rule: a successful send clears the draft;
 * a failed one keeps exactly what the user had typed so nothing is lost.
 */
export function draftAfterSend(
  previousValue: string,
  succeeded: boolean,
): string {
  return succeeded ? "" : previousValue;
}

export function Composer({
  agents,
  onSend,
}: {
  readonly agents: readonly MentionCandidate[];
  /** Resolves to whether the send succeeded; the composer decides what to do with the draft from that. */
  readonly onSend: (text: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const candidates =
    mention !== null ? filterMentionCandidates(agents, mention.query) : [];

  function syncMentionState(text: string, caret: number) {
    const next = activeMentionQuery(text, caret);
    setMention(next);
    setHighlight(0);
  }

  function pickMention(candidate: MentionCandidate) {
    const textarea = textareaRef.current;
    if (mention === null || textarea === null) return;
    const caret = textarea.selectionStart;
    const result = insertMention(value, caret, mention, candidate.handle);
    setValue(result.text);
    setMention(null);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(result.caret, result.caret);
    });
  }

  async function send() {
    const trimmed = value.trim();
    if (trimmed.length === 0 || sending) return;
    setSending(true);
    setSendFailed(false);
    const succeeded = await onSend(trimmed);
    setSending(false);
    setValue((previous) => draftAfterSend(previous, succeeded));
    if (succeeded) {
      setMention(null);
    } else {
      setSendFailed(true);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mention !== null && candidates.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlight((index) => (index + 1) % candidates.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight(
          (index) => (index - 1 + candidates.length) % candidates.length,
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const chosen = candidates[highlight];
        if (chosen !== undefined) pickMention(chosen);
        return;
      }
      if (event.key === "Escape") {
        setMention(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <div className="chat-composer">
      {mention !== null && (
        <div className="chat-mention-popover" role="listbox">
          {candidates.length === 0 ? (
            <div className="chat-mention-empty">
              {CHAT_STRINGS.mentionEmpty}
            </div>
          ) : (
            candidates.map((candidate, index) => (
              <button
                key={candidate.id}
                type="button"
                role="option"
                aria-selected={index === highlight}
                className="chat-mention-option"
                data-highlighted={index === highlight}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pickMention(candidate);
                }}
              >
                <span className="chat-mention-handle">@{candidate.handle}</span>
                {candidate.label !== candidate.handle && (
                  <span className="chat-mention-label">{candidate.label}</span>
                )}
              </button>
            ))
          )}
        </div>
      )}
      <div className="chat-composer-row">
        <textarea
          ref={textareaRef}
          className="chat-composer-input"
          value={value}
          placeholder={CHAT_STRINGS.composerPlaceholder}
          onChange={(event) => {
            setValue(event.target.value);
            syncMentionState(
              event.target.value,
              event.target.selectionStart ?? event.target.value.length,
            );
          }}
          onKeyDown={handleKeyDown}
          rows={1}
        />
        <Button
          type="button"
          variant="primary"
          size="icon"
          disabled={value.trim().length === 0 || sending}
          onClick={() => void send()}
          aria-label={CHAT_STRINGS.composerSend}
        >
          <Send />
        </Button>
      </div>
      {sendFailed && (
        <div className="chat-composer-error" role="alert">
          {CHAT_STRINGS.sendFailedMessage}
        </div>
      )}
    </div>
  );
}
