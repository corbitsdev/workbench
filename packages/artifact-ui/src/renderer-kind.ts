// Which typed renderer an artifact's content plays through — the canvas
// pane, the Library detail preview, and a chat artifact chip's opened blob
// all resolve to one of these before `ArtifactRenderer` ever sees them, so
// the renderer itself never has to know whether it was picked by a Library
// `kind` string or a chat `Part`'s MIME type.

import { titleExtension } from "./title-extension";

export const ARTIFACT_RENDERER_KINDS = [
  "doc",
  "sheet",
  "pdf",
  "unsupported",
] as const;

export type ArtifactRendererKind = (typeof ARTIFACT_RENDERER_KINDS)[number];

/**
 * Renderer selection for a Library artifact — reuses the same
 * kind/extension mapping as the Library kind nav (`kind-filter.ts`), so a
 * card that files under "Sheet" always previews through the sheet
 * renderer. Routines have no typed renderer in this phase — they fall
 * back honestly to "unsupported" rather than guessing at a shape.
 */
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
  return "unsupported";
}

const DOC_MEDIA_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "application/json",
]);
const SHEET_MEDIA_TYPES = new Set([
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const PDF_MEDIA_TYPES = new Set(["application/pdf"]);

/**
 * Renderer selection for a chat `Part`'s file attachment — no Library
 * `kind` exists for a blob that was never diverted into an artifact, so
 * this reads the MIME type first and falls back to the filename
 * extension exactly like the Library mapping does for a bare "file" kind.
 */
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

/** Whether a chat blob's bytes can be shown as text at all — gates whether
 * `chat-artifact-open.ts` even attempts to decode them. `.xls`/`.xlsx`
 * are binary spreadsheet formats, not CSV, so they resolve to the sheet
 * renderer by extension but are excluded here — decoding their bytes as
 * UTF-8 text would just show binary noise. */
export function isTextDecodableMediaType(mediaType: string): boolean {
  const mime = mediaType.trim().toLowerCase();
  if (mime === "application/vnd.ms-excel") return false;
  if (
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    return false;
  }
  return (
    DOC_MEDIA_TYPES.has(mime) || mime === "text/csv" || mime.startsWith("text/")
  );
}
