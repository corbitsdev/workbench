// A message's `file` part is the wire shape for an artifact reference: it
// always carries a name and media type, and carries `blobId` once the
// platform has persisted the bytes, or `artifactId` when it also links back
// to a Library row (`packages/chat/src/parts.ts`, CL-6000). Either one gives
// the host a stable id to open — a still-in-flight `data`-only attachment
// with neither renders the same chip, inert.
//
// Opening a chip is a callback the host supplies (mirrors `onOpenProfile`
// and `onOpenThread` in `timeline.tsx`): this package owns no router. A
// host that only understands blob ids can still open an artifact-only chip
// by falling back to the Library at large; a per-artifact deep link is the
// host's call to make.

import { FileText } from "lucide-react";

import type { Part } from "./api";
import { CHAT_STRINGS } from "./strings";

export function ArtifactChip({
  part,
  onOpen,
}: {
  readonly part: Part & { kind: "file" };
  readonly onOpen?: (part: Part & { kind: "file" }) => void;
}) {
  const openable =
    (part.blobId !== undefined || part.artifactId !== undefined) &&
    onOpen !== undefined;

  return (
    <button
      type="button"
      className="chat-artifact-chip"
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
  );
}
