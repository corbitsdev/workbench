import {
  Component,
  useEffect,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { File as FileIcon } from "lucide-react";
import { cn, Markdown } from "@workbench/ui";
import { type ChatMessage, type ChatImage, type ChatAttachment } from "./types";
import { formatBytes } from "./attachments";
import { ReasoningDisclosure } from "./ReasoningDisclosure";
import {
  extractUIBlockFromText,
  UIBlockView,
  type UIBlock,
  type UIResponse,
} from "@workbench/blocks";
import { MessageFeedback } from "./MessageFeedback";
import type { FeedbackSubjectKind } from "./feedback-types";

class UIBlockErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {}

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <p className="text-sm text-text-3">
          This interactive block could not be displayed.
        </p>
      );
    }
    return this.props.children;
  }
}

export interface MessageBubbleProps {
  message: ChatMessage;
  /** Forwarded to interactive UI blocks embedded in the agent's reply. */
  onRespond?: (response: UIResponse) => void;
  /** Forwarded to document UI blocks for copy / download / save-artifact. */
  onAction?: (
    action: "copy" | "download" | "save-artifact",
    block: UIBlock,
  ) => void;
  /**
   * When provided, a thumbs up/down row is shown below settled agent messages.
   * The host supplies the save function so the chat package stays transport-free.
   */
  onRate?: (
    subjectId: string,
    subjectKind: FeedbackSubjectKind,
    rating: 1 | -1,
  ) => Promise<void>;
  /** Returns the server-fetched rating for a subject, if one is available. */
  getRating?: (
    subjectId: string,
    subjectKind: FeedbackSubjectKind,
  ) => 1 | -1 | null | undefined;
  /**
   * Resolves an attachment's stored blob to a displayable/downloadable object
   * URL. The chat package stays transport-free: the host supplies this and owns
   * the authenticated fetch, caching, and URL lifetime. Attachments render only
   * when this is provided.
   */
  resolveAttachmentUrl?: (blobId: string) => Promise<string>;
}

/**
 * A single chat bubble. User messages align right in the brand-accent bubble;
 * agent messages render as plain full-width prose on the panel background (no
 * card), and system messages align left on a neutral surface.
 *
 * Agent and system messages are rendered through the shared <Markdown>. When an
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

function FileChip({
  attachment,
  resolveAttachmentUrl,
}: {
  attachment: ChatAttachment;
  resolveAttachmentUrl: (blobId: string) => Promise<string>;
}) {
  const [downloading, setDownloading] = useState(false);
  const [failed, setFailed] = useState(false);

  const onDownload = () => {
    setDownloading(true);
    setFailed(false);
    resolveAttachmentUrl(attachment.blobId)
      .then((url) => {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = attachment.name;
        anchor.click();
      })
      // Surface the failure rather than swallowing it — a dead click with no
      // feedback is worse than an error the user can act on.
      .catch(() => setFailed(true))
      .finally(() => setDownloading(false));
  };

  return (
    <span className="inline-flex flex-col gap-0.5">
      <button
        type="button"
        onClick={onDownload}
        disabled={downloading}
        title={`Download ${attachment.name}`}
        className="flex items-center gap-2 rounded-lg border border-border bg-surface py-1 pl-1 pr-1.5 text-xs text-text transition-transform hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange active:scale-[0.97] disabled:opacity-60"
      >
        <span className="flex h-8 w-8 items-center justify-center">
          <FileIcon className="h-5 w-5 text-text-3" />
        </span>
        <span className="max-w-[10rem] truncate">{attachment.name}</span>
        <span className="text-text-3">{formatBytes(attachment.size)}</span>
      </button>
      {failed && (
        <span role="alert" className="text-xs text-red-500">
          Couldn't download — try again
        </span>
      )}
    </span>
  );
}

function ImageAttachment({
  attachment,
  resolveAttachmentUrl,
}: {
  attachment: ChatAttachment;
  resolveAttachmentUrl: (blobId: string) => Promise<string>;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    resolveAttachmentUrl(attachment.blobId)
      .then((resolved) => {
        if (!cancelled) setUrl(resolved);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.blobId, resolveAttachmentUrl]);

  if (failed) {
    return (
      <FileChip
        attachment={attachment}
        resolveAttachmentUrl={resolveAttachmentUrl}
      />
    );
  }

  if (url === null) {
    return (
      <span
        aria-label={`Loading ${attachment.name}`}
        className="block h-16 w-16 animate-pulse rounded-lg bg-surface-2 ring-1 ring-inset ring-border"
      />
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={`Open ${attachment.name}`}
      className="block"
    >
      <img
        src={url}
        alt={attachment.name}
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-16 w-16 rounded-lg object-cover ring-1 ring-inset ring-border transition-transform hover:scale-[1.02]"
      />
    </a>
  );
}

function MessageAttachments({
  attachments,
  resolveAttachmentUrl,
}: {
  attachments: ChatAttachment[];
  resolveAttachmentUrl: (blobId: string) => Promise<string>;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((attachment) => {
        const isImage = attachment.type.startsWith("image/");
        if (isImage) {
          return (
            <ImageAttachment
              key={attachment.blobId}
              attachment={attachment}
              resolveAttachmentUrl={resolveAttachmentUrl}
            />
          );
        }
        return (
          <FileChip
            key={attachment.blobId}
            attachment={attachment}
            resolveAttachmentUrl={resolveAttachmentUrl}
          />
        );
      })}
    </div>
  );
}

export function MessageBubble({
  message,
  onRespond,
  onAction,
  onRate,
  getRating,
  resolveAttachmentUrl,
}: MessageBubbleProps) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const isStreaming = message.status === "sending";
  const hasReasoning =
    message.role === "agent" && (message.reasoning ?? "").trim() !== "";
  const hasImages = message.images !== undefined && message.images.length > 0;
  const hasAttachments =
    resolveAttachmentUrl !== undefined &&
    message.attachments !== undefined &&
    message.attachments.length > 0;
  // Trimmed so a turn that commits as only whitespace ("\n\n") is treated as
  // empty rather than rendering a blank bubble.
  const hasBody = message.content.trim() !== "";

  // Nothing to show: no body, not streaming, no reasoning, no images, no
  // renderable attachments.
  if (
    !hasBody &&
    message.status !== "sending" &&
    !hasReasoning &&
    !hasImages &&
    !hasAttachments
  )
    return null;

  // Only attempt block extraction on settled agent/system messages — a partial
  // stream may contain a half-written fence we should not try to parse yet.
  const extracted =
    !isUser && !isStreaming ? extractUIBlockFromText(message.content) : null;

  function renderBody() {
    if (isUser) return message.content;
    if (extracted !== null) {
      return (
        <div className="flex flex-col gap-2">
          {extracted.text !== "" && <Markdown>{extracted.text}</Markdown>}
          <UIBlockErrorBoundary>
            <UIBlockView
              block={extracted.block}
              {...(onRespond !== undefined ? { onRespond } : {})}
              {...(onAction !== undefined ? { onAction } : {})}
            />
          </UIBlockErrorBoundary>
        </div>
      );
    }
    return (
      <Markdown mode={isStreaming ? "streaming" : "static"}>
        {message.content}
      </Markdown>
    );
  }

  return (
    <div
      data-role={message.role}
      className={cn(
        "flex w-full flex-col gap-2",
        isUser ? "items-end" : "items-start",
      )}
    >
      {message.senderLabel !== undefined && message.senderLabel !== "" && (
        <span className="text-xs text-text-3">From: {message.senderLabel}</span>
      )}
      {hasReasoning && (
        <ReasoningDisclosure
          reasoning={message.reasoning ?? ""}
          streaming={isStreaming && message.content === ""}
        />
      )}
      {(hasBody || (message.status === "sending" && !hasReasoning)) && (
        <div
          className={cn(
            "text-sm break-words",
            message.role === "agent"
              ? "w-full text-text"
              : "max-w-[80%] rounded-lg px-3 py-2",
            isUser && "bg-orange text-white whitespace-pre-wrap",
            isUser && "transition-opacity duration-200",
            isUser && message.status === "sending" && "opacity-70",
            isSystem && "bg-surface-2 text-text-3 italic",
          )}
        >
          {renderBody()}
        </div>
      )}
      {hasImages &&
        message.images!.map((image, index) => (
          <InlineImage key={index} image={image} />
        ))}
      {hasAttachments && (
        <MessageAttachments
          attachments={message.attachments!}
          resolveAttachmentUrl={resolveAttachmentUrl!}
        />
      )}
      {message.role === "agent" &&
        message.status !== "sending" &&
        onRate !== undefined && (
          <MessageFeedback
            subjectId={message.feedbackId ?? message.id}
            subjectKind="turn_part"
            savedRating={
              getRating !== undefined
                ? (getRating(message.feedbackId ?? message.id, "turn_part") ??
                  null)
                : null
            }
            onRate={onRate}
          />
        )}
      {isUser && message.status === "sending" && (
        <span className="text-xs text-text-3">Sending…</span>
      )}
      {message.status === "failed" && (
        <span role="alert" className="text-xs text-red">
          Failed to send
        </span>
      )}
    </div>
  );
}
