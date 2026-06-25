import { isLinkedInPostArtifactKind } from "./artifact-kinds";

// LinkedIn's mobile composer collapses blank lines on paste. Invisible line-break
// anchors on empty lines preserve paragraph spacing when pasted from the clipboard.

export const LINKEDIN_LINE_BREAK_ANCHOR = "\u2800";

function withoutLeadingTrailingBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") {
    start += 1;
  }
  while (end > start && lines[end - 1]!.trim() === "") {
    end -= 1;
  }
  return lines.slice(start, end);
}

export function formatLinkedInPostForClipboard(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmed = withoutLeadingTrailingBlankLines(normalized.split("\n"));
  return trimmed
    .map((line) => (line.trim() === "" ? LINKEDIN_LINE_BREAK_ANCHOR : line))
    .join("\n");
}

export function resolveArtifactClipboardText(
  content: string,
  kind: string,
  formatForLinkedIn: boolean,
): string {
  if (formatForLinkedIn && isLinkedInPostArtifactKind(kind)) {
    return formatLinkedInPostForClipboard(content);
  }
  return content;
}
