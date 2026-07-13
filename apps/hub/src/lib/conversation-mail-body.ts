import { extractPartByPath, parseMimePart } from "@intx/mime";
import { tryParseHeaderSection } from "./mail-headers";

function normalizeMailText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false })
    .decode(bytes)
    .replace(/\r\n/g, "\n")
    .trim();
}

/**
 * Extract human-readable conversation text from a stored RFC 2822 frame.
 *
 * Mirrors `extractConversationText` in `packages/workflow-host/src/child/run-child.ts`
 * and the conversation branch of mail-memory `fetchFull`: signed multipart envelopes
 * expose text at MIME path `1` or `1.1`; flat `text/plain` uses bytes after headers.
 * On parse failure, returns an empty string so inbox reads degrade rather than throw.
 */
export function extractConversationBodyFromRaw(raw: Uint8Array): string {
  const parsed = tryParseHeaderSection(raw);
  if (parsed === null) return "";

  const { headers, bodyOffset } = parsed;
  const rootMime = (headers.get("content-type") ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();

  if (rootMime === undefined || !rootMime.startsWith("multipart/")) {
    return normalizeMailText(raw.subarray(bodyOffset));
  }

  try {
    const part1 = parseMimePart(extractPartByPath(raw, "1"));
    const part1Mime = (part1.contentType.split(";")[0] ?? "")
      .trim()
      .toLowerCase();
    const bodyBytes = part1Mime.startsWith("multipart/")
      ? parseMimePart(extractPartByPath(raw, "1.1")).body
      : part1.body;
    return normalizeMailText(bodyBytes);
  } catch {
    return "";
  }
}
