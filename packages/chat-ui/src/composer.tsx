// The message composer: a plain textarea (Enter sends, Shift+Enter breaks
// the line), an accessible file picker for attachments, disabled while
// empty, with an @-mention popover listing the active channel's agent
// participants. Kept local and simple rather than adopting the library's
// `ChatInput` — that component is built around the agent-chat `ChatMessage`
// model (working/stop) this surface does not use, and its send affordance
// does not compose with an inline mention popover.

import { Button } from "@corbits/react-ui";
import { Paperclip, Send, X } from "lucide-react";
import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";

import type { Part } from "./api";
import {
  activeMentionQuery,
  filterMentionCandidates,
  insertMention,
} from "./mentions";
import type { MentionCandidate, MentionQuery } from "./mentions";
import {
  SLASH_COMMANDS,
  activeSlashQuery,
  filterSlashCommands,
} from "./slash-commands";
import type { SlashCommandSpec, SlashQuery } from "./slash-commands";
import { CHAT_STRINGS } from "./strings";

/** A file the user picked in the composer, already base64-encoded for the wire. */
export type ComposerAttachment = {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly data: string;
};

export type ComposerSendPayload = {
  readonly text: string;
  readonly attachments: readonly ComposerAttachment[];
};

/** Imperative seam a host can grab a ref to, so content from outside the
 * composer's own tree — the profile card's Mention action (CL-5914) — can
 * land in the active draft at the caret. */
export type ComposerHandle = {
  readonly insertText: (text: string) => void;
};

/** Splice `insertion` in at `caret`, pure and independent of any DOM state
 * so it unit-tests the same way `insertMention` does. */
export function insertTextAtCaret(
  value: string,
  caret: number,
  insertion: string,
): { readonly text: string; readonly caret: number } {
  const before = value.slice(0, caret);
  const after = value.slice(caret);
  const text = `${before}${insertion}${after}`;
  return { text, caret: before.length + insertion.length };
}

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

/**
 * Same rule for selected files: clear the attachment list only after a
 * successful send so a failed post does not force the user to re-pick files.
 */
export function attachmentsAfterSend(
  previous: readonly ComposerAttachment[],
  succeeded: boolean,
): readonly ComposerAttachment[] {
  return succeeded ? [] : previous;
}

/**
 * Build the wire `Part[]` for a composer send. Empty trimmed text is omitted;
 * each attachment becomes a `FilePart` carrying inline base64 `data`.
 */
export function partsForSend(
  text: string,
  attachments: readonly ComposerAttachment[],
): Part[] {
  const parts: Part[] = [];
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    parts.push({ kind: "text", text: trimmed });
  }
  for (const file of attachments) {
    parts.push({
      kind: "file",
      name: file.name,
      mediaType: file.mediaType,
      data: file.data,
    });
  }
  return parts;
}

export function canSendComposer(
  text: string,
  attachments: readonly ComposerAttachment[],
): boolean {
  return text.trim().length > 0 || attachments.length > 0;
}

/**
 * Client-side attachment ceilings, kept under the platform's decoded-byte
 * limits (10 MiB per file / 30 MiB total) so a pick fails in the composer
 * rather than after a failed post.
 */
export const COMPOSER_ATTACHMENT_LIMITS = {
  maxCount: 5,
  maxPerFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 15 * 1024 * 1024,
} as const;

export type ComposerAttachmentLimits = {
  readonly maxCount: number;
  readonly maxPerFileBytes: number;
  readonly maxTotalBytes: number;
};

/** Size metadata available before FileReader runs (File.size). */
export type AttachmentPickCandidate = {
  readonly name: string;
  readonly size: number;
};

export type AttachmentValidationError =
  | { readonly kind: "count"; readonly max: number; readonly attempted: number }
  | {
      readonly kind: "perFile";
      readonly name: string;
      readonly size: number;
      readonly max: number;
    }
  | { readonly kind: "total"; readonly total: number; readonly max: number };

/**
 * Validate a multi-file pick against count, per-file, and total size limits
 * before any FileReader work. Failures are all-or-nothing for the pick.
 */
export function validateAttachmentPick(
  existingCount: number,
  existingTotalBytes: number,
  candidates: readonly AttachmentPickCandidate[],
  limits: ComposerAttachmentLimits = COMPOSER_ATTACHMENT_LIMITS,
): AttachmentValidationError | null {
  if (candidates.length === 0) return null;
  const attempted = existingCount + candidates.length;
  if (attempted > limits.maxCount) {
    return { kind: "count", max: limits.maxCount, attempted };
  }
  let addedBytes = 0;
  for (const file of candidates) {
    if (file.size > limits.maxPerFileBytes) {
      return {
        kind: "perFile",
        name: file.name,
        size: file.size,
        max: limits.maxPerFileBytes,
      };
    }
    addedBytes += file.size;
  }
  const total = existingTotalBytes + addedBytes;
  if (total > limits.maxTotalBytes) {
    return { kind: "total", total, max: limits.maxTotalBytes };
  }
  return null;
}

/** Decoded byte length of a standard base64 payload (padding-aware). */
export function base64DecodedByteLength(data: string): number {
  if (data.length === 0) return 0;
  let padding = 0;
  if (data.endsWith("==")) padding = 2;
  else if (data.endsWith("=")) padding = 1;
  return (data.length * 3) / 4 - padding;
}

export function attachmentBytesOnComposer(
  attachments: readonly ComposerAttachment[],
): number {
  let total = 0;
  for (const file of attachments) {
    total += base64DecodedByteLength(file.data);
  }
  return total;
}

function formatLimitMiB(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

export function attachmentValidationMessage(
  error: AttachmentValidationError,
): string {
  switch (error.kind) {
    case "count":
      return CHAT_STRINGS.composerAttachmentCountError(error.max);
    case "perFile":
      return CHAT_STRINGS.composerAttachmentPerFileError(
        error.name,
        formatLimitMiB(error.max),
      );
    case "total":
      return CHAT_STRINGS.composerAttachmentTotalError(
        formatLimitMiB(error.max),
      );
  }
}

/** Send/Enter stay blocked while a send or file read is in flight. */
export function canSendComposerAction(
  text: string,
  attachments: readonly ComposerAttachment[],
  state: { readonly sending: boolean; readonly preparing: boolean },
): boolean {
  if (state.sending || state.preparing) return false;
  return canSendComposer(text, attachments);
}

/** Attach stays blocked while a send or file read is in flight. */
export function canAttachComposer(state: {
  readonly sending: boolean;
  readonly preparing: boolean;
}): boolean {
  return !state.sending && !state.preparing;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("expected a data URL from FileReader"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("failed to read attachment"));
    reader.readAsDataURL(file);
  });
}

let attachmentSeq = 0;

function nextAttachmentId(): string {
  attachmentSeq += 1;
  return `att_${attachmentSeq}`;
}

export const Composer = forwardRef<
  ComposerHandle,
  {
    readonly agents: readonly MentionCandidate[];
    /** Resolves to whether the send succeeded; the composer decides draft/attachment cleanup from that. */
    readonly onSend: (payload: ComposerSendPayload) => Promise<boolean>;
    /** `/invite` — opens the invite-agent dialog. */
    readonly onInviteAgent: () => void;
    /** `/agents` — opens this channel's settings, Agents section. */
    readonly onOpenAgentsSettings: () => void;
    /** `/run` — the cheapest real hop to running a routine: Routines, create/run open. */
    readonly onOpenRoutines: () => void;
  }
>(function Composer(
  { agents, onSend, onInviteAgent, onOpenAgentsSettings, onOpenRoutines },
  ref,
) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>(
    [],
  );
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [slash, setSlash] = useState<SlashQuery | null>(null);
  const [slashHighlight, setSlashHighlight] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(
    ref,
    () => ({
      insertText: (text: string) => {
        const textarea = textareaRef.current;
        const caret = textarea?.selectionStart ?? value.length;
        const result = insertTextAtCaret(value, caret, text);
        setValue(result.text);
        requestAnimationFrame(() => {
          textarea?.focus();
          textarea?.setSelectionRange(result.caret, result.caret);
        });
      },
    }),
    [value],
  );

  const candidates =
    mention !== null ? filterMentionCandidates(agents, mention.query) : [];
  const slashCandidates =
    slash !== null ? filterSlashCommands(slash.query) : [];
  const busy = { sending, preparing };
  const canSend = canSendComposerAction(value, attachments, busy);
  const canAttach = canAttachComposer(busy);

  function syncComposerSuggestState(text: string, caret: number) {
    setHelpOpen(false);
    const openSlash = activeSlashQuery(text, caret);
    if (openSlash !== null) {
      setSlash(openSlash);
      setSlashHighlight(0);
      setMention(null);
      return;
    }
    setSlash(null);
    const openMention = activeMentionQuery(text, caret);
    setMention(openMention);
    setHighlight(0);
  }

  async function performSend(payload: ComposerSendPayload): Promise<boolean> {
    setSending(true);
    setErrorMessage(null);
    const succeeded = await onSend(payload);
    setSending(false);
    return succeeded;
  }

  function runSlashCommand(command: SlashCommandSpec) {
    switch (command.id) {
      case "invite":
        onInviteAgent();
        return;
      case "agents":
        onOpenAgentsSettings();
        return;
      case "run":
        onOpenRoutines();
        return;
      case "summarize":
        void summarizeThread();
        return;
      case "help":
        setHelpOpen(true);
        return;
    }
  }

  function chooseSlash(command: SlashCommandSpec) {
    setValue("");
    setSlash(null);
    setSlashHighlight(0);
    runSlashCommand(command);
  }

  /** The mock's own honest macro: no server-side "/summarize" exists, so
   * this addresses the channel's actual first agent participant the same
   * way a person would type the mention by hand. */
  async function summarizeThread() {
    const target = agents[0];
    if (target === undefined) {
      setErrorMessage(CHAT_STRINGS.composerSummarizeNoAgentError);
      return;
    }
    if (sending || preparing) return;
    const succeeded = await performSend({
      text: `@${target.handle} summarize this thread`,
      attachments: [],
    });
    if (!succeeded) setErrorMessage(CHAT_STRINGS.sendFailedMessage);
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

  function resetFileInput() {
    if (fileInputRef.current !== null) {
      fileInputRef.current.value = "";
    }
  }

  async function addFiles(fileList: FileList | null) {
    if (fileList === null || fileList.length === 0) return;
    if (!canAttachComposer({ sending, preparing })) return;

    const files = Array.from(fileList);
    const validation = validateAttachmentPick(
      attachments.length,
      attachmentBytesOnComposer(attachments),
      files.map((file) => ({ name: file.name, size: file.size })),
    );
    if (validation !== null) {
      setErrorMessage(attachmentValidationMessage(validation));
      resetFileInput();
      return;
    }

    setPreparing(true);
    setErrorMessage(null);
    try {
      const next: ComposerAttachment[] = [];
      for (const file of files) {
        const data = await readFileAsBase64(file);
        next.push({
          id: nextAttachmentId(),
          name: file.name,
          mediaType:
            file.type.length > 0 ? file.type : "application/octet-stream",
          data,
        });
      }
      // All-or-nothing: only commit once every file in the pick has read.
      setAttachments((previous) => [...previous, ...next]);
    } catch {
      setErrorMessage(CHAT_STRINGS.composerAttachmentReadError);
    } finally {
      setPreparing(false);
      resetFileInput();
    }
  }

  function removeAttachment(id: string) {
    setAttachments((previous) => previous.filter((file) => file.id !== id));
  }

  async function send() {
    if (!canSendComposerAction(value, attachments, { sending, preparing })) {
      return;
    }
    const succeeded = await performSend({ text: value, attachments });
    setValue((previous) => draftAfterSend(previous, succeeded));
    setAttachments((previous) => attachmentsAfterSend(previous, succeeded));
    if (succeeded) {
      setMention(null);
    } else {
      setErrorMessage(CHAT_STRINGS.sendFailedMessage);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (helpOpen && event.key === "Escape") {
      event.preventDefault();
      setHelpOpen(false);
      return;
    }
    if (slash !== null && slashCandidates.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashHighlight((index) => (index + 1) % slashCandidates.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashHighlight(
          (index) =>
            (index - 1 + slashCandidates.length) % slashCandidates.length,
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const chosen = slashCandidates[slashHighlight];
        if (chosen !== undefined) chooseSlash(chosen);
        return;
      }
      if (event.key === "Escape") {
        setSlash(null);
        return;
      }
    }
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

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    void addFiles(event.target.files);
  }

  return (
    <div className="chat-composer">
      {slash !== null && (
        <div className="chat-mention-popover" role="listbox">
          {slashCandidates.length === 0 ? (
            <div className="chat-mention-empty">
              {CHAT_STRINGS.composerSlashEmpty}
            </div>
          ) : (
            slashCandidates.map((command, index) => (
              <button
                key={command.id}
                type="button"
                role="option"
                aria-selected={index === slashHighlight}
                className="chat-mention-option"
                data-highlighted={index === slashHighlight}
                onMouseDown={(event) => {
                  event.preventDefault();
                  chooseSlash(command);
                }}
              >
                <span className="chat-mention-handle">{command.name}</span>
                <span className="chat-mention-label">
                  {command.description}
                </span>
              </button>
            ))
          )}
        </div>
      )}
      {slash === null && mention !== null && (
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
      {helpOpen && (
        <div className="chat-mention-popover chat-slash-help" role="note">
          <div className="chat-slash-help-title">
            {CHAT_STRINGS.composerHelpTitle}
          </div>
          {SLASH_COMMANDS.map((command) => (
            <div key={command.id} className="chat-mention-option">
              <span className="chat-mention-handle">{command.name}</span>
              <span className="chat-mention-label">{command.description}</span>
            </div>
          ))}
          <div className="chat-slash-help-footer">
            <span className="chat-slash-help-note">
              {CHAT_STRINGS.composerHelpNote}
            </span>
            <button
              type="button"
              className="chat-slash-help-close"
              onMouseDown={(event) => {
                event.preventDefault();
                setHelpOpen(false);
              }}
            >
              {CHAT_STRINGS.composerHelpClose}
            </button>
          </div>
        </div>
      )}
      {attachments.length > 0 && (
        <ul
          className="chat-composer-attachments"
          aria-label={CHAT_STRINGS.composerAttachmentsLabel}
        >
          {attachments.map((file) => (
            <li key={file.id} className="chat-composer-attachment">
              <span className="chat-composer-attachment-name">{file.name}</span>
              <button
                type="button"
                className="chat-composer-attachment-remove"
                aria-label={CHAT_STRINGS.composerRemoveAttachment(file.name)}
                onClick={() => removeAttachment(file.id)}
              >
                <X aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="chat-composer-row">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="chat-composer-file-input"
          onChange={handleFileChange}
          tabIndex={-1}
          aria-hidden="true"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={!canAttach}
          onClick={() => fileInputRef.current?.click()}
          aria-label={CHAT_STRINGS.composerAttach}
        >
          <Paperclip />
        </Button>
        <textarea
          ref={textareaRef}
          className="chat-composer-input"
          value={value}
          placeholder={CHAT_STRINGS.composerPlaceholder}
          onChange={(event) => {
            setValue(event.target.value);
            syncComposerSuggestState(
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
          disabled={!canSend}
          onClick={() => void send()}
          aria-label={CHAT_STRINGS.composerSend}
        >
          <Send />
        </Button>
      </div>
      <div
        className="chat-composer-status"
        aria-live="polite"
        aria-atomic="true"
      >
        {preparing ? CHAT_STRINGS.composerPreparing : null}
      </div>
      {errorMessage !== null && (
        <div className="chat-composer-error" role="alert">
          {errorMessage}
        </div>
      )}
    </div>
  );
});
