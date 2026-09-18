// A part with an `artifactId` resolves through the Library artifacts
// surface, never raw blob bytes; only a plain human upload with no
// Library row falls back to the blob route.

import {
  isTextDecodableMediaType,
  resolveArtifactRendererKind,
  resolveRendererKindFromMediaType,
} from "@/library";
import { artifactPreviewPath, type ArtifactDetail } from "./api";
import { base64ToUtf8 } from "./chat/threads-api";
import type { CanvasArtifactContent } from "./shell/canvas-availability";

/** Same renderer-kind resolution `LibraryPage`'s preview pane uses, so a
 * chip opened from chat renders identically to Library. */
export function artifactContentFromDetail(
  tenantId: string,
  detail: ArtifactDetail,
): CanvasArtifactContent {
  const rendererKind = resolveArtifactRendererKind(detail);
  return {
    id: detail.id,
    title: detail.title,
    rendererKind,
    content: detail.content,
    // Text-kind Library artifacts are co-editable (phase 2); the
    // presence `/update` route's own write-grant check is the real gate
    // — this only decides which pane a capable viewer sees.
    canEdit: rendererKind === "doc",
    ...(rendererKind === "html" ? { previewSrc: artifactPreviewPath(tenantId, detail.id) } : {}),
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
    unavailableReason: message,
  };
}

/** Binary content this UI can't decode as text renders through the
 * "unsupported" pane with an honest reason, rather than raw bytes. */
export function artifactContentFromBlob(
  part: { readonly name: string; readonly mediaType: string },
  blobId: string,
  contentBase64: string,
): CanvasArtifactContent {
  const rendererKind = resolveRendererKindFromMediaType(part.mediaType, part.name);
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
    content: base64ToUtf8(contentBase64),
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
    unavailableReason: message,
  };
}
