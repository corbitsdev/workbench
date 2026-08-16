// A minimal composer variant for the one screen with no conversation yet
// to attach to: a zero-workbench bench's first-run prompt (CL-6124). The
// real `Composer` (`./composer.tsx`) is built around an active channel —
// mentions, slash commands, an agents list to @-address — none of which
// exist before the first workbench does. This variant reuses the same
// attachment validation and send-state helpers so the two stay honest
// about what "ready to send" means, but owns its own minimal markup: one
// box, corner affordances (attach bottom-left, dictate bottom-right, send
// bottom-right), no popovers.
//
// Unlike `Composer.send`, which clears the draft the instant it hands off
// (a host-owned pending bubble becomes the one place the text lives while
// a send is in flight), this screen has no timeline to hold a pending
// bubble — so the draft stays in the box until `onSend` actually resolves,
// and a failure leaves the exact text the person typed for a straight
// retry.

import { Button } from "@corbits/react-ui";
import { Loader2, Mic, Plus, Send, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import {
  attachmentBytesOnComposer,
  attachmentValidationMessage,
  canSendComposerAction,
  composerSendVisualState,
  validateAttachmentPick,
} from "./composer";
import type { ComposerAttachment } from "./composer";
import { CHAT_STRINGS } from "./strings";

/** The subset of the Web Speech API this component drives — narrow enough
 * to type by hand rather than pull in `dom.iterable`'s speech lib, and
 * honest that only the fields actually read/assigned here exist. */
type DictationEvent = {
  readonly resultIndex: number;
  readonly results: ArrayLike<ArrayLike<{ readonly transcript: string }>>;
};
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: DictationEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    readonly SpeechRecognition?: SpeechRecognitionCtor;
    readonly webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
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
  return `first_run_att_${attachmentSeq}`;
}

/**
 * Fold picked files into the one-shot description text: the drafting
 * endpoint this screen posts to (`draftAgentDefinition`) takes a single
 * `purpose` string, with no attachment channel of its own, so a file
 * chosen here travels as a plain mention in that string rather than
 * silently vanishing on submit.
 */
export function textWithAttachments(
  text: string,
  attachments: readonly ComposerAttachment[],
): string {
  if (attachments.length === 0) return text;
  const names = attachments.map((file) => file.name).join(", ");
  return `${text}\n\nAttached: ${names}`;
}

export function FirstRunComposer({
  placeholder,
  sending,
  error,
  onSend,
}: {
  readonly placeholder?: string;
  readonly sending: boolean;
  readonly error: string | null;
  /** Resolves to whether the send succeeded; the composer only clears its
   * draft once it has. */
  readonly onSend: (text: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>(
    [],
  );
  const [preparing, setPreparing] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const [dictationCtor] = useState(speechRecognitionCtor);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [value]);

  const busy = { sending, preparing };
  const canSend = canSendComposerAction(value, attachments, busy);
  const sendVisualState = composerSendVisualState(value, attachments, {
    sending,
  });

  async function submit() {
    if (!canSendComposerAction(value, attachments, busy)) return;
    const ok = await onSend(textWithAttachments(value.trim(), attachments));
    if (ok) {
      setValue("");
      setAttachments([]);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  function resetFileInput() {
    if (fileInputRef.current !== null) fileInputRef.current.value = "";
  }

  async function addFiles(fileList: FileList | null) {
    if (fileList === null || fileList.length === 0) return;
    if (sending || preparing) return;
    const files = Array.from(fileList);
    const validation = validateAttachmentPick(
      attachments.length,
      attachmentBytesOnComposer(attachments),
      files.map((file) => ({ name: file.name, size: file.size })),
    );
    if (validation !== null) {
      setPickError(attachmentValidationMessage(validation));
      resetFileInput();
      return;
    }
    setPreparing(true);
    setPickError(null);
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
      setAttachments((previous) => [...previous, ...next]);
    } catch {
      setPickError(CHAT_STRINGS.composerAttachmentReadError);
    } finally {
      setPreparing(false);
      resetFileInput();
    }
  }

  function removeAttachment(id: string) {
    setAttachments((previous) => previous.filter((file) => file.id !== id));
  }

  function toggleDictation() {
    if (dictationCtor === null) return;
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const recognition = new dictationCtor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i]?.[0]?.transcript ?? "";
      }
      if (transcript.trim() === "") return;
      setValue((previous) =>
        previous.length === 0 || previous.endsWith(" ")
          ? `${previous}${transcript.trim()}`
          : `${previous} ${transcript.trim()}`,
      );
    };
    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognition.onerror = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }

  return (
    <div className="first-run-composer">
      <div className="first-run-composer-box">
        {attachments.length > 0 && (
          <ul
            className="chat-composer-attachments"
            aria-label={CHAT_STRINGS.composerAttachmentsLabel}
          >
            {attachments.map((file) => (
              <li key={file.id} className="chat-composer-attachment">
                <span className="chat-composer-attachment-name">
                  {file.name}
                </span>
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
        <textarea
          ref={textareaRef}
          className="first-run-composer-input"
          value={value}
          placeholder={placeholder ?? CHAT_STRINGS.composerPlaceholder}
          disabled={sending}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          autoFocus
        />
        <div className="first-run-composer-corners">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="chat-composer-file-input"
            onChange={(event) => void addFiles(event.target.files)}
            tabIndex={-1}
            aria-hidden="true"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="first-run-composer-attach"
            disabled={sending || preparing}
            onClick={() => fileInputRef.current?.click()}
            aria-label={CHAT_STRINGS.composerAttach}
            title={CHAT_STRINGS.composerAttach}
          >
            <Plus aria-hidden="true" />
          </Button>
          <div className="first-run-composer-corners-right">
            {dictationCtor !== null && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="first-run-composer-mic"
                data-listening={listening ? "true" : undefined}
                disabled={sending}
                onClick={toggleDictation}
                aria-label={
                  listening
                    ? CHAT_STRINGS.composerDictateStop
                    : CHAT_STRINGS.composerDictate
                }
                title={
                  listening
                    ? CHAT_STRINGS.composerDictateStop
                    : CHAT_STRINGS.composerDictate
                }
              >
                <Mic aria-hidden="true" />
              </Button>
            )}
            <Button
              type="button"
              variant={sendVisualState === "empty" ? "ghost" : "primary"}
              size="icon"
              data-send-state={sendVisualState}
              disabled={!canSend}
              onClick={() => void submit()}
              aria-label={
                sending
                  ? CHAT_STRINGS.composerSending
                  : CHAT_STRINGS.composerSend
              }
              title={
                sending
                  ? CHAT_STRINGS.composerSending
                  : CHAT_STRINGS.composerSend
              }
            >
              {sendVisualState === "sending" ? (
                <Loader2
                  className="chat-composer-send-spinner"
                  aria-hidden="true"
                />
              ) : (
                <Send aria-hidden="true" />
              )}
            </Button>
          </div>
        </div>
      </div>
      <div
        className="chat-composer-status"
        aria-live="polite"
        aria-atomic="true"
      >
        {preparing ? CHAT_STRINGS.composerPreparing : null}
      </div>
      {(pickError ?? error) !== null && (
        <div className="chat-composer-error" role="alert">
          {pickError ?? error}
        </div>
      )}
    </div>
  );
}
