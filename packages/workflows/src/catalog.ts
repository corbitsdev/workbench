// Deploy-layer metadata for every seeded workflow package, since
// Interchange's `defineWorkflow` has no automatable/display-name concept.
// Read straight off each package's `corbits.workflow` block, no second copy.
import { type } from "arktype";

import assistantPkg from "../../../agents/myra/package.json";

const CorbitsWorkflowBlock = type({
  assetName: "string > 0",
  displayName: "string > 0",
  automatable: "boolean",
});
type CorbitsWorkflowBlock = typeof CorbitsWorkflowBlock.infer;

/** Reads one workflow package's `corbits.workflow` block — the only
 * source of truth for `assetName`/`displayName`/`automatable`. Throws on
 * a malformed block rather than seeding a broken catalog entry. */
function workflowBlock(pkg: {
  readonly corbits?: { readonly workflow?: unknown };
}): CorbitsWorkflowBlock {
  const parsed = CorbitsWorkflowBlock(pkg.corbits?.workflow);
  if (parsed instanceof type.errors) {
    throw new Error(`invalid corbits.workflow block: ${parsed.summary}`);
  }
  return parsed;
}

/** One named field a mail trigger reads by name — the create-time UI's only
 * source of truth for what a workflow's trigger expects. */
export const WorkflowTriggerField = type({
  key: "/^[a-zA-Z][a-zA-Z0-9]*$/",
  // Explicit, never defaulted: `"text"` renders a plain input and
  // accepts any non-empty string; `"agent"` renders a picker of
  // taskable agent definitions and its value must resolve to a real
  // taskable definition at create time.
  kind: "'text' | 'agent'",
  label: "string > 0",
  "placeholder?": "string",
  required: "boolean",
  "default?": "string",
  "help?": "string",
});
export type WorkflowTriggerField = typeof WorkflowTriggerField.infer;

export type WorkflowCatalogEntry = {
  readonly assetName: string;
  readonly displayName: string;
  /** Schedulable as a Routine. False for conversational agents / chat hosts. */
  readonly automatable: boolean;
  /**
   * A real chat partner a person can open a DM with and converse
   * freely — as opposed to a mail-triggered utility whose only sane
   * input is its declared trigger contract. Only the seeded
   * `assistant`/Myra definition is `true`.
   */
  readonly conversational: boolean;
  /** Where a run's result lands: `"workbench"` posts into the picked
   * delivery workbench's thread; `"inbox"` reaches only the creator's Inbox. */
  readonly deliveryMode: "workbench" | "inbox";
  /** One honest sentence: what this workflow actually does. No metrics, no hype. */
  readonly whatItDoes: string;
  /**
   * Connector ids this workflow's tool packages call — a stored
   * credential's provider name. Empty for workflows with no external
   * connector dependency.
   */
  readonly requiredConnections: readonly string[];
  /** A short, honest one-line readout of what a run actually produces —
   * capitalized, no trailing period, same shape across every entry. */
  readonly exampleOutput: string;
  /** A short, honestly-hedged hint — never fabricated precision. */
  readonly typicalDuration: string;
  /** Named trigger inputs a person can fill in at create time or on a
   * manual run, in display order. Omitted when there's nothing to fill in. */
  readonly triggerFields?: readonly WorkflowTriggerField[];
};

/** Every known workbench workflow package. Agent definitions created at
 * runtime are never listed here, so they cannot pass the automatable
 * filter by accident. */
export const WORKFLOW_CATALOG: readonly WorkflowCatalogEntry[] = [
  {
    ...workflowBlock(assistantPkg),
    conversational: true,
    deliveryMode: "workbench",
    whatItDoes:
      "A general-purpose assistant for the workspace — answers questions, drafts text, and reasons through problems in conversation.",
    requiredConnections: [],
    exampleOutput: "Drafted a short, polite decline you can send as-is",
    typicalDuration: "varies with the conversation",
  },
];

for (const entry of WORKFLOW_CATALOG) {
  if (entry.triggerFields === undefined) continue;
  const parsed = WorkflowTriggerField.array()(entry.triggerFields);
  if (parsed instanceof type.errors) {
    throw new Error(
      `workflow-catalog entry "${entry.assetName}" has an invalid ` +
        `triggerFields shape: ${parsed.summary}`,
    );
  }
}

const byAssetName = new Map(WORKFLOW_CATALOG.map((entry) => [entry.assetName, entry]));

export function isAutomatableWorkflowName(name: string): boolean {
  return byAssetName.get(name)?.automatable === true;
}

/** Whether a workflow name is fit to offer as a DM/chat target. A name
 * absent from the catalog is agent-directory-created and always
 * conversational; a catalog entry is conversational only when it says so. */
export function isConversationalWorkflowName(name: string): boolean {
  const entry = byAssetName.get(name);
  return entry === undefined || entry.conversational;
}

/** Whether a routine on this workflow needs a `deliveryWorkbenchId`. An
 * unknown name defaults to `true` (workbench required). */
export function deliveryWorkbenchRequiredForWorkflowName(name: string): boolean {
  return byAssetName.get(name)?.deliveryMode !== "inbox";
}

/** The full catalog entry for an asset name, or `undefined` if it isn't
 * a known workflow — the demo-card fields (`whatItDoes`, `exampleOutput`,
 * etc.) live here alongside the display name. */
export function workflowCatalogEntry(name: string): WorkflowCatalogEntry | undefined {
  return byAssetName.get(name);
}

/**
 * Friendly label for a workflow definition. Prefer the catalog display
 * name, then a non-empty description, then a humanized asset name — never
 * a raw definition id.
 */
export function workflowDisplayName(name: string, description?: string | null): string {
  const entry = byAssetName.get(name);
  if (entry !== undefined) return entry.displayName;
  if (description !== undefined && description !== null) {
    const trimmed = description.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return humanizeAssetName(name);
}

function humanizeAssetName(name: string): string {
  return name
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export type TriggerFieldsValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/** Create-time boundary check for a routine's stored `input`. Inputs bind at
 * use, never at creation, so a missing required field is not rejected here
 * — only a caller-provided but blank value is. Fire-time validation remains
 * the authoritative required-field gate. */
export function validateTriggerFieldsAtCreate(
  fields: readonly WorkflowTriggerField[],
  input: Record<string, unknown>,
): TriggerFieldsValidation {
  for (const field of fields) {
    if (!(field.key in input)) continue;
    const value = input[field.key];
    if (typeof value !== "string" || value.trim() === "") {
      return {
        ok: false,
        message: `"${field.label}" must not be blank`,
      };
    }
  }
  return { ok: true };
}
