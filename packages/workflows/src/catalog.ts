// Deploy-layer metadata for every seeded workflow package: display name,
// whether it's schedulable as a routine, where its result actually lands
// (a channel vs. the creator's Inbox only), required connections, and
// optional trigger-input fields. Interchange's `defineWorkflow` has no
// automatable/display-name concept of its own.
//
// `assetName`/`displayName`/`automatable` are read straight off each
// `workflows/*/package.json`'s `corbits.workflow` block via a static JSON
// import below — resolved at build time (Vite, tsc, and Bun all support
// `resolveJsonModule`), never at runtime, so this stays importable from
// the browser bundle. There is nothing left to keep "in lockstep": the
// package.json block IS the value this module reads, not a copy of it.
// The remaining fields (`conversational`, `deliveryMode`, `whatItDoes`,
// `requiredConnections`, `exampleOutput`, `typicalDuration`,
// `triggerFields`) have no npm-visible home of their own — they exist
// only here, so there is no second copy for them to drift from.
import { type } from "arktype";

import assistantPkg from "../../../agents/assistant/package.json";

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

/**
 * One named field a mail trigger reads by name — the create-time UI's only
 * source of truth for what a workflow's trigger actually expects (see a
 * workflow's own system prompt / intake tool for the underlying contract
 * this mirrors). `key` is the exact field name a trigger payload carries —
 * never relabeled or humanized before it reaches the workflow.
 */
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
  /**
   * Where a run's result actually lands — the honest end-to-end
   * contract a routine's "Deliver results to" step depends on. Every
   * entry states this plainly, whether or not it is automatable:
   * `"workbench"` posts into the picked delivery workbench's thread —
   * every catalog entry today; `"inbox"` never posts to a workbench at
   * all — its result reaches only the creator's Inbox, so a create/run
   * flow for it must never collect or require a deliveryWorkbenchId that
   * would otherwise be silently discarded.
   */
  readonly deliveryMode: "workbench" | "inbox";
  /** One honest sentence: what this workflow actually does. No metrics, no hype. */
  readonly whatItDoes: string;
  /**
   * Connector ids this workflow's tool packages call — either a native
   * connector (`@corbits/connections/registry`'s `CONNECTOR_REGISTRY`)
   * or an MCP preset slug a person connects under Plugins
   * (`@corbits/connections/mcp-presets`' `MCP_PRESETS`), which is the
   * only way some integrations (Attio) are reachable here at all. Empty
   * for workflows with no external connector dependency.
   */
  readonly requiredConnections: readonly string[];
  /** A short, honest one-line readout of what a run actually produces —
   * capitalized, no trailing period, same shape across every entry. */
  readonly exampleOutput: string;
  /** A short, honestly-hedged hint — never fabricated precision. */
  readonly typicalDuration: string;
  /**
   * Named trigger inputs a person can fill in at create time (the routine
   * create stepper) or on a manual run — omitted entirely for workflows
   * whose trigger carries no human-supplied content (see each entry's own
   * comment for why). Order is display order.
   */
  readonly triggerFields?: readonly WorkflowTriggerField[];
};

/**
 * Every known workbench workflow package, keyed by the asset name seed
 * deploys under. Agent definitions created at runtime are never listed
 * here, so they cannot pass the automatable filter by accident.
 */
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

/**
 * Whether a workflow definition name is fit to offer as a DM/chat target
 * (the sidebar's agent rows, a taskable-agent picker, …) rather than a
 * triggered automation utility. A name absent from this catalog is an
 * agent-directory-created definition — "Agent definitions created at
 * runtime are never listed here" (see `WORKFLOW_CATALOG`'s own comment) —
 * and is always conversational; a name present here is conversational
 * only when its entry says so (`assistant`/Myra, the only entry today).
 */
export function isConversationalWorkflowName(name: string): boolean {
  const entry = byAssetName.get(name);
  return entry === undefined || entry.conversational;
}

/**
 * Whether a routine on this workflow needs a `deliveryWorkbenchId` at
 * all — `false` only for a known `"inbox"`-delivering entry (see
 * `WorkflowCatalogEntry.deliveryMode`). An unknown name defaults `true`
 * (workbench required): the safe, prior-behavior default when a workflow
 * isn't catalog-known at all.
 */
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

/**
 * The create-time boundary check for a routine's stored `input`
 *: inputs bind at USE, never at creation, so a required
 * field with no value at all in `input` is never a create-time
 * rejection — a workflow with a required trigger field can still be
 * created with it left open until someone actually runs it. Only a
 * value the caller explicitly provided gets checked,
 * and only for basic shape (a non-empty string) — a key present but
 * blank is a caller bug, not an open input, and still rejected.
 * `kind: "agent"` resolution (does a provided value name a real
 * taskable definition) is a separate, still-eager check a host layers
 * on top (`apps/hub/src/index.ts`'s `routineInputValid`) since it
 * needs a tenant DB lookup this function can't do. Fire-time
 * validation (a host's own launcher definition checks) remains the
 * authoritative required-field gate.
 */
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
