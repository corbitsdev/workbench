// Deploy-layer metadata for seeded workflow packages. Interchange's
// defineWorkflow has no automatable / display-name fields; each
// workflows/*/package.json carries a `corbits.workflow` block, and this
// module is the TypeScript mirror both seed and the web picker import.
// Keep the two in lockstep — the package.json block is the npm-visible
// source of truth for package authors; this list is what runtime code
// reads.

export type WorkflowCatalogEntry = {
  readonly assetName: string;
  readonly displayName: string;
  /** Schedulable as a Routine. False for conversational agents / chat hosts. */
  readonly automatable: boolean;
};

/**
 * Every known workbench workflow package, keyed by the asset name seed
 * deploys under. Agent definitions created at runtime are never listed
 * here, so they cannot pass the automatable filter by accident.
 */
export const WORKFLOW_CATALOG: readonly WorkflowCatalogEntry[] = [
  {
    assetName: "echo",
    displayName: "Echo",
    automatable: false,
  },
  {
    assetName: "assistant",
    displayName: "Assistant",
    automatable: false,
  },
  {
    assetName: "heartbeat",
    displayName: "Heartbeat",
    automatable: true,
  },
  {
    assetName: "channel-digest",
    displayName: "Channel digest",
    automatable: true,
  },
];

const byAssetName = new Map(
  WORKFLOW_CATALOG.map((entry) => [entry.assetName, entry]),
);

export function isAutomatableWorkflowName(name: string): boolean {
  return byAssetName.get(name)?.automatable === true;
}

/**
 * Friendly label for a workflow definition. Prefer the catalog display
 * name, then a non-empty description, then a humanized asset name — never
 * a raw definition id.
 */
export function workflowDisplayName(
  name: string,
  description?: string | null,
): string {
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
