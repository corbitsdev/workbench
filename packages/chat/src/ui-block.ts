/**
 * Generative-UI contract for agent output.
 *
 * An agent (or a tool) emits a typed "UI block": a discriminated union the
 * client maps to a dedicated renderer (see UIBlockView). Two emission paths,
 * both producing the same UIBlock:
 *
 *   1. The agent embeds a fenced ```ui block in its reply text — used when the
 *      agent digests a tool result and reformats it into something richer than
 *      a markdown dump. Parsed via {@link extractUIBlockFromText}.
 *   2. A tool returns a JSON object (Interchange stringifies it on the way out);
 *      parsed back via {@link parseToolResult}.
 *
 * Parsing never throws. Unrecognised input degrades to a plain text block, so
 * the worst case is exactly the pre-existing behaviour, never a crash.
 */

export interface DocumentActions {
  copy?: boolean;
  download?: boolean;
  saveArtifact?: boolean;
}

export type UIBlock =
  | { kind: "text"; text: string }
  | { kind: "markdown"; title?: string; source: string; collapsible?: boolean }
  | {
      kind: "document";
      title: string;
      subtitle?: string;
      source: string;
      actions?: DocumentActions;
    }
  | {
      kind: "table";
      title?: string;
      columns: string[];
      rows: (string | number)[][];
    }
  | { kind: "link"; url: string; title?: string; description?: string }
  | { kind: "error"; message: string; detail?: string }
  | {
      kind: "choice";
      prompt?: string;
      options: {
        id: string;
        label: string;
        value?: string;
        description?: string;
      }[];
    }
  | { kind: "canvas"; title?: string; blocks: UIBlock[] };

const KNOWN_KINDS = new Set<UIBlock["kind"]>([
  "text",
  "markdown",
  "document",
  "table",
  "link",
  "error",
  "choice",
  "canvas",
]);

function hasKind(value: unknown): value is { kind: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof (value as { kind: unknown }).kind === "string"
  );
}

/**
 * Validate that a parsed value is a structurally-sound UIBlock. This is a
 * shallow guard: it confirms the discriminant and the required fields each
 * variant's renderer reads, so a malformed block degrades to text rather than
 * throwing inside React.
 */
export function isUIBlock(value: unknown): value is UIBlock {
  if (!hasKind(value)) return false;
  const block = value as Record<string, unknown>;
  if (!KNOWN_KINDS.has(block.kind as UIBlock["kind"])) return false;

  switch (block.kind) {
    case "text":
      return typeof block.text === "string";
    case "markdown":
      return typeof block.source === "string";
    case "document":
      return (
        typeof block.title === "string" && typeof block.source === "string"
      );
    case "table":
      return Array.isArray(block.columns) && Array.isArray(block.rows);
    case "link":
      return typeof block.url === "string";
    case "error":
      return typeof block.message === "string";
    case "choice":
      return Array.isArray(block.options) && block.options.length > 0;
    case "canvas":
      return Array.isArray(block.blocks);
    default:
      return false;
  }
}

function tryParseJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}

/**
 * Parse a tool-result string into a UIBlock. JSON object/array results that
 * match the UIBlock shape light up their renderer; everything else stays a
 * plain text block (today's behaviour).
 */
export function parseToolResult(result: string): UIBlock {
  const trimmed = result.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = tryParseJson(trimmed);
    if (isUIBlock(parsed)) return parsed;
  }
  return { kind: "text", text: result };
}

const UI_FENCE = /```ui\s*\n([\s\S]*?)\n```/u;

export interface ExtractedUIBlock {
  /** The block parsed from the fenced region. */
  block: UIBlock;
  /** The message text with the fenced block removed, trimmed. */
  text: string;
}

/**
 * Extract a fenced ```ui block from agent message text. Returns the parsed
 * block plus the surrounding prose (fence removed). Returns null when there is
 * no well-formed ```ui block, so callers fall back to rendering plain markdown.
 */
export function extractUIBlockFromText(
  content: string,
): ExtractedUIBlock | null {
  const match = UI_FENCE.exec(content);
  if (match === null || match[1] === undefined) return null;
  const parsed = tryParseJson(match[1]);
  if (!isUIBlock(parsed)) return null;
  const before = content.slice(0, match.index).trim();
  const after = content.slice(match.index + match[0].length).trim();
  const text = [before, after].filter((part) => part !== "").join("\n\n");
  return { block: parsed, text };
}

/** An interactive block's response, posted back to the agent as the next turn. */
export interface UIResponse {
  blockKind: "choice";
  /** The chosen option's value (falls back to its label). */
  value: string;
}
