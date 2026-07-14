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
import { ComparisonResultSchema, type ComparisonResult } from "@workbench/ui";

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
  // The interactive block that produced this response (CL-2715). `choice` posts a
  // single option; `form` posts a structured field map; `multiSelect` posts an
  // array of picked values. The host (WorkflowDock) routes all three the same
  // way — by `signalName` + verbatim `payload` — so the discriminant is carried
  // for the renderer's benefit, never branched on downstream.
  blockKind: "'choice' | 'form' | 'multiSelect' | 'reviewList'",
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
 * A selectable option for a `select` / `multiSelect` form field or the
 * standalone `multiSelect` block (CL-2715). `value` is what the field submits;
 * `label` is what the human reads.
 */
export type FormFieldOption = {
  value: string;
  label: string;
  description?: string;
  defaultChecked?: boolean;
};

/**
 * A column in a `reviewList` block (CL-2759). `key` indexes the row's `fields`
 * map; `label` is the human header; `kind` chooses the cell renderer (plain
 * text, rendered markdown, a badge pill, or a clickable link). Absent `kind`
 * renders as text.
 */
export const ReviewListDisplayFieldSchema = type({
  key: "string",
  label: "string",
  "kind?": "'text' | 'markdown' | 'badge' | 'link'",
});
export type ReviewListDisplayField = typeof ReviewListDisplayFieldSchema.infer;

/**
 * The emitted decision for one row of a `reviewList` block (CL-2759): the row's
 * FULL verbatim `payload` spread flat, plus the human's `approved` verdict.
 * Extra keys (the payload's own fields) are allowed through — this schema only
 * pins the `approved` discriminant a downstream step branches on.
 */
export const ReviewListDecisionSchema = type({
  approved: "boolean",
});
export type ReviewListDecision = typeof ReviewListDecisionSchema.infer;

/**
 * A single typed input in a `form` block (CL-2715). Kept minimal — only the
 * field kinds the real pre-execution config + intake gates need (ab-config
 * variants, attio review/sync-approval, reddit/seo/last30days intake), NOT a
 * general form-builder DSL. On submit the form emits a `Record<name, value>`
 * payload: text/textarea/select → string, number → number, multiSelect →
 * string[], group → an array of per-row records.
 *
 * Like the parent UIBlock union, this is a plain TS discriminated union
 * validated by a hand-written guard rather than an arktype `scope()` — the
 * `group` variant nests `FormField[]`, and arktype's recursive-scope compiler
 * hits the same `Apply is not a function` cycle bug documented on UIBlock. The
 * guard (see {@link isFormField}) mirrors the runtime shape exactly; a
 * workflow's submitted payload is validated by the workflow-owned arktype
 * schema at the /resume boundary, not by this contract.
 */
export type FormField =
  | {
      kind: "text";
      name: string;
      label?: string;
      placeholder?: string;
      required?: boolean;
      defaultValue?: string;
    }
  | {
      kind: "textarea";
      name: string;
      label?: string;
      placeholder?: string;
      required?: boolean;
      defaultValue?: string;
    }
  | {
      kind: "number";
      name: string;
      label?: string;
      placeholder?: string;
      required?: boolean;
      defaultValue?: number;
    }
  | {
      kind: "select";
      name: string;
      label?: string;
      required?: boolean;
      options: FormFieldOption[];
      defaultValue?: string;
    }
  | {
      kind: "multiSelect";
      name: string;
      label?: string;
      required?: boolean;
      min?: number;
      max?: number;
      options: FormFieldOption[];
    }
  | {
      // A repeatable group of leaf fields — the multi-variant case (ab-config's
      // N provider/model variants). Its sub-fields may NOT themselves be groups
      // (one level of nesting only). Submits an array of per-row records.
      kind: "group";
      name: string;
      label?: string;
      addLabel?: string;
      min?: number;
      max?: number;
      defaultRows?: Record<string, unknown>[];
      fields: Exclude<FormField, { kind: "group" }>[];
    };

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
      // options that carry an object `payload`. When `required` is true the note
      // is mandatory: every option's submit button in the choice is disabled
      // until the note is non-empty (CL-2730) — mirroring the run-page panel's
      // `feedback.trim().length > 0` guard so a dock decision cannot be submitted
      // with an empty required note (e.g. a guidance-less refine).
      promptBox?: {
        placeholder?: string;
        payloadKey: string;
        required?: boolean;
      };
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
  | {
      // A multi-field input gate (CL-2715). Renders typed fields and, on submit,
      // emits a structured `Record<name, value>` payload via the same
      // verbatim-payload seam `choice` uses. When `signalName` is set the host
      // resumes the run with that signal + the field-value payload; a required
      // field left empty holds the submit button (mirroring promptBox.required).
      kind: "form";
      prompt?: string;
      signalName?: string;
      submitLabel?: string;
      fields: FormField[];
    }
  | {
      // An N-of-M selection gate (CL-2715): pick between `min` and `max` of the
      // options. Emits the picked values as an ARRAY payload. `min` defaults to
      // 1 (a selection gate must pick at least one); the submit button holds
      // until the count is in range.
      kind: "multiSelect";
      prompt?: string;
      signalName?: string;
      submitLabel?: string;
      min?: number;
      max?: number;
      options: {
        id: string;
        label: string;
        value?: string;
        description?: string;
        defaultChecked?: boolean;
      }[];
    }
  | {
      // A per-record approve/reject gate over an array of rich, model-generated
      // records (CL-2759): the one HITL shape no other primitive expresses.
      // Each row shows `displayFields` drawn from its `fields` map and carries a
      // verbatim `payload` (the FULL record) forwarded downstream. On submit it
      // emits the approved rows' payloads under `approvedKey` (default
      // "approvedPieces") plus a `decisions` array covering EVERY row with its
      // `approved` verdict. `min`/`max` bound the approved count; the submit
      // button holds until it is in range. Each row's `defaultDecision` seeds
      // its toggle (default "approved").
      kind: "reviewList";
      title?: string;
      prompt?: string;
      signalName?: string;
      submitLabel?: string;
      approvedKey?: string;
      min?: number;
      max?: number;
      displayFields: ReviewListDisplayField[];
      rows: {
        id: string;
        fields: Record<string, string | number>;
        payload: unknown;
        defaultDecision?: "approved" | "rejected";
      }[];
    }
  | {
      // A side-by-side A/B comparison rendered through @workbench/ui's
      // ComparisonView — the single renderer for both the live run and the
      // saved artifact. `status` is the run-level phase (the winner
      // accent only applies once `"final"`); each variant carries its own
      // streaming / responded / no-response lifecycle. `blind` hides the
      // provider/model identity during a blind review.
      kind: "comparison";
      status: "running" | "final";
      result: ComparisonResult;
      blind?: boolean;
    }
  | {
      // A compact summary card for one entity or decision (CL-3547).
      kind: "card";
      title: string;
      subtitle?: string;
      body?: string;
      badge?: string;
      footer?: string;
      href?: string;
    }
  | {
      // A scannable bullet or numbered list (CL-3547).
      kind: "list";
      title?: string;
      ordered?: boolean;
      items: {
        id?: string;
        title: string;
        description?: string;
        meta?: string;
        badge?: string;
      }[];
    }
  | {
      // A rich link preview with optional thumbnail (CL-3547).
      kind: "preview";
      url: string;
      title?: string;
      description?: string;
      imageUrl?: string;
    }
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
  "form",
  "multiSelect",
  "reviewList",
  "comparison",
  "card",
  "list",
  "preview",
  "canvas",
]);

const FORM_FIELD_KINDS = new Set<FormField["kind"]>([
  "text",
  "textarea",
  "number",
  "select",
  "multiSelect",
  "group",
]);

function isFormFieldOption(value: unknown): value is FormFieldOption {
  if (typeof value !== "object" || value === null) return false;
  const opt = value as Record<string, unknown>;
  return (
    typeof opt.value === "string" &&
    typeof opt.label === "string" &&
    (opt.defaultChecked === undefined ||
      typeof opt.defaultChecked === "boolean")
  );
}

/**
 * Structural guard for a single {@link FormField}. Shallow per variant: it
 * confirms the discriminant plus the fields the renderer reads. A `group`
 * recurses one level into its sub-fields and rejects a nested group (the type
 * forbids it; the guard enforces it at runtime so a malformed block degrades to
 * text rather than infinitely nesting).
 */
export function isFormField(
  value: unknown,
  allowGroup = true,
): value is FormField {
  if (typeof value !== "object" || value === null) return false;
  const field = value as Record<string, unknown>;
  if (
    typeof field.kind !== "string" ||
    !FORM_FIELD_KINDS.has(field.kind as FormField["kind"])
  ) {
    return false;
  }
  if (typeof field.name !== "string" || field.name.length === 0) return false;
  if (field.kind === "select" || field.kind === "multiSelect") {
    return (
      Array.isArray(field.options) && field.options.every(isFormFieldOption)
    );
  }
  if (field.kind === "group") {
    if (!allowGroup) return false;
    return (
      Array.isArray(field.fields) &&
      field.fields.length > 0 &&
      (field.defaultRows === undefined ||
        (Array.isArray(field.defaultRows) &&
          field.defaultRows.every(
            (r: unknown) => typeof r === "object" && r !== null,
          ))) &&
      field.fields.every((sub) => isFormField(sub, false))
    );
  }
  return true;
}

function hasKind(value: unknown): value is { kind: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof (value as { kind: unknown }).kind === "string"
  );
}

export const MAX_UI_BLOCK_NEST_DEPTH = 24;

function isTableCell(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isTableShape(block: Record<string, unknown>): boolean {
  if (!Array.isArray(block.columns) || !Array.isArray(block.rows)) return false;
  if (!(block.columns as unknown[]).every((c) => typeof c === "string"))
    return false;
  return (block.rows as unknown[]).every(
    (row) =>
      Array.isArray(row) &&
      (row as unknown[]).every((cell) => isTableCell(cell)),
  );
}

/**
 * Validate that a parsed value is a structurally-sound UIBlock. Confirms the
 * discriminant and the fields each renderer reads (including table cell types
 * and canvas nesting depth) so malformed input degrades to text, not a crash.
 */
function isUIBlockAtDepth(value: unknown, depth: number): value is UIBlock {
  if (depth > MAX_UI_BLOCK_NEST_DEPTH) return false;
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
      return isTableShape(block);
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
    case "form":
      return (
        Array.isArray(block.fields) &&
        block.fields.length > 0 &&
        (block.fields as unknown[]).every((field) => isFormField(field))
      );
    case "multiSelect":
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
    case "reviewList":
      return (
        Array.isArray(block.displayFields) &&
        block.displayFields.length > 0 &&
        (block.displayFields as unknown[]).every(
          (field) =>
            !(ReviewListDisplayFieldSchema(field) instanceof type.errors),
        ) &&
        Array.isArray(block.rows) &&
        (block.rows as unknown[]).every(
          (row) =>
            typeof row === "object" &&
            row !== null &&
            typeof (row as Record<string, unknown>).id === "string" &&
            typeof (row as Record<string, unknown>).fields === "object" &&
            (row as Record<string, unknown>).fields !== null &&
            "payload" in (row as Record<string, unknown>),
        )
      );
    case "comparison":
      return (
        (block.status === "running" || block.status === "final") &&
        !(ComparisonResultSchema(block.result) instanceof type.errors) &&
        (block.blind === undefined || typeof block.blind === "boolean")
      );
    case "card":
      return typeof block.title === "string" && block.title.length > 0;
    case "list":
      return (
        Array.isArray(block.items) &&
        block.items.length > 0 &&
        (block.items as unknown[]).every(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            typeof (item as Record<string, unknown>).title === "string" &&
            ((item as Record<string, unknown>).title as string).length > 0,
        )
      );
    case "preview":
      return typeof block.url === "string" && block.url.length > 0;
    case "canvas":
      return (
        Array.isArray(block.blocks) &&
        (block.blocks as unknown[]).every((child) =>
          isUIBlockAtDepth(child, depth + 1),
        )
      );
    default:
      return false;
  }
}

export function isUIBlock(value: unknown): value is UIBlock {
  return isUIBlockAtDepth(value, 0);
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
