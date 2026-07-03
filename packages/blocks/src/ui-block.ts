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

import { type } from "arktype";

export const DocumentActionsSchema = type({
  "copy?": "boolean",
  "download?": "boolean",
  "saveArtifact?": "boolean",
});
export type DocumentActions = typeof DocumentActionsSchema.infer;

export const ProgressStepStateSchema = type(
  "'done' | 'running' | 'awaiting' | 'pending' | 'failed'",
);
export type ProgressStepState = typeof ProgressStepStateSchema.infer;

export const ProgressStepSchema = type({
  state: ProgressStepStateSchema,
  "label?": "string",
  "meta?": "string",
});
export type ProgressStep = typeof ProgressStepSchema.infer;

export const UIResponseSchema = type({
  blockKind: "'choice'",
  value: "string",
  // When the interactive block is a workflow gate (CL-2681), it carries the
  // pending gate's `awaitSignal` name. The host resumes the run with this
  // signal + the response value as payload instead of posting a chat turn.
  "signalName?": "string",
  // A structured resume payload the selected option carries (CL-2683). When
  // present the host delivers it verbatim as the gate's signal payload instead
  // of wrapping the string `value` as free text — this lets a choice express a
  // typed decision (e.g. a ranking) the workflow's compose step reads directly.
  "payload?": "unknown",
});
/** An interactive block's response, posted back to the agent as the next turn. */
export type UIResponse = typeof UIResponseSchema.infer;

/**
 * UIBlock is a recursive discriminated union — the "canvas" variant wraps
 * `blocks: UIBlock[]`. Arktype 2.2.0's `scope()` compiler triggers a runtime
 * bug (`this.CanvasBlock1Apply is not a function`) when multiple scope aliases
 * participate in a mutual cycle via intermediate alias references: the compiled
 * Apply methods for canvas-adjacent aliases are emitted out of order and never
 * initialized. Keeping the type as a plain TS discriminated union and validating
 * it with a manual structural guard sidesteps the bug entirely; the guard is
 * recursive on `canvas.blocks`, matching the runtime behaviour exactly.
 */
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
      // A workflow gate's `awaitSignal` name (CL-2681). When present, selecting
      // an option resolves the response to a run resume with this signal rather
      // than a chat turn — the renderer carries it, never hardcodes it.
      signalName?: string;
      // An optional free-text field rendered alongside the options (CL-2683). Its
      // typed value is folded into the selected option's structured `payload`
      // under `payloadKey` when non-empty, so a choice can carry a rationale (or
      // any per-decision note) the panel equivalent collects. Only meaningful for
      // options that carry an object `payload`.
      promptBox?: { placeholder?: string; payloadKey: string };
      options: {
        id: string;
        label: string;
        value?: string;
        description?: string;
        // A structured resume payload delivered verbatim as the gate's signal
        // payload when this option is selected (CL-2683). Absent for a plain
        // choice, which posts the string `value` wrapped as free text.
        payload?: unknown;
      }[];
    }
  | { kind: "progress"; title?: string; steps: ProgressStep[] }
  | { kind: "canvas"; title?: string; blocks: UIBlock[] };

export type ExtractedUIBlock = {
  /** The block parsed from the fenced region. */
  block: UIBlock;
  /** The message text with the fenced block removed, trimmed. */
  text: string;
};

const KNOWN_KINDS = new Set<UIBlock["kind"]>([
  "text",
  "markdown",
  "document",
  "table",
  "link",
  "error",
  "choice",
  "progress",
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
      return (
        Array.isArray(block.options) &&
        block.options.length > 0 &&
        (block.options as unknown[]).every(
          (opt) =>
            typeof opt === "object" &&
            opt !== null &&
            typeof (opt as Record<string, unknown>).id === "string" &&
            typeof (opt as Record<string, unknown>).label === "string",
        )
      );
    case "progress":
      return (
        Array.isArray(block.steps) &&
        block.steps.length > 0 &&
        (block.steps as unknown[]).every(
          (step) => !(ProgressStepSchema(step) instanceof type.errors),
        )
      );
    case "canvas":
      return (
        Array.isArray(block.blocks) &&
        (block.blocks as unknown[]).every(isUIBlock)
      );
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
