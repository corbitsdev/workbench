// Resolved before `ArtifactRenderer` ever sees it, so the renderer never
// has to know whether it was picked by a Library `kind` or a MIME type.

import { titleExtension } from "./title-extension";

export const ARTIFACT_RENDERER_KINDS = ["doc", "sheet", "pdf", "html", "unsupported"] as const;

export type ArtifactRendererKind = (typeof ARTIFACT_RENDERER_KINDS)[number];

// Reuses the same mapping as the Library kind nav, so a card filed under
// "Sheet" always previews through the sheet renderer.
export function resolveArtifactRendererKind(artifact: {
  readonly kind: string;
  readonly title: string;
}): ArtifactRendererKind {
  const kind = artifact.kind.trim().toLowerCase();
  const ext = titleExtension(artifact.title);

  if (kind === "document") return "doc";
  if (kind === "file" && (ext === "doc" || ext === "txt" || ext === "md")) {
    return "doc";
  }
  if (kind === "csv-export" || kind === "sheet") return "sheet";
  if (kind === "file" && (ext === "xls" || ext === "xlsx" || ext === "csv")) {
    return "sheet";
  }
  if (kind === "pdf") return "pdf";
  if (kind === "file" && ext === "pdf") return "pdf";
  if (kind === "file" && ext === "html") return "html";
  return "unsupported";
}

const DOC_MEDIA_TYPES = new Set(["text/plain", "text/markdown", "application/json"]);
const SHEET_MEDIA_TYPES = new Set([
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const PDF_MEDIA_TYPES = new Set(["application/pdf"]);

// No Library `kind` exists for a blob never diverted into an artifact, so
// this reads MIME type first, falling back to extension.
export function resolveRendererKindFromMediaType(
  mediaType: string,
  filename: string,
): ArtifactRendererKind {
  const mime = mediaType.trim().toLowerCase();
  if (DOC_MEDIA_TYPES.has(mime)) return "doc";
  if (SHEET_MEDIA_TYPES.has(mime)) return "sheet";
  if (PDF_MEDIA_TYPES.has(mime)) return "pdf";

  const ext = titleExtension(filename);
  if (ext === "doc" || ext === "txt" || ext === "md") return "doc";
  if (ext === "xls" || ext === "xlsx" || ext === "csv") return "sheet";
  if (ext === "pdf") return "pdf";
  return "unsupported";
}

// `.xls`/`.xlsx` resolve to the sheet renderer by extension but are
// excluded here: decoding their binary bytes as UTF-8 shows only noise.
export function isTextDecodableMediaType(mediaType: string): boolean {
  const mime = mediaType.trim().toLowerCase();
  if (mime === "application/vnd.ms-excel") return false;
  if (mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    return false;
  }
  return DOC_MEDIA_TYPES.has(mime) || mime === "text/csv" || mime.startsWith("text/");
}
