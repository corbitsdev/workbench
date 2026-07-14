import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowUp,
  File as FileIcon,
  Mic,
  Paperclip,
  Plus,
  Square,
  X,
} from "lucide-react";
import { useComposerVoiceDictation } from "./composer-voice-dictation";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  cn,
  inputFieldClass,
} from "@workbench/ui";
import { formatMention } from "@workbench/shared";
import {
  formatBytes,
  validateFiles,
  type AttachmentPolicy,
  type PendingAttachment,
} from "./attachments";

/** One workspace member the `@` composer trigger can mention. */
export interface MentionCandidate {
  /** The member's bare user id (their `refId`); formatMention adds the `usr_` marker. */
  id: string;
  name: string;
}

// Matches an in-progress `@query` at the caret so the trigger only fires
// while typing a token, not on every `@` anywhere in the draft. No
// whitespace in the query keeps this from matching across word boundaries.
const MENTION_TRIGGER = /@([^\s@]*)$/;

/**
 * A draft submitted while a turn is in flight (CL-2988). Held here — not
 * dispatched — until the turn completes, then auto-sent in FIFO order. The
 * composer never blocks typing or attaching while a turn runs; only the
 * queued item's own send is deferred.
 */
interface QueuedMessage {
  id: string;
  text: string;
  attachments?: PendingAttachment[];
}

function filesFromClipboard(data: DataTransfer | null): File[] {
  if (data === null) return [];
  const fromList = Array.from(data.files);
  if (fromList.length > 0) return fromList;
  return Array.from(data.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

function findMentionQuery(
  text: string,
  caret: number,
): { query: string; start: number } | null {
  const upToCaret = text.slice(0, caret);
  const match = MENTION_TRIGGER.exec(upToCaret);
  if (match === null) return null;
  const query = match[1] ?? "";
  return { query, start: caret - query.length - 1 };
}

// Shared geometry for the composer's circular controls (+ trigger and send)
// so they stay the same size and sit on one axis with the textarea.
const CIRCLE_BUTTON =
  "flex h-10 w-10 shrink-0 items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-orange disabled:cursor-not-allowed cursor-pointer";

export interface ChatInputProps {
  /**
   * Fired with the trimmed draft (and any attachments) when the user submits.
   * May return a promise; while it is pending the composer stays populated so a
   * failed attachment send is recoverable.
   */
  onSend: (
    text: string,
    attachments?: PendingAttachment[],
  ) => void | Promise<void>;
  /**
   * Stops the agent's in-flight turn. While `busy` (and not disabled) the
   * send control becomes an enabled stop button that fires this; when it
   * returns a promise the button disables until the abort settles, and a
   * rejection surfaces as a composer error.
   */
  onAbort?: () => void | Promise<void>;
  placeholder?: string;
  /** Session-level hard block (e.g. loading/provisioning/fatal) — disables typing and attaching entirely. */
  disabled?: boolean;
  /**
   * When true the agent is processing a turn. The composer stays fully
   * editable (CL-2988): a submit while busy queues the draft instead of
   * dispatching it, and the queued message auto-sends once `busy` goes back
   * to false. A visual indicator (spinner / stop control) is still shown.
   */
  busy?: boolean;
  className?: string;
  /**
   * Enables file attachments when present with a non-empty accepted set. The
   * accepted MIME types are already narrowed to what the active agent's adapter
   * can consume (see @workbench/agents `attachmentCapabilityForAgent`).
   */
  attachmentPolicy?: AttachmentPolicy;
  /**
   * Run the input row edge-to-edge, left-aligned, instead of the default
   * centered, capped (`lg:max-w-[60vw]`) width. Used in the docked context so
   * the composer's left edge lines up with the message column.
   */
  fullWidth?: boolean;
  /**
   * Workspace members eligible for `@` mention autocomplete. Omitted or
   * empty disables the trigger entirely (no dropdown, `@` types literally).
   */
  mentionCandidates?: MentionCandidate[];
  /**
   * Enables microphone dictation with end-of-speech auto-send (Myra composer).
   * Hidden when the browser lacks speech recognition.
   */
  voiceInput?: boolean;
}

/**
 * A minimal input bar. It owns presentational draft + pending-attachment state;
 * the committed message and its attachments are handed to the host via
 * `onSend`. No transport here.
 */
export function ChatInput({
  onSend,
  onAbort,
  placeholder,
  disabled,
  busy,
  className,
  attachmentPolicy,
  fullWidth,
  mentionCandidates,
  voiceInput,
}: ChatInputProps) {
  const [draft, setDraft] = useState("");
  const draftRef = useRef("");
  draftRef.current = draft;
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [sending, setSending] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const wasBusyRef = useRef(busy === true);
  const [mentionState, setMentionState] = useState<{
    start: number;
    query: string;
    activeIndex: number;
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputId = useId();

  const mentionMatches = useMemo(() => {
    if (mentionState === null || mentionCandidates === undefined) return [];
    const query = mentionState.query.toLowerCase();
    return mentionCandidates
      .filter((m) => m.name.toLowerCase().includes(query))
      .slice(0, 6);
  }, [mentionState, mentionCandidates]);

  const mentionOpen =
    mentionState !== null &&
    mentionCandidates !== undefined &&
    mentionCandidates.length > 0 &&
    mentionMatches.length > 0;

  const insertMention = useCallback(
    (candidate: MentionCandidate) => {
      if (mentionState === null) return;
      const el = textareaRef.current;
      const caret = el?.selectionStart ?? draft.length;
      const before = draft.slice(0, mentionState.start);
      const after = draft.slice(caret);
      const token = `${formatMention(candidate.id, candidate.name)} `;
      const nextDraft = `${before}${token}${after}`;
      setDraft(nextDraft);
      setMentionState(null);
      requestAnimationFrame(() => {
        const nextCaret = before.length + token.length;
        el?.focus();
        el?.setSelectionRange(nextCaret, nextCaret);
      });
    },
    [draft, mentionState],
  );

  const syncMentionState = useCallback(
    (text: string, caret: number) => {
      if (mentionCandidates === undefined || mentionCandidates.length === 0) {
        setMentionState(null);
        return;
      }
      const found = findMentionQuery(text, caret);
      if (found === null) {
        setMentionState(null);
        return;
      }
      setMentionState({
        start: found.start,
        query: found.query,
        activeIndex: 0,
      });
    },
    [mentionCandidates],
  );

  // Only a genuinely unusable session (loading, provisioning, fatal, etc.)
  // blocks the textarea and attachment affordances. A turn in flight (`busy`)
  // no longer locks the composer (CL-2988) — the user keeps drafting and,
  // on submit, the draft is queued instead of dispatched (see `submit`).
  const hardBlocked = disabled === true;
  // Guards the actual dispatch: a session-level disable, or a prior
  // non-queued send whose promise has not yet settled.
  const isBlocked = hardBlocked || sending;
  const showBusy = busy === true || sending;
  // While the agent works, the send control becomes a stop control (only the
  // host-signalled `busy` counts — a local optimistic `sending` has nothing
  // server-side to stop yet).
  const showStop = busy === true && disabled !== true && onAbort !== undefined;
  const attachmentsEnabled =
    attachmentPolicy !== undefined &&
    attachmentPolicy.acceptedMimeTypes.length > 0;
  // Docked context lines the composer up with the message column; the wide
  // full-page/expanded surfaces keep the centered, capped prompt.
  const rowWidth =
    fullWidth === true ? "w-full" : "mx-auto w-full lg:max-w-[60vw]";

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = "auto";
    const vh = typeof window !== "undefined" ? window.innerHeight : 800;
    const maxHeight = Math.floor(vh * 0.3);
    const target = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${target}px`;
  }, []);

  useLayoutEffect(() => {
    adjustHeight();
  }, [draft, adjustHeight]);

  const addFiles = (files: File[]) => {
    if (attachmentPolicy === undefined || files.length === 0) return;
    const { accepted, errors: newErrors } = validateFiles(
      files,
      attachmentPolicy,
      pending,
    );
    if (accepted.length > 0) setPending((prev) => [...prev, ...accepted]);
    // Append rather than replace: a later valid add must not silently wipe an
    // earlier rejection the user has not acknowledged. Cleared on send.
    if (newErrors.length > 0) setErrors((prev) => [...prev, ...newErrors]);
  };

  const removePending = (id: string) => {
    setPending((prev) => prev.filter((a) => a.id !== id));
  };

  const clearComposer = () => {
    setDraft("");
    setPending([]);
    setErrors([]);
    setMentionState(null);
  };

  // Dispatches one message through the host's onSend, handling the
  // promise/void contract the same way whether it came straight from the
  // draft or was popped off the queue (CL-2988).
  const dispatch = useCallback(
    (text: string, attachments: PendingAttachment[] | undefined) => {
      const result = onSend(text, attachments);
      if (result instanceof Promise) {
        setSending(true);
        setErrors([]);
        result.then(
          () => {
            setSending(false);
            clearComposer();
          },
          (err: unknown) => {
            setSending(false);
            setErrors([
              err instanceof Error ? err.message : "Could not send. Try again.",
            ]);
          },
        );
        return;
      }
      clearComposer();
    },
    [onSend],
  );

  const submit = useCallback(() => {
    const text = draftRef.current.trim();
    if (disabled === true) return;
    if (text.length === 0 && pending.length === 0) return;
    const attachments = pending.length > 0 ? pending : undefined;
    // A turn is in flight: the composer stays editable, but the draft is
    // held and auto-sent once the turn completes (CL-2988) rather than
    // dispatched now — only double-submission of the same draft is guarded,
    // not typing/attaching while busy.
    if (busy === true) {
      const queued: QueuedMessage =
        attachments !== undefined
          ? { id: crypto.randomUUID(), text, attachments }
          : { id: crypto.randomUUID(), text };
      setQueue((prev) => [...prev, queued]);
      clearComposer();
      return;
    }
    if (sending) return;
    dispatch(text, attachments);
  }, [busy, dispatch, disabled, pending, sending]);

  // Auto-send the oldest queued message the moment the turn that was running
  // when it was queued completes (busy: true -> false). A queue built up
  // during one long turn drains one message per subsequent turn, which
  // matches the "at least one queued message" requirement; multiple queued
  // messages are amortized without ever double-dispatching. Held (not
  // auto-sent) if the composer is now hard-disabled — e.g. the session
  // itself went unusable — so the user must confirm from a working composer
  // rather than dispatching into a session that cannot accept it.
  useEffect(() => {
    const wasBusy = wasBusyRef.current;
    wasBusyRef.current = busy === true;
    if (!wasBusy || busy === true) return;
    if (disabled === true) return;
    setQueue((prev) => {
      if (prev.length === 0) return prev;
      const [next, ...rest] = prev;
      if (next === undefined) return prev;
      const result = onSend(next.text, next.attachments);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          setErrors((prevErrors) => [
            ...prevErrors,
            err instanceof Error
              ? err.message
              : "Could not send the queued message. Try again.",
          ]);
          // Never drop the text: put the failed queued message back so the
          // user can retry or edit it from the queue chip.
          setQueue((prevQueue) => [next, ...prevQueue]);
        });
      }
      return rest;
    });
  }, [busy, disabled, onSend]);

  const editQueued = useCallback((id: string) => {
    setQueue((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target === undefined) return prev;
      setDraft(target.text);
      setPending(target.attachments ?? []);
      return prev.filter((item) => item.id !== id);
    });
  }, []);

  const cancelQueued = useCallback((id: string) => {
    setQueue((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const voice = useComposerVoiceDictation({
    enabled: voiceInput === true,
    disabled: disabled === true,
    sendBlocked: isBlocked,
    getDraft: () => draftRef.current,
    setDraft,
    triggerSend: submit,
  });

  const handleAbort = () => {
    if (onAbort === undefined || aborting) return;
    const result = onAbort();
    if (!(result instanceof Promise)) return;
    setAborting(true);
    result.then(
      () => {
        setAborting(false);
      },
      (err: unknown) => {
        setAborting(false);
        setErrors((prev) => [
          ...prev,
          err instanceof Error && err.message.trim().length > 0
            ? err.message
            : "Couldn't stop. Try again.",
        ]);
      },
    );
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionState((prev) =>
          prev === null
            ? prev
            : {
                ...prev,
                activeIndex: (prev.activeIndex + 1) % mentionMatches.length,
              },
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionState((prev) =>
          prev === null
            ? prev
            : {
                ...prev,
                activeIndex:
                  (prev.activeIndex - 1 + mentionMatches.length) %
                  mentionMatches.length,
              },
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const candidate = mentionMatches[mentionState.activeIndex];
        if (candidate !== undefined) insertMention(candidate);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionState(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!attachmentsEnabled) return;
    event.preventDefault();
    setDragActive(false);
    addFiles(Array.from(event.dataTransfer.files));
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!attachmentsEnabled || hardBlocked) return;
    // Only light up for an actual file drag — dragging selected text or a link
    // must not promise a drop the composer will then silently ignore.
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    setDragActive(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    // dragLeave also fires when the pointer crosses into a child (textarea,
    // chips, send button). Only clear the ring on a true exit of the zone.
    if (event.currentTarget.contains(event.relatedTarget as Node | null))
      return;
    setDragActive(false);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!attachmentsEnabled || hardBlocked) {
      requestAnimationFrame(adjustHeight);
      return;
    }
    const files = filesFromClipboard(event.clipboardData);
    if (files.length === 0) {
      requestAnimationFrame(adjustHeight);
      return;
    }
    event.preventDefault();
    addFiles(files);
    requestAnimationFrame(adjustHeight);
  };

  return (
    <div
      className={cn(
        "shrink-0 border-t border-border/60 bg-page px-4 py-3 sm:px-7",
        dragActive && "ring-2 ring-inset ring-orange",
        className,
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {queue.length > 0 && (
        <div className={cn("mb-2 space-y-1.5", rowWidth)}>
          {queue.map((item) => (
            <QueuedMessageChip
              key={item.id}
              item={item}
              onEdit={() => editQueued(item.id)}
              onCancel={() => cancelQueued(item.id)}
            />
          ))}
        </div>
      )}

      {pending.length > 0 && (
        <div
          className={cn(
            "mb-2 flex max-h-28 flex-wrap gap-2 overflow-y-auto",
            rowWidth,
          )}
        >
          {pending.map((attachment) => (
            <AttachmentChip
              key={attachment.id}
              attachment={attachment}
              onRemove={() => removePending(attachment.id)}
            />
          ))}
        </div>
      )}

      {(errors.length > 0 || voice.error !== null) && (
        <div className={cn("mb-2 space-y-0.5", rowWidth)}>
          {errors.map((message, index) => (
            <p key={index} role="alert" className="text-xs text-red">
              {message}
            </p>
          ))}
          {voice.error !== null && (
            <p role="alert" className="text-xs text-red">
              {voice.error}
            </p>
          )}
        </div>
      )}

      {voice.supported && voice.phase !== "off" && (
        <div
          className={cn(
            "mb-2 flex items-center justify-between gap-2 text-xs text-text-2",
            rowWidth,
          )}
          data-testid="composer-voice-status"
        >
          <span aria-live="polite">
            {voice.phase === "listening" && "Listening…"}
            {voice.phase === "countdown" &&
              voice.countdownSec !== null &&
              `Sending in ${voice.countdownSec}…`}
            {voice.phase === "sending" && "Sending…"}
          </span>
          {(voice.phase === "countdown" || voice.phase === "sending") && (
            <button
              type="button"
              onClick={voice.cancelVoice}
              className="shrink-0 rounded-md px-2 py-0.5 text-orange hover:bg-surface-2 cursor-pointer"
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {/* Centered + capped by default so the prompt box does not stretch
          edge-to-edge across a wide/expanded panel; `fullWidth` lines it up with
          the message column in the docked context. */}
      <div className={cn("relative flex items-end gap-2", rowWidth)}>
        {mentionOpen && (
          <ul
            role="listbox"
            aria-label="Mention a member"
            className="absolute bottom-full left-0 z-10 mb-1 max-h-48 w-64 overflow-y-auto rounded-card border border-border bg-surface py-1 shadow-lg"
          >
            {mentionMatches.map((candidate, index) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === mentionState.activeIndex}
                  onClick={() => insertMention(candidate)}
                  onMouseEnter={() =>
                    setMentionState((prev) =>
                      prev === null ? prev : { ...prev, activeIndex: index },
                    )
                  }
                  className={cn(
                    "block w-full cursor-pointer truncate px-3 py-1.5 text-left text-sm text-text",
                    index === mentionState.activeIndex && "bg-surface-2",
                  )}
                >
                  {candidate.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        {voice.supported && (
          <button
            type="button"
            aria-label={
              voice.phase === "off" ? "Start voice input" : "Stop voice input"
            }
            aria-pressed={voice.phase !== "off"}
            disabled={disabled === true}
            onClick={voice.toggleListening}
            className={cn(
              CIRCLE_BUTTON,
              "border border-border text-text-2 transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50",
              voice.phase === "listening" &&
                "border-orange text-orange ring-2 ring-orange/30",
              voice.phase === "countdown" && "border-orange text-orange",
            )}
          >
            <Mic className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
        {attachmentsEnabled && (
          <>
            <input
              id={fileInputId}
              type="file"
              multiple
              accept={attachmentPolicy.acceptedMimeTypes.join(",")}
              className="hidden"
              onChange={(event) => {
                addFiles(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
            <Menu>
              <MenuTrigger
                type="button"
                aria-label="Add files"
                disabled={hardBlocked}
                className={cn(
                  CIRCLE_BUTTON,
                  "border border-border text-text-2 transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50",
                )}
              >
                <Plus className="h-4 w-4" />
              </MenuTrigger>
              <MenuContent align="start" side="top">
                {/* A <label> opens the picker via native activation, which is a
                    trusted gesture in every browser — unlike a programmatic
                    input.click() from a Radix onSelect (blocked in Safari). */}
                <MenuItem asChild>
                  <label htmlFor={fileInputId}>
                    <Paperclip className="h-4 w-4" />
                    Add files
                  </label>
                </MenuItem>
              </MenuContent>
            </Menu>
          </>
        )}
        <textarea
          ref={textareaRef}
          aria-label="Message"
          rows={1}
          value={draft}
          disabled={hardBlocked}
          placeholder={placeholder ?? "Message…"}
          onChange={(event) => {
            setDraft(event.target.value);
            voice.onManualDraftEdit(event.target.value);
            adjustHeight();
            syncMentionState(event.target.value, event.target.selectionStart);
          }}
          onInput={adjustHeight}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          className={cn(
            inputFieldClass,
            "chat-composer-textarea max-h-[30vh] min-h-[2.5rem] flex-1 resize-none overflow-x-hidden overflow-y-auto disabled:opacity-50",
          )}
        />
        {showStop ? (
          <button
            type="button"
            aria-label="Stop"
            aria-busy={aborting}
            onClick={handleAbort}
            disabled={aborting}
            className={cn(
              CIRCLE_BUTTON,
              // Full color like the busy spinner — stopping is an active,
              // available action, not a greyed-out control.
              "bg-orange text-white transition-[background-color,transform] hover:bg-orange-deep active:scale-[0.97] disabled:active:scale-100 disabled:opacity-100",
            )}
          >
            <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            aria-label={showBusy ? "Waiting for agent" : "Send"}
            aria-busy={showBusy}
            onClick={submit}
            disabled={
              isBlocked || (draft.trim().length === 0 && pending.length === 0)
            }
            className={cn(
              CIRCLE_BUTTON,
              "bg-orange text-white transition-[background-color,transform] hover:bg-orange-deep active:scale-[0.97] disabled:active:scale-100",
              // Busy keeps full color — the spinner reads as active work, not a
              // greyed-out control the user might think is broken.
              showBusy ? "disabled:opacity-100" : "disabled:opacity-50",
            )}
          >
            {showBusy ? (
              <span
                data-testid="composer-busy-spinner"
                aria-hidden="true"
                className="block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white motion-reduce:animate-none"
              />
            ) : (
              <ArrowUp className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}

function QueuedMessageChip({
  item,
  onEdit,
  onCancel,
}: {
  item: QueuedMessage;
  onEdit: () => void;
  onCancel: () => void;
}) {
  const preview = item.text.length > 0 ? item.text : "Attachment only";
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-text">
      <span className="shrink-0 rounded-full bg-orange/15 px-2 py-0.5 text-orange">
        Queued
      </span>
      <span className="min-w-0 flex-1 truncate" title={item.text}>
        {preview}
        {item.attachments !== undefined && item.attachments.length > 0 && (
          <span className="text-text-3">
            {" "}
            · {item.attachments.length} attachment
            {item.attachments.length === 1 ? "" : "s"}
          </span>
        )}
      </span>
      <button
        type="button"
        onClick={onEdit}
        className="shrink-0 rounded-md px-2 py-0.5 text-text-2 hover:bg-surface-2 hover:text-text cursor-pointer"
      >
        Edit
      </button>
      <button
        type="button"
        aria-label="Cancel queued message"
        onClick={onCancel}
        className="shrink-0 rounded-md px-2 py-0.5 text-text-2 hover:bg-surface-2 hover:text-text cursor-pointer"
      >
        Cancel
      </button>
    </div>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: PendingAttachment;
  onRemove: () => void;
}) {
  const isImage = attachment.mimeType.startsWith("image/");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isImage) return;
    const url = URL.createObjectURL(attachment.file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [attachment.file, isImage]);

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-surface py-1 pl-1 pr-1.5 text-xs text-text">
      {isImage && previewUrl !== null ? (
        <img
          src={previewUrl}
          alt={attachment.name}
          className="h-8 w-8 rounded object-cover ring-1 ring-inset ring-border"
        />
      ) : (
        <span className="flex h-8 w-8 items-center justify-center">
          <FileIcon className="h-5 w-5 text-text-3" />
        </span>
      )}
      <span className="max-w-[10rem] truncate" title={attachment.name}>
        {attachment.name}
      </span>
      <span className="text-text-3">{formatBytes(attachment.size)}</span>
      <button
        type="button"
        aria-label={`Remove ${attachment.name}`}
        onClick={onRemove}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-3 transition-transform hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange active:scale-[0.97]"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
