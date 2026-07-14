// Pure text-cleaning helpers for gallery card previews (CL-3632). Cards must
// never render raw markdown/HTML/JSON syntax — these functions turn artifact
// bodies into prose excerpts.

const CODE_FENCE = /```[a-zA-Z0-9]*\n?([\s\S]*?)```/g;
const INLINE_CODE = /`([^`]+)`/g;
const IMAGE_LINK = /!\[([^\]]*)\]\([^)]*\)/g;
const TEXT_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const HEADING = /^\s{0,3}#{1,6}\s+/gm;
const BOLD_ITALIC = /(\*\*\*|___)([\s\S]*?)\1/g;
const BOLD = /(\*\*|__)([\s\S]*?)\1/g;
const ITALIC = /(\*|_)([\s\S]*?)\1/g;
const BLOCKQUOTE = /^\s{0,3}>\s?/gm;
const UNORDERED_LIST = /^\s*[-*+]\s+/gm;
const ORDERED_LIST = /^\s*\d+\.\s+/gm;
const HORIZONTAL_RULE = /^\s{0,3}(-{3,}|_{3,}|\*{3,})\s*$/gm;

/** Strip common markdown syntax down to prose. Keeps link/image text, drops URLs. */
export function stripMarkdownSyntax(text: string): string {
  let out = text.replace(CODE_FENCE, "$1");
  out = out.replace(INLINE_CODE, "$1");
  out = out.replace(IMAGE_LINK, "$1");
  out = out.replace(TEXT_LINK, "$1");
  out = out.replace(HEADING, "");
  out = out.replace(BOLD_ITALIC, "$2");
  out = out.replace(BOLD, "$2");
  out = out.replace(ITALIC, "$2");
  out = out.replace(BLOCKQUOTE, "");
  out = out.replace(UNORDERED_LIST, "");
  out = out.replace(ORDERED_LIST, "");
  out = out.replace(HORIZONTAL_RULE, "");
  return out;
}

const DOCTYPE = /<!DOCTYPE[^>]*>/gi;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const SCRIPT_OR_STYLE = /<(script|style)[^>]*>[\s\S]*?<\/\1>/gi;
const HTML_TAG = /<[^>]+>/g;
const HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

/** Strip HTML tags, doctype declarations, comments, and script/style bodies. */
export function stripHtmlTags(text: string): string {
  let out = text.replace(DOCTYPE, "");
  out = out.replace(HTML_COMMENT, "");
  out = out.replace(SCRIPT_OR_STYLE, "");
  out = out.replace(HTML_TAG, " ");
  for (const [entity, replacement] of Object.entries(HTML_ENTITIES)) {
    out = out.split(entity).join(replacement);
  }
  return out;
}

const JSON_SUMMARY_KEYS = ["summary", "description", "title"] as const;

function tryParseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** True when content parses as JSON (object or array) — never render it raw. */
export function isJsonContent(text: string): boolean {
  return tryParseJsonObject(text) !== undefined;
}

/**
 * Pulls a human summary out of JSON content via `summary`/`description`/`title`
 * fields, in that preference order. Returns undefined when the content is not
 * JSON, or is JSON with none of those fields populated.
 */
export function extractJsonSummary(text: string): string | undefined {
  const parsed = tryParseJsonObject(text);
  if (parsed === undefined) return undefined;
  for (const key of JSON_SUMMARY_KEYS) {
    const value = parsed[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * Reduces raw artifact content to clean prose suitable for a card excerpt.
 * JSON content resolves through its summary field (or the caller-supplied
 * `fallbackTitle` when no summary field is present) rather than ever
 * surfacing raw JSON syntax. Markdown/HTML content has its syntax stripped.
 */
export function cleanContentForExcerpt(
  content: string,
  fallbackTitle?: string,
): string {
  const jsonSummary = extractJsonSummary(content);
  if (jsonSummary !== undefined) return jsonSummary;
  if (isJsonContent(content)) return fallbackTitle ?? "";
  return stripMarkdownSyntax(stripHtmlTags(content));
}
