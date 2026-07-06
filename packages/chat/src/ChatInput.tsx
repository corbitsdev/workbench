import {
  type DragEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { File as FileIcon, Paperclip, Plus, X } from "lucide-react";
import {
  Button,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  buttonVariants,
  cn,
} from "@workbench/ui";
import {
  formatBytes,
  validateFiles,
  type AttachmentPolicy,
  type PendingAttachment,
} from "./attachments";

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
  placeholder?: string;
  disabled?: boolean;
  /** When true the agent is processing; submission is blocked and a visual indicator is shown. */
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
}

/**
 * A minimal input bar. It owns presentational draft + pending-attachment state;
 * the committed message and its attachments are handed to the host via
 * `onSend`. No transport here.
 */
export function ChatInput({
  onSend,
  placeholder,
  disabled,
  busy,
  className,
  attachmentPolicy,
  fullWidth,
}: ChatInputProps) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputId = useId();

  const isBlocked = disabled === true || busy === true || sending;
  const showBusy = busy === true || sending;
  const attachmentsEnabled =
    attachmentPolicy !== undefined &&
    attachmentPolicy.acceptedMimeTypes.length > 0;
  // Docked context lines the composer up with the message column; the wide
  // full-page/expanded surfaces keep the centered, capped prompt.
  const rowWidth =
    fullWidth === true ? "w-full" : "mx-auto w-full lg:max-w-[60vw]";

  useLayoutEffect(() => {
    if (textareaRef.current === null) return;
    textareaRef.current.style.height = "auto";
    textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
  }, [draft]);

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
  };

  const submit = () => {
    const text = draft.trim();
    if (isBlocked) return;
    if (text.length === 0 && pending.length === 0) return;
    const attachments = pending.length > 0 ? pending : undefined;
    const result = onSend(text, attachments);
    // When the host returns a promise (attachment send), keep the pending files
    // until it resolves so a failed send preserves the composer and shows why.
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
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
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
    if (!attachmentsEnabled || isBlocked) return;
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

  return (
    <div
      className={cn(
        "shrink-0 border-t border-border px-4 py-3",
        dragActive && "ring-2 ring-inset ring-orange",
        className,
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
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

      {errors.length > 0 && (
        <div className={cn("mb-2 space-y-0.5", rowWidth)}>
          {errors.map((message, index) => (
            <p key={index} role="alert" className="text-xs text-red-500">
              {message}
            </p>
          ))}
        </div>
      )}

      {/* Centered + capped by default so the prompt box does not stretch
          edge-to-edge across a wide/expanded panel; `fullWidth` lines it up with
          the message column in the docked context. */}
      <div className={cn("flex items-end gap-2", rowWidth)}>
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
                disabled={isBlocked}
                className={cn(
                  buttonVariants({ variant: "ghost", size: "sm" }),
                  "px-2",
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
          disabled={isBlocked}
          placeholder={placeholder ?? "Message Ada…"}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          className="max-h-32 min-h-[2.5rem] flex-1 resize-none overflow-x-hidden overflow-y-auto rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-orange disabled:opacity-50"
        />
        <Button
          type="button"
          size="sm"
          aria-label={showBusy ? "Waiting for agent" : "Send"}
          onClick={submit}
          disabled={
            isBlocked || (draft.trim().length === 0 && pending.length === 0)
          }
          className={cn(showBusy && "opacity-60")}
        >
          {showBusy ? (
            <span className="flex items-center gap-1" aria-hidden="true">
              <span className="block h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
              <span className="block h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
              <span className="block h-1.5 w-1.5 animate-bounce rounded-full bg-current" />
            </span>
          ) : (
            "Send"
          )}
        </Button>
      </div>
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
