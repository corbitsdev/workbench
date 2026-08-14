// Turns a chat `FilePart` into the canvas's typed artifact content —
// `ChatPage`'s glue between the chip-open callback and `chat-ui`'s blob
// route (see `packages/chat/src/routes.ts` `GET /channels/:id/blobs/:blobId`).
//
// There is no stored link from a chat blob to a Library artifact today
// (see `packages/chat-ui/src/artifact-chip.tsx`), so this always resolves
// through the raw blob read, never the Library artifacts surface — a real
// per-artifact deep link is follow-up work once that link exists.

import {
  isTextDecodableMediaType,
  resolveRendererKindFromMediaType,
} from "@corbits/artifact-ui";
import type { CanvasArtifactContent } from "./shell/canvas-column-state";

/** Decodes a base64 blob body into the canvas artifact content for a
 * `FilePart`, given its already-known `name`/`mediaType`. Binary content
 * (a MIME type this UI can't decode as text) renders through the
 * "unsupported" pane with an honest reason rather than raw bytes. */
export function artifactContentFromBlob(
  part: { readonly name: string; readonly mediaType: string },
  blobId: string,
  contentBase64: string,
): CanvasArtifactContent {
  const rendererKind = resolveRendererKindFromMediaType(
    part.mediaType,
    part.name,
  );
  if (!isTextDecodableMediaType(part.mediaType)) {
    return {
      id: blobId,
      title: part.name,
      rendererKind: "unsupported",
      content: "",
      unavailableReason: `"${part.mediaType}" isn't a text type this canvas can preview inline yet.`,
    };
  }
  return {
    id: blobId,
    title: part.name,
    rendererKind,
    content: atob(contentBase64),
  };
}

/** The honest "couldn't read it" pane for a blob fetch that failed
 * (network error, blob no longer resolvable, etc). */
export function artifactContentFromBlobError(
  part: { readonly name: string },
  blobId: string,
  message: string,
): CanvasArtifactContent {
  return {
    id: blobId,
    title: part.name,
    rendererKind: "unsupported",
    content: "",
    unavailableReason: `Couldn't load this attachment: ${message}`,
  };
}
