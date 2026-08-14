// Turns a chat `FilePart` into the canvas's typed artifact content —
// `ChatPage`'s glue between the chip-open callback and either of two reads:
// `artifactId` resolves through the Library artifacts surface (the same
// `GET /api/tenants/:id/artifacts/:id` `LibraryRoute` reads —
// `artifactContentFromDetail`), never raw blob bytes. Only a part with no
// `artifactId` — a plain human upload that never got a Library row — falls
// back to `chat-ui`'s blob route (see `packages/chat/src/routes.ts`
// `GET /channels/:id/blobs/:blobId`, `artifactContentFromBlob`).

import {
  isTextDecodableMediaType,
  resolveArtifactRendererKind,
  resolveRendererKindFromMediaType,
} from "@corbits/artifact-ui";
import type { ArtifactDetail } from "./api";
import type { CanvasArtifactContent } from "./shell/canvas-column-state";

/** Decodes a Library artifact detail into the canvas's typed content — the
 * same renderer-kind resolution `LibraryPage`'s preview pane uses, so a
 * chip opened from chat and the same artifact opened from Library render
 * identically. */
export function artifactContentFromDetail(
  detail: ArtifactDetail,
): CanvasArtifactContent {
  return {
    id: detail.id,
    title: detail.title,
    rendererKind: resolveArtifactRendererKind(detail),
    content: detail.content,
  };
}

/** The honest "couldn't read it" pane for an artifact detail fetch that
 * failed (network error, artifact no longer resolvable, etc). */
export function artifactContentFromDetailError(
  part: { readonly name: string },
  artifactId: string,
  message: string,
): CanvasArtifactContent {
  return {
    id: artifactId,
    title: part.name,
    rendererKind: "unsupported",
    content: "",
    unavailableReason: `Couldn't load this artifact: ${message}`,
  };
}

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
