// A message's `file` part is the wire shape for an artifact reference: it
// always carries a name and media type, and carries `blobId` once the
// platform has persisted the bytes, or `artifactId` when it also links back
// to a Library row (`packages/chat/src/parts.ts`, CL-6000). Either one gives
// the host a stable id to open — a still-in-flight `data`-only attachment
// with neither renders the same chip, inert.
//
// Opening a chip is a callback the host supplies (mirrors `onOpenProfile`
// and `onOpenThread` in `timeline.tsx`): this package owns no router. A
// second, artifactId-only affordance — "Open in Library" — hands the host a
// separate callback so it can navigate there directly (CL-6015); it only
// ever renders when `artifactId` is present, since a blob-only part has no
// Library row to deep-link to.

import { FileText, Library } from "lucide-react";

import type { Part } from "./api";
import { CHAT_STRINGS } from "./strings";

export function ArtifactChip({
  part,
  onOpen,
  onOpenInLibrary,
}: {
  readonly part: Part & { kind: "file" };
  readonly onOpen?: (part: Part & { kind: "file" }) => void;
  readonly onOpenInLibrary?: (part: Part & { kind: "file" }) => void;
}) {
  const openable =
    (part.blobId !== undefined || part.artifactId !== undefined) &&
    onOpen !== undefined;
  const libraryOpenable =
    part.artifactId !== undefined && onOpenInLibrary !== undefined;

  return (
    <div className="chat-artifact-chip">
      <button
        type="button"
        className="chat-artifact-chip-open"
        disabled={!openable}
        {...(openable && onOpen !== undefined
          ? { onClick: () => onOpen(part) }
          : {})}
      >
        <span className="chat-artifact-chip-icon" aria-hidden="true">
          <FileText />
        </span>
        <span className="chat-artifact-chip-meta">
          <strong>{part.name}</strong>
          <span>
            {CHAT_STRINGS.filePartLabel} · {part.mediaType}
          </span>
        </span>
      </button>
      {libraryOpenable && onOpenInLibrary !== undefined ? (
        <button
          type="button"
          className="chat-artifact-chip-library"
          aria-label="Open in Library"
          title="Open in Library"
          onClick={() => onOpenInLibrary(part)}
        >
          <Library />
        </button>
      ) : null}
    </div>
  );
}
