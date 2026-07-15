/**
 * Adapted from the vendored AI Elements Attachments component
 * (./vendor/ai-elements/attachments.tsx `getMediaCategory` / label helpers),
 * narrowed to the two categories this package renders (we have no video/audio/
 * source-document attachment kind) and to our `ChatAttachment`/`PendingAttachment`
 * MIME-string shape rather than the AI SDK's `FileUIPart`.
 */

export type AttachmentMediaCategory = "image" | "document";

export function getAttachmentMediaCategory(
  mimeType: string,
): AttachmentMediaCategory {
  return mimeType.startsWith("image/") ? "image" : "document";
}

const MAX_LABEL_LENGTH = 4;

/** A short, uppercase file-type badge label, e.g. "PDF", "PNG", "DOCX". */
export function getFileTypeLabel(name: string, mimeType: string): string {
  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot < name.length - 1) {
    return name
      .slice(dot + 1)
      .toUpperCase()
      .slice(0, MAX_LABEL_LENGTH);
  }
  const subtype = mimeType.split("/")[1];
  if (subtype !== undefined && subtype.length > 0) {
    return subtype.toUpperCase().slice(0, MAX_LABEL_LENGTH);
  }
  return "FILE";
}
