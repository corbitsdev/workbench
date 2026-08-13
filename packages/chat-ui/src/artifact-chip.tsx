// A message's `file` part is the wire shape for an artifact reference: it
// always carries a name and media type, and carries `blobId` once the
// platform has persisted the bytes (see `packages/chat/src/parts.ts`). Only
// a persisted file has a stable id anything could open, so the chip below
// is clickable exactly when `blobId` is set — a still-in-flight `data`-only
// attachment renders the same chip, inert.
//
// Opening a chip is a callback the host supplies (mirrors `onOpenProfile`
// and `onOpenThread` in `timeline.tsx`): this package owns no router. Today
// there is no stored link from a chat blob to a Library artifact id, so the
// host can only navigate to the Library at large — a real per-artifact deep
// link, and opening in canvas rather than navigating, are follow-up work.

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
  const openable = part.blobId !== undefined && onOpen !== undefined;

  return (
    <button
      type="button"
      className="chat-artifact-chip"
      disabled={!openable}
      {...(part.blobId !== undefined && onOpen !== undefined
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
